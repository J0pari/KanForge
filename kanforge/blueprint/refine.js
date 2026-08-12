// Refine loop (architecture.md §1, build_order.md §4.2).
// Repeatedly picks the lowest unproved stub (topological order), runs the Phase-1 tactic loop
// on it via agent/loop.js, and either records the verified proof or re-splits the stub into
// child stubs (re-split adds children; existing statements are never edited). Drift is
// re-checked every round via blueprint/drift.js. The blueprint statement set is invariant
// across the run.
import fs from 'node:fs';
import path from 'node:path';
import { TacticLoop } from '../agent/loop.js';
import { SkeletonGenerator, normalizeStub } from './skeleton.js';
import { validateBlueprint, topologicalOrder } from './dag.js';
import { checkDrift } from './drift.js';
import { hashStatement } from '../lean/pin.js';
import { buildLemmaIndex } from '../growth/lemmaStore.js';
import { Patch, patchStreamFromEvents } from '../core/patch.js';
import { RunCheckpoint } from '../core/checkpoint.js';

export class BlueprintRefiner {
    constructor({ llm, backend, outDir = null, loopOptions = {}, maxRounds = 200, lemmaStore = null, dataset = null, checkpoint = null } = {}) {
        if (!llm || !backend) {
            throw new Error('BlueprintRefiner requires a real llm client and a real backend');
        }
        this.llm = llm;
        this.backend = backend;
        this.outDir = outDir;
        this.loopOptions = { concurrency: 1, maxTacticsPerGoal: 8, maxGoalsPerLemma: 100, onEvent: () => {}, ...loopOptions };
        this.maxRounds = maxRounds;
        this.skeleton = new SkeletonGenerator({ llm, backend });
        this.lemmaStore = lemmaStore ?? null;
        this.dataset = dataset ?? null;
        this.checkpoint = checkpoint ?? (outDir ? new RunCheckpoint(outDir) : null);
    }

    async refine(blueprint) {
        const audit = validateBlueprint(blueprint);
        if (!audit.ok) {
            return { ok: false, error: 'invalid blueprint', errors: audit.errors, refined: blueprint, proved: [], unproved: [], rounds: [] };
        }

        const working = JSON.parse(JSON.stringify(blueprint));
        const rounds = [];
        let hashChain = [];
        let guard = 0;
        let idleCount = 0;

        // Resume from checkpoint: mark proved lemmas, restore rounds, continue hash chain.
        const loaded = this.checkpoint?.load();
        if (loaded) {
            const { proved } = RunCheckpoint.applyResume(loaded);
            for (const [id, l] of proved) {
                const lemma = working.lemmas.find(w => w.id === id);
                if (lemma) { lemma.proof = l.proof; lemma.stalled = false; }
            }
            rounds.push(...(loaded.rounds ?? []));
            hashChain = (loaded.hashChain ?? []).map(e => ({ ...e }));
            console.log(`[refine] resumed ${proved.size} proven lemmas from checkpoint (${loaded.rounds?.length ?? 0} rounds, ${loaded.savedAt})`);
        }

        while (guard < this.maxRounds) {
            const drift = checkDrift(working.lemmas);
            if (!drift.ok) {
                return { ok: false, error: 'drift detected', drifts: drift.drifts, refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const order = topologicalOrder(working.lemmas);
            if (!order) {
                return { ok: false, error: 'blueprint became cyclic', refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const provenIds = new Set(working.lemmas.filter(l => l.proof).map(l => l.id));
            const next = order.map(id => working.lemmas.find(l => l.id === id))
                .find(l => !l.proof && !l.stalled && (l.deps ?? []).every(d => provenIds.has(d)));
            if (!next) {
                const stillWorkable = working.lemmas.find(l => !l.proof && !l.stalled
                    && (l.deps ?? []).every(d => provenIds.has(d)));
                if (!stillWorkable) break;
                // A lemma is ready but blocked on deps — idle; don't count as a real round.
                idleCount++;
                if (idleCount >= 3) break;
                continue;
            }
            idleCount = 0;

            const before = working.lemmas.length;
            const round = await this._attempt(next, working);
            guard++;
            console.log(`[refine] round ${guard}/${this.maxRounds} lemma ${next.id.slice(0, 10)}… proved=${round.proved} resplit=${round.resplit} added=${round.added} error=${round.error ?? '(none)'}`);
            rounds.push({ id: next.id, ok: round.proved, resplit: round.resplit, added: round.added, error: round.error ?? null });
            if (round.hashChainEntry) hashChain.push(round.hashChainEntry);
            // The warm worker survives the loop's endLemma (leased worker is separate — killed
            // and replaced by workerPerProblem). No re-warm needed — the warm env is intact.
            const madeProgress = round.proved || working.lemmas.length > before;
            // Checkpoint after every round — progress or not. A stalled lemma (no progress,
            // no new children) must still persist the round history + hash chain, or a crash
            // mid-run loses the stalls that the resume logic needs to skip.
            this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain });
            if (!madeProgress) {
                next.stalled = true;
                continue;
            }
            if (round.proved || round.added > 0) {
                for (const l of working.lemmas) delete l.stalled;
            }
        }

        const proved = working.lemmas.filter(l => l.proof).map(l => l.id);
        const unproved = working.lemmas.filter(l => !l.proof).map(l => l.id);
        const ok = unproved.length === 0;

        if (this.outDir && ok) this._write(working);

        return {
            ok,
            refined: working,
            proved,
            unproved,
            rounds,
            hashChain,
            maxRoundsReached: guard >= this.maxRounds && unproved.length > 0,
            stored: {
                lemmas: this.lemmaStore?.size ?? 0,
                samples: this.dataset?.samples.length ?? 0
            }
        };
    }

    async _attempt(stub, working) {
        // §5.7 Stage 2 — exact reuse: a previously-verified statement (same hash) in the store
        // reuses its stored proof with zero LLM/kernel spend. The proof is re-verified by the
        // kernel at commit — retrieval never bypasses verification.
        const stmtHash = hashStatement(stub.statement);
        const reused = this.lemmaStore?.get(stmtHash);
        if (reused?.proofScript) {
            stub.proof = reused.proofScript;
            // §5.9: a store hit is a typed `reuse` patch — recorded, not a silent shortcut.
            stub.patchStream = [new Patch({ node: stmtHash, op: 'reuse', replacement: reused.proofScript, scope: 'lemma', meta: { source: reused.statementHash ?? stmtHash } })];
            return { proved: true, resplit: false, added: 0, reused: true };
        }

        const userOnEvent = this.loopOptions.onEvent;
        const lemmaEvents = [];
        const loop = new TacticLoop({
            backend: this.backend,
            llm: this.llm,
            ...this.loopOptions,
            onEvent: e => {
                this._currentStub = stub;
                lemmaEvents.push(e);
                this._capture(e, lemmaEvents);
                this._currentStub = null;
                userOnEvent?.(e);
            }
        });
        loop.addLemma(stub.statement);
        const outcome = await loop.proveAll();

        if (outcome.ok) {
            const verified = loop.events().filter(e => e.type === 'lemma_verified').pop();
            stub.proof = verified?.proofScript ?? '';
            // §5.9: the typed mutation record — the lemma's patch stream is its transformation
            // history, stored on the stub so both the retrieval index entry and the digest carry it.
            stub.patchStream = patchStreamFromEvents(loop.events().filter(e => e.lemmaId === verified?.lemmaId));
            // Carry the loop's hash chain entry to the run-level chain.
            const chainEntry = outcome.hashChain?.length ? outcome.hashChain[outcome.hashChain.length - 1] : null;
            return { proved: true, resplit: false, added: 0, hashChainEntry: chainEntry };
        }

        const failedEvt = loop.events().filter(e => e.type === 'lemma_failed').pop();
        const loopError = failedEvt?.error?.message ?? failedEvt?.error ?? 'tactic loop failed';

        // Re-split: decompose the failed stub into child stubs via the skeleton generator.
        // The stub statement itself is never edited; only child stubs are added.
        const sub = await this.skeleton.generate(stub.statement);
        if (!sub.ok) {
            console.log(`[refine]   skeleton re-split failed: ${sub.error ?? 'unknown'}`);
            return { proved: false, resplit: false, added: 0, error: loopError };
        }

        const rootId = hashStatement(normalizeStub(stub.statement));
        const subRoot = sub.blueprint.lemmas.find(l => l.id === rootId);
        if (!subRoot) {
            console.log(`[refine]   skeleton root not found in re-split (rootId=${rootId.slice(0,10)}…)`);
            return { proved: false, resplit: false, added: 0 };
        }

        const known = new Set(working.lemmas.map(l => l.id));
        let added = 0;
        for (const child of sub.blueprint.lemmas) {
            if (child.id === rootId) continue;
            if (!known.has(child.id)) {
                working.lemmas.push(child);
                added++;
            }
        }
        console.log(`[refine]   re-split produced ${sub.blueprint.lemmas.length} lemmas, ${added} new`);
        stub.deps = (subRoot.deps ?? []).filter(d => d !== stub.id);
        return { proved: false, resplit: true, added };
    }

    _capture(event, lemmaEvents = []) {
        if (!this.lemmaStore && !this.dataset) return;
        const { statement } = event;
        if (event.type === 'lemma_verified') {
            if (this.lemmaStore) {
                const stub = this._currentStub;
                this.lemmaStore.put(hashStatement(statement), buildLemmaIndex({
                    statementHash: hashStatement(statement),
                    statement,
                    proofScript: event.proofScript,
                    deps: stub?.deps ?? [],
                    goalCount: event.goalCount ?? null,
                    ms: event.ms ?? null,
                    // §5.9: the typed transformation history. `lemma_verified` is the lemma's
                    // terminal event, so the accumulated array is complete at this point; the
                    // reuse fast-path sets stub.patchStream directly (no loop ran).
                    patchStream: (stub?.patchStream ?? patchStreamFromEvents(lemmaEvents))
                }));
            }
            if (this.dataset) {
                this.dataset.addSample({ lemma: statement }, event.proofScript ?? '', 'verified');
            }
        } else if (event.type === 'lemma_failed' && this.dataset) {
            this.dataset.addSample({ lemma: statement }, null, 'failed');
        }
    }

    _write(blueprint) {
        fs.mkdirSync(this.outDir, { recursive: true });
        fs.writeFileSync(path.join(this.outDir, 'refined.json'), JSON.stringify(blueprint, null, 2) + '\n');
    }
}
