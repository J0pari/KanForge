// Premise retrieval + premise-locked flag (architecture.md §5, build_order.md §5.2).
//
// LeanDojo-style relevance scoring over a premise corpus, implemented as the standard
// non-learned lexical baseline (BM25) — the bar any learned retriever must beat and the
// only option until the Mathlib-enabled repl (P0.1) provides a real corpus. A "premise" is
// `{ name, type }` (e.g. `{ name: 'Nat.add_comm', type: '(a b : Nat) : a + b = b + a' }`).
// The retriever scores each premise against the current goal (its type plus context) and
// returns the top-k. `premiseLocked` then restricts the generator to those premises: the
// tactic prompt lists them as the only permitted theorems, and a commit-time guard checks
// that the assembled proof script references no unretrieved premise.

// Lean-aware tokenizer: keeps unicode identifiers and numbers (including single-letter
// math variables like `a`, `b`, `x`, `n` — they carry the signal in arithmetic goals),
// splits `snake_case` and camelCase into sub-tokens, and lowercases.
export function tokenize(text) {
    const tokens = [];
    for (const m of String(text ?? '').matchAll(/[\p{L}\p{N}_]+/gu)) {
        const words = m[0].replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[_ ]+/);
        for (const w of words) {
            const t = w.toLowerCase();
            if (t) tokens.push(t);
        }
    }
    return tokens;
}

// Raw dotted-identifier extraction (for the premise-lock check, which must match full
// names like `Nat.add_comm`, not the split tokens the scorer uses).
export function extractIdentifiers(source) {
    return [...String(source ?? '').matchAll(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu)].map(m => m[0]);
}

// A premise is referenced by its full name or any dotted suffix (`mul_comm` for
// `Nat.mul_comm`, `add_comm` for `Nat.add_comm`). Map every alias to its canonical name.
function aliasKeys(name) {
    const parts = String(name).split('.');
    const keys = new Set();
    for (let i = 0; i < parts.length; i++) keys.add(parts.slice(i).join('.'));
    return keys;
}

export function buildPremiseAliases(corpus) {
    const aliases = new Map();
    for (const p of corpus ?? []) {
        const name = p?.name;
        if (!name) continue;
        for (const k of aliasKeys(name)) {
            if (!aliases.has(k)) aliases.set(k, name);
        }
    }
    return aliases;
}

// Corpus premise names referenced by a proof source (exact + dotted-suffix aliases).
export function premisesUsedIn(source, corpus) {
    const aliases = buildPremiseAliases(corpus);
    const used = new Set();
    for (const id of extractIdentifiers(source)) {
        const name = aliases.get(id);
        if (name) used.add(name);
    }
    return [...used];
}

// Premise-lock guard: names used by the source but missing from the retrieved set are
// violations. Tactics and goal/context symbols are not corpus premise names, so they never
// false-positive — only actual corpus theorems count.
export function findPremiseLockViolations(source, corpus, retrievedNames = []) {
    const retrieved = new Set(retrievedNames.filter(Boolean));
    return premisesUsedIn(source, corpus).filter(n => !retrieved.has(n));
}

function idf(n, df) {
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

export class PremiseRetriever {
    constructor(corpus = []) {
        this.corpus = [];
        this._tokens = [];
        this._df = null;
        this._avgdl = 0;
        for (const p of corpus ?? []) this.addPremise(p);
    }

    addPremise(p) {
        if (p && (p.name ?? '') !== '') {
            this.corpus.push(p);
            this._tokens.push(tokenize(`${p.name} ${p.type ?? ''}`));
            this._df = null;
        }
    }

    _build() {
        const df = new Map();
        let totalLen = 0;
        for (const toks of this._tokens) {
            for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
            totalLen += toks.length;
        }
        this._df = df;
        this._avgdl = this.corpus.length > 0 ? totalLen / this.corpus.length : 0;
    }

    _queryTokens(goal) {
        const type = goal?.type ?? '';
        const context = goal?.context ?? [];
        return tokenize([type, ...context.map(c => `${c.name} ${c.type}`)].join(' '));
    }

    // BM25 relevance: score every premise against the goal's token bag, return the top-k
    // with positive score, sorted by descending score (ties broken by name for determinism).
    retrieve(goal, topK = 5) {
        if (this._df === null) this._build();
        if (this.corpus.length === 0) return [];

        const query = this._queryTokens(goal);
        if (query.length === 0) return [];

        const q = new Set(query);
        const n = this.corpus.length;
        const avgdl = this._avgdl || 1;
        const k1 = 1.5;
        const b = 0.75;

        const scored = this.corpus.map((p, i) => {
            const toks = this._tokens[i];
            const tf = new Map();
            for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
            const dl = toks.length || 1;

            let score = 0;
            for (const t of q) {
                const f = tf.get(t) ?? 0;
                if (f === 0) continue;
                const w = idf(n, this._df.get(t) ?? 0);
                const denom = f + k1 * (1 - b + b * (dl / avgdl));
                score += w * ((f * (k1 + 1)) / denom);
            }
            return { name: p.name, type: p.type ?? '', score };
        });

        scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        return scored.filter(r => r.score > 0).slice(0, topK);
    }
}

// Prompt builder that injects retrieved premises. `premiseLocked` restricts the generator
// to the listed premises (build_order.md §5.2); with no premises it degrades to the plain
// tactic prompt (agent/prompts.js shape).
export function buildPremisePrompt(goal, premises = [], opts = {}) {
    const { attempt = 1, maxAttempts = 8, premiseLocked = false } = opts;
    const contextStr = goal?.context?.length > 0
        ? `\nContext:\n${goal.context.map(c => `  ${c.name} : ${c.type}`).join('\n')}`
        : '';
    const premisesStr = premises.length > 0
        ? `\n\nPremises (theorems you may use):\n${premises.map(p => `  - ${p.name} : ${p.type}`).join('\n')}`
        : '';

    const system = premiseLocked
        ? 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. You may ONLY use the premises listed under "Premises" — do not reference any other theorem.'
        : 'You are a Lean 4 proof assistant. Given a goal, propose ONE tactic to make progress. Reply with ONLY the tactic, no explanation or markdown formatting. Examples: "intro h", "omega", "simp [h]", "apply foo", "cases h".';

    return [
        { role: 'system', content: system },
        { role: 'user', content: `Goal:\n  ${goal?.type ?? ''}${contextStr}${premisesStr}\n\nPropose ONE tactic (attempt ${attempt}/${maxAttempts}):` }
    ];
}

// --- Premise-aware proposal-prompt augmentation (ablation harness, build_order.md §5.2) ---
// The search strategies build their own proposal prompts from `goal.type` and call
// llm.complete() directly. To measure premise retrieval with/without WITHOUT touching every
// strategy, a wrapper intercepts proposal prompts at the llm boundary, retrieves premises for
// the goal, and routes them through buildPremisePrompt — mirroring what TacticLoop does
// internally. Judge prompts are never augmented (they compare tactics, they do not propose).

// Extract the prompt text from any shape this codebase passes to llm.complete(): an array of
// { role, content }, a `{ user }` object, or a bare string.
export function promptText(prompt) {
    if (typeof prompt === 'string') return prompt;
    if (Array.isArray(prompt)) {
        const last = prompt.findLast(p => p.role === 'user');
        return String(last?.content ?? '');
    }
    return String(prompt?.user ?? '');
}

// Pure: pull the goal type out of the proposal-prompt shapes the strategies emit, or null when
// the prompt is not a tactic-proposal (swiss judge). Handles:
//   "Goal: a * (b + c) = ...\nPropose tactic:"   (bestofn / swiss)
//   "Goal:\n  a * (b + c) = ...\nPropose ONE tactic (attempt 1/8):"  (bfs / mcgs)
// Premise-augmented prompts are NOT excluded: the wrapper chain is premises-outermost /
// menu-innermost, so the menu augmenter sees premise-rebuilt prompts and must still extract
// the goal (it appends the menu in place, never re-rebuilding the premise section).
export function parseProposalGoal(prompt) {
    const text = promptText(prompt);
    if (!text) return null;
    if (/Judge which/.test(text)) return null;                    // swiss judge, never augmented
    const m = text.match(/^Goal:\s*\n?\s*([^\n]+)/);
    return m ? m[1].trim() : null;
}

// llm wrapper: augments proposal prompts with retrieved premises (build_order.md §5.2 "with"
// side of the ablation). `premiseLocked` restricts the generator to the retrieved set.
export class PremiseAugmentingLLM {
    constructor(llm, retriever, { premiseLocked = false, premiseTopK = 5 } = {}) {
        if (!llm || !retriever) throw new Error('PremiseAugmentingLLM requires an llm and a retriever');
        this.llm = llm;
        this.retriever = retriever;
        this.premiseLocked = premiseLocked;
        this.premiseTopK = premiseTopK;
        this.retrievedFor = new Map();
    }

    async complete(prompt, opts = {}) {
        const goalType = parseProposalGoal(prompt);
        if (goalType !== null) {
            const premises = this.retriever.retrieve({ type: goalType }, this.premiseTopK);
            this.retrievedFor.set(goalType, premises.map(p => p.name));
            const augmented = buildPremisePrompt({ type: goalType }, premises, {
                attempt: 1,
                maxAttempts: 8,
                premiseLocked: this.premiseLocked
            });
            return this.llm.complete(augmented, opts);
        }
        return this.llm.complete(prompt, opts);
    }
}
