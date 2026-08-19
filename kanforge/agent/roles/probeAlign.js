// Align partial probe-example lists with their candidate instances. The probe builder may omit
// candidates whose proposition it cannot verify; index alignment is then lost, so each example
// is matched MECHANICALLY against its instance label: the example text contains the literal
// `(N : Nat) ∈` / `(N : Nat) ∉` pair, from which the number and membership direction are read
// (no LLM text is trusted beyond what the kernel already verified).
const IN_SYM = String.fromCharCode(0x2208); // ∈
const NOT_IN_SYM = String.fromCharCode(0x2209); // ∉

const PATTERN = new RegExp('\\(\\s*(\\d+)\\s*:\\s*Nat\\s*\\)\\s*([\u2208\u2209])');

export function alignPartialExamples(examples, instances) {
    const out = [];
    for (const ex of examples ?? []) {
        const m = String(ex).match(PATTERN);
        if (m) {
            const n = parseInt(m[1], 10);
            const isNot = m[2] === NOT_IN_SYM;
            out.push({
                example: ex,
                instance: `the number ${n} is ${isNot ? 'not ' : ''}an element of the set`
            });
        } else {
            out.push({ example: ex, instance: null });
        }
    }
    return out;
}
