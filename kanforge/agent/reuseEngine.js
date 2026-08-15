// ReuseEngine (architecture.md §4 role split, §2.8): the root-level lemma-store reuse path. A
// previously-proven lemma whose conclusion matches the root goal is inlined — declaration +
// proof + its DEPENDENCY CLOSURE (the stored proof references its own lemmas, so the closure
// must be declared for the combined source to verify in a fresh env) — and proved by
// `exact <name>`; the kernel re-verifies the combined source, so retrieval never bypasses
// verification and cross-problem reuse works in any fresh session.
import { hashStatement } from '../lean/pin.js';
import { buildReuseSource } from '../core/state.js';

export class ReuseEngine {
    constructor({ backend, store = null }) {
        this.backend = backend;
        this.store = store;
    }

    // Returns { solved, directProof, lemma } when a stored lemma closes the root goal
    // (verified by the current backend), else null. Reuse-by-name requires a NAMED stored
    // declaration — anonymous entries (`example …`) are skipped, never referenced by a
    // placeholder name.
    async tryRoot({ statement, lemmaId, graph, onReuse = null }) {
        if (!this.store || graph.isRootSolved()) return null;
        const rootGoal = graph.currentGoal(graph.rootId);
        if (!rootGoal) return null;
        const stored = this.store.findByGoal(rootGoal.type);
        if (!stored?.lemmaName) return null;
        // Degrade chain: full dependency closure first; if the kernel rejects the assembled
        // source (a foreign stored entry can be malformed), fall back to the stored lemma
        // alone, then the target alone — each step still kernel-verified. Warm-first with a
        // fresh fallback: the warm env carries the mission's import block, so an in-family
        // reuse verifies in seconds; a warm rejection is re-tested fresh (authoritative).
        const variants = [
            buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, closureOf: hashStatement(stored.statement), includeClosureRoot: true }),
            buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, closureOf: hashStatement(stored.statement) }),
            buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}` })
        ];
        let check = null;
        for (const combined of variants) {
            check = await this.backend.check(combined, { useWarmEnv: true });
            if (check.status === 'verified') break;
            check = await this.backend.check(combined, { useWarmEnv: false });
            if (check.status === 'verified') break;
        }
        if (check.status !== 'verified') {
            onReuse?.({ type: 'store_reuse_rejected', lemmaId, error: check.error?.message?.slice(0, 100) ?? 'verification failed' });
            return null;
        }
        const rootClass = graph.classes.get(graph.rootId);
        if (rootClass) {
            rootClass.state = 'SOLVED';
            graph.setDirectProof(graph.rootId, `by exact ${stored.lemmaName}`);
        }
        onReuse?.({ type: 'store_reuse', lemmaId, lemma: stored.lemmaName });
        return { solved: true, directProof: `by exact ${stored.lemmaName}`, lemma: stored.lemmaName };
    }
}
