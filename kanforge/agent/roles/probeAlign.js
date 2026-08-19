// Align partial probe-example lists with their candidate instances. The probe builder may omit
// candidates whose proposition it cannot verify; index alignment is then lost, so each example
// is matched MECHANICALLY against its instance label: the example text contains the literal
// membership direction (`example : N ∉ ...` or `example : (N : Nat) ∈ ...`), from which the
// number and direction are read (no LLM text is trusted beyond what the kernel already verified).
const IN_SYM = String.fromCharCode(0x2208); // ∈
const NOT_IN_SYM = String.fromCharCode(0x2209); // ∉

// Handles both `example : 1 ∉ S` and `example : (1 : Nat) ∉ S` (the type ascription is optional).
const PATTERN = new RegExp('example\\s*:\\s*\\(?\\s*(\\d+)\\s*(?::\\s*[\\w\u2115. ]+)?\\)?\\s*([\u2208\u2209])');

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
