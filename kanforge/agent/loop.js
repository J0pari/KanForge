// Tactic-level search loop (architecture.md §2.2, §4) — ORCHESTRATION.
//
// Two-level structure:
// - Level 1: Lemma DAG (dependency-ordered dispatch via scheduler)
// - Level 2: Goal-state graph behind the GoalStateGraph contract (core/goalStateGraph.js) —
//   the transposition graph is the incumbent structure; the genuine e-graph
//   (core/egraph.js) is the staged searchStructure alternative
//
// Role split (§4): the loop wires and orchestrates; the heavy seams live in their own modules:
// - ProofSession (agent/proofSession.js) — backend proof-state lifecycle
// - ReuseEngine (agent/reuseEngine.js) — root-level lemma-store reuse (kernel re-verified)
// - SearchEngine (agent/searchEngine.js) — per-lemma search, recipes, repair, proposals
// - ProposalEngine (agent/proposalEngine.js) — the single LLM seam (counting + budget wall)
// - CommitGate (agent/commitGate.js) — pin/drift/assembly/whole-source verification/policy
// - RunRecorder (agent/runRecorder.js) — hash chain, checkpoints, audit packs, metrics
//
// For each lemma: session.open → reuse.tryRoot → search.run → commit gate → recorder.
// Telemetry: every event flows through optimization/bus.js into optimization/store.js with
// id/t/parent — the parent chain is the causal DAG per lemma.

import { Scheduler } from '../core/scheduler.js';
import { PullGraph } from '../core/pullgraph.js';
import { hashStatement, makePin, checkPin } from '../lean/pin.js';
import { isLemmaProved } from './solve.js';
import { GoalTranspositionGraph, lexicalNormalize } from '../core/transpositionGraph.js';
import { GoalEGraph, DEFAULT_EGRAPH_RULES } from '../core/egraph.js';
import { createDefEqOracle } from '../lean/defEqOracle.js';
import { assertGoalStateGraph } from '../core/goalStateGraph.js';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';
import { runCommitGate } from './commitGate.js';
import { Guardrails } from '../core/guardrails.js';
import { ProofSession } from './proofSession.js';
import { ReuseEngine } from './reuseEngine.js';
import { SearchEngine } from './searchEngine.js';
import { RunRecorder } from './runRecorder.js';
import { PremiseRetriever } from '../search/premises.js';
import { TestTimePolicy } from '../optimization/ttrl.js';
import { GRPOHarness } from '../optimization/grpo.js';
import fs from 'node:fs';
import path from 'node:path';

// Search recipes the loop can run (architecture.md §5 integration contract). Per-goal recipes
// dispatch inside the frontier loop; whole-graph recipes delegate the entire graph search and
// share the commit gate.
export const LOOP_SEARCH_RECIPES = ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'mcgs'];

export class TacticLoop {
    constructor({ backend, llm, concurrency = 2, maxTacticsPerGoal = 8, maxGoalsPerLemma = 100, onEvent = null, bus = null, store = null, checkpointDir = null, useSwiss = false, swissN = 8, premises = null, premiseLocked = false, premiseTopK = 5, searchRecipe = 'loop', repulsion = false, predictors = null, monitor = false, exportTo = null, ttrl = false, grpo = false, lemmaStore = null, dataset = null, menu = false, exemplars = false, exemplarLimit = 3, maxLlmCalls = null, writeAuditPacks = true, repair = true, predictorExploration = 0.02, searchStructure = 'transposition', compressionMetrics = true } = {}) {
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
        // searchStructure (registry component, build_order.md §5.12): the Level-2 goal-state
        // structure — 'transposition' (incumbent, syntactic identity) or 'egraph' (congruence
        // closure + kernel-confirmed rule unions). Ablation decides the default.
        this.searchStructure = searchStructure === 'egraph' ? 'egraph' : 'transposition';
        // compressionMetrics (registry component): include the §0.5 compression-quality block
        // in the outcome's KPI catalog.
        this.compressionMetrics = compressionMetrics !== false;
        // The egraph's def-eq oracle is backend-grounded: `rfl` checks only. A backend without
        // check() (e.g. a minimal mock) degrades to congruence-only unions — never unverified.
        this.egraphOracle = this.searchStructure === 'egraph' && typeof backend?.check === 'function'
            ? createDefEqOracle(backend)
            : null;

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

        // Role split (§4): the loop owns orchestration; these modules own their seams.
        this.session = new ProofSession(this.backend);
        this.reuse = new ReuseEngine({ backend: this.backend, store: this.lemmaStore });
        this.search = new SearchEngine({
            backend: this.backend,
            llm: this.llm,
            menu: this.menu,
            maxLlmCalls: this.maxLlmCalls,
            predictorExploration: this.predictorExploration,
            searchRecipe: this.searchRecipe,
            maxTacticsPerGoal: this.maxTacticsPerGoal,
            maxGoalsPerLemma: this.maxGoalsPerLemma,
            swissN: this.swissN,
            repulsion: this.repulsion,
            predictors: this.predictors,
            dataset: this.dataset,
            lemmaStore: this.lemmaStore,
            retriever: this.retriever,
            premiseLocked: this.premiseLocked,
            premiseTopK: this.premiseTopK,
            exemplars: this.exemplars,
            exemplarLimit: this.exemplarLimit,
            ttrlPolicy: this.ttrlPolicy,
            repair: this.repair,
            store: this.store,
            emit: (e, lemmaId) => this._emit(e, lemmaId)
        });
        this.recorder = new RunRecorder({
            store: this.store,
            hashChain: this.hashChain,
            graph: this.graph,
            checkpointDir: this.checkpointDir,
            writeAuditPacks: this.writeAuditPacks,
            monitor: this.monitor,
            grpoHarness: this.grpoHarness,
            exportTo: this.exportTo,
            llm: this.llm,
            emit: (e, lemmaId) => this._emit(e, lemmaId)
        });

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

        // Predictor provenance (§6): version the matcher in the event stream so audits can
        // distinguish a fresh prior-run mining from a stale one.
        if (this.predictors) {
            this._emit({ type: 'predictor_compiled', lemmaId, count: this.predictors.count ?? null, inert: this.predictors.inert ?? null, source: this.predictors.source ?? null, minedAt: this.predictors.minedAt ?? null }, lemmaId);
        }

        try {
            // Level 2: goal-state graph behind the contract — structure selection is the
            // searchStructure component (§5.12); the loop depends on the contract only.
            const graph = this.searchStructure === 'egraph'
                ? assertGoalStateGraph(new GoalEGraph({
                    oracle: this.egraphOracle,
                    rules: DEFAULT_EGRAPH_RULES,
                    onUnion: (a, b, reason, confirmed) => {
                        this._emit({ type: 'egraph_union', lemmaId, reason, confirmed, classA: a, classB: b }, lemmaId);
                    }
                }), { label: 'GoalEGraph' })
                : new GoalTranspositionGraph({ normalizer: lexicalNormalize });

            // ProofSession (§4): extractGoals opens the backend proof session (leased worker).
            let rootGoals;
            try {
                rootGoals = await this.session.open(statement);
            } catch (err) {
                fail(`could not extract root goal: ${err?.message ?? String(err)}`, { extractFailed: true });
            }
            if (!rootGoals || rootGoals.length === 0) {
                fail('could not extract root goal (empty goal list)', { extractFailed: true });
            }

            graph.setRoot(rootGoals[0]);

            // ReuseEngine (§2.8, §0.3): a stored lemma that closes the root goal — inlined and
            // kernel re-verified, so retrieval never bypasses verification.
            const reuse = await this.reuse.tryRoot({ statement, lemmaId, graph, onReuse: e => this._emit(e, lemmaId) });
            const directProof = reuse?.directProof ?? null;

            // SearchEngine (§4): per-lemma search — recipes, repair, proposals. Throws the
            // fail() contract on exhaustion paths; counters survive via lastRun (finally).
            if (!graph.isRootSolved()) {
                const s = await this.search.run({ statement, lemmaId, graph, signal, fail });
                this._retrievedPremises = s.retrievedPremises;
            }

            const pin = this.pins.get(lemmaId);
            if (!isLemmaProved(graph, hashStatement(statement), pin?.statementHash ?? '')) {
                if (!graph.isRootSolved()) {
                    fail(`root goal not solved after search`);
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

            const ms = Date.now() - start;
            this._emit({ type: 'lemma_verified', lemmaId, statement, proofScript: gate.proofScript, ms, goalCount: this.search.lastRun?.goalCount ?? 0 }, lemmaId);

            const result = { statement: gate.result.statement, proofScript: gate.proofScript, verifiedAt: gate.result.verifiedAt, goalCount: this.search.lastRun?.goalCount ?? 0, ms };

            // RunRecorder (§4): hash-chain entry + checkpoint after every verified lemma.
            this.recorder.recordVerifiedLemma({ lemmaId, result, hashEntry: gate.hashEntry });

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
            // Accumulate the search's engine-counted LLM calls into the loop total (write-through
            // accounting: the engine counted every call once; the loop just adds it up). The
            // snapshot survives failures — cost accounting is not optional for failed runs.
            const last = this.search.lastRun;
            if (last) {
                this.llmCalls += last.llmCalls ?? 0;
                this.tacticCalls += last.tacticCalls ?? 0;
                this.predictorSkips += last.predictorSkips ?? 0;
            }
            // Release the leased proof-session worker back to the backend pool.
            this.session.close(lemmaId);
        }
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

        // Invariant sweep (§2.5 enforcement points): checkAll audits the whole graph at run end
        // — statement pins, kernel evidence, leakage over ASSEMBLED sources, acyclicity,
        // checkpoint coverage, and the hash chain. Every violation is emitted as a guardrail
        // trip; the sweep report rides the outcome for the digest/ablation layers.
        const sweep = Guardrails.checkAll(this.graph, { pins: this.pins, hashChain: this.hashChain });
        for (const v of sweep.violations) {
            this._emit({ type: 'guardrail_trip', lemmaId: null, violation: v }, null);
        }
        outcome.guardrailSweep = sweep;

        // RunRecorder (§4): audit packs, hermeticity, KPI summary + provenance, monitors, GRPO,
        // export — the whole finalization tail.
        this.recorder.finalize(outcome, {
            runStart: this._runStart,
            llmCalls: this.llmCalls,
            tacticCalls: this.tacticCalls,
            predictorSkips: this.predictorSkips,
            librarySize: this.lemmaStore?.size ?? null,
            compressionMetrics: this.compressionMetrics
        });

        return outcome;
    }

    events() {
        return [...this.store.events];
    }

    // Resume from checkpoint (P2.2): load serialized graph state, mark cached lemmas as CACHED,
    // and restore the causal event stream so parent links resolve across the resume boundary.
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

        // Restore the durable event stream (written by the recorder alongside state.json) so
        // causal chains continue across the resume boundary.
        const dir = path.dirname(checkpointPath);
        const streamPath = path.join(dir, 'events.ndjson');
        if (fs.existsSync(streamPath)) {
            let restored = 0;
            for (const raw of fs.readFileSync(streamPath, 'utf8').split(/\r?\n/)) {
                if (!raw.trim()) continue;
                try {
                    const ev = JSON.parse(raw);
                    this.store.append(ev);
                    const last = this._chains.get(ev.lemmaId);
                    if (!last || (ev.id !== last)) this._chains.set(ev.lemmaId, ev.id);
                    restored++;
                } catch {
                    // malformed line: skip — the audit pack re-derives chains from the graph
                }
            }
            this._emit({ type: 'resumed_event_stream', checkpointPath, restored });
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

// Timestamped log prefix — the loop's console.log calls need timestamps so a long run's
// liveness and timing are inspectable from the log alone.
export function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
