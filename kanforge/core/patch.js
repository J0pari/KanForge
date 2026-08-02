// Typed patch envelope (architecture.md §2.7; Wave2 §4, Lean-relevant operator subset).
// Candidates are typed graph mutations, not source strings: reorderable, mergeable,
// discardable, replayable independently of source text.

export const PATCH_OPS = Object.freeze([
    'tactic',   // propose a tactic/script for a goal node (kernel check)
    'lemma',    // introduce a helper lemma (adds a pinned stub child)
    'rewrite',  // alternative proof path (transposition-merge target; dedup, no tree mutation)
    'replace'   // replace a failing subproof subtree (tree-level repair, re-straighten)
]);

export class Patch {
    constructor({ node, op, replacement, scope = null, meta = {} }) {
        this.node = node;
        this.op = op;
        this.replacement = replacement;
        this.scope = scope;
        this.meta = meta;
    }

    validate() {
        const errors = [];
        if (!this.node || typeof this.node !== 'string') {
            errors.push('patch.node must be a non-empty string id');
        }
        if (!PATCH_OPS.includes(this.op)) {
            errors.push(`patch.op must be one of ${PATCH_OPS.join(', ')}; got ${this.op}`);
        }
        if (this.op === 'lemma' && (!this.replacement || typeof this.replacement !== 'string')) {
            errors.push('lemma patch requires a replacement statement string');
        }
        if (this.replacement !== null && this.replacement !== undefined &&
            typeof this.replacement !== 'string') {
            errors.push('patch.replacement must be a string when present');
        }
        if (this.meta && typeof this.meta !== 'object') {
            errors.push('patch.meta must be an object');
        }
        return { ok: errors.length === 0, errors };
    }

    withMeta(extra) {
        return new Patch({
            node: this.node,
            op: this.op,
            replacement: this.replacement,
            scope: this.scope,
            meta: { ...this.meta, ...extra }
        });
    }
}
