// ReuseEngine (architecture.md §4 role split, §2.8): the root-level lemma-store reuse path.
// Three escalating transfer modes, all kernel-gated:
//   1. Session transfer (cheap): `exact`/`apply`/`rw [<name>]` against the LIVE root goal —
//      the elaborator instantiates the stored lemma's binders by unification (the
//      specialization class: `Even (2^n)` closes `Even (2^(2^(k+1)))` via one `apply`).
//   2. Trajectory replay (reasoning transfer): replay the stored proof's tactic trajectory
//      against the root goal, kernel-checked per step, stopping on divergence — this moves
//      multi-step reasoning patterns, not conclusions.
//   3. Source inlining (authoritative): the assembled closure+declaration source, fresh-checked.
// Exact conclusion match runs first; ranked BM25 candidates second; the kernel is the sole
// accept authority for every mode.
import { hashStatement } from '../lean/pin.js';
import { buildReuseSource } from '../core/state.js';

const TRANSFER_OPS = [
    { name: 'exact', tactic: n => `exact ${n}`, via: 'exact' },
    { name: 'apply', tactic: n => `apply ${n}`, via: 'apply' },
    { name: 'rw', tactic: n => `rw [${n}]`, via: 'rw' }
];

export class ReuseEngine {
    constructor({ backend, store = null, rejectMemo = null, goalMemory = null, rankedReuse = true, rankLimit = 3, maxRankedChecks = 4, reuseTransfer = true, maxTransferOps = 4, maxInline = 24 } = {}) {
        this.backend = backend;
        this.store = store;
        this.rejectMemo = rejectMemo; // shared per-pass set (statement hash -> rejected): churned stubs skip the doomed re-check
        this.goalMemory = goalMemory; // campaign goal memory: reuse-level rejections feed the unknown-identifier veto channel
        this.rankedReuse = rankedReuse !== false; // §2.8 ranked fallback toggle (registry component)
        this.rankLimit = rankLimit; // top-K ranked fallback candidates (§2.8 specialization/generalization)
        this.maxRankedChecks = maxRankedChecks; // global fresh-check cap across ranked candidates
        this.reuseTransfer = reuseTransfer !== false; // session transfer operators + trajectory replay (registry component)
        this.maxTransferOps = maxTransferOps; // cap on session tactic applications per attempt
        this.maxInline = maxInline; // registry reuseMaxInline: inlined declarations per reuse source
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
            const hit = await this._tryCandidate({ statement, stored, graph, lemmaId, onReuse, rootGoal });
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
                const hit = await this._tryCandidate({ statement, stored: cand, graph, lemmaId, onReuse, rootGoal, maxChecks: Math.max(1, this.maxRankedChecks - checks) });
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

    // Session transfer (mode 1+2): apply the stored lemma to the LIVE root goal via the
    // leased proof session — `exact <name>` / `apply <name>` / `rw [<name>]`, then the stored
    // proof's tactic trajectory, kernel-checked per step. DETECTION ONLY: this phase never
    // mutates the goal graph (no patches, no state flips) — a transfer that closes in-session
    // still must verify a committable source variant, and a failed candidate must leave the
    // graph exactly as the caller's search expects it. Proof-state chaining is tracked locally
    // (frontier-head discipline, the same the loop's open[0] uses), stopping at divergence.
    // Returns { solved, transferOps } — solved is advisory; the variant loop decides the result.
    async _tryTransfer({ stored, lemmaId, onReuse, budget, rootGoal }) {
        const name = stored.lemmaName;
        let ops = 0;
        let current = rootGoal;
        const applyOne = async (tactic, via, { continueOnFail = false } = {}) => {
            if (ops >= budget) return { stop: true };
            ops++;
            const res = await this.backend.applyTactic(current, tactic);
            if (res.status !== 'ok') {
                this._recordUnknownIdentifier(res.error);
                onReuse?.({ type: 'store_reuse_transfer', lemmaId, lemma: name, tactic, via, ok: false, newGoals: 0 });
                // Fixed operators are independent attempts on the ORIGINAL goal — a failed
                // `exact` must not prevent trying `apply`. Trajectory steps chain proof states,
                // so their failure is divergence: stop.
                return { stop: !continueOnFail };
            }
            onReuse?.({ type: 'store_reuse_transfer', lemmaId, lemma: name, tactic, via, ok: true, newGoals: res.newGoals?.length ?? 0 });
            if ((res.newGoals?.length ?? 0) === 0) {
                return { stop: true, solved: true };
            }
            current = { ...res.newGoals[0], type: res.newGoals[0].type, context: res.newGoals[0].context ?? [], sessionKey: current?.sessionKey };
            return { stop: false };
        };

        if (this.reuseTransfer) {
            for (const op of TRANSFER_OPS) {
                current = rootGoal; // each operator is an independent attempt on the ORIGINAL goal
                const r = await applyOne(op.tactic(name), op.via, { continueOnFail: true });
                if (r.stop) return { solved: r.solved === true, transferOps: ops };
            }
            current = rootGoal; // the trajectory replays from the original goal
            const trajectory = stored.tacticTrajectory ?? [];
            for (const t of trajectory.slice(0, this.maxTransferOps)) {
                const r = await applyOne(t, 'trajectory');
                if (r.stop) return { solved: r.solved === true, transferOps: ops };
            }
        }
        return { solved: false, transferOps: ops };
    }

    // One candidate through the full transfer chain: session transfer first (cheap — the
    // elaborator instantiates binders by unification), then the source-inline variants
    // (authoritative whole-source verification). A session-close alone is NOT committable:
    // the commit gate re-verifies a complete source and the transferred name is not in scope
    // there — so every accepted path records the kernel-verified ASSEMBLED source as the
    // direct source (the commit gate verifies it instead of re-assembling). Returns
    // { result, checks, transferOps }.
    async _tryCandidate({ statement, stored, graph, lemmaId, onReuse, maxChecks = 4, rootGoal = null }) {
        // Mode 1+2 first: session ops are ~seconds; source checks are 30-200s fresh builds.
        const transfer = await this._tryTransfer({ stored, lemmaId, onReuse, budget: TRANSFER_OPS.length + this.maxTransferOps, rootGoal });

        const storedHash = hashStatement(stored.statement);
        // Each variant pairs its assembled source with the directProof the commit gate must
        // record when THAT variant verifies: the by-name variants reference the stored lemma;
        // the body variants inline the stored proof, so their directProof is the proof itself.
        // The verified source itself is recorded as the directSource (reuse prelude).
        const variants = [
            { source: buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, closureOf: storedHash, includeClosureRoot: true, maxInline: this.maxInline }), directProof: `by exact ${stored.lemmaName}` },
            { source: buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript, closureOf: storedHash, maxInline: this.maxInline }), directProof: stored.proofScript },
            { source: buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, maxInline: this.maxInline }), directProof: `by exact ${stored.lemmaName}` },
            { source: buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript, maxInline: this.maxInline }), directProof: stored.proofScript }
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
                    if (typeof graph.setDirectSource === 'function') graph.setDirectSource(graph.rootId, v.source);
                }
                return { result: { solved: true, directProof: v.directProof, lemma: stored.lemmaName }, checks, transferOps: transfer.transferOps };
            }
            this.lastRejectError = check.error ?? null;
            this._recordUnknownIdentifier(check.error);
        }
        // The session transfer may have closed the root in-graph, but without a verified
        // committable source the commit gate would reject the by-name script. No variant
        // verified -> the candidate fails; the graph's in-session progress is discarded by the
        // caller's failed lemma anyway.
        return { result: null, checks, transferOps: transfer.transferOps };
    }
}
