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

export function buildTacticPrompt(goal, attempt, maxAttempts = 8) {
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. Examples: "intro h", "omega", "simp [h]", "apply foo", "cases h".'
        },
        {
            role: 'user',
            content: `${formatGoalPrompt(goal)}\n\nPropose ONE tactic (attempt ${attempt}/${maxAttempts}):`
        }
    ];
}
