// Prompt builder from Lean terms (architecture.md §4).
//
// Shared goal renderer: `Goal:\n  <type>` + a Context block of hypotheses when present. All
// proposal prompts must show the context — a root goal for `example (p q r : Prop) (h : p ∨ q)
// ... : r` is type `r`, which is unprovable without the telescope in scope (the multi-step tier
// in bench/stepSmoke.js, §5.4, lives on this).
export function formatGoalPrompt(goal) {
    const contextStr = goal.context && goal.context.length > 0
        ? `\nContext:\n${goal.context.map(c => `  ${c.name} : ${c.type}`).join('\n')}`
        : '';
    return `Goal:\n  ${goal.type}${contextStr}`;
}

// Proposal-unit constraint schema (architecture.md §4.1): the granularity one LLM response may
// propose and the act stage enforces, expressed as data so every prompt path renders the same
// constraint. `maxAtoms` is the number of kernel-applicable tactic atoms per response. The live
// value is 1 — the multi-atom (macro) axis is staged (build_order.md §5.11) — but the schema is
// the single place the constraint lives, not scattered prompt strings.
export const PROPOSAL_SPEC = { maxAtoms: 1 };

export function proposalSystemMessage() {
    return 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. Examples: "intro h", "omega", "simp [h]", "apply foo", "cases h".';
}

export function proposalImperative(attempt, maxAttempts, spec = PROPOSAL_SPEC) {
    const unit = spec.maxAtoms === 1 ? 'ONE tactic' : `up to ${spec.maxAtoms} tactics, one per line`;
    return `Propose ${unit} (attempt ${attempt}/${maxAttempts}):`;
}

export function buildTacticPrompt(goal, attempt, maxAttempts = 8) {
    return [
        { role: 'system', content: proposalSystemMessage() },
        { role: 'user', content: `${formatGoalPrompt(goal)}\n\n${proposalImperative(attempt, maxAttempts)}` }
    ];
}
