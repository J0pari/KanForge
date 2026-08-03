// Error-driven repair (APOLLO-style) per architecture.md §4, build_order.md §3.1.
export function classifyError(error) {
    const msg = error?.message ?? String(error);
    if (/syntax|unexpected|expected/i.test(msg)) return 'syntax';
    if (/type error|mismatch|failed to synthesize/i.test(msg)) return 'type';
    if (/unknown identifier|not found/i.test(msg)) return 'missing-lemma';
    return 'unknown';
}

export function buildRepairPrompt(goal, error, previousTactic) {
    const errorType = classifyError(error);
    return {
        system: `You are an expert Lean 4 repair assistant. The previous tactic "${previousTactic}" failed with a ${errorType} error: ${error.message}. Propose a corrected single tactic.`,
        user: `Goal:\n  ${goal.type}\n\nFailed tactic: ${previousTactic}\nError: ${error.message}\n\nPropose a corrected tactic:`
    };
}
