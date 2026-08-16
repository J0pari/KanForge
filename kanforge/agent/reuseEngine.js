// ReuseEngine (architecture.md §4 role split, §2.8): the root-level lemma-store reuse path. A
// previously-proven lemma whose conclusion matches the root goal is inlined — declaration +
// proof + its DEPENDENCY CLOSURE (the stored proof references its own lemmas, so the closure
// must be declared for the combined source to verify in a fresh env) — and proved by
// `exact <name>`; the kernel re-verifies the combined source, so retrieval never bypasses
// verification and cross-problem reuse works in any fresh session.
import { hashStatement } from '../lean/pin.js';
import { buildReuseSource } from '../core/state.js';

export class ReuseEngine {
    constructor({ backend, store = null, rejectMemo = null, goalMemory = null }) {
        this.backend = backend;
        this.store = store;
        this.rejectMemo = rejectMemo; // shared per-pass set (statement hash -> rejected): churned stubs skip the doomed re-check
        this.goalMemory = goalMemory; // campaign goal memory: reuse-level rejections feed the unknown-identifier veto channel
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
        const stored = this.store.findByGoal(rootGoal.type);
        if (!stored?.lemmaName) return null;
        // Degrade chain: full dependency closure first; if the kernel rejects the assembled
        // source (a foreign stored entry can be malformed), fall back progressively.
        // FRESH-ONLY: reuse sources carry import lines and the repl forbids `import` over an
        // env continuation (the warm path can never accept them — a warm attempt is doomed
        // spend plus a wasted wipe of the warm chain).
        // Variants: (1) closure + stored lemma, referenced by name; (2) closure deps + the
        // stored proof inlined AS THE TARGET'S BODY (no by-name reference — this is the
        // name-collision and hypothesis-transfer path, e.g. when the target stub shares the
        // stored lemma's name); (3) by-name, target alone; (4) body, target alone.
        const storedHash = hashStatement(stored.statement);
        const variants = [
            buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}`, closureOf: storedHash, includeClosureRoot: true }),
            buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript, closureOf: storedHash }),
            buildReuseSource({ store: this.store, statement, proofScript: `by exact ${stored.lemmaName}` }),
            buildReuseSource({ store: this.store, statement, proofScript: stored.proofScript })
        ];
        let check = null;
        for (const combined of variants) {
            check = await this.backend.check(combined, { useWarmEnv: false });
            if (check.status === 'verified') break;
        }
        if (check.status !== 'verified') {
            this.rejectMemo?.add(hashStatement(statement));
            // The kernel's rejection reason is campaign-scoped evidence: an undeclared
            // identifier here means every future tactic referencing it is vetoed before
            // kernel spend (the commit gate's channel — fed here too, since reuse rejects
            // BEFORE the commit gate ever runs).
            this._recordUnknownIdentifier(check.error);
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
