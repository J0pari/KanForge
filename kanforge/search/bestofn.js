// Best-of-N search baseline (architecture.md §5).
import { sanitizeTacticText } from '../agent/llm.js';
import { formatGoalPrompt } from '../agent/prompts.js';
export async function bestOfN(goal, backend, llm, N = 8) {
    for (let i = 0; i < N; i++) {
        const response = await llm.complete({ user: `${formatGoalPrompt(goal)}\n\nPropose tactic:` });
        const tactic = sanitizeTacticText(response.text);
        if (!tactic) continue;
        const result = await backend.applyTactic(goal, tactic);
        if (result.status === 'ok') {
            return { ok: true, tactic, result };
        }
    }
    return { ok: false };
}
