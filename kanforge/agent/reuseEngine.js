// ReuseEngine (architecture.md §4 role split, §2.8): the root-level lemma-store reuse path. A
// previously-proven lemma whose conclusion matches the root goal is inlined — declaration +
// proof — and proved by `exact <name>`; the kernel re-verifies the combined source, so
// retrieval never bypasses verification and cross-problem reuse works in any fresh session.
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
        const storedSource = stored.statement.replace(/:=\s*by\s+sorry\s*$/, `:= ${stored.proofScript}`);
        const currentDecl = statement.replace(/:=\s*by\s+sorry\s*$/, `:= by exact ${stored.lemmaName}`);
        const combined = `${storedSource}\n\n${currentDecl}`;
        const check = await this.backend.check(combined, { useWarmEnv: false });
        if (check.status !== 'verified') {
            onReuse?.({ type: 'store_reuse_rejected', lemmaId, error: check.error?.message?.slice(0, 100) ?? 'verification failed' });
            return null;
        }
        const rootClass = graph.classes.get(graph.rootId);
        if (rootClass) {
            rootClass.state = 'SOLVED';
            rootClass._directProof = `by exact ${stored.lemmaName}`;
        }
        onReuse?.({ type: 'store_reuse', lemmaId, lemma: stored.lemmaName });
        return { solved: true, directProof: `by exact ${stored.lemmaName}`, lemma: stored.lemmaName };
    }
}
