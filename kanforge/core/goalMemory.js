// Campaign-level goal memory — the cross-lemma extension of the transposition graph's identity
// discipline (architecture.md §2.2, §6). The Level-2 goal-state graph is per-lemma (rebuilt
// for every stub attempt); the memory is the campaign-scoped record keyed by the SAME canonical
// keys (goalCanonicalKey, core/transpositionGraph.js), so a goal shape that reappears in a
// re-split child or a fresh lemma shares one entry. Swapping the goal-state structure (egraph)
// does not change the memory — the key vocabulary is the syntactic canonical key, and every
// replay is kernel re-verified, so a keying mismatch costs at most a wasted attempt.
//
// Channels, all kernel-grounded:
//  - solvedBy: tactic texts that SOLVED this goal shape (goal_solved). A new class with the
//    same shape replays them first — the replay still runs through backend.applyTactic and the
//    commit gate, so replay is a cache of ORDER, never of truth.
//  - failed: tactic texts that FAILED this goal shape in-session (tactic_failed). Identical
//    proposals are vetoed before kernel/LLM spend (subject to the §6 exploration valve).
//  - unknownIdentifiers: identifier names the kernel reported undeclared at whole-source
//    verification (KERNEL_REJECTED). Any future tactic text referencing one is vetoed
//    campaign-wide — this kills the `exact twopow_one` loop across every goal shape.
//
// Sizing caps keep the checkpoint lean; the memory is a bounded LRU-ish cache, not an archive.
import { goalCanonicalKey } from './transpositionGraph.js';

export const GOAL_MEMORY_CAPS = Object.freeze({
    entries: 1000,
    solvedBy: 3,
    failed: 10,
    unknownIdentifiers: 64
});

// Lean identifier characters: letters, digits, _, ', and namespace dots (`.` binds as part of
// the identifier reference; word boundaries don't cover `'`, so lookarounds delimit).
function identifierRegex(name) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_'.])${esc}(?![A-Za-z0-9_'])`);
}

export class GoalMemory {
    constructor({ caps = GOAL_MEMORY_CAPS } = {}) {
        this.caps = { ...GOAL_MEMORY_CAPS, ...caps };
        this.entries = new Map();            // canonicalKey -> { solvedBy: [], failed: [] }
        this.unknownIdentifiers = new Set(); // campaign-wide undeclared identifier names
        this.hits = { solvedReplay: 0, solvedReplayVerified: 0, failedVeto: 0, unknownVeto: 0 };
    }

    keyFor(goal) {
        return goalCanonicalKey(goal.type, goal.context ?? []);
    }

    _entry(key) {
        let e = this.entries.get(key);
        if (!e) {
            e = { solvedBy: [], failed: [] };
            if (this.entries.size >= this.caps.entries) {
                const oldest = this.entries.keys().next().value;
                this.entries.delete(oldest);
            }
            this.entries.set(key, e);
        }
        // Freshness: a re-touched entry is moved to the end (cheap LRU approximation).
        this.entries.delete(key);
        this.entries.set(key, e);
        return e;
    }

    solvedBy(goal) {
        const e = this.entries.get(this.keyFor(goal));
        return e ? [...e.solvedBy] : [];
    }

    recordSolved(goal, tactic) {
        if (!tactic) return;
        const e = this._entry(this.keyFor(goal));
        if (!e.solvedBy.includes(tactic)) {
            e.solvedBy.push(tactic);
            if (e.solvedBy.length > this.caps.solvedBy) e.solvedBy.shift();
        }
    }

    failedTactics(goal) {
        const e = this.entries.get(this.keyFor(goal));
        return e ? new Set(e.failed) : new Set();
    }

    recordFailure(goal, tactic) {
        if (!tactic) return;
        const e = this._entry(this.keyFor(goal));
        if (!e.failed.includes(tactic)) {
            e.failed.push(tactic);
            if (e.failed.length > this.caps.failed) e.failed.shift();
        }
    }

    recordUnknownIdentifier(name) {
        if (!name) return;
        const clean = String(name).trim();
        if (!clean) return;
        if (this.unknownIdentifiers.size >= this.caps.unknownIdentifiers) {
            const oldest = this.unknownIdentifiers.values().next().value;
            this.unknownIdentifiers.delete(oldest);
        }
        this.unknownIdentifiers.add(clean);
    }

    referencesUnknownIdentifier(tactic) {
        const text = String(tactic ?? '');
        for (const name of this.unknownIdentifiers) {
            if (identifierRegex(name).test(text)) return name;
        }
        return null;
    }

    // Compact, resumable shape (rides the run checkpoint — core/checkpoint.js).
    serialize() {
        return {
            entries: Array.from(this.entries.entries())
                .map(([key, e]) => [key, { solvedBy: e.solvedBy.slice(0, this.caps.solvedBy), failed: e.failed.slice(0, this.caps.failed) }]),
            unknownIdentifiers: Array.from(this.unknownIdentifiers),
            hits: { ...this.hits }
        };
    }

    static deserialize(data) {
        const m = new GoalMemory();
        for (const [key, e] of data?.entries ?? []) {
            m.entries.set(key, { solvedBy: [...(e?.solvedBy ?? [])], failed: [...(e?.failed ?? [])] });
        }
        for (const name of data?.unknownIdentifiers ?? []) m.unknownIdentifiers.add(name);
        m.hits = { ...m.hits, ...(data?.hits ?? {}) };
        return m;
    }
}
