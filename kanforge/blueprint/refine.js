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

export class BlueprintRefiner {
    constructor({ llm, backend, outDir = null, loopOptions = {}, maxRounds = 200, lemmaStore = null, dataset = null } = {}) {
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
    }

    async refine(blueprint) {
        const audit = validateBlueprint(blueprint);
        if (!audit.ok) {
            return { ok: false, error: 'invalid blueprint', errors: audit.errors, refined: blueprint, proved: [], unproved: [], rounds: [] };
        }

        const working = JSON.parse(JSON.stringify(blueprint));
        const rounds = [];
        let guard = 0;

        for (; guard < this.maxRounds; guard++) {
            const drift = checkDrift(working.lemmas);
            if (!drift.ok) {
                return { ok: false, error: 'drift detected', drifts: drift.drifts, refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const order = topologicalOrder(working.lemmas);
            if (!order) {
                return { ok: false, error: 'blueprint became cyclic', refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const next = order.map(id => working.lemmas.find(l => l.id === id)).find(l => !l.proof);
            if (!next) break;

            const before = working.lemmas.length;
            const round = await this._attempt(next, working);
            rounds.push({ id: next.id, ok: round.proved, resplit: round.resplit, added: round.added, error: round.error ?? null });
            const madeProgress = round.proved || working.lemmas.length > before;
            if (!madeProgress) break;
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
            maxRoundsReached: guard >= this.maxRounds && unproved.length > 0,
            stored: {
                lemmas: this.lemmaStore?.size ?? 0,
                samples: this.dataset?.samples.length ?? 0
            }
        };
    }

    async _attempt(stub, working) {
        const userOnEvent = this.loopOptions.onEvent;
        const loop = new TacticLoop({
            backend: this.backend,
            llm: this.llm,
            ...this.loopOptions,
            onEvent: e => {
                this._capture(e);
                userOnEvent?.(e);
            }
        });
        loop.addLemma(stub.statement);
        const outcome = await loop.proveAll();

        if (outcome.ok) {
            const verified = loop.events().filter(e => e.type === 'lemma_verified').pop();
            stub.proof = verified?.proofScript ?? '';
            return { proved: true, resplit: false, added: 0 };
        }

        const failedEvt = loop.events().filter(e => e.type === 'lemma_failed').pop();
        const loopError = failedEvt?.error?.message ?? failedEvt?.error ?? 'tactic loop failed';

        // Re-split: decompose the failed stub into child stubs via the skeleton generator.
        // The stub statement itself is never edited; only child stubs are added.
        const sub = await this.skeleton.generate(stub.statement);
        if (!sub.ok) {
            return { proved: false, resplit: false, added: 0, error: loopError };
        }

        const rootId = hashStatement(normalizeStub(stub.statement));
        const subRoot = sub.blueprint.lemmas.find(l => l.id === rootId);
        if (!subRoot) {
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
        stub.deps = (subRoot.deps ?? []).filter(d => d !== stub.id);
        return { proved: false, resplit: true, added };
    }

    _capture(event) {
        if (!this.lemmaStore && !this.dataset) return;
        const { statement } = event;
        if (event.type === 'lemma_verified') {
            if (this.lemmaStore) {
                this.lemmaStore.put(hashStatement(statement), {
                    statement,
                    proofScript: event.proofScript,
                    goalCount: event.goalCount,
                    ms: event.ms,
                    timestamp: Date.now()
                });
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
