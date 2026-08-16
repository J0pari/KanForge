// ReuseEngine (architecture.md §4 role split, §2.8): the root-level lemma-store reuse path. A
// previously-proven lemma whose conclusion matches the root goal is inlined — declaration +
// proof + its DEPENDENCY CLOSURE (the stored proof references its own lemmas, so the closure
// must be declared for the combined source to verify in a fresh env) — and proved by
// `exact <name>`; the kernel re-verifies the combined source, so retrieval never bypasses
// verification and cross-problem reuse works in any fresh session.
import { hashStatement } from '../lean/pin.js';
import { buildReuseSource } from '../core/state.js';

export class ReuseEngine {
    constructor({ backend, store = null, rejectMemo = null, goalMemory = null, rankedReuse = true, rankLimit = 3, maxRankedChecks = 4 } = {}) {
        this.backend = backend;
        this.store = store;
        this.rejectMemo = rejectMemo; // shared per-pass set (statement hash -> rejected): churned stubs skip the doomed re-check
        this.goalMemory = goalMemory; // campaign goal memory: reuse-level rejections feed the unknown-identifier veto channel
        this.rankedReuse = rankedReuse !== false; // §2.8 ranked fallback toggle (registry component)
        this.rankLimit = rankLimit; // top-K ranked fallback candidates (§2.8 specialization/generalization)
        this.maxRankedChecks = maxRankedChecks; // global fresh-check cap across ranked candidates
    }

    _recordUnknownIdentifier(error) {
        if (!this.goalMemory) return;
        const msg = String(error?.message ?? error ?? '');
        const m = /[Uu]nknown (?:identifier|constant) [`']?([A-Za-z0-9_.']+)/.exec(msg);
        if (m?.[1]) this.goalMemory.recordUnknownIdentifier(m[1]);
    }

    // Returns { solved, directProof, lemma } when a stored lemma closes the root goal
    // (verified by the current backend), else null. Reuse-by-name requires a NAMED stored
    // declaration — anonymous entries (`example …`) are skipped, never referenced by a
    // placeholder name.
    async tryRoot({ statement, lemmaId, graph, onReuse = null }) {
        if (!this.store || graph.isRootSolved()) return null;
        if (this.rejectMemo?.has(hashStatement(statement))) return null;
        const rootGoal = graph.currentGoal(graph.rootId);
        if (!rootGoal) return null;

        // Path A: exact normalized-conclusion match (cheapest, proven path).
        const stored = this.store.findByGoal(rootGoal.type);
        if (stored?.lemmaName) {
            const hit = await this._tryCandidate({ statement, stored, graph });
            if (hit?.result) {
                onReuse?.({ type: 'store_reuse', lemmaId, lemma: stored.lemmaName, via: 'exact' });
                return hit.result;
            }
        }

        // Path B: ranked retrieval fallback (§2.8 specialization/generalization, live). The
        // BM25 ranker over proved entries surfaces relevant lemmas when no identical
        // conclusion exists; each candidate is kernel-verified through the same variant chain,
        // under a global fresh-check cap. Ranked candidates are RETRIEVAL, never truth.
        if (this.rankedReuse && typeof this.store.rankByGoal === 'function') {
            const ranked = this.store.rankByGoal(rootGoal.type, rootGoal.context, { limit: this.rankLimit });
            let checks = 0;
            for (const cand of ranked) {
                if (!cand.lemmaName || cand.lemmaName === stored?.lemmaName) continue;
                const hit = await this._tryCandidate({ statement, stored: cand, graph, maxChecks: Math.max(1, this.maxRankedChecks - checks) });
                checks += hit?.checks ?? 0;
                if (hit?.result) {
                    onReuse?.({ type: 'store_reuse', lemmaId, lemma: cand.lemmaName, via: 'ranked', score: cand.score });
                    return hit.result;
                }
                if (checks >= this.maxRankedChecks) break;
            }
        }

        this.rejectMemo?.add(hashStatement(statement));
        this._recordUnknownIdentifier(this.lastRejectError ?? null);
        onReuse?.({ type: 'store_reuse_rejected', lemmaId, error: (this.lastRejectError?.message ?? 'verification failed')?.slice(0, 100) });
        return null;
    }

    // One candidate through the variant chain, kernel-verified. Returns { result, checks } on
    // success, null on failure. Fresh-only: reuse sources carry import lines and the repl
    // forbids `import` over an env continuation.
    async _tryCandidate({ statement, stored, graph, maxChecks = 4 }) {
        const storedHash = hashStatement(stored.statement);
        // Each variant pairs its assembled source with the directProof the commit gate must
        // record when THAT variant verifies: the by-name variants reference the stored lemma;
        // the body variants inline the stored proof, so their directProof is the proof itself.
        const variants = [
            { source: buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, closureOf: storedHash, includeClosureRoot: true }), directProof: `by exact ${stored.lemmaName}` },
            { source: buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript, closureOf: storedHash }), directProof: stored.proofScript },
            { source: buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}` }), directProof: `by exact ${stored.lemmaName}` },
            { source: buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript }), directProof: stored.proofScript }
        ];
        let checks = 0;
        for (const v of variants) {
            if (checks >= maxChecks) break;
            checks++;
            const check = await this.backend.check(v.source, { useWarmEnv: false });
            if (check.status === 'verified') {
                const rootClass = graph.classes.get(graph.rootId);
                if (rootClass) {
                    rootClass.state = 'SOLVED';
                    graph.setDirectProof(graph.rootId, v.directProof);
                }
                return { result: { solved: true, directProof: v.directProof, lemma: stored.lemmaName }, checks };
            }
            this.lastRejectError = check.error ?? null;
            this._recordUnknownIdentifier(check.error);
        }
        return { result: null, checks };
    }
}
