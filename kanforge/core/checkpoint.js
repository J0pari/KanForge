// Run-level checkpoint (architecture.md §0.3, build_order.md P2.2). Consolidates the REFINE
// loop's working state — blueprint lemmas, rounds, the run-level hash chain, and the event
// store tail — into a single resumable record. Reuses the existing subsystems:
//   - hashChain from core/hasher.js (one entry per verified lemma, integrity-checkable)
//   - lemmaStore from growth/lemmaStore.js (content-addressed, already write-through — proved
//     lemmas survive crashes regardless of checkpoint)
//   - EventStore from optimization/store.js (causal event stream; serialize/deserialize below)
// A checkpoint is written after each refine round. On resume, proved lemmas are skipped and
// the hash chain continues from the checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import { verifyHashChain } from './hasher.js';

export const CHECKPOINT_FILENAME = 'checkpoint.json';

// Serialize the event store's causal events (plain array of plain objects).
export function serializeEventStore(store) {
    return (store?.events ?? []).map(e => ({ ...e }));
}

// Deserialize events back into a new store (the store's append method handles the array).
export function deserializeEventStore(store, events) {
    if (!store) return;
    for (const e of events ?? []) store.append({ ...e });
    return store.events.length;
}

export class RunCheckpoint {
    // workDir: the blueprint run's output directory (runs/<name>/).
    constructor(workDir) {
        this.workDir = workDir;
        this.file = path.join(workDir, CHECKPOINT_FILENAME);
    }

    // Write the current run state. Called after each refine round.
    save({ lemmas = [], rounds = [], hashChain = [], eventStore = null, provenance = null } = {}) {
        fs.mkdirSync(this.workDir, { recursive: true });
        const events = serializeEventStore(eventStore);
        const payload = {
            savedAt: new Date().toISOString(),
            lemmas: lemmas.map(l => ({
                id: l.id,
                statement: l.statement,
                deps: l.deps ?? [],
                proof: l.proof ?? null,
                stalled: l.stalled === true ? true : undefined,
                pinnedHash: l.pinnedHash ?? l.id
            })),
            rounds: rounds.map(r => ({
                id: r.id,
                ok: r.ok,
                resplit: r.resplit,
                added: r.added,
                error: r.error ?? null
            })),
            hashChain: hashChain.map(e => ({ ...e })),
            events,
            provenance: provenance ?? null
        };
        fs.writeFileSync(this.file, JSON.stringify(payload, null, 1), 'utf8');
        return this.file;
    }

    // Load a previously saved checkpoint. Returns null if none exists.
    load() {
        if (!fs.existsSync(this.file)) return null;
        try {
            return JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch {
            return null;
        }
    }

    // Verify the run-level hash chain from the checkpoint (integrity check on resume).
    static verifyHashChain(entries) {
        if (!entries?.length) return { ok: true };
        return verifyHashChain(entries);
    }

    // Merge loaded state into the refinery: mark proved lemmas, restore hash chain and rounds,
    // re-populate the event store. Returns { lemmas, rounds, hashChain, eventCount } for the
    // refiner to resume from. The refiner skips proved lemmas in its selection logic.
    static applyResume(checkpoint, { eventStore = null } = {}) {
        if (!checkpoint) return null;
        const proved = new Map();
        for (const l of checkpoint.lemmas ?? []) {
            if (l.proof) proved.set(l.id, l);
        }
        const hashChain = (checkpoint.hashChain ?? []).map(e => ({ ...e }));
        if (eventStore) {
            deserializeEventStore(eventStore, checkpoint.events ?? []);
        }
        return {
            proved,
            rounds: checkpoint.rounds ?? [],
            hashChain,
            eventCount: checkpoint.events?.length ?? 0,
            savedAt: checkpoint.savedAt ?? null
        };
    }
}
