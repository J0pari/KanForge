// Goal-text parsing (architecture.md §3).
// The repl reports goals as a pretty-printed telescope followed by the turnstile target:
//
//     case succ                      <- optional case tag (from induction/cases)
//     a b c : Nat                    <- context entries; several names may share one type
//     h : a < b
//     ⊢ a < c                        <- the target type
//
// Both backends parse this exact format: the repl from `sorries[].goal` / tactic-mode
// `goals[]`, the CLI from `trace_state` / "unsolved goals" error blocks. One parser, one
// contract — keeping it shared is what lets the e-graph normalize goals from either backend.
//
// Goal = { type, context: [{ name, type }], caseName?, pos?, proofState? }

const TURNSTILE = '⊢';
const CASE_TAG = /^case\s+(\S+)\s*$/;

// Parse one pretty-printed goal block. Hypothesis continuations (a wrapped type) are joined
// onto the previous entry; anything before the first context entry that is not a case tag is
// treated as part of the case/header line and skipped.
export function parseGoalText(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const context = [];
    let type = '';
    let caseName = null;
    let inTarget = false;

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;

        const tIdx = line.indexOf(TURNSTILE);
        if (tIdx !== -1) {
            inTarget = true;
            type = line.slice(tIdx + TURNSTILE.length).trim();
            continue;
        }
        if (inTarget) {
            type += ' ' + line.trim(); // wrapped target type
            continue;
        }

        const tag = CASE_TAG.exec(line.trim());
        if (tag) {
            caseName = tag[1];
            continue;
        }

        const colon = line.indexOf(':');
        if (colon !== -1) {
            const names = line.slice(0, colon).trim().split(/\s+/).filter(Boolean);
            const entryType = line.slice(colon + 1).trim();
            if (names.length && entryType) {
                for (const name of names) context.push({ name, type: entryType });
                continue;
            }
        }

        // No colon and no turnstile: continuation of the previous entry's type, if any.
        if (context.length) {
            context[context.length - 1].type += ' ' + line.trim();
        }
    }

    return { type, context, caseName };
}

// Rebuild the binders telescope for statement reconstruction (CLI backend, proof scripts).
//   context [{name,type}] + target -> "(a b : Nat) (h : a < b)" etc.
export function formatBinders(context = []) {
    return context.map(({ name, type }) => `(${name} : ${type})`).join(' ');
}

// Split an "unsolved goals" CLI error block into individual goal blocks. Goals are separated
// by blank lines or by lines that introduce a new case tag after a target was seen.
export function splitGoalBlocks(text) {
    const blocks = [];
    let current = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        const isTag = CASE_TAG.test(line.trim());
        const isTurnstile = line.includes(TURNSTILE);
        const blank = !line.trim();
        if ((blank || isTag) && current.some(l => l.includes(TURNSTILE))) {
            blocks.push(current.join('\n'));
            current = [];
            if (blank) continue;
        }
        if (blank) continue;
        current.push(line);
        void isTurnstile;
    }
    if (current.length && current.some(l => l.includes(TURNSTILE))) {
        blocks.push(current.join('\n'));
    }
    return blocks;
}
