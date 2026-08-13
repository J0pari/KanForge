// SearchEngine (architecture.md §4 role split): the per-lemma search — goal-selection, recipe
// dispatch (inline loop / bestofn / swiss / swiss+repulsion / bfs / mcgs), store-hit proposals,
// predictor pre-filter with exploration, error-driven repair, and the lemma-level restoration
// attempt. The engine owns NO verification (the commit gate does that) and NO session (the
// ProofSession does that); it reads and mutates the goal-state graph behind the GoalStateGraph
// contract. LLM accounting flows through the per-lemma ProposalEngine (single counting point).
import { ProposalEngine } from './proposalEngine.js';
import { formatGoalPrompt, buildTacticPrompt } from './prompts.js';
import { classifyError, buildRepairPrompt } from './repair.js';
import { buildProofSource } from '../core/state.js';
import { Patch } from '../core/patch.js';
import { isGoalSolved } from './solve.js';
import { TacticMenuAugmentingLLM, splicePrompt } from '../search/tacticMenu.js';
import { bestOfNWithSwiss, buildPairwiseJudge, swissRank } from '../search/swiss.js';
import { bestOfN } from '../search/bestofn.js';
import { BestFirstSearch } from '../search/bfs.js';
import { MCGS } from '../search/mcgs.js';
import { RepulsionSampler } from '../search/repulsion.js';
import { tacticHead } from '../optimization/causal.js';
import { buildPremisePrompt } from '../search/premises.js';
import { extractLemmaName } from './reuseEngine.js';

// Timestamped log prefix.
export function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// True when the LLM response is a multi-line proof block (not a single tactic).
function isMultiLineProof(tactic) {
    const s = String(tactic ?? '').trim();
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.length >= 2 && lines.some(l => /^\s*(intro|rcases|exact|rw|apply|have|refine|by_contra|induction|cases|constructor|simp|omega|ring|linarith|norm_num|positivity|nlinarith|field_simp|abel|tauto|decide|native_decide|use|obtain|calc|·|\.$)/.test(l));
}

// Lemma-level repair prompt: the full statement (with imports) and a request for a complete
// proof. Used after per-goal search exhausts its budget — one restoration attempt.
function buildLemmarepairPrompt(statement) {
    return [
        { role: 'system', content: 'You are a Lean 4 proof expert. Given a theorem statement, produce a complete proof script. Return ONLY the proof (the text between `:= by` and the end), no markdown, no explanation. Use the tactics: intro, rcases, rw, exact, apply, have, omega, ring, norm_num, positivity, simp, linarith, nlinarith, field_simp, abel, tauto, constructor, cases, induction, refine, use, obtain, calc, native_decide, decide. One tactic per line.' },
        { role: 'user', content: `Prove this theorem:\n\n${statement}` }
    ];
}

export class SearchEngine {
    constructor({ backend, llm, menu = false, maxLlmCalls = null, predictorExploration = 0.02, searchRecipe = 'loop', maxTacticsPerGoal = 8, maxGoalsPerLemma = 100, swissN = 8, repulsion = false, predictors = null, dataset = null, lemmaStore = null, retriever = null, premiseLocked = false, premiseTopK = 5, exemplars = false, exemplarLimit = 3, ttrlPolicy = null, repair = true, store = null, emit }) {
        this.backend = backend;
        this.llm = llm;
        this.menu = menu;
        this.maxLlmCalls = maxLlmCalls;
        this.predictorExploration = predictorExploration;
        this.searchRecipe = searchRecipe;
        this.maxTacticsPerGoal = maxTacticsPerGoal;
        this.maxGoalsPerLemma = maxGoalsPerLemma;
        this.swissN = swissN;
        this.repulsion = repulsion;
        this.predictors = predictors;
        this.dataset = dataset;
        this.lemmaStore = lemmaStore;
        this.retriever = retriever;
        this.premiseLocked = premiseLocked;
        this.premiseTopK = premiseTopK;
        this.exemplars = exemplars;
        this.exemplarLimit = exemplarLimit;
        this.ttrlPolicy = ttrlPolicy;
        this.repair = repair;
        this.store = store; // the run's event store (ttrl observes it)
        this.emit = emit ?? (() => {});
    }

    // Run the search for one lemma. Throws the loop's fail-error contract (lemma_failed is
    // emitted by `fail` before the throw) — the loop's catch/finally handles the session.
    async run({ statement, lemmaId, graph, signal = null, fail }) {
        // Lemma-scoped events carry lemmaId IN the event (the loop's call sites always did) and
        // as the causal-chain key.
        const emit = (event) => this.emit({ lemmaId, ...event }, lemmaId);
        // Per-lemma proposal engine (§4.1): the tactic menu wraps the raw llm; the engine owns
        // the budget-walled, write-through counting client every proposal path uses.
        const proposalLLM = this.menu ? new TacticMenuAugmentingLLM(this.llm, { statement }) : this.llm;
        const proposal = new ProposalEngine({
            llm: proposalLLM,
            maxLlmCalls: this.maxLlmCalls,
            predictorExploration: this.predictorExploration,
            onEvent: e => this.emit({ ...e, lemmaId }, lemmaId)
        });

        let tacticCalls = 0;
        let predictorSkips = 0;
        const retrievedPremises = new Set();
        this._retrievedPremises = retrievedPremises;
        const triedTactics = [];
        let goalCount = 0;

        // On failure the counters must still reach the loop (cost accounting is not optional
        // for failed runs — the ablation harness reads them): snapshot before rethrowing.
        const snapshot = () => {
            this.lastRun = { goalCount, llmCalls: proposal.llmCalls, tacticCalls, predictorSkips, retrievedPremises };
            return this.lastRun;
        };
        const wrappedFail = (error, extra = {}) => {
            snapshot();
            return fail(error, extra);
        };

        if (this.searchRecipe === 'bfs' || this.searchRecipe === 'mcgs') {
            // Whole-graph delegation (architecture.md §5 integration contract): the strategy
            // owns goal selection AND proposals over the graph; the loop keeps the commit
            // gate. LLM calls flow through the proposal engine (counted + budget-walled).
            const countedBackend = this._countingBackend(this.backend, () => tacticCalls++);
            const searcher = this.searchRecipe === 'mcgs'
                ? new MCGS({ backend: countedBackend, llm: proposal.llm, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors, predictorExploration: this.predictorExploration })
                : new BestFirstSearch({ backend: countedBackend, llm: proposal.llm, maxTacticsPerGoal: this.maxTacticsPerGoal, repulsion: this.repulsion, predictors: this.predictors, predictorExploration: this.predictorExploration });
            emit({ type: 'search_start', recipe: this.searchRecipe, budget: this.maxGoalsPerLemma });
            const searchResult = await searcher.search(graph, this.searchRecipe === 'mcgs' ? { rollouts: this.maxGoalsPerLemma } : { maxExpansions: this.maxGoalsPerLemma });
            goalCount = searchResult.expansions ?? searchResult.rollouts ?? 0;
            predictorSkips += searcher.skipped ?? 0;
            if ((searcher.explored ?? 0) > 0) {
                emit({ type: 'predictor_explored', recipe: this.searchRecipe, count: searcher.explored });
            }
            // Delegated searchers expand classes without the structure's own saturation hook —
            // run it on the root once the search settles (opportunistic, never fatal).
            if (typeof graph.saturateGoalClass === 'function' && graph.rootId) {
                try { await graph.saturateGoalClass(graph.rootId); } catch { /* opportunistic */ }
            }
            emit({ type: 'search_complete', recipe: this.searchRecipe, solved: graph.isRootSolved(), llmCalls: proposal.llmCalls, tacticCalls, skipped: searcher.skipped ?? 0 });
            if (!graph.isRootSolved()) {
                wrappedFail(`search recipe ${this.searchRecipe} exhausted budget ${this.maxGoalsPerLemma} without solving`);
            }
            return snapshot();
        }

        goalCount = 1;
        while (!graph.isRootSolved() && goalCount < this.maxGoalsPerLemma) {
            if (signal?.aborted) break;
            if (proposal.budgetExhausted) {
                emit({ type: 'budget_exhausted', budget: this.maxLlmCalls, llmCalls: proposal.llmCalls });
                break;
            }

            // Frontier order: the first open class is the head goal of the current proof
            // state; its freshest concrete goal carries the live proofState.
            const openGoals = graph.getOpenGoals();
            if (openGoals.length === 0) break;

            const currentGoalClass = openGoals[0];
            const goal = graph.currentGoal(currentGoalClass.id);
            emit({ type: 'goal_selected', goalClassId: currentGoalClass.id, goal });
            const ctx = (goal.context ?? []).map(c => `${c.name}: ${c.type}`).join('; ');
            console.log(`[${ts()}] [loop] goal_selected ${currentGoalClass.id.slice(0, 10)}… ⊢ ${goal.type.slice(0, 120)}${ctx ? ` | ctx: ${ctx.slice(0, 200)}` : ''}`);

            let solved = false;
            let lastResult = null;

            if (this.searchRecipe === 'loop') {
                // Test-time policy (§6.3): a goal class that keeps failing gets a larger
                // tactic budget — within-run adaptation from this run's own outcomes.
                if (this.ttrlPolicy) this.ttrlPolicy.observe(this.store?.events ?? []);
                const maxAttempts = this.ttrlPolicy?.stateFor(currentGoalClass.id).maxAttempts ?? this.maxTacticsPerGoal;
                // Causal predictor pre-filter (§5.3, §6 feedback interconnection): before
                // spending kernel time on a tactic, check whether it completes a known-
                // failing window. Rejected tactics skip the kernel call and count as
                // predictor-skips in telemetry — the LLM is not charged for the prediction.
                const predictorHistory = [];
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (signal?.aborted) break;
                    if (proposal.budgetExhausted) break;

                    // Lemma-store lookup: if a previously-proven lemma's conclusion matches
                    // the current goal type (after semantic normalization), skip the LLM
                    // entirely and use `exact <lemma>`. A store hit costs zero LLM calls.
                    const stored = this.lemmaStore?.findByGoal(goal.type);
                    const proposed = stored
                        ? { tactic: `exact ${extractLemmaName(stored.statement)}`, llmMs: 0, promptTokens: 0, completionTokens: 0 }
                        : await proposal.propose(this._buildTacticPrompt(goal, attempt, lemmaId, currentGoalClass.id, predictorHistory));
                    const tactic = proposed?.tactic;
                    if (!tactic) {
                        emit({ type: 'llm_error', goalClassId: currentGoalClass.id, attempt, error: proposed?.error ?? 'LLM returned no tactic', errorKind: proposed?.errorKind ?? 'abstention' });
                        continue;
                    }

                    emit({ type: 'tactic_proposed', goalClassId: currentGoalClass.id, attempt, tactic, llmMs: proposed.llmMs, promptTokens: proposed.promptTokens, completionTokens: proposed.completionTokens });
                    console.log(`[${ts()}] [loop] goal ${currentGoalClass.id.slice(0, 10)}… (${goal.type.slice(0, 90)}) attempt ${attempt}/${maxAttempts}: "${tactic}"`);

                    // Predictor veto is NOT permanent (§6): with probability
                    // `predictorExploration` the tactic is tried anyway, producing the
                    // counterfactual evidence that keeps the predictor from self-confirming.
                    const head = tacticHead(tactic);
                    if (this.predictors?.rejects(head, predictorHistory)) {
                        if (proposal.shouldExplore(tactic)) {
                            emit({ type: 'predictor_explored', goalClassId: currentGoalClass.id, attempt, tactic, head });
                        } else {
                            predictorSkips++;
                            emit({ type: 'tactic_predicted_failure', goalClassId: currentGoalClass.id, attempt, tactic, head });
                            continue;
                        }
                    }
                    predictorHistory.push(head);

                    tacticCalls++;
                    const result = await this.backend.applyTactic(goal, tactic);
                    lastResult = result;

                    if (result.status === 'error') {
                        console.log(`[${ts()}] [loop]   tactic failed: ${String(result.error?.message ?? 'no message').slice(0, 150)}`);
                        emit({ type: 'tactic_failed', goalClassId: currentGoalClass.id, attempt, tactic, error: result.error?.message ?? 'tactic failed' });
                        continue;
                    }

                    const patch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: tactic, scope: 'goal', meta: { attempt, newGoals: result.newGoals } });
                    const record = await this._applyPatch(graph, patch);
                    emit({ type: 'tactic_applied', goalClassId: currentGoalClass.id, tactic, goalType: goal.type, newGoalCount: result.newGoals?.length ?? 0 });
                    for (const subgoal of record.created) {
                        emit({ type: 'subgoal_created', subgoal });
                    }

                    if (isGoalSolved(result)) {
                        solved = true;
                        emit({ type: 'goal_solved', goalClassId: currentGoalClass.id, tactic, attempt, via: 'proposal', goalType: goal.type });
                        break;
                    }

                    solved = true; // decomposed into subgoals; they join the frontier
                    break;
                }
            } else {
                // Per-goal delegated recipes: bestofn / swiss / swiss+repulsion
                const pick = await this._pickByRecipe(goal, lemmaId, currentGoalClass.id, triedTactics, proposal, retrievedPremises);
                tacticCalls += pick.tacticCalls ?? 0;
                predictorSkips += pick.skipped ?? 0;

                if (pick.ok) {
                    const dpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: pick.tactic, scope: 'goal', meta: { via: pick.via, newGoals: pick.result.newGoals } });
                    const record = await this._applyPatch(graph, dpatch);
                    emit({ type: 'tactic_applied', goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via, goalType: goal.type, newGoalCount: pick.result.newGoals?.length ?? 0 });
                    for (const subgoal of record.created) {
                        emit({ type: 'subgoal_created', subgoal });
                    }
                    solved = true;
                    lastResult = pick.result;
                    if (isGoalSolved(pick.result)) {
                        emit({ type: 'goal_solved', goalClassId: currentGoalClass.id, tactic: pick.tactic, via: pick.via, goalType: goal.type });
                    }
                } else {
                    lastResult = { error: { message: pick.lastError ?? 'no tactic proposed' } };
                    emit({ type: 'recipe_failed', goalClassId: currentGoalClass.id, recipe: this.searchRecipe, lastError: lastResult.error.message });
                }
            }

            if (!solved && this.repair) {
                // P3.1: attempt repair before giving up. The structured error OBJECT (span /
                // subErrors) flows into the repair prompt, not just the message string.
                const lastError = lastResult?.error ?? { message: 'unknown error' };
                const errorType = classifyError(lastError);
                emit({ type: 'repair_attempted', goalClassId: currentGoalClass.id, errorType, lastError: lastError?.message ?? String(lastError) });

                const repairPrompt = buildRepairPrompt(goal, lastError, lastResult?.tactic);
                const repaired = await proposal.propose(repairPrompt);
                const repairedTactic = repaired?.tactic;

                if (repairedTactic) {
                    console.log(`[${ts()}] [loop]   repair attempt: "${String(repairedTactic).slice(0, 120)}"`);
                    emit({ type: 'repair_proposed', goalClassId: currentGoalClass.id, tactic: repairedTactic, llmMs: repaired.llmMs, promptTokens: repaired.promptTokens, completionTokens: repaired.completionTokens });

                    // Multi-line repair: the LLM produced a full proof script. Verify it as a
                    // complete source — bypass applyTactic entirely.
                    if (isMultiLineProof(repairedTactic)) {
                        const fullSource = buildProofSource(statement, `by\n${repairedTactic}`);
                        const check = await this.backend.check(fullSource, { useWarmEnv: false });
                        if (check.status === 'verified') {
                            const rootClass = graph.classes.get(graph.rootId);
                            if (rootClass) {
                                rootClass.state = 'SOLVED';
                                rootClass._directProof = `by\n${repairedTactic}`;
                            }
                            solved = true;
                            lastResult = { status: 'ok', newGoals: [] };
                            emit({ type: 'repair_applied', goalClassId: currentGoalClass.id, tactic: '(multi-line proof verified)' });
                            continue;
                        }
                        console.log(`[${ts()}] [loop]   multi-line repair check failed: ${check.error?.message?.slice(0, 120) ?? 'unknown'}`);
                    }

                    tacticCalls++;
                    const repairResult = await this.backend.applyTactic(goal, repairedTactic);

                    if (repairResult.status === 'ok') {
                        const rpatch = new Patch({ op: 'tactic', node: currentGoalClass.id, replacement: repairedTactic, scope: 'goal', meta: { via: 'repair', newGoals: repairResult.newGoals } });
                        const record = await this._applyPatch(graph, rpatch);
                        emit({ type: 'repair_applied', goalClassId: currentGoalClass.id, tactic: repairedTactic });
                        for (const subgoal of record.created) {
                            emit({ type: 'subgoal_created', subgoal });
                        }
                        solved = true;
                        lastResult = repairResult;

                        if (isGoalSolved(repairResult)) {
                            emit({ type: 'goal_solved', goalClassId: currentGoalClass.id, tactic: repairedTactic, via: 'repair', goalType: goal.type });
                        }
                    } else {
                        console.log(`[${ts()}] [loop]   repair failed: ${String(repairResult.error?.message ?? 'no message').slice(0, 150)}`);
                        emit({ type: 'repair_failed', goalClassId: currentGoalClass.id, tactic: repairedTactic, error: repairResult.error?.message });
                    }
                }
            }

            if (!solved) {
                const attemptsLabel = this.searchRecipe === 'loop' ? this.maxTacticsPerGoal : this.maxTacticsPerGoal;
                console.log(`[${ts()}] [loop] goal class ${currentGoalClass.id.slice(0, 10)}… UNRESOLVED after ${attemptsLabel} attempts + repair (goal: ${goal.type.slice(0, 120)})`);
                graph.markFailed(currentGoalClass.id);
            }

            goalCount += lastResult?.newGoals?.length ?? 0;
        }

        // All per-goal attempts exhausted without solving the root. Try one lemma-level
        // repair: ask the LLM for a complete proof of the full statement. If the kernel
        // accepts a multi-line proof, skip the rest of the commit path and mark solved.
        if (this.repair && !graph.isRootSolved() && !proposal.budgetExhausted) {
            console.log(`[${ts()}] [loop] lemma ${lemmaId.slice(0, 10)}… per-goal exhausted, trying lemma-level repair`);
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
                    console.log(`[${ts()}] [loop] lemma-level repair rejected: ${lemmaCheck.error?.message?.slice(0, 120) ?? 'unknown'}`);
                }
            }
        }

        return snapshot();
    }

    // Apply a tactic patch through the contract, then run the structure's own saturation hook
    // when present (the e-graph's kernel-confirmed rule unions; the transposition graph has
    // none). Saturation is opportunistic: a failure never fails the tactic application.
    async _applyPatch(graph, patch) {
        const record = graph.applyPatch(patch);
        if (typeof graph.saturateGoalClass === 'function') {
            for (const id of [patch.node, ...record.subgoalClasses]) {
                try {
                    await graph.saturateGoalClass(id);
                } catch {
                    // saturation is an optimization, never a correctness requirement
                }
            }
        }
        return record;
    }

    // Per-goal delegated recipes (architecture.md §5): pick a tactic for the current goal via
    // the named strategy, applying candidates through a counting backend. LLM calls flow
    // through the proposal engine's walled client (counted + budget-enforced). Returns
    // { ok, tactic, result, via, llmCalls, tacticCalls, skipped, lastError }.
    async _pickByRecipe(goal, lemmaId, goalClassId, triedTactics, proposal, retrievedPremises) {
        this._pickTacticCalls = 0; // per-pick kernel-call counter (reset each invocation)
        const countedBackend = this._countingBackend(this.backend, () => { this._pickTacticCalls = (this._pickTacticCalls ?? 0) + 1; });
        const N = this.swissN > 1 ? this.swissN : this.maxTacticsPerGoal;
        // Preference-pair hook (§6.2): every judged pair is a preference record — persisted to
        // the dataset at zero extra LLM cost (the judgment was already computed for ranking).
        const onOutcome = ({ tacticA, tacticB, result }) => {
            this.dataset?.addPreference({ goalShape: goal.type, tacticA, tacticB, winner: result });
        };
        const emit = event => this.emit(event, lemmaId);

        if (this.searchRecipe === 'bestofn') {
            const pick = await bestOfN(goal, countedBackend, proposal.llm, N, this.predictors);
            return { ...pick, via: 'bestofn', llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: pick.ok ? null : 'no tactic accepted in best-of-N' };
        }

        if (this.searchRecipe === 'swiss') {
            emit({ type: 'swiss_tournament_start', goalClassId, N });
            const swissResult = await bestOfNWithSwiss(goal, countedBackend, proposal.llm, { N, predictors: this.predictors, onOutcome });
            if (swissResult.ok) {
                emit({ type: 'swiss_tournament_complete', goalClassId, winner: swissResult.tactic, rankingSize: swissResult.ranking.length });
                return { ...swissResult, via: 'swiss', llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: null };
            }
            emit({ type: 'swiss_tournament_failed', goalClassId, rankingSize: swissResult.ranking.length });
            return { ...swissResult, via: 'swiss', llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: 'no tactic accepted in tournament' };
        }

        // swiss+repulsion: candidates drawn through a RepulsionSampler seeded with every tactic
        // tried (and failed) so far in this lemma, ranked by swiss, applied in order.
        emit({ type: 'swiss_tournament_start', goalClassId, N, repulsion: true });
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
            emit({ type: 'swiss_tournament_failed', goalClassId, rankingSize: 0, repulsion: true });
            return { ok: false, via: 'swiss+repulsion', llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: 'no candidates sampled' };
        }
        const judge = buildPairwiseJudge(goal, { llm: proposal.llm });
        const ranking = await swissRank(candidates, judge, { onOutcome });
        let skipped = 0;
        const history = [];
        for (const { candidate } of ranking) {
            if (this.predictors?.rejects(tacticHead(candidate), history)) {
                // §6: rejection is not permanent — occasionally re-test the counterfactual.
                if (this.predictorExploration > 0 && Math.random() < this.predictorExploration) {
                    emit({ type: 'predictor_explored', goalClassId, tactic: candidate, via: 'swiss+repulsion' });
                } else {
                    skipped++;
                    continue;
                }
            }
            history.push(tacticHead(candidate));
            const result = await countedBackend.applyTactic(goal, candidate);
            if (result.status === 'ok') {
                emit({ type: 'swiss_tournament_complete', goalClassId, winner: candidate, rankingSize: ranking.length, repulsion: true });
                return { ok: true, tactic: candidate, result, via: 'swiss+repulsion', skipped, llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: null };
            }
            triedTactics.push(candidate);
        }
        emit({ type: 'swiss_tournament_failed', goalClassId, rankingSize: ranking.length, repulsion: true });
        return { ok: false, via: 'swiss+repulsion', skipped, llmCalls: proposal.llmCalls, tacticCalls: this._pickTacticCalls ?? 0, lastError: 'all ranked candidates failed kernel' };
    }

    _countingBackend(backend, onCall) {
        const counted = { ...backend };
        const applyTactic = backend.applyTactic.bind(backend);
        const extractGoals = backend.extractGoals.bind(backend);
        counted.applyTactic = async (goal, tactic) => {
            onCall();
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
            this.emit({ type: 'premises_retrieved', lemmaId, goalClassId, count: premises.length, names: premises.map(p => p.name) }, lemmaId);
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
}
