// RunRecorder (architecture.md §4 role split): the post-run recording glue — per-verified-lemma
// hash-chain entries + checkpoint writes, and the run-finalization tail (audit packs,
// hermeticity check, KPI summary with provenance, degeneracy monitors, GRPO recording,
// telemetry export). Pure recording: it never calls the LLM or the backend.
import fs from 'node:fs';
import path from 'node:path';
import { hashChainEntry, verifyHashChain } from '../core/hasher.js';
import { computeMetrics } from '../optimization/metrics.js';
import { analyzePatterns } from '../optimization/patterns.js';
import { exportTelemetry } from '../optimization/exporter.js';
import { assembleAuditPack, writeAuditPack } from '../digest/auditPack.js';

export class RunRecorder {
    constructor({ store, hashChain, graph, checkpointDir, writeAuditPacks = true, monitor = false, grpoHarness = null, exportTo = null, llm = null, emit }) {
        this.store = store;
        this.hashChain = hashChain;
        this.graph = graph;
        this.checkpointDir = checkpointDir;
        this.writeAuditPacks = writeAuditPacks;
        this.monitor = monitor;
        this.grpoHarness = grpoHarness;
        this.exportTo = exportTo;
        this.llm = llm;
        this.emit = emit;
    }

    // After a successful commit gate: append the run-level hash chain entry and write the
    // checkpoint (P2.2 resumability — every verified lemma is persisted immediately).
    recordVerifiedLemma({ lemmaId, result, hashEntry }) {
        const prevHash = this.hashChain.length > 0 ? this.hashChain[this.hashChain.length - 1].hash : null;
        this.hashChain.push({
            prevHash,
            statementHash: hashEntry.statementHash,
            proofHash: hashEntry.proofHash,
            outcome: 'verified',
            hash: hashChainEntry(prevHash, hashEntry.statementHash, hashEntry.proofHash, 'verified')
        });

        if (this.checkpointDir) {
            const node = this.graph.nodes.get(lemmaId);
            if (node) {
                node.cached = true;
                node.value = result;
            }
            const checkpointPath = path.join(this.checkpointDir, 'state.json');
            const serialized = this.graph.serialize();
            fs.writeFileSync(checkpointPath, JSON.stringify(serialized, null, 2));
            // Causal-chain durability (§4/§7): append this lemma's events to the checkpoint's
            // JSONL stream so a resume restores parent links, not just cached nodes. The
            // in-memory store remains a bounded index; this file is the durable record.
            const streamPath = path.join(this.checkpointDir, 'events.ndjson');
            const lemmaEvents = this.store.events.filter(e => e.lemmaId === lemmaId);
            fs.appendFileSync(streamPath, lemmaEvents.map(e => JSON.stringify(e)).join('\n') + (lemmaEvents.length ? '\n' : ''));
            this.emit({ type: 'checkpoint_written', lemmaId, checkpointPath }, lemmaId);
        }
    }

    // Run finalization: the tail of proveAll — audit packs, hermeticity, KPIs, monitors, GRPO,
    // export. Mutates and returns `outcome`. Counters + wall start come from the loop, which
    // owns them (the recorder only renders them into the outcome).
    finalize(outcome, { runStart = null, llmCalls = 0, tacticCalls = 0, predictorSkips = 0 } = {}) {
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

            this.emit({ type: 'audit_packs_written', runId, runsDir, count: outcome.results.size }, null);
        }

        // Hermeticity check (§7): the run's statement hash chain must be intact end to end.
        outcome.hashChainOk = true;
        if (this.hashChain.length > 0) {
            const chain = verifyHashChain(this.hashChain);
            if (!chain.ok) {
                outcome.hashChainOk = false;
                this.emit({ type: 'guardrail_trip', lemmaId: null, violation: { type: 'HASH_CHAIN_BROKEN', message: chain.reason } }, null);
            }
        }

        const wallMs = Date.now() - (runStart ?? Date.now());
        const metrics = computeMetrics(this.store.events);
        metrics.secondsPerTheorem = (metrics.verifiedLemmas > 0 ? wallMs / 1000 / metrics.verifiedLemmas : null);
        outcome.metrics = {
            ...metrics,
            llmCalls,
            tacticCalls,
            predictorSkips,
            wallMs,
            model: this.llm?.getModel?.() ?? null,
            provider: this.llm?.getProvider?.() ?? null
        };
        outcome.hashChain = this.hashChain;

        if (this.monitor) {
            const patterns = analyzePatterns(this.store.events);
            for (const o of patterns.observations) {
                this.emit({ type: 'pattern_observation', severity: o.severity, pattern: o.type, count: o.count, message: o.message }, null);
            }
            outcome.patterns = patterns;
        }

        if (this.grpoHarness) {
            this.grpoHarness.record(this.store.events);
            outcome.grpo = this.grpoHarness.summary();
        }

        if (this.exportTo) {
            outcome.export = exportTelemetry({ file: this.exportTo, events: this.store.events, metrics: outcome.metrics, meta: { model: outcome.metrics.model, provider: outcome.metrics.provider } });
        }

        return outcome;
    }
}
