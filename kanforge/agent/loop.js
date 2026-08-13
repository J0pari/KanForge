// Tactic-level search loop (architecture.md §2.2, §4).
//
// Two-level structure:
// - Level 1: Lemma DAG (dependency-ordered dispatch via scheduler)
// - Level 2: Goal transposition graph (syntactic class identity with transposition merging;
//   the genuine e-graph in core/graph.js is a staged searchStructure alternative)
//
// For each lemma, the loop works backwards from the target goal to simpler subgoals:
// 1. Pick the first open goal equivalence class from the e-graph (frontier order — the repl
//    tactic API attacks the head goal of a proof state)
// 2. Ask the LLM for a proposal bounded by PROPOSAL_SPEC (one tactic atom; §4.1)
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
import { GoalTranspositionGraph, lexicalNormalize } from '../core/transpositionGraph.js';
import { buildProofSource } from '../core/state.js';
import { Patch } from '../core/patch.js';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';
import { computeMetrics } from '../optimization/metrics.js';
import { assembleAuditPack, writeAuditPack } from '../digest/auditPack.js';
import { classifyError, buildRepairPrompt } from './repair.js';
import { formatGoalPrompt, buildTacticPrompt } from './prompts.js';
import { ProposalEngine } from './proposalEngine.js';
import { runCommitGate } from './commitGate.js';
import { bestOfNWithSwiss, buildPairwiseJudge, swissRank } from '../search/swiss.js';
import { bestOfN } from '../search/bestofn.js';
import { BestFirstSearch } from '../search/bfs.js';
import { MCGS } from '../search/mcgs.js';
import { RepulsionSampler } from '../search/repulsion.js';
import { TacticMenuAugmentingLLM, splicePrompt } from '../search/tacticMenu.js';
import { tacticHead } from '../optimization/causal.js';
import { analyzePatterns } from '../optimization/patterns.js';
import { exportTelemetry } from '../optimization/exporter.js';
import { TestTimePolicy } from '../optimization/ttrl.js';
import { GRPOHarness } from '../optimization/grpo.js';
import { PremiseRetriever, buildPremisePrompt } from '../search/premises.js';
import fs from 'node:fs';
import path from 'node:path';

// Search recipes the loop can run (architecture.md §5 integration contract). Per-goal recipes
// dispatch inside the frontier loop; whole-graph recipes delegate the entire e-graph search and
// share the commit gate.
export const LOOP_SEARCH_RECIPES = ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'mcgs'];

export class TacticLoop {
    constructor({ backend, llm, concurrency = 2, maxTacticsPerGoal = 8, maxGoalsPerLemma = 100, onEvent = null, bus = null, store = null, checkpointDir = null, useSwiss = false, swissN = 8, premises = null, premiseLocked = false, premiseTopK = 5, searchRecipe = 'loop', repulsion = false, predictors = null, monitor = false, exportTo = null, ttrl = false, grpo = false, lemmaStore = null, dataset = null, menu = false, exemplars = false, exemplarLimit = 3, maxLlmCalls = null, writeAuditPacks = true, repair = true, predictorExploration = 0.02 } = {}) {
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
        this.dataset = dataset ?? null;
        this.menu = menu === true;
        this.exemplars = exemplars === true;
        this.exemplarLimit = exemplarLimit;
        this.maxLlmCalls = maxLlmCalls ?? null; // hard LLM-call budget per lemma (ablation cost-normalization)
        this.writeAuditPacks = writeAuditPacks !== false; // digest/artifacts are the record for driven runs
        this.repair = repair !== false; // error-driven repair toggle (registry component)
        this.predictorSkips = 0; // kernel-budget saved by the predictor pre-filter (per lemma, summed)
        this.predictorExploration = predictorExploration; // §6: counterfactual re-tests of rejected tactics

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

        let proposal = null;
        try {
            // Level 2: Goal e-graph. extractGoals opens the backend proof session.
            const graph = new GoalTranspositionGraph({ normalizer: lexicalNormalize });
            // Per-lemma proposal engine (§4.1): the tactic menu wraps the raw llm with this
            // lemma's statement, and the ProposalEngine owns the budget-walled, write-through
            // counting client every proposal path uses — one accounting point, one budget wall.
            const proposalLLM = this.menu ? new TacticMenuAugmentingLLM(this.llm, { statement }) : this.llm;
            proposal = new ProposalEngine({
                llm: proposalLLM,
                maxLlmCalls: this.maxLlmCalls,
                predictorExploration: this.predictorExploration,
                onEvent: e => this._emit({ ...e, lemmaId }, lemmaId)
            });
            let rootGoals;
            try {
                rootGoals = await this.backend.extractGoals(statement);
            } catch (err) {
                fail(`could not extract root goal: ${err?.message ?? String(err)}`, { extractFailed: true });
            }
            if (!rootGoals || rootGoals.length === 0) {
                fail('could not extract root goal (empty goal list)', { extractFailed: true });
            }

            const rootId = graph.addGoal(rootGoals[0]);
            graph.setRoot(rootGoals[0]);

            // Lemma-store reuse (§2.8, §0.3): if a previously-proven lemma's conclusion matches
            // the root goal, inline the lemma's declaration + proof into the source and prove by
            // `exact <name>` — the kernel re-verifies the whole source, so retrieval never
            // bypasses verification and cross-problem reuse works in any fresh session.
            if (this.lemmaStore && !graph.isRootSolved()) {
                const stored = this.lemmaStore.findByGoal(rootGoals[0].type);
                if (stored) {
                    const storedSource = stored.statement.replace(/:=\s*by\s+sorry\s*$/, `:= ${stored.proofScript}`);
                    const currentDecl = statement.replace(/:=\s*by\s+sorry\s*$/, `:= by exact ${extractLemmaName(stored.statement)}`);
                    const combined = `${storedSource}\n\n${currentDecl}`;
                    const reuseCheck = await this.backend.check(combined, { useWarmEnv: false });
                    if (reuseCheck.status === 'verified') {
                        const rootClass = graph.classes.get(graph.rootId);
                        if (rootClass) {
                            rootClass.state = 'SOLVED';
                            rootClass._directProof = `by exact ${extractLemmaName(stored.statement)}`;
                        }
                        console.log(`[${ts()}] [loop] lemma ${lemmaId.slice(0,10)}… PROVED by store reuse (${extractLemmaName(stored.statement)})`);
                        this._emit({ type: 'store_reuse', lemmaId, lemma: extractLemmaName(stored.statement) }, lemmaId);
                    } else {
                        console.log(`[${ts()}] [loop] store reuse rejected: ${reuseCheck.error?.message?.slice(0,100) ?? 'unknown'}`);
                    }
                }
            }

            let goalCount = 0;
            if (this.searchRecipe === 'bfs' || this.searchRecipe === 'mcgs') {
                // Whole-graph delegation (architecture.md §5 integration contract): the strategy
                // owns goal selection AND proposals over the e-graph; the loop keeps the commit
                // gate below. LLM calls flow through the proposal engine (counted + budget-walled);
                // backend calls are counted via the proxy so tacticCalls stays honest.
                const countedBackend = this._countingBackend(this.backend);
                const searcher = this.searchRecipe === 'mcgs'
                    ? new MCGS({ backend: countedBackend, llm: proposal.llm, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors })
                    : new BestFirstSearch({ backend: countedBackend, llm: proposal.llm, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors });
                this._emit({ type: 'search_start', lemmaId, recipe: this.searchRecipe, budget: this.maxGoalsPerLemma }, lemmaId);
                const searchResult = await searcher.search(graph, this.searchRecipe === 'mcgs' ? { rollouts: this.maxGoalsPerLemma } : { maxExpansions: this.maxGoalsPerLemma });
                goalCount = searchResult.expansions ?? searchResult.rollouts ?? 0;
                this.tacticCalls += countedBackend.tacticCalls;
                this.predictorSkips += searcher.skipped ?? 0;
                this._emit({ type: 'search_complete', lemmaId, recipe: this.searchRecipe, solved: graph.isRootSolved(), llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, skipped: searcher.skipped ?? 0 }, lemmaId);
                if (!graph.isRootSolved()) {
                    fail(`search recipe ${this.searchRecipe} exhausted budget ${this.maxGoalsPerLemma} without solving`);
                }
            } else {
                const triedTactics = [];
                goalCount = 1;
                while (!graph.isRootSolved() && goalCount < this.maxGoalsPerLemma) {
                    if (signal?.aborted) break;
                    if (proposal.budgetExhausted) {
                        this._emit({ type: 'budget_exhausted', lemmaId, budget: this.maxLlmCalls, llmCalls: proposal.llmCalls }, lemmaId);
                        break;
                    }

                    // Frontier order: the first open class is the head goal of the current
                    // proof state; its freshest concrete goal carries the live proofState.
                    const openGoals = graph.getOpenGoals();
                    if (openGoals.length === 0) break;

                    const currentGoalClass = openGoals[0];
                    const goal = graph.currentGoal(currentGoalClass.id);
                    this._emit({ type: 'goal_selected', lemmaId, goalClassId: currentGoalClass.id, goal }, lemmaId);
                    const ctx = (goal.context ?? []).map(c => `${c.name}: ${c.type}`).join('; ');
                    console.log(`[${ts()}] [loop] goal_selected ${currentGoalClass.id.slice(0,10)}… ⊢ ${goal.type.slice(0, 120)}${ctx ? ` | ctx: ${ctx.slice(0, 200)}` : ''}`);

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
                            if (proposal.budgetExhausted) break;

                            // Lemma-store lookup: if a previously-proven lemma's conclusion
                            // matches the current goal type (after semantic normalization),
                            // skip the LLM entirely and use `exact <lemma>`. A store hit costs
                            // zero LLM calls — only real model calls go through the engine.
                            const stored = this.lemmaStore?.findByGoal(goal.type);
                            const proposed = stored
                                ? { tactic: `exact ${extractLemmaName(stored.statement)}`, llmMs: 0, promptTokens: 0, completionTokens: 0 }
                                : await proposal.propose(this._buildTacticPrompt(goal, attempt, lemmaId, currentGoalClass.id, predictorHistory));
                            const tactic = proposed?.tactic;
                            if (!tactic) {
                                this._emit({ type: 'llm_error', lemmaId, goalClassId: currentGoalClass.id, attempt, error: proposed?.error ?? 'LLM returned no tactic', errorKind: proposed?.errorKind ?? 'abstention' }, lemmaId);
                                continue;
                            }

                            this._emit({ type: 'tactic_proposed', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, llmMs: proposed.llmMs, promptTokens: proposed.promptTokens, completionTokens: proposed.completionTokens }, lemmaId);
                            console.log(`[${ts()}] [loop] goal ${currentGoalClass.id.slice(0,10)}… (${goal.type.slice(0,90)}) attempt ${attempt}/${maxAttempts}: "${tactic}"`);

                            // Feedback interconnection (architecture.md §0.3): a causal predictor
                            // that knows a tactic head leads to kernel rejection can veto it before
                            // the expensive call — zero kernel spend on a predicted failure. The
                            // veto is NOT permanent (§6): with probability `predictorExploration`
                            // the tactic is tried anyway, producing the counterfactual evidence
                            // that keeps the predictor from self-confirming.
                            const head = tacticHead(tactic);
                            if (this.predictors?.rejects(head, predictorHistory)) {
                                if (proposal.shouldExplore(tactic)) {
                                    this._emit({ type: 'predictor_explored', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, head }, lemmaId);
                                } else {
                                    this.predictorSkips++;
                                    this._emit({ type: 'tactic_predicted_failure', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, head }, lemmaId);
                                    continue;
                                }
                            }
                            predictorHistory.push(head);

                            this.tacticCalls++;
                            const result = await this.backend.applyTactic(goal, tactic);
                            lastResult = result;

                            if (result.status === 'error') {
                                console.log(`[${ts()}] [loop]   tactic failed: ${String(result.error?.message ?? 'no message').slice(0, 150)}`);
                                this._emit({ type: 'tactic_failed', lemmaId, goalClassId: currentGoalClass.id, attempt, tactic, error: result.error?.message ?? 'tactic failed' }, lemmaId);
                                continue;
                            }

                            const patch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: tactic, scope: 'goal', meta: { attempt, newGoals: result.newGoals } });
                            const record = graph.applyPatch(patch);
                            this._emit({ type: 'tactic_applied', lemmaId, goalClassId: currentGoalClass.id, tactic, goalType: goal.type, newGoalCount: result.newGoals?.length ?? 0 }, lemmaId);
                            for (const subgoal of record.created) {
                                this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                            }

                            if (isGoalSolved(result)) {
                                solved = true;
                                this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic, attempt, via: 'proposal', goalType: goal.type }, lemmaId);
                                break;
                            }

                            solved = true; // decomposed into subgoals; they join the frontier
                            break;
                        }
                    } else {
                        // Per-goal delegated recipes: bestofn / swiss / swiss+repulsion
                        // (LLM calls counted by the proposal engine; kernel calls by the proxy).
                        const pick = await this._pickByRecipe(goal, lemmaId, currentGoalClass.id, triedTactics, proposal);
                        this.tacticCalls += pick.tacticCalls ?? 0;
                        this.predictorSkips += pick.skipped ?? 0;

                        if (pick.ok) {
                            const dpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: pick.tactic, scope: 'goal', meta: { via: pick.via, newGoals: pick.result.newGoals } });
                            const record = graph.applyPatch(dpatch);
                            this._emit({ type: 'tactic_applied', lemmaId, goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via, goalType: goal.type, newGoalCount: pick.result.newGoals?.length ?? 0 }, lemmaId);
                            for (const subgoal of record.created) {
                                this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                            }
                            solved = true;
                            lastResult = pick.result;
                            if (isGoalSolved(pick.result)) {
                                this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via, goalType: goal.type }, lemmaId);
                            }
                        } else {
                            lastResult = { error: { message: pick.lastError ?? 'no tactic proposed' } };
                            this._emit({ type: 'recipe_failed', lemmaId, goalClassId: currentGoalClass.id, recipe: this.searchRecipe, lastError: lastResult.error.message }, lemmaId);
                        }
                    }

                    if (!solved && this.repair) {
                        // P3.1: Attempt repair before giving up
                        const lastError = lastResult?.error?.message ?? 'unknown error';
                        const errorType = classifyError(lastError);
                        this._emit({ type: 'repair_attempted', lemmaId, goalClassId: currentGoalClass.id, errorType, lastError }, lemmaId);

                        const repairPrompt = buildRepairPrompt(goal, lastError, lastResult?.tactic);
                        const repaired = await proposal.propose(repairPrompt);
                        const repairedTactic = repaired?.tactic;

                        if (repairedTactic) {
                            console.log(`[${ts()}] [loop]   repair attempt: "${String(repairedTactic).slice(0, 120)}"`);
                            this._emit({ type: 'repair_proposed', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, llmMs: repaired.llmMs, promptTokens: repaired.promptTokens, completionTokens: repaired.completionTokens }, lemmaId);

                            // Multi-line repair: the LLM produced a full proof script. Verify it
                            // as a complete source — bypass applyTactic entirely.
                            if (isMultiLineProof(repairedTactic)) {
                                const fullSource = buildProofSource(statement, `by\n${repairedTactic}`);
                                const check = await this.backend.check(fullSource, { useWarmEnv: false });
                                if (check.status === 'verified') {
                                    // Bypass the per-goal loop: the LLM gave us the full proof.
                                    // Mark the graph's root as solved and store the proof for
                                    // the commit gate to use directly.
                                    const rootClass = graph.classes.get(graph.rootId);
                                    if (rootClass) {
                                        rootClass.state = 'SOLVED';
                                        rootClass._directProof = `by\n${repairedTactic}`;
                                    }
                                    solved = true;
                                    lastResult = { status: 'ok', newGoals: [] };
                                    this._emit({ type: 'repair_applied', lemmaId, goalClassId: currentGoalClass.id, tactic: '(multi-line proof verified)' }, lemmaId);
                                    continue;
                                }
                                console.log(`[${ts()}] [loop]   multi-line repair check failed: ${check.error?.message?.slice(0,120) ?? 'unknown'}`);
                            }

                            this.tacticCalls++;
                            const repairResult = await this.backend.applyTactic(goal, repairedTactic);

                            if (repairResult.status === 'ok') {
                                const rpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: repairedTactic, scope: 'goal', meta: { via: 'repair', newGoals: repairResult.newGoals } });
                                const record = graph.applyPatch(rpatch);
                                this._emit({ type: 'repair_applied', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic }, lemmaId);
                                for (const subgoal of record.created) {
                                    this._emit({ type: 'subgoal_created', lemmaId, subgoal }, lemmaId);
                                }
                                solved = true;
                                lastResult = repairResult;

                                if (isGoalSolved(repairResult)) {
                                    this._emit({ type: 'goal_solved', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, via: 'repair', goalType: goal.type }, lemmaId);
                                }
                            } else {
                                console.log(`[${ts()}] [loop]   repair failed: ${String(repairResult.error?.message ?? 'no message').slice(0, 150)}`);
                                this._emit({ type: 'repair_failed', lemmaId, goalClassId: currentGoalClass.id, tactic: repairedTactic, error: repairResult.error?.message }, lemmaId);
                            }
                        }

                        if (!solved) {
                            const attemptsLabel = this.searchRecipe === 'loop' ? maxAttempts : this.maxTacticsPerGoal;
                            console.log(`[${ts()}] [loop] goal class ${currentGoalClass.id.slice(0,10)}… UNRESOLVED after ${attemptsLabel} attempts + repair (goal: ${goal.type.slice(0, 120)})`);
                            graph.markFailed(currentGoalClass.id);
                        }
                    }

                    goalCount += lastResult?.newGoals?.length ?? 0;
                }
            }

            // All per-goal attempts exhausted without solving the root. Try one lemma-level
            // repair: ask the LLM for a complete proof of the full statement. If the kernel
            // accepts a multi-line proof, skip the rest of the commit path and mark solved.
            if (this.repair && !graph.isRootSolved() && !proposal.budgetExhausted) {
                console.log(`[${ts()}] [loop] lemma ${lemmaId.slice(0,10)}… per-goal exhausted, trying lemma-level repair`);
                const resp = await proposal.propose(buildLemmarepairPrompt(statement));
                const proof = resp?.tactic;
                if (proof && isMultiLineProof(proof)) {
                    const fullSource = buildProofSource(statement, `by\n${proof}`);
                    const lemmaCheck = await this.backend.check(fullSource, { useWarmEnv: false });
                    if (lemmaCheck.status === 'verified') {
                        console.log(`[${ts()}] [loop] lemma-level repair ACCEPTED`);
                        const rootClass = graph.classes.get(graph.rootId);
                        if (rootClass) {
                            rootClass.state = 'SOLVED';
                            rootClass._directProof = `by\n${proof}`;
                        }
                    } else {
                        console.log(`[${ts()}] [loop] lemma-level repair rejected: ${lemmaCheck.error?.message?.slice(0,120) ?? 'unknown'}`);
                    }
                }
            }

            const pin = this.pins.get(lemmaId);
            if (!isLemmaProved(graph, hashStatement(statement), pin?.statementHash ?? '')) {
                if (!graph.isRootSolved()) {
                    fail(`root goal not solved after ${goalCount} goals`);
                }
                // Root solved but pin mismatch — record as a guardrail violation.
                const v = { invariant: 1, type: 'STATEMENT_WEAKENED', message: 'statement hash differs from pin at commit' };
                this._emit({ type: 'statement_weakened', lemmaId, violation: v }, lemmaId);
                this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                fail('guardrails rejected the commit: STATEMENT_WEAKENED');
            }

            // Commit gate (§2.5, commitGate.js): pin-drift check, proof assembly (tree →
            // script → full source), pre-flight, whole-source kernel verify, premise lock, and
            // the HARD guardrail gate (the leakage scan covers the complete source). The gate
            // makes no LLM calls and returns a typed outcome the loop maps to its event stream.
            const rootClass = graph.classes.get(graph.rootId);
            const gate = await runCommitGate({
                backend: this.backend,
                statement,
                lemmaId,
                pin,
                currentPin: makePin(statement, this.backend.pin?.() ?? {}),
                checkPin,
                graph,
                directProof: rootClass?._directProof ?? null,
                premiseLocked: this.premiseLocked,
                retriever: this.retriever,
                retrievedPremises: this._retrievedPremises
            });

            if (!gate.ok) {
                if (gate.kind === 'pin_drift') {
                    const v = { invariant: 1, type: 'PIN_DRIFT', message: gate.message };
                    this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                    fail(`guardrails rejected the commit: PIN_DRIFT (${gate.message})`);
                }
                if (gate.kind === 'premise_lock') {
                    const v = { type: 'PREMISE_LOCK_VIOLATION', message: gate.message, names: gate.names };
                    this._emit({ type: 'premise_lock_trip', lemmaId, violation: v }, lemmaId);
                    this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                    fail('guardrails rejected the commit: PREMISE_LOCK_VIOLATION');
                }
                if (gate.kind === 'preflight_failed') {
                    console.log(`[${ts()}] [loop] pre-flight failed lemma ${lemmaId.slice(0, 10)}… error: ${String(gate.preflightError ?? gate.message).slice(0, 300)}`);
                    console.log(`[${ts()}] [loop] assembled source:\n${(gate.sourceHead ?? '').slice(0, 600)}`);
                    fail(gate.message, { sourceHead: gate.sourceHead, preflightError: gate.preflightError });
                }
                if (gate.kind === 'guardrails') {
                    for (const v of gate.violations) {
                        if (v.type === 'STATEMENT_WEAKENED') {
                            this._emit({ type: 'statement_weakened', lemmaId, violation: v }, lemmaId);
                        }
                        this._emit({ type: 'guardrail_trip', lemmaId, violation: v }, lemmaId);
                    }
                    // Surface the kernel error and the assembled source so the refine cohort can
                    // diagnose what the kernel rejected — silent KERNEL_REJECTED is unactionable.
                    const verr = gate.kernelError ?? 'no kernel message';
                    console.log(`[${ts()}] [loop] KERNEL_REJECTED lemma ${lemmaId.slice(0, 10)}… verify-error: ${String(verr).slice(0, 200)}`);
                    console.log(`[${ts()}] [loop] assembled source head:\n${gate.sourceHead ?? ''}`);
                    fail(`guardrails rejected the commit: ${gate.message}`, {
                        kernelError: String(verr),
                        sourceHead: gate.sourceHead
                    });
                }
                fail(gate.message ?? 'commit gate failed');
            }

            // Run-level statement hash chain (§7): every verified lemma appends a tamper-evident
            // entry — sha256(prevHash || statementHash || proofHash || outcome).
            const prevHash = this.hashChain.length > 0 ? this.hashChain[this.hashChain.length - 1].hash : null;
            this.hashChain.push({
                prevHash,
                statementHash: gate.hashEntry.statementHash,
                proofHash: gate.hashEntry.proofHash,
                outcome: 'verified',
                hash: hashChainEntry(prevHash, gate.hashEntry.statementHash, gate.hashEntry.proofHash, 'verified')
            });

            const ms = Date.now() - start;
            this._emit({ type: 'lemma_verified', lemmaId, statement, proofScript: gate.proofScript, ms, goalCount }, lemmaId);

            const result = { statement: gate.result.statement, proofScript: gate.proofScript, verifiedAt: gate.result.verifiedAt, goalCount, ms };

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
            // Accumulate this lemma's engine-counted LLM calls into the loop total (write-through
            // accounting: the engine counted every call once; the loop just adds it up).
            if (proposal) this.llmCalls += proposal.llmCalls;
            // Release the leased proof-session worker back to the backend pool.
            this.backend.endLemma?.(lemmaId);
        }
    }

    // Per-goal delegated recipes (architecture.md §5): pick a tactic for the current goal via the
    // named strategy, applying candidates through a counting backend. LLM calls flow through the
    // proposal engine's walled client (counted + budget-enforced); the engine's counter is the
    // single accounting point. Returns { ok, tactic, result, via, llmCalls, tacticCalls,
    // lastError }.
    async _pickByRecipe(goal, lemmaId, goalClassId, triedTactics, proposal) {
        const countedBackend = this._countingBackend(this.backend);
        const N = this.swissN > 1 ? this.swissN : this.maxTacticsPerGoal;
        // Preference-pair hook (§6.2): every judged pair is a preference record — persisted to
        // the dataset at zero extra LLM cost (the judgment was already computed for ranking).
        const onOutcome = ({ tacticA, tacticB, result }) => {
            this.dataset?.addPreference({ goalShape: goal.type, tacticA, tacticB, winner: result });
        };

        if (this.searchRecipe === 'bestofn') {
            const pick = await bestOfN(goal, countedBackend, proposal.llm, N, this.predictors);
            return { ...pick, via: 'bestofn', llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: pick.ok ? null : 'no tactic accepted in best-of-N' };
        }

        if (this.searchRecipe === 'swiss') {
            this._emit({ type: 'swiss_tournament_start', lemmaId, goalClassId, N }, lemmaId);
            const swissResult = await bestOfNWithSwiss(goal, countedBackend, proposal.llm, { N, predictors: this.predictors, onOutcome });
            if (swissResult.ok) {
                this._emit({ type: 'swiss_tournament_complete', lemmaId, goalClassId, winner: swissResult.tactic, rankingSize: swissResult.ranking.length }, lemmaId);
                return { ...swissResult, via: 'swiss', llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: null };
            }
            this._emit({ type: 'swiss_tournament_failed', lemmaId, goalClassId, rankingSize: swissResult.ranking.length }, lemmaId);
            return { ...swissResult, via: 'swiss', llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'no tactic accepted in tournament' };
        }

        // swiss+repulsion: candidates drawn through a RepulsionSampler seeded with every tactic
        // tried (and failed) so far in this lemma, ranked by swiss, applied in order.
        this._emit({ type: 'swiss_tournament_start', lemmaId, goalClassId, N, repulsion: true }, lemmaId);
        const sampler = new RepulsionSampler({ llm: proposal.llm });
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
            return { ok: false, via: 'swiss+repulsion', llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'no candidates sampled' };
        }
        const judge = buildPairwiseJudge(goal, { llm: proposal.llm });
        const ranking = await swissRank(candidates, judge, { onOutcome });
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
                return { ok: true, tactic: candidate, result, via: 'swiss+repulsion', skipped, llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: null };
            }
            triedTactics.push(candidate);
        }
        this._emit({ type: 'swiss_tournament_failed', lemmaId, goalClassId, rankingSize: ranking.length, repulsion: true }, lemmaId);
        return { ok: false, via: 'swiss+repulsion', skipped, llmCalls: proposal.llmCalls, tacticCalls: countedBackend.tacticCalls, lastError: 'all ranked candidates failed kernel' };
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

    _buildTacticPrompt(goal, attempt, lemmaId = null, goalClassId = null, history = []) {
        const hints = this._buildHints(goal, history);
        if (this.retriever) {
            const premises = this.retriever.retrieve(goal, this.premiseTopK);
            for (const p of premises) this._retrievedPremises?.add(p.name);
            this._emit({ type: 'premises_retrieved', lemmaId, goalClassId, count: premises.length, names: premises.map(p => p.name) }, lemmaId);
            const prompt = buildPremisePrompt(goal, premises, { attempt, maxAttempts: this.maxTacticsPerGoal, premiseLocked: this.premiseLocked });
            return hints ? splicePrompt(prompt, hints) : prompt;
        }

        const prompt = buildTacticPrompt(goal, attempt, this.maxTacticsPerGoal);
        return hints ? splicePrompt(prompt, hints) : prompt;
    }

    // Inference-only guidance block (§6.2): exemplars from the lemma store (ranked by goal-shape
    // similarity — pointing) and predictor warnings (patterns whose prefix matches the recent
    // history — steering). Hypercompressed, kernel-grounded, injected before the "Propose"
    // imperative. Returns null when neither source has anything to say.
    _buildHints(goal, history = []) {
        const lines = [];
        if (this.exemplars && this.lemmaStore) {
            const similar = this.lemmaStore.findSimilar(goal.type, { limit: this.exemplarLimit });
            if (similar.length) {
                lines.push('Similar proven lemmas:');
                for (const s of similar) {
                    const shape = (s.normalizedGoalShape ?? 'lemma').slice(0, 70);
                    const head = s.tacticTrajectory?.[0] ?? null;
                    lines.push(`- \`${shape}\`${head ? ` — started with \`${head}\`` : ''}`);
                }
            }
        }
        const warnings = this.predictors?.warnings?.(history) ?? [];
        if (warnings.length) {
            if (lines.length) lines.push('');
            lines.push('Avoid (historically failed):');
            for (const pattern of warnings) {
                lines.push(`- after ${pattern.slice(0, -1).join(' → ')}, avoid proposing \`${pattern[pattern.length - 1]}\``);
            }
        }
        return lines.length ? lines.join('\n') : null;
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

        // Generate audit packs for verified lemmas (opt-out for driven runs — the development
        // digest + per-lemma artifacts are the publication record there).
        if (this.writeAuditPacks && (outcome.ok || outcome.results.size > 0)) {
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
            predictorSkips: this.predictorSkips,
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

// Timestamped log prefix — the loop's console.log calls need timestamps so a long run's
// liveness and timing are inspectable from the log alone.
export function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// True when the LLM response is a multi-line proof block (not a single tactic).
// Detects: multiple lines with `intro`, `rcases`, `exact`, `rw`, `apply` patterns.
function isMultiLineProof(tactic) {
    const s = String(tactic ?? '').trim();
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.length >= 2 && lines.some(l => /^\s*(intro|rcases|exact|rw|apply|have|refine|by_contra|induction|cases|constructor|simp|omega|ring|linarith|norm_num|positivity|nlinarith|field_simp|abel|tauto|decide|native_decide|use|obtain|calc|·|\.$)/.test(l));
}

// Lemma-level repair prompt: give the LLM the full statement (with imports) and ask for a
// complete proof. Used after per-goal search exhausts its budget — one restoration attempt.
function buildLemmarepairPrompt(statement) {
    return [
        { role: 'system', content: 'You are a Lean 4 proof expert. Given a theorem statement, produce a complete proof script. Return ONLY the proof (the text between `:= by` and the end), no markdown, no explanation. Use the tactics: intro, rcases, rw, exact, apply, have, omega, ring, norm_num, positivity, simp, linarith, nlinarith, field_simp, abel, tauto, constructor, cases, induction, refine, use, obtain, calc, native_decide, decide. One tactic per line.' },
        { role: 'user', content: `Prove this theorem:\n\n${statement}` }
    ];
}
