// Best-of-N search baseline (architecture.md §5).
// Pre-filter stage (§5.3): when a compiled predictor matcher is supplied, a proposed tactic
// that completes a known-failing window is rejected BEFORE kernel verification — budget is
// spent on non-predictor branches, not on branches known to precede FAIL.
import { sanitizeTacticText } from '../agent/llm.js';
import { formatGoalPrompt } from '../agent/prompts.js';
import { tacticHead } from '../optimization/causal.js';
export async function bestOfN(goal, backend, llm, N = 8, predictors = null) {
    const history = [];
    let skipped = 0;
    for (let i = 0; i < N; i++) {
        const response = await llm.complete({ user: `${formatGoalPrompt(goal)}\n\nPropose tactic:` });
        const tactic = sanitizeTacticText(response.text);
        if (!tactic) continue;
        if (predictors?.rejects(tacticHead(tactic), history)) {
            skipped++;
            continue;
        }
        history.push(tacticHead(tactic));
        const result = await backend.applyTactic(goal, tactic);
        if (result.status === 'ok') {
            return { ok: true, tactic, result, skipped };
        }
    }
    return { ok: false, skipped };
}
