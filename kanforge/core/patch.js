// Typed mutation record — the patch algebra (architecture.md §2.7, build_order.md §5.9).
// The loop's core operation IS a typed graph mutation; the patch is the typed form of that
// operation, derived from the LIVE event stream (not a parallel dead type). Every loop event
// already carries the patch tuple's fields (node=goalClassId, replacement=tactic,
// meta=attempt/llmMs/tokens/via); patchFromEvent(e) is the pure projection into the typed form.
// The per-lemma patch stream is the transformation history (whitepaper §14), captured into the
// retrieval index + development digest.

export const PATCH_OPS = Object.freeze([
    'tactic',   // ONE tactic applied to a goal equivalence class (kernel check via applyTactic)
    'lemma',    // introduce a helper lemma (adds a pinned stub child at Level 1)
    'rewrite',  // alternative proof path (transposition-merge target; dedup, no tree mutation)
    'replace',  // replace a failing subproof subtree (tree-level repair, re-straighten)
    'reuse'     // apply a stored lemma from the retrieval index (§2.8)
]);

export class Patch {
    constructor({ node, op, replacement, scope = null, meta = {} }) {
        if (!PATCH_OPS.includes(op)) throw new Error(`unknown patch op: ${op}`);
        this.node = node;
        this.op = op;
        this.replacement = replacement;
        this.scope = scope;
        this.meta = meta;
    }
}

// Event-type → patch op. The loop emits outcome events that carry a tactic; the proposal event
// carries the meta (attempt/llmMs/tokens). Failure events are still patches — a failed tactic is
// a recorded mutation (the trace must show what was tried, not only what succeeded).
const EVENT_TO_OP = {
    tactic_proposed: 'tactic',
    tactic_applied: 'tactic',
    tactic_failed: 'tactic',
    repair_proposed: 'tactic',
    repair_applied: 'tactic',
    repair_failed: 'tactic',
    subgoal_created: 'tactic',
    goal_solved: 'tactic',
    lemma_verified: 'lemma',
    lemma_failed: 'lemma'
};

// Project a loop event into the typed mutation record. Pure: no state, no calls out.
//   node        ← goalClassId (or lemmaId for lemma-level events)
//   op          ← EVENT_TO_OP[e.type]
//   replacement ← e.tactic
//   scope       ← 'goal' | 'lemma'
//   meta        ← attempt / llmMs / promptTokens / completionTokens / via / error
export function patchFromEvent(e) {
    const op = EVENT_TO_OP[e?.type] ?? null;
    if (!op) return null;
    const meta = {};
    for (const k of ['attempt', 'llmMs', 'promptTokens', 'completionTokens', 'via', 'error']) {
        if (e[k] !== undefined && e[k] !== null) meta[k] = e[k];
    }
    return new Patch({
        node: e.goalClassId ?? e.lemmaId ?? null,
        op,
        replacement: e.tactic ?? null,
        scope: e.goalClassId != null ? 'goal' : 'lemma',
        meta
    });
}

// The per-lemma patch stream: projection of a lemma's events, in emit order, with the terminal
// verified/failed event last. Skips events that do not map to a patch op (telemetry only).
export function patchStreamFromEvents(events) {
    const out = [];
    for (const e of events ?? []) {
        const p = patchFromEvent(e);
        if (p) out.push(p);
    }
    return out;
}
