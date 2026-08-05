// Goedel-style diversity penalty (architecture.md §5).
import { sanitizeTacticText } from '../agent/llm.js';
export function computeRepulsionPenalty(tactic, activeTactics) {
    let penalty = 0.0;
    for (const t of activeTactics) {
        if (t === tactic) penalty += 0.5;
    }
    return penalty;
}

// Diversity-aware proposal sampler: wraps an llm and refuses to re-propose tactics already
// attempted (exact-duplicate repulsion, the actionable form of the Goedel penalty). When a
// `tried` list is supplied it is also echoed into the prompt so the generator can steer away
// from known failures instead of wasting kernel checks on them.
export class RepulsionSampler {
    constructor({ llm, maxTries = 16 } = {}) {
        if (!llm) throw new Error('RepulsionSampler requires an llm');
        this.llm = llm;
        this.maxTries = maxTries;
    }

    // propose(prompt, { tried }) -> Promise<string | null>
    // Returns the first tactic not already in `tried`, or null once maxTries draws produce no
    // fresh tactic. `tried` must be an iterable of tactic strings.
    async propose(prompt, { tried = [] } = {}) {
        const triedSet = new Set(tried);
        const augmented = triedSet.size > 0 ? augmentPrompt(prompt, triedSet) : prompt;
        for (let i = 0; i < this.maxTries; i++) {
            const response = await this.llm.complete(augmented);
            const tactic = sanitizeTacticText(response.text);
            if (tactic && !triedSet.has(tactic)) return tactic;
        }
        return null;
    }
}

// Append a "do not repeat" note to prompts of the shapes used in this codebase: a string, a
// `{ user: string }` object, or a message-array whose last user message carries the text.
function augmentPrompt(prompt, tried) {
    const note = 'Already attempted (do not repeat any of these):\n' + [...tried].map(t => `- ${t}`).join('\n');
    if (typeof prompt === 'string') return `${prompt}\n\n${note}`;
    if (prompt && typeof prompt === 'object') {
        if (typeof prompt.user === 'string') return { ...prompt, user: `${prompt.user}\n\n${note}` };
        if (Array.isArray(prompt)) {
            return prompt.map((m, i) =>
                m.role === 'user' && i === prompt.length - 1
                    ? { ...m, content: `${m.content}\n\n${note}` }
                    : m
            );
        }
    }
    return prompt;
}
