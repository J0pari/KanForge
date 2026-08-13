// Error-driven repair (APOLLO-style) per architecture.md §4, build_order.md §3.1.
//
// Structured-first classification (§4): the backend's LeanError carries `span` (file/line/col)
// and `subErrors`; when present they take precedence over the message regexes, which remain as
// the fallback for backends that only surface a string. The repair prompt includes the
// structured location so the model sees WHERE the kernel objected, not just what it said.
export function classifyError(error) {
    const span = error?.span ?? error?.location ?? null;
    const sub = error?.subErrors;
    const msg = error?.message ?? String(error);

    if (span) {
        // A span narrows the class: the model is told exactly where the kernel objected.
        return 'location';
    }
    if (Array.isArray(sub) && sub.length > 0) {
        // Nested errors usually arise from elaboration failures — the message alone would
        // conflate namespace and type problems; the sub-error text is the real signal.
        const subMsg = sub.map(s => s?.message ?? '').join(' ').toLowerCase();
        if (/unknown|not found/.test(subMsg)) return 'missing-lemma';
        if (/type|mismatch|failed to synthesize/.test(subMsg)) return 'type';
        return 'elaboration';
    }
    if (/syntax|unexpected|expected/i.test(msg)) return 'syntax';
    if (/type error|mismatch|failed to synthesize/i.test(msg)) return 'type';
    if (/unknown identifier|not found/i.test(msg)) return 'missing-lemma';
    return 'unknown';
}

export function buildRepairPrompt(goal, error, previousTactic) {
    const errorType = classifyError(error);
    const msg = error?.message ?? String(error);
    const span = error?.span ?? error?.location ?? null;
    const location = span
        ? ` at ${span.file ?? 'source'}:${span.line ?? '?'}:${span.col ?? '?'}`
        : '';
    return {
        system: `You are an expert Lean 4 repair assistant. The previous tactic "${previousTactic}" failed with a ${errorType} error${location}: ${msg}. Propose a corrected single tactic.`,
        user: `Goal:\n  ${goal.type}\n\nFailed tactic: ${previousTactic}\nError${location}: ${msg}\n\nPropose a corrected tactic:`
    };
}
