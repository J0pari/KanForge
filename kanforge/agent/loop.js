// Tactic-level search loop (architecture.md §2.2, §4).
//
// Two-level structure:
// - Level 1: Lemma DAG (dependency-ordered dispatch via scheduler)
// - Level 2: Goal e-graph (equivalence classes of goals with transposition merging)
//
// For each lemma, the loop works backwards from the target goal to simpler subgoals:
// 1. Pick the first open goal equivalence class from the e-graph (frontier order — the repl
//    tactic API attacks the head goal of a proof state)
// 2. Ask the LLM for ONE tactic
// 3. Apply it via backend.applyTactic(goal, tactic) on the goal's proofState
// 4. Get zero or more new goal equivalence classes
// 5. Repeat until the root goal class is solved (lemma proved) or budget exhausted
//
// Commit gate (§2.5): the composed tree is straightened to a script, spliced into the pinned
// statement (state.js buildProofSource), kernel-verified as a whole, and only then checked
// against the HARD guardrails (pin unchanged, kernel accepted, no leakage). A violation marks
// the node WEAKENED/FAILED and emits a guardrail trip — never a cached success.
//
// Telemetry (build_order.md P1.1): every event flows through optimization/bus.js into
// optimization/store.js with id/t/parent — the parent chain is the causal DAG per lemma.

import { Scheduler } from '../core/scheduler.js';
import { PullGraph } from '../core/pullgraph.js';
import { hashStatement, makePin, checkPin } from '../lean/pin.js';
import { hashChainEntry, verifyHashChain } from '../core/hasher.js';
import { isGoalSolved, isLemmaProved } from './solve.js';
import { GoalEGraph, lexicalNormalize } from '../core/egraph.js';
import { straighten, buildProofSource } from '../core/state.js';
import { Guardrails } from '../core/guardrails.js';
import { Patch } from '../core/patch.js';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';
import { computeMetrics } from '../optimization/metrics.js';
import { assembleAuditPack, writeAuditPack } from '../digest/auditPack.js';
import { classifyError, buildRepairPrompt } from './repair.js';
import { formatGoalPrompt } from './prompts.js';
import { bestOfNWithSwiss, buildPairwiseJudge, swissRank } from '../search/swiss.js';
import { bestOfN } from '../search/bestofn.js';
import { BestFirstSearch } from '../search/bfs.js';
import { MCGS } from '../search/mcgs.js';
import { RepulsionSampler } from '../search/repulsion.js';
import { tacticHead } from '../optimization/causal.js';
import { analyzePatterns } from '../optimization/patterns.js';
import { exportTelemetry } from '../optimization/exporter.js';
import { TestTimePolicy } from '../optimization/ttrl.js';
import { GRPOHarness } from '../optimization/grpo.js';
import { PremiseRetriever, buildPremisePrompt, findPremiseLockViolations } from '../search/premises.js';
import fs from 'node:fs';
import path from 'node:path';

// Search recipes the loop can run (architecture.md §5 integration contract). Per-goal recipes
// dispatch inside the frontier loop; whole-graph recipes delegate the entire e-graph search and
// share the commit gate.
export const LOOP_SEARCH_RECIPES = ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'mcgs'];

export class TacticLoop {
    constructor({ backend, llm, concurrency = 2, maxTacticsPerGoal = 8, maxGoalsPerLemma = 100, onEvent = null, bus = null, store = null, checkpointDir = null, useSwiss = false, swissN = 8, premises = null, premiseLocked = false, premiseTopK = 5, searchRecipe = 'loop', repulsion = false, predictors = null, monitor = false, exportTo = null, ttrl = false, grpo = false, lemmaStore = null } = {}) {
        if (!backend || !llm) {
            throw new Error('TacticLoop requires a real backend and a real llm client');
        }
        this.backend = backend;
        this.llm = llm;
        this.concurrency = concurrency;
        this.maxTacticsPerGoal = maxTacticsPerGoal;
        this.maxGoalsPerLemma = maxGoalsPerLemma;
        this.checkpointDir = checkpointDir;
        this.useSwiss = useSwiss;
        this.swissN = swissN;
        const recipe = LOOP_SEARCH_RECIPES.includes(searchRecipe) ? searchRecipe : 'loop';
        this.searchRecipe = (useSwiss && recipe === 'loop') ? 'swiss' : recipe;
        this.repulsion = repulsion;
        this.predictors = predictors;
        this.premiseLocked = premiseLocked;
        this.premiseTopK = premiseTopK;
        this.retriever = (premises && premises.length > 0) ? new PremiseRetriever(premises) : null;
        this.monitor = monitor === true;
        this.exportTo = exportTo ?? null;
        this.ttrl = ttrl === true;
        this.grpo = grpo === true;
        this.ttrlPolicy = this.ttrl ? new TestTimePolicy() : null;
        this.grpoHarness = this.grpo ? new GRPOHarness() : null;
        this.lemmaStore = lemmaStore ?? null;

        this.bus = bus ?? new EventBus();
        this.store = store ?? new EventStore();
        if (!bus || !store) this.bus.subscribe(e => this.store.append(e));
        this.onEvent = onEvent ?? (e => console.log(JSON.stringify(e)));

        this.graph = new PullGraph();
        this.pins = new Map();          // lemmaId -> Pin (statement pinning, §3)
        this._chains = new Map();       // lemmaId -> last event id (causal parent chain)
        this._age = new Map();
        this._order = 0;
        this.llmCalls = 0;
        this.tacticCalls = 0;
        this.lastOutcome = null;
        this.hashChain = [];        // run-level statement hash chain (§7): one entry per verified lemma

        // Create checkpoint directory if specified
        if (this.checkpointDir) {
            fs.mkdirSync(this.checkpointDir, { recursive: true });
        }
    }

    addLemma(statement, { deps = [] } = {}) {
        const id = hashStatement(statement);
        if (!this.graph.nodes.has(id)) {
            this._age.set(id, this._order++);
            this.graph.register(id, () => statement);
            this.pins.set(id, makePin(statement, this.backend.pin?.() ?? {}));
        }
        for (const dep of deps) {
            const depId = hashStatement(dep);
            if (!this.graph.nodes.has(depId)) {
                this._age.set(depId, this._order++);
                this.graph.register(depId, () => dep);
                this.pins.set(depId, makePin(dep, this.backend.pin?.() ?? {}));
            }
            this.graph.dependsOn(id, depId);
        }
        return id;
    }

    priority(nodeId) {
        return this._age.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
    }

    _emit(event, lemmaId = null) {
        const enriched = this.bus.emit({
            ...event,
            parent: lemmaId ? (this._chains.get(lemmaId) ?? null) : null
        });
        if (lemmaId) this._chains.set(lemmaId, enriched.id);
        this.onEvent?.(enriched);
        return enriched;
    }

    async _proveLemma(lemmaId, statement, signal = null) {
        this._emit({ type: 'lemma_goal', lemmaId, statement }, lemmaId);
        const start = Date.now();
        this._retrievedPremises = new Set(); // union of all per-goal retrievals (premise-lock commit check)

        const fail = (error, extra = {}) => {
            const ms = Date.now() - start;
            this._emit({ type: 'lemma_failed', lemmaId, statement, ms, error, ...extra }, lemmaId);
            const err = new Error(`lemma ${lemmaId} failed: ${error}`);
            err.lemmaFailedEmitted = true; // catch below must not double-emit
            throw err;
        };

        try {
            // Level 2: Goal e-graph. extractGoals opens the backend proof session.
            const egraph = new GoalEGraph({ normalizer: lexicalNormalize });
            let rootGoals;
            try {
                rootGoals = await this.backend.extractGoals(statement);
            } catch (err) {
                fail(`could not extract root goal: ${err?.message ?? String(err)}`, { extractFailed: true });
            }
            if (!rootGoals || rootGoals.length === 0) {
                fail('could not extract root goal (empty goal list)', { extractFailed: true });
            }

            const rootId = egraph.addGoal(rootGoals[0]);
            egraph.setRoot(rootGoals[0]);

            let goalCount = 0;
            if (this.searchRecipe === 'bfs' || this.searchRecipe === 'mcgs') {
                // Whole-graph delegation (architecture.md §5 integration contract): the strategy
                // owns goal selection AND proposals over the e-graph; the loop keeps the commit
                // gate below. Cost is counted via counting proxies so the loop's llmCalls and
                // tacticCalls stay honest for metrics/audit.
                const countedLLM = this._countingLLM(this.llm);
                const countedBackend = this._countingBackend(this.backend);
                const searcher = this.searchRecipe === 'mcgs'
                    ? new MCGS({ backend: countedBackend, llm: countedLLM, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors })
                    : new BestFirstSearch({ backend: countedBackend, llm: countedLLM, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors });
                this._emit({ type: 'search_start', lemmaId, recipe: this.searchRecipe, budget: this.maxGoalsPerLemma }, lemmaId);
                const searchResult = await searcher.search(egraph, this.searchRecipe === 'mcgs' ? { rollouts: this.maxGoalsPerLemma } : { maxExpansions: this.maxGoalsPerLemma });
                goalCount = searchResult.expansions ?? searchResult.rollouts ?? 0;
                this.llmCalls += countedLLM.llmCalls;
                this.tacticCalls += countedBackend.tacticCalls;
                this._emit({ type: 'search_complete', lemmaId, recipe: this.searchRecipe, solved: egraph.isRootSolved(), llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, skipped: searcher.skipped ?? 0 }, lemmaId);
                if (!egraph.isRootSolved()) {
                    fail(`search recipe ${this.searchRecipe} exhausted budget ${this.maxGoalsPerLemma} without solving`);
                }
            } else {
                const triedTactics = [];
                goalCount = 1;
                while (!egraph.isRootSolved() && goalCount < this.maxGoalsPerLemma) {
                    if (signal?.aborted) break;

                    // Frontier order: the first open class is the head goal of the current
                    // proof state; its freshest concrete goal carries the live proofState.
                    const openGoals = egraph.getOpenGoals();
                    if (openGoals.length === 0) break;

                    const currentGoalClass = openGoals[0];
                    const goal = egraph.currentGoal(currentGoalClass.id);
                    this._emit({ type: 'goal_selected', lemmaId, goalClassId: currentGoalClass.id, goal }, lemmaId);
                    const ctx = (goal.context ?? []).map(c => `${c.name}: ${c.type}`).join('; ');
                    console.log(`[loop] goal_selected ${currentGoalClass.id.slice(0,10)}… ⊢ ${goal.type.slice(0, 120)}${ctx ? ` | ctx: ${ctx.slice(0, 200)}` : ''}`);

                    let solved = false;
                    let lastResult = null;

                    if (this.searchRecipe === 'loop') {
                        // Test-time policy (§6.3): a goal class that keeps failing gets a larger
                        // tactic budget — within-run adaptation from this run's own outcomes.
                        if (this.ttrlPolicy) this.ttrlPolicy.observe(this.store.events);
                        const maxAttempts = this.ttrlPolicy?.stateFor(currentGoalClass.id).maxAttempts ?? this.maxTacticsPerGoal;
                        // Causal predictor pre-filter (§5.3, §6 feedback interconnection): before
                        // spending kernel time on a tactic, check whether it completes a known-
                        // failing window. Rejected tactics skip the kernel call and count as
                        // predictor-skips in telemetry — the LLM is not charged for the prediction.
                        const predictorHistory = [];
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            if (signal?.aborted) break;

                            this.llmCalls++;
                            // Lemma-store lookup: if a previously-proven lemma's conclusion
                            // matches the current goal type (after lexical normalization),
                            // skip the LLM entirely and use `exact <lemma>`.
                            const stored = this.lemmaStore?.findByGoal(goal.type);
                            const proposed = stored
                                ? { tactic: `exact ${extractLemmaName(stored.statement)}`, llmMs: 0, promptTokens: 0, completionTokens: 0 }
                                : (this.llmCalls++, await this._proposeTactic(goal, attempt, lemmaId, currentGoalClass.id));
                            const tactic = proposed?.tactic;
                            if (!tactic) {
                                this._emit({ type: 'llm_error', lemmaId, goalClassId: currentGoalClass.id, attempt, error: 'LLM returned no tactic' }, lemmaId);
                                continue;
                            }

                            this._emit({ type: 'tactic_proposed', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, llmMs: proposed.llmMs, promptTokens: proposed.promptTokens, completionTokens: proposed.completionTokens }, lemmaId);
                            console.log(`[loop] goal ${currentGoalClass.id.slice(0,10)}… (${goal.type.slice(0,90)}) attempt ${attempt}/${maxAttempts}: "${tactic}"`);

                            // Feedback interconnection (architecture.md §0.3): a causal predictor
                            // that knows a tactic head leads to kernel rejection can veto it before
                            // the expensive call — zero kernel spend on a predicted failure.
                            const head = tacticHead(tactic);
                            if (this.predictors?.rejects(head, predictorHistory)) {
                                this._emit({ type: 'tactic_predicted_failure', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, head }, lemmaId);
                                continue;
                            }
                            predictorHistory.push(head);

                            this.tacticCalls++;
                            const result = await this.backend.applyTactic(goal, tactic);
                            lastResult = result;

                            if (result.status === 'error') {
                                console.log(`[loop]   tactic failed: ${String(result.error?.message ?? 'no message').slice(0, 150)}`);
                                this._emit({ type: 'tactic_failed', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, error: result.error?.message ?? 'tactic failed' }, lemmaId);
                                continue;
                            }

                            const patch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: tactic, scope: 'goal', meta: { attempt, newGoals: result.newGoals } });
                            const record = egraph.applyPatch(patch);
                            this._emit({ type: 'tactic_applied', lemmaId, goalClassId: currentGoalClass.id, tactic }, lemmaId);
                            for (const subgoal of record.created) {
                                this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                            }

                            if (isGoalSolved(result)) {
                                solved = true;
                                this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic, attempt, via: 'proposal' }, lemmaId);
                                break;
                            }

                            solved = true; // decomposed into subgoals; they join the frontier
                            break;
                        }
                    } else {
                        // Per-goal delegated recipes: bestofn / swiss / swiss+repulsion
                        const pick = await this._pickByRecipe(goal, lemmaId, currentGoalClass.id, triedTactics);
                        this.llmCalls += pick.llmCalls ?? 0;
                        this.tacticCalls += pick.tacticCalls ?? 0;

                        if (pick.ok) {
                            const dpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: pick.tactic, scope: 'goal', meta: { via: pick.via, newGoals: pick.result.newGoals } });
                            const record = egraph.applyPatch(dpatch);
                            this._emit({ type: 'tactic_applied', lemmaId, goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via }, lemmaId);
                            for (const subgoal of record.created) {
                                this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                            }
                            solved = true;
                            lastResult = pick.result;
                            if (isGoalSolved(pick.result)) {
                                this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via }, lemmaId);
                            }
                        } else {
                            lastResult = { error: { message: pick.lastError ?? 'no tactic proposed' } };
                            this._emit({ type: 'recipe_failed', lemmaId, goalClassId: currentGoalClass.id, recipe: this.searchRecipe, lastError: lastResult.error.message }, lemmaId);
                        }
                    }

                    if (!solved) {
                        // P3.1: Attempt repair before giving up
                        const lastError = lastResult?.error?.message ?? 'unknown error';
                        const errorType = classifyError(lastError);
                        this._emit({ type: 'repair_attempted', lemmaId, goalClassId: currentGoalClass.id, errorType, lastError }, lemmaId);

                        const repairPrompt = buildRepairPrompt(goal, lastError, lastResult?.tactic);
                        const repaired = await this._proposeTacticFromPrompt(repairPrompt);
                        const repairedTactic = repaired?.tactic;

                        if (repairedTactic) {
                            console.log(`[loop]   repair attempt: "${repairedTactic}"`);
                            this._emit({ type: 'repair_proposed', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, llmMs: repaired.llmMs, promptTokens: repaired.promptTokens, completionTokens: repaired.completionTokens }, lemmaId);

                            this.tacticCalls++;
                            const repairResult = await this.backend.applyTactic(goal, repairedTactic);

                            if (repairResult.status === 'ok') {
                                const rpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: repairedTactic, scope: 'goal', meta: { via: 'repair', newGoals: repairResult.newGoals } });
                                const record = egraph.applyPatch(rpatch);
                                this._emit({ type: 'repair_applied', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic }, lemmaId);
                                for (const subgoal of record.created) {
                                    this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                                }
                                solved = true;
                                lastResult = repairResult;

                                if (isGoalSolved(repairResult)) {
                                    this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, via: 'repair' }, lemmaId);
                                }
                            } else {
                                console.log(`[loop]   repair failed: ${String(repairResult.error?.message ?? 'no message').slice(0, 150)}`);
                                this._emit({ type: 'repair_failed', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, error: repairResult.error?.message }, lemmaId);
                            }
                        }

                        if (!solved) {
                            console.log(`[loop] goal class ${currentGoalClass.id.slice(0,10)}… UNRESOLVED after ${this.maxTacticsPerGoal} attempts + repair (goal: ${goal.type.slice(0, 120)})`);
                            egraph.markFailed(currentGoalClass.id);
                            fail(`could not solve goal class ${currentGoalClass.id} after ${this.maxTacticsPerGoal} attempts + repair`);
                        }
                    }

                    goalCount += lastResult?.newGoals?.length ?? 0;
                }
            }

            const pin = this.pins.get(lemmaId);
            if (!isLemmaProved(egraph, hashStatement(statement), pin?.statementHash ?? '')) {
                if (!egraph.isRootSolved()) {
                    fail(`root goal not solved after ${goalCount} goals`);
                }
                // Root solved but pin mismatch — record as a guardrail violation.
                const v = { invariant: 1, type: 'STATEMENT_WEAKENED', message: 'statement hash differs from pin at commit' };
                this._emit({ type: 'statement_weakened', lemmaId, violation: v }, lemmaId);
                this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                fail('guardrails rejected the commit: STATEMENT_WEAKENED');
            }

            // Pin-context drift check (§3.1): the toolchain/norm context captured at pin
            // time must still match the live backend, or the proof was built against a
            // different Lean/mathlib than the one that will re-verify it.
            const currentPin = makePin(statement, this.backend.pin?.() ?? {});
            const pinStatus = checkPin(pin, currentPin);
            if (!pinStatus.ok && !pinStatus.drift) {
                const v = { invariant: 1, type: 'PIN_DRIFT', message: pinStatus.reason };
                this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                fail(`guardrails rejected the commit: PIN_DRIFT (${pinStatus.reason})`);
            }

            // Compose the proof tree, straighten to a script, splice into the pinned
            // statement, and kernel-verify the WHOLE source (§2.4, §2.5 invariant 2).
            const proofTree = egraph.extractProof();
            if (!proofTree) {
                fail('proof extraction failed');
            }
            const { script: proofScript } = straighten(proofTree);
            const source = buildProofSource(statement, proofScript);

            // Pre-flight check: the assembled source must be syntactically and type-level
            // valid before the full kernel verify. Catches bullet misalignment, unclosed
            // goals, and variable shadowing — compose errors that straighten missed.
            const preflight = await this.backend.check(source, { useWarmEnv: false });
            if (preflight.status !== 'verified') {
                const perr = preflight.error?.message ?? 'pre-flight check failed';
                console.log(`[loop] pre-flight failed lemma ${lemmaId.slice(0, 10)}… error: ${String(perr).slice(0, 300)}`);
                console.log(`[loop] assembled source:\n${source.slice(0, 600)}`);
                fail(`proof composition invalid: ${perr.slice(0, 200)}`, { sourceHead: source.slice(0, 400), preflightError: perr });
            }
            const verification = await this.backend.verifyProof(source, lemmaId);

            // Premise-lock gate (build_order.md §5.2): when locked, the proof may only
            // reference premises that were actually retrieved for this lemma.
            if (this.premiseLocked) {
                const violations = findPremiseLockViolations(proofScript, this.retriever?.corpus ?? [], [...this._retrievedPremises]);
                if (violations.length > 0) {
                    const v = { type: 'PREMISE_LOCK_VIOLATION', message: `proof references unretrieved premises: ${violations.join(', ')}`, names: violations };
                    this._emit({ type: 'premise_lock_trip', lemmaId, violation: v }, lemmaId);
                    this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                    fail('guardrails rejected the commit: PREMISE_LOCK_VIOLATION');
                }
            }

            // HARD guardrail gate at commit (§2.5): pin unchanged, kernel accepted, no leakage.
            const commit = Guardrails.assertLemmaCommit({
                pin: this.pins.get(lemmaId),
                statement,
                proofScript,
                verification
            });
            if (!commit.ok) {
                for (const v of commit.violations) {
                    if (v.type === 'STATEMENT_WEAKENED') {
                        this._emit({ type: 'statement_weakened', lemmaId, violation: v }, lemmaId);
                    }
                    this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                }
                // Surface the kernel error and the assembled source so the refine cohort can
                // diagnose what the kernel rejected — silent KERNEL_REJECTED is unactionable.
                const verr = verification.error?.message ?? verification.error ?? 'no kernel message';
                const srcHead = source.slice(0, 400);
                console.log(`[loop] KERNEL_REJECTED lemma ${lemmaId.slice(0, 10)}… verify-error: ${String(verr).slice(0, 200)}`);
                console.log(`[loop] assembled source head:\n${srcHead}`);
                fail(`guardrails rejected the commit: ${commit.violations.map(v => v.type).join(', ')}`, {
                    kernelError: String(verr),
                    sourceHead: srcHead
                });
            }

            // Run-level statement hash chain (§7): every verified lemma appends a tamper-evident
            // entry — sha256(prevHash || statementHash || proofHash || outcome).
            const prevHash = this.hashChain.length > 0 ? this.hashChain[this.hashChain.length - 1].hash : null;
            const statementHash = hashStatement(statement);
            const proofHash = hashStatement(proofScript);
            this.hashChain.push({
                prevHash,
                statementHash,
                proofHash,
                outcome: 'verified',
                hash: hashChainEntry(prevHash, statementHash, proofHash, 'verified')
            });

            const ms = Date.now() - start;
            this._emit({ type: 'lemma_verified', lemmaId, statement, proofScript, ms, goalCount }, lemmaId);

            const result = { statement, proofScript, verifiedAt: new Date().toISOString(), goalCount, ms };

            // Checkpoint: serialize graph state after each verified lemma (P2.2 resumability)
            // Mark node as cached before serializing so it's included in the checkpoint
            if (this.checkpointDir) {
                const node = this.graph.nodes.get(lemmaId);
                if (node) {
                    node.cached = true;
                    node.value = result;
                }
                const checkpointPath = path.join(this.checkpointDir, 'state.json');
                const serialized = this.graph.serialize();
                fs.writeFileSync(checkpointPath, JSON.stringify(serialized, null, 2));
                this._emit({ type: 'checkpoint_written', lemmaId, checkpointPath }, lemmaId);
            }

            return result;
        } catch (err) {
            // Exception-based failures (backend errors, timeouts, repl worker exits) must reach
            // the causal store too, or the predictor miner and audits lose the failure terminal.
            // fail() already emitted lemma_failed; guard so it isn't double-reported.
            if (!(err && err.lemmaFailedEmitted)) {
                const ms = Date.now() - start;
                this._emit({ type: 'lemma_failed', lemmaId, statement, ms, error: err?.message ?? String(err) }, lemmaId);
            }
            throw err;
        } finally {
            // Release the leased proof-session worker back to the backend pool.
            this.backend.endLemma?.(lemmaId);
        }
    }

    async _proposeTactic(goal, attempt, lemmaId = null, goalClassId = null) {
        const prompt = this._buildTacticPrompt(goal, attempt, lemmaId, goalClassId);
        return this._proposeTacticFromPrompt(prompt);
    }

    // Per-goal delegated recipes (architecture.md §5): pick a tactic for the current goal via the
    // named strategy, applying candidates through a counting backend. Returns
    // { ok, tactic, result, via, llmCalls, tacticCalls, lastError }.
    async _pickByRecipe(goal, lemmaId, goalClassId, triedTactics) {
        const countedLLM = this._countingLLM(this.llm);
        const countedBackend = this._countingBackend(this.backend);
        const N = this.swissN > 1 ? this.swissN : this.maxTacticsPerGoal;

        if (this.searchRecipe === 'bestofn') {
            const pick = await bestOfN(goal, countedBackend, countedLLM, N, this.predictors);
            return { ...pick, via: 'bestofn', llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: pick.ok ? null : 'no tactic accepted in best-of-N' };
        }

        if (this.searchRecipe === 'swiss') {
            this._emit({ type: 'swiss_tournament_start', lemmaId, goalClassId, N }, lemmaId);
            const swissResult = await bestOfNWithSwiss(goal, countedBackend, countedLLM, { N, predictors: this.predictors });
            if (swissResult.ok) {
                this._emit({ type: 'swiss_tournament_complete', lemmaId, goalClassId, winner: swissResult.tactic, rankingSize: swissResult.ranking.length }, lemmaId);
                return { ...swissResult, via: 'swiss', llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: null };
            }
            this._emit({ type: 'swiss_tournament_failed', lemmaId, goalClassId, rankingSize: swissResult.ranking.length }, lemmaId);
            return { ...swissResult, via: 'swiss', llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'no tactic accepted in tournament' };
        }

        // swiss+repulsion: candidates drawn through a RepulsionSampler seeded with every tactic
        // tried (and failed) so far in this lemma, ranked by swiss, applied in order.
        this._emit({ type: 'swiss_tournament_start', lemmaId, goalClassId, N, repulsion: true }, lemmaId);
        const sampler = new RepulsionSampler({ llm: countedLLM });
        const candidates = [];
        const seen = new Set();
        for (let i = 0; i < N; i++) {
            const t = await sampler.propose(`${formatGoalPrompt(goal)}\n\nPropose tactic:`, { tried: [...triedTactics] });
            if (t && !seen.has(t)) {
                seen.add(t);
                candidates.push(t);
            }
        }
        if (candidates.length === 0) {
            this._emit({ type: 'swiss_tournament_failed', lemmaId, goalClassId, rankingSize: 0, repulsion: true }, lemmaId);
            return { ok: false, via: 'swiss+repulsion', llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'no candidates sampled' };
        }
        const judge = buildPairwiseJudge(goal, { llm: countedLLM });
        const ranking = await swissRank(candidates, judge);
        let skipped = 0;
        const history = [];
        for (const { candidate } of ranking) {
            if (this.predictors?.rejects(tacticHead(candidate), history)) {
                skipped++;
                continue;
            }
            history.push(tacticHead(candidate));
            const result = await countedBackend.applyTactic(goal, candidate);
            if (result.status === 'ok') {
                this._emit({ type: 'swiss_tournament_complete', lemmaId, goalClassId, winner: candidate, rankingSize: ranking.length, repulsion: true }, lemmaId);
                return { ok: true, tactic: candidate, result, via: 'swiss+repulsion', skipped, llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: null };
            }
            triedTactics.push(candidate);
        }
        this._emit({ type: 'swiss_tournament_failed', lemmaId, goalClassId, rankingSize: ranking.length, repulsion: true }, lemmaId);
        return { ok: false, via: 'swiss+repulsion', skipped, llmCalls: countedLLM.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'all ranked candidates failed kernel' };
    }

    // Counting proxies (mirror bench/ablation.js): make delegated strategies' LLM/backend cost
    // visible to the loop's metrics and audit without touching their interfaces.
    _countingLLM(llm) {
        const counted = { ...llm };
        counted.llmCalls = 0;
        const complete = llm.complete.bind(llm);
        counted.complete = async (...args) => {
            counted.llmCalls++;
            return complete(...args);
        };
        return counted;
    }

    _countingBackend(backend) {
        const counted = { ...backend };
        counted.tacticCalls = 0;
        const applyTactic = backend.applyTactic.bind(backend);
        const extractGoals = backend.extractGoals.bind(backend);
        counted.applyTactic = async (goal, tactic) => {
            counted.tacticCalls++;
            return applyTactic(goal, tactic);
        };
        counted.extractGoals = async (statement) => extractGoals(statement);
        return counted;
    }

        async _proposeTacticFromPrompt(prompt) {
        const t0 = Date.now();
        try {
            const response = await this.llm.complete(prompt);
            const llmMs = Date.now() - t0;
            if (llmMs > 20000) console.log(`[loop] slow LLM call: ${(llmMs/1000).toFixed(1)}s`);
            let tactic = response.text?.trim();
            if (tactic) {
                // Extract the first Lean code-fence block (the LLM sometimes wraps output in
                // markdown with explanations — the first ``` lean ... ``` is the tactic text).
                const fence = tactic.match(/```\s*(?:lean4?|lean\s*4)?\s*[\r\n]*([\s\S]*?)```/i);
                if (fence) {
                    tactic = fence[1].trim();
                } else {
                    tactic = tactic.replace(/^```(?:lean)?\s*/i, '').replace(/```\s*$/, '').trim();
                }
                tactic = tactic.replace(/^`|`$/g, '').trim();
            }
            return {
                tactic: tactic || null,
                llmMs,
                promptTokens: response.usage?.promptTokens ?? null,
                completionTokens: response.usage?.completionTokens ?? null
            };
        } catch (err) {
            return { tactic: null, llmMs: Date.now() - t0, promptTokens: null, completionTokens: null };
        }
    }

    _buildTacticPrompt(goal, attempt, lemmaId = null, goalClassId = null) {
        if (this.retriever) {
            const premises = this.retriever.retrieve(goal, this.premiseTopK);
            for (const p of premises) this._retrievedPremises?.add(p.name);
            this._emit({ type: 'premises_retrieved', lemmaId, goalClassId, count: premises.length, names: premises.map(p => p.name) }, lemmaId);
            return buildPremisePrompt(goal, premises, { attempt, maxAttempts: this.maxTacticsPerGoal, premiseLocked: this.premiseLocked });
        }

        const contextStr = goal.context?.length > 0
            ? `\nContext:\n${goal.context.map(c => `  ${c.name} : ${c.type}`).join('\n')}`
            : '';

        return [
            {
                role: 'system',
                content: 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. Examples: "intro h", "omega", "simp [h]", "apply foo", "cases h".'
            },
            {
                role: 'user',
                content: `Goal:\n  ${goal.type}${contextStr}\n\nPropose ONE tactic (attempt ${attempt}/${this.maxTacticsPerGoal}):`
            }
        ];
    }

    async proveAll() {
        this._runStart = Date.now();
        const scheduler = new Scheduler(this.graph, {
            check: async (id, signal) => this._proveLemma(id, this.graph.nodes.get(id).computation.value, signal),
            concurrency: this.concurrency,
            timeoutMs: null, // No timeout: each operation is bounded
            priority: id => this.priority(id),
            maxFailures: null,
            onProgress: info => this._emit({ type: `scheduler_${info.stage}`, ...info }, info.nodeId)
        });

        scheduler.enqueue([...this.graph.nodes.keys()]);
        const outcome = await scheduler.run();
        this.lastOutcome = outcome;
        this._emit({ type: 'loop_finished', ok: outcome.ok, stopped: outcome.stopped, failures: [...outcome.failures.keys()] });

        // Generate audit packs for verified lemmas
        if (outcome.ok || outcome.results.size > 0) {
            const runId = `run_${Date.now()}`;
            const runsDir = path.join(process.cwd(), 'runs', runId);

            for (const [lemmaId, result] of outcome.results) {
                const statement = this.graph.nodes.get(lemmaId).computation.value;
                const deps = [...(this.graph.edges?.get(lemmaId) ?? [])];
                const lemmaEvents = this.store.events.filter(e => e.lemmaId === lemmaId);

                const pack = assembleAuditPack({
                    theorem: statement,
                    statementHash: lemmaId,
                    proofScript: result.proofScript,
                    deps,
                    events: lemmaEvents,
                    metrics: {
                        tacticsPerLemma: result.goalCount,
                        tacticSuccessRate: lemmaEvents.filter(e => e.type === 'tactic_applied').length / Math.max(1, lemmaEvents.filter(e => e.type === 'tactic_proposed').length)
                    },
                    guardrailReport: { ok: true, violations: [] }
                });

                const lemmaDir = path.join(runsDir, lemmaId.slice(0, 8));
                writeAuditPack(pack, lemmaDir);
            }

            this._emit({ type: 'audit_packs_written', runId, runsDir, count: outcome.results.size });
        }

        // Hermeticity check (§7): the run's statement hash chain must be intact end to end.
        outcome.hashChainOk = true;
        if (this.hashChain.length > 0) {
            const chain = verifyHashChain(this.hashChain);
            if (!chain.ok) {
                outcome.hashChainOk = false;
                this._emit({ type: 'guardrail_trip', lemmaId: null, violation: { type: 'HASH_CHAIN_BROKEN', message: chain.reason } }, null);
            }
        }

        // KPI summary (build_order.md §5.6, architecture.md §6.1): surface the full metrics
        // catalog so the bench and digest layers can report quantitatively, not just functionally.
        // Provenance (architecture.md §5.7): the model that produced this run is recorded so
        // telemetry is attributable when the model is switched.
        const wallMs = Date.now() - (this._runStart ?? Date.now());
        const metrics = computeMetrics(this.store.events);
        metrics.secondsPerTheorem = (metrics.verifiedLemmas > 0 ? wallMs / 1000 / metrics.verifiedLemmas : null);
        outcome.metrics = {
            ...metrics,
            llmCalls: this.llmCalls,
            tacticCalls: this.tacticCalls,
            wallMs,
            model: this.llm?.getModel?.() ?? null,
            provider: this.llm?.getProvider?.() ?? null
        };
        outcome.hashChain = this.hashChain; // run-level chain per verified lemma

        // Degeneracy monitors (architecture.md §6, optimization/patterns.js): pure analysis of
        // the run's own event stream — error clusters, same-failure cycles, guardrail spikes.
        if (this.monitor) {
            const patterns = analyzePatterns(this.store.events);
            for (const o of patterns.observations) {
                this._emit({ type: 'pattern_observation', severity: o.severity, pattern: o.type, count: o.count, message: o.message }, null);
            }
            outcome.patterns = patterns;
        }

        // GRPO harness (architecture.md §6): record episode batches from this run's outcomes.
        if (this.grpoHarness) {
            this.grpoHarness.record(this.store.events);
            outcome.grpo = this.grpoHarness.summary();
        }

        // Telemetry export (optimization/exporter.js): persist the causal stream + KPI summary.
        if (this.exportTo) {
            outcome.export = exportTelemetry({ file: this.exportTo, events: this.store.events, metrics: outcome.metrics, meta: { model: outcome.metrics.model, provider: outcome.metrics.provider } });
        }

        return outcome;
    }

    events() {
        return [...this.store.events];
    }

    // Resume from checkpoint (P2.2): load serialized graph state, mark cached lemmas as CACHED
    resume(checkpointPath) {
        if (!fs.existsSync(checkpointPath)) {
            throw new Error(`checkpoint not found: ${checkpointPath}`);
        }
        const serialized = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

        // Restore cached nodes
        for (const obj of serialized.objects) {
            const node = this.graph.nodes.get(obj.id);
            if (node) {
                node.cached = true;
                node.value = obj.value;
                node.pullCount = obj.pullCount;
            }
        }

        this._emit({ type: 'resumed_from_checkpoint', checkpointPath, cachedCount: serialized.objects.length });
        return serialized.objects.length;
    }

    getInfos() {
        return {
            lemmas: this.graph.nodes.size,
            llmCalls: this.llmCalls,
            tacticCalls: this.tacticCalls,
            hashChainLength: this.hashChain.length
        };
    }
}

// Extract the lemma/theorem name from a stored lemma statement for `exact <name>`.
function extractLemmaName(statement) {
    const m = String(statement ?? '').match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*)/);
    return m ? m[1] : 't';
}
