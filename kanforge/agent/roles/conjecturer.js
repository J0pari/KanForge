// Conjecturer role (architecture.md §7.3, §4): proposes subsidiary/open targets from a corpus
// entry, in the four target shapes the pipeline can consume — universal claim, witness discovery
// (prove-or-refute), equivalence/isomorphism, closed form. The role's output is always a strict
// JSON array of candidates; the autoformalizer then formalizes them. Purely propose — no proof
// attempt, no assertion.

export const CONJECTURE_KINDS = ['universal', 'witness', 'equivalence', 'closed_form'];

export function parseConjectureJson(text) {
    const t = String(text ?? '');
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    let start = candidate.indexOf('[');
    let end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON array in conjecturer output' };
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return { ok: false, error: 'conjecturer output is not parseable JSON' };
    }
    const out = [];
    for (const c of Array.isArray(parsed) ? parsed : []) {
        if (!c || typeof c !== 'object') continue;
        const kind = CONJECTURE_KINDS.includes(c.kind) ? c.kind : null;
        if (!kind || typeof c.statement !== 'string' || !c.statement.trim()) continue;
        out.push({ kind, statement: c.statement.trim(), rationale: typeof c.rationale === 'string' ? c.rationale : null });
    }
    return out.length > 0 ? { ok: true, candidates: out } : { ok: false, error: 'no well-formed candidates' };
}

export class Conjecturer {
    constructor({ llm, maxCandidates = 4 } = {}) {
        if (!llm) throw new Error('Conjecturer requires an llm client');
        this.llm = llm;
        this.maxCandidates = maxCandidates;
    }

    async propose(corpusEntry, { retries = 1 } = {}) {
        const entry = typeof corpusEntry === 'string' ? { statement: corpusEntry } : corpusEntry ?? {};
        const prompt = [
            {
                role: 'system',
                content: 'You are a research mathematician proposing Lean-4-formalizable targets from a problem statement.\n' +
                    `Propose up to ${this.maxCandidates} subsidiary conjectures in exactly these kinds:\n` +
                    '- "universal": a universal claim about the structure (∀ x, P x).\n' +
                    '- "witness": a prove-or-refute target — is some property universal? Needs a bounded candidate space.\n' +
                    '- "equivalence": two structures claimed isomorphic/equal.\n' +
                    '- "closed_form": an explicit value/construction claimed equal to a named quantity.\n' +
                    'Return ONLY a JSON array, no prose, no markdown fences:\n' +
                    '[{"kind": "<kind>", "statement": "<one-sentence Lean-4-friendly statement>", "rationale": "<why it matters>"}]'
            },
            {
                role: 'user',
                content: `Problem:\n${entry.statement ?? ''}\n\nPropose subsidiary conjectures worth proving or refuting.`
            }
        ];

        let lastError = null;
        for (let i = 0; i <= retries; i++) {
            try {
                const response = await this.llm.complete(prompt);
                const parsed = parseConjectureJson(response.text);
                if (parsed.ok) return parsed;
                lastError = parsed.error;
            } catch (err) {
                lastError = err.message ?? String(err);
            }
        }
        return { ok: false, error: lastError ?? 'conjecturer failed' };
    }
}
