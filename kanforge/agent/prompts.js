// Prompt builder from Lean terms (architecture.md §4).
export function buildTacticPrompt(goal, attempt, maxAttempts = 8) {
    const contextStr = goal.context && goal.context.length > 0
        ? `\nContext:\n${goal.context.map(c => `  ${c.name} : ${c.type}`).join('\n')}`
        : '';
    
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. Examples: "intro h", "omega", "simp [h]", "apply foo", "cases h".'
        },
        {
            role: 'user',
            content: `Goal:\n  ${goal.type}${contextStr}\n\nPropose ONE tactic (attempt ${attempt}/${maxAttempts}):`
        }
    ];
}
