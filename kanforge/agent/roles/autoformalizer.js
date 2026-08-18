// Autoformalizer role (architecture.md §0.1, build_order.md §7.1).
// The §0 front door: prose target → kernel-typechecked Lean statement, with behavioral probes,
// consensus, and a pin. This is the formalization PIPELINE, not a translation call.
//
// Efficiency contract (no floundering): the expensive resource is the kernel check (cold worker
// + mathlib imports). Every candidate is STATICALLY validated before it ever reaches the kernel
// (zero-cost catches: malformed JSON, missing `:= by sorry`, unbalanced brackets, inline `open`).
// The LLM output is a STRICT JSON contract, so parsing is deterministic. Repair is CLASSIFIED
// (parse / structure / typecheck / probe) and targeted, not a raw error dump. Probes are
// generated in ONE batched LLM call. The backend is warmed with the target's imports once, so
// statement + probe checks reuse the same warm worker (import cost paid at most once).

import { hashStatement, makePin } from '../../lean/pin.js';
import { swissRank, parseJudgeVerdict } from '../../search/swiss.js';
import { normalizeFormalization, suggestImportsForError, SYMBOL_MODULES } from './normalize.js';
import { LOGICAL_OPS } from '../../search/tacticMenu.js';

// LOGICAL_OPS is the canonical operator set (search/tacticMenu.js): → ↔ ∨ ∧ ¬ ∀ ∃.
// The shape classifier treats ↔ (and its relation variants ≃ ≅ ⇔) as the equivalence signal,
// ∃ as witness-discovery, and a stripped propositional `=` as closed-form; default universal.
const SHAPE_SUPPLEMENT = /[≃≅⇔]/;

// --- static validation (zero kernel cost) ---

// True when the statement is structurally a valid single-theorem sorry-stub. Catches the
// "expected token" class BEFORE the repl is touched.
export function staticValidateStatement(text) {
    const s = String(text ?? '').trim();
    if (!s) return { ok: false, reason: 'empty statement' };
    if (!/^import\s+\S+/m.test(s) && !/^theorem\b|^example\b/.test(s.replace(/^import[^\n]*\n/gm, '').trim())) {
        return { ok: false, reason: 'no theorem/example declaration' };
    }
    const stripped = s.replace(/^import\s+[^\n]*\n?/gm, '');
    const body = stripped.trim();
    if (!/^(theorem|example)\b/.test(body)) return { ok: false, reason: 'statement must be `theorem` or `example`' };
    if (/(^|\n)\s*open\s+(scoped\s+)?\w/.test(body)) {
        return { ok: false, reason: 'inline `open` is not allowed; put module access in `import` lines only' };
    }
    if (!/:=\s*by\s+sorry\s*$/.test(body)) return { ok: false, reason: 'statement must end with `:= by sorry`' };
    if (/sorry/.test(body.replace(/:=\s*by\s+sorry\s*$/, ''))) return { ok: false, reason: '`sorry` may appear only in the final body' };
    // balanced brackets (parens, braces, brackets, angle brackets) — cheap structural sanity.
    const stack = [];
    const pairs = { ')': '(', '}': '{', ']': '[', '⟩': '⟨', '⟩': '⟨' };
    for (const ch of body) {
        if (ch === '(' || ch === '{' || ch === '[' || ch === '⟨') stack.push(ch);
        else if (ch === ')' || ch === '}' || ch === ']' || ch === '⟩') {
            if (stack.pop() !== pairs[ch]) return { ok: false, reason: `unbalanced bracket near "${ch}"` };
        }
    }
    if (stack.length) return { ok: false, reason: 'unbalanced brackets (unclosed opener)' };
    return { ok: true };
}

// Parse the LLM's STRICT JSON output: { "imports": [...], "theorem": "..." }.
// Tolerates code fences and leading prose before the first '{'.
export function parseFormalizationJson(text) {
    const t = String(text ?? '');
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    let start = candidate.indexOf('{');
    let end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in LLM output' };
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return { ok: false, error: 'LLM output is not parseable JSON' };
    }
    const theorem = typeof parsed.theorem === 'string' ? parsed.theorem.trim() : null;
    const imports = Array.isArray(parsed.imports) ? parsed.imports.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];
    if (!theorem) return { ok: false, error: 'JSON has no `theorem` string' };
    return { ok: true, imports, theorem };
}

// Assemble the full statement text (imports + theorem) for the kernel check.
export function assembleStatement(imports, theorem) {
    const imp = imports.map(i => `import ${i}`).join('\n');
    return (imp ? imp + '\n\n' : '') + theorem;
}

// Strip import lines (for checks that continue a warm session — the env already has them).
export function stripImports(statement) {
    return String(statement ?? '').split(/\r?\n/).filter(l => !/^\s*import\s+\S/.test(l)).join('\n').trim();
}

// Instance-ledger extraction from a FormalConjectures source file: the `@[category test]`
// theorems are the author's membership instances. Each becomes an instance string for the
// autoformalizer's probe step — phrased against the SET IN THE STATEMENT (the LLM probe
// builder resolves the concrete decidable example against the statement's set literal).
export function extractTestInstancesFromFc(fcText) {
    const out = [];
    const blocks = String(fcText ?? '').split(/(?=@\[category test\])/g);
    for (const b of blocks) {
        const m = b.match(/theorem\s+\w+[\s\S]*?:\s*(\d+)\s*(∈|∉)\s*([A-Za-z_][A-Za-z0-9_.']*)/);
        if (!m) continue;
        out.push({ n: Number(m[1]), in: m[2] === '∈' });
    }
    return out;
}

// Instance strings for the ledger/probe step from extracted membership facts. Phrased
// generically — the set literal does not exist until the statement is formalized; the
// formalization prompt and the probe builder both consume these.
export function instanceStringsFor(facts) {
    return facts.map(f => `the number ${f.n} ${f.in ? 'is' : 'is not'} an element of the set described in the statement`);
}

// --- prompts ---

function buildFormalizationPrompt(prose, instances, repair = null) {
    const instText = (instances?.length ?? 0)
        ? `\n\nAsserted instances (the instance ledger — each must hold under your formalization):\n${instances.map(i => `- ${i}`).join('\n')}`
        : '';
    const repairText = repair
        ? `\n\nYour previous attempt was rejected:\n- stage: ${repair.stage}\n- reason: ${repair.reason}`
          + (repair.candidate ? `\n\nYour previous theorem text (verbatim, this is what failed):\n\`\`\`\n${repair.candidate}\n\`\`\`` : '')
          + (repair.suggestModules?.length ? `\n- Add these imports (the symbol is missing from the current environment): ${repair.suggestModules.join(', ')}` : '')
          + (repair.notationFix ? `\n- Rewrite: ${repair.notationFix}` : '')
          + '\nFix ONLY what the reason identifies and return the corrected JSON.'
        : '';
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 formalization expert. Given a mathematical problem statement in prose, produce a formal Lean 4 theorem statement.\n' +
                'Return ONLY a JSON object, no prose, no markdown fences:\n' +
                '{"imports": ["Mathlib.<module>", ...], "theorem": "theorem <name> : <proposition> := by sorry"}\n' +
                'Rules:\n' +
                '- `imports` lists ONLY the mathlib modules the statement needs.\n' +
                '- `theorem` is exactly ONE statement ending in `:= by sorry`; body is exactly `by sorry`, never proved.\n' +
                '- Do NOT strengthen or weaken the proposition.\n' +
                '- Do NOT use `open`/`open scoped`; modules come via imports only.\n' +
                '- Use only identifiers available in mathlib.' +
                instText + repairText
        },
        {
            role: 'user',
            content: `Formalize this problem statement as a Lean 4 theorem statement:\n\n${prose}`
        }
    ];
}

function buildProbePrompt(statement, instances) {
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 formalization verifier. Given a formal statement and asserted instances, produce Lean `example` statements that verify each instance holds under the proposition.\n' +
                'Return ONLY a JSON object, no prose, no markdown fences:\n' +
                '{"examples": ["example ... : <instance proposition> := by <tactics>", ...]}\n' +
                'Rules:\n' +
                '- One example per asserted instance, same length.\n' +
                '- Do NOT assume the theorem; each example must be an independent kernel-checked claim.\n' +
                '- Use `by native_decide` / `norm_num` / `omega` / `simp` when the instance is decidable.\n' +
                '- Use the SAME imports as the statement.'
        },
        {
            role: 'user',
            content: `Statement:\n${statement}\n\nAsserted instances:\n${instances.join('\n')}`
        }
    ];
}

export function parseProbeJson(text, expectedCount) {
    const t = String(text ?? '');
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    let start = candidate.indexOf('{');
    let end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in probe output' };
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return { ok: false, error: 'probe output is not parseable JSON' };
    }
    const examples = Array.isArray(parsed.examples) ? parsed.examples.filter(x => typeof x === 'string') : [];
    if (examples.length !== expectedCount) {
        return { ok: false, error: `expected ${expectedCount} probe examples, got ${examples.length}` };
    }
    return { ok: true, examples };
}

export class Autoformalizer {
    // checkTimeoutMs: the kernel check on a COLD worker imports mathlib; warm via backend
    // warmupStatement (intake harness builds the pool with the target's imports) so the paid
    // cost is at most once. The timeout must cover that first import.
    constructor({ llm, backend, maxAttempts = 2, checkTimeoutMs = 180_000, onAttempt = null } = {}) {
        if (!llm || !backend) throw new Error('Autoformalizer requires a real llm client and a real backend');
        this.llm = llm;
        this.backend = backend;
        this.maxAttempts = maxAttempts;
        this.checkTimeoutMs = checkTimeoutMs;
        this.onAttempt = onAttempt; // per-attempt observability: ({ attempt, stage, reason, candidate, suggestModules })
    }

    _attempt(attempt, last) {
        this.onAttempt?.({
            attempt,
            stage: last?.stage ?? null,
            reason: last?.reason ?? null,
            candidate: last?.candidate ?? null,
            suggestModules: last?.suggestModules ?? []
        });
    }

    // formalize(prose, { instances, source }) → { ok, statement, shortlistEntry, error? }
    // pipeline: propose (strict JSON) → static-validate → kernel-check → probes (batched) →
    // entry. Repair is classified and targeted; maxAttempts bounds the loop.
    async formalize(prose, { instances = [], source = null } = {}) {
        let last = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const proposed = await this._propose(prose, instances, last);
            if (!proposed.ok) {
                last = { stage: 'parse', reason: proposed.error };
                this._attempt(attempt, last);
                continue;
            }
            // Normalize the candidate: resolve imports to modules that exist in the pinned
            // mathlib, and normalize the theorem text (unicode/LaTeX/ASCII → canonical Lean).
            // Merge any repair-suggested modules (missing-symbol fixes) into the import set,
            // PREFERRING them over the LLM's heavy imports (the suggested module is the light
            // symbol-providing one, e.g. Data.Finset.Sum over BigOperators.Group.Finset.Defs).
            const extraImports = last?.suggestModules ?? [];
            const suggested = new Set(extraImports);
            const proposedImports = [...extraImports, ...(proposed.imports ?? []).filter(i => !suggested.has(i))];
            const normalized = normalizeFormalization(proposedImports, proposed.theorem);
            if (!normalized.imports.length && proposedImports.length > 0) {
                last = { stage: 'imports', reason: `no proposed import resolved: ${proposedImports.join(', ')}; propose modules that exist in mathlib` };
                this._attempt(attempt, last);
                continue;
            }
            const statement = normalized.statement;
            const staticCheck = staticValidateStatement(statement);
            if (!staticCheck.ok) {
                last = { stage: 'structure', reason: staticCheck.reason };
                this._attempt(attempt, last);
                continue;
            }
            // Warm the pool with the candidate's imports BEFORE the check: the cold mathlib
            // import is paid once here, and statement + probe checks continue the SAME
            // statement-mode session (useWarmEnv) — no re-import per check.
            let verdict;
            try {
                if (this.backend.warm) {
                    await this.backend.warm(statement, { timeoutMs: this.checkTimeoutMs });
                }
                verdict = await this._verifyStatement(statement);
            } catch (err) {
                // A thrown check/warm error (e.g. repl timeout with kind: 'timeout') is a repair
                // signal, never a crash: surface it so the light-import fallback below can
                // suggest lighter modules for the next attempt.
                verdict = { ok: false, error: `${err?.kind === 'timeout' ? 'timeout' : 'check error'}: ${err?.message ?? String(err)}` };
            }
            if (!verdict.ok) {
                // If the failure is a missing symbol ("environment does not contain X") OR a
                // timeout on a heavy import, suggest the light module(s) that provide the
                // statement's symbols so the next attempt uses them instead.
                let suggest = suggestImportsForError(verdict.error);
                if (!suggest && /timeout|timed out/i.test(verdict.error ?? '')) {
                    // Heavy import blew the budget: suggest the light module for any known symbol
                    // in the statement, and drop the heavy imports.
                    for (const sym of Object.keys(SYMBOL_MODULES)) {
                        if (statement.includes(sym)) {
                            const e = SYMBOL_MODULES[sym];
                            suggest = { symbol: sym, modules: e.modules, notationFix: e.notationFix ?? null };
                            break;
                        }
                    }
                }
                last = suggest
                    ? { stage: 'typecheck', reason: verdict.error, candidate: statement, suggestModules: suggest.modules, notationFix: suggest.notationFix ?? null }
                    : { stage: 'typecheck', reason: verdict.error, candidate: statement };
                this._attempt(attempt, last);
                continue;
            }
            const probes = await this._verifyProbes(statement, instances);
            if (!probes.ok) {
                // Per §0.1: a probe failure is a formalization failure WITH evidence, never
                // silently corrected — but a fixable probe-set is retried once (targeted).
                last = { stage: 'probe', reason: probes.error };
                this._attempt(attempt, last);
                if (attempt < this.maxAttempts) continue;
                return { ok: false, error: probes.error, probes: probes.results ?? [], shortlistEntry: null };
            }
            this._attempt(attempt, { stage: 'verified', reason: 'kernel typecheck + probes' });
            return {
                ok: true,
                statement,
                shortlistEntry: this._entry(statement, prose, { source, instances, probes: probes.results, attempts: attempt })
            };
        }
        return { ok: false, error: last ? `${last.stage}: ${last.reason}` : 'formalization failed', shortlistEntry: null };
    }

    async _propose(prose, instances, repair = null) {
        try {
            const resp = await this.llm.complete(buildFormalizationPrompt(prose, instances, repair));
            return parseFormalizationJson(resp?.text);
        } catch (err) {
            return { ok: false, error: `LLM call failed: ${err?.message ?? String(err)}` };
        }
    }

    async _verifyStatement(statement) {
        // Try the fast chained path first (strip imports, warm env — 0.4s). If the repl quirk
        // surfaces for this particular statement shape, fall back to the fresh-env path (full
        // statement with imports — cold, ~200s but correct).
        const stripped = stripImports(statement);
        const fast = await this.backend.check(stripped, { timeoutMs: this.checkTimeoutMs, useWarmEnv: true });
        if (fast.status === 'verified') return { ok: true };
        if (!/expected token/i.test(fast.error?.message ?? '')) {
            const msg = String(fast.error?.message ?? fast.error ?? 'unknown error');
            return { ok: false, error: msg.slice(0, 1500) };
        }
        // Repl quirk: fall back to fresh env with imports.
        const fresh = await this.backend.check(statement, { timeoutMs: this.checkTimeoutMs, useWarmEnv: false });
        if (fresh.status === 'verified') return { ok: true };
        const msg = String(fresh.error?.message ?? fresh.error ?? 'unknown error');
        return { ok: false, error: msg.slice(0, 1500) };
    }

    // One batched LLM call produces all probe examples; each is kernel-checked on the warm
    // worker. A failed probe is recorded WITH evidence (never silently corrected).
    async _verifyProbes(statement, instances) {
        if (!instances?.length) return { ok: true, results: [] };
        try {
            const resp = await this.llm.complete(buildProbePrompt(statement, instances));
            const parsed = parseProbeJson(resp?.text, instances.length);
            if (!parsed.ok) return { ok: false, error: parsed.error };
            const results = [];
            for (let i = 0; i < instances.length; i++) {
                const full = parsed.examples[i];
                const example = stripImports(full);
                let verified = false, error = null;
                try {
                    const fast = await this.backend.check(example, { timeoutMs: this.checkTimeoutMs, useWarmEnv: true });
                    if (fast.status === 'verified') {
                        verified = true;
                    } else if (/expected token/i.test(fast.error?.message ?? '')) {
                        const fresh = await this.backend.check(full, { timeoutMs: this.checkTimeoutMs, useWarmEnv: false });
                        verified = fresh.status === 'verified';
                        error = verified ? null : (fresh.error?.message ?? 'unverified');
                    } else {
                        error = fast.error?.message ?? 'unverified';
                    }
                } catch (err) {
                    error = err?.message ?? String(err);
                }
                results.push({ instance: instances[i], example, verified, error });
            }
            const failed = results.filter(r => !r.verified);
            return failed.length ? { ok: false, error: `probe failed: ${failed[0].instance} (${failed[0].error ?? 'unverified'})`, results } : { ok: true, results };
        } catch (err) {
            return { ok: false, error: `probe LLM call failed: ${err?.message ?? String(err)}` };
        }
    }

    _entry(statement, prose, { source = null, instances = [], probes = [], attempts }) {
        return {
            source,
            prose,
            statement,
            statementHash: hashStatement(statement),
            status: 'formalized',
            attempts,
            probes,
            justification: {
                formalizability: probes.length ? 'kernel-typechecked, probes verified' : 'kernel-typechecked',
                substrateCost: estimateSubstrateCost(statement, { probes }),
                shape: this._shapeOf(statement),
                novelty: null // no-known-proof evidence; filled by intake (absent-from-mathlib check)
            }
        };
    }

    _shapeOf(statement) {
        // Strip the declaration suffix (`:= by sorry`) and binder colons: a shape-classifying
        // `=` is a propositional equality, not syntax.
        const s = String(statement ?? '').replace(/:=\s*by\s+sorry\s*$/i, '').replace(/:\s*[A-Za-z_][A-Za-z0-9_.]*/g, '');
        // LOGICAL_OPS (search/tacticMenu.js) is the canonical logical-operator vocabulary; the
        // shape priorities follow architecture.md §0.2: equivalence → witness-discovery →
        // closed-form → universal. ↔ and its relation variants (≃≅⇔) are the equivalence signal;
        // ∃ is witness-discovery; a stripped propositional `=` is closed-form.
        for (const op of LOGICAL_OPS) {
            if (s.includes(op)) {
                if (op === '↔') return 'equivalence';
                if (op === '∃') return 'witness-discovery';
            }
        }
        if (SHAPE_SUPPLEMENT.test(s)) return 'equivalence';
        if (s.includes('=')) return 'closed-form';
        return 'universal-claim';
    }

    // Consensus (§0.1.4, P7.1 d3): TWO independent formalizations of the same prose, then a
    // swiss pairwise judge ranks which is more faithful. Agreement is not required for entry —
    // the winner is, and both statements are returned so a human (or the kernel) can adjudicate.
    async consensusFormalize(prose, { instances = [], source = null } = {}) {
        const A = await this.formalize(prose, { instances, source });
        const B = await this.formalize(prose, { instances, source });
        if (!A.ok || !B.ok) {
            return { ok: false, error: `dual formalization incomplete: A=${A.ok ? 'ok' : A.error}, B=${B.ok ? 'ok' : B.error}`, A, B };
        }
        const judge = buildStatementJudge(prose, { llm: this.llm });
        const ranking = await swissRank([A.statement, B.statement], judge);
        const winnerKey = ranking[0]?.candidate === A.statement ? 'A' : 'B';
        return {
            ok: true,
            A: A.statement,
            B: B.statement,
            agreement: A.statement === B.statement,
            ranking,
            winner: winnerKey === 'A' ? A.statement : B.statement,
            winnerEntry: winnerKey === 'A' ? A.shortlistEntry : B.shortlistEntry,
            bothEntries: [A.shortlistEntry, B.shortlistEntry]
        };
    }

    // Assumption ledger + pin commit (§0.1.4, P7.1 d4): every asserted instance is recorded with
    // its kernel verification evidence; the formalized statement is pinned to the backend
    // context so a later environment drift trips the pin rather than silently re-verifying.
    assumptionLedger(statement, instances, probeResults = []) {
        const results = new Map((probeResults ?? []).map(r => [r.instance, r]));
        return (instances ?? []).map(inst => {
            const r = results.get(inst);
            return { instance: inst, verified: r?.verified ?? false, example: r?.example ?? null, error: r?.error ?? null };
        });
    }

    async commitPin(statement, ledger) {
        const pin = makePin(statement, this.backend.pin?.() ?? {});
        return { pin, ledgerHash: hashStatement(JSON.stringify(ledger)) };
    }
}

// Substrate-cost estimate (§7.2): the statement's definitional footprint — how many distinct
// identifiers it references, how heavy its import profile is, and how many probe checks its
// verification demanded. An ESTIMATE for mission selection, not a measured cost: the true cost
// is measured at prove time (metrics.secondsPerTheorem).
export function estimateSubstrateCost(statement = '', { probes = [] } = {}) {
    const s = String(statement);
    const importLines = (s.match(/^import\s+([^\n]+)/gm) ?? []);
    const imports = importLines.flatMap(l => l.replace(/^import\s+/, '').split(/\s+/)).filter(Boolean);
    const identifiers = new Set();
    const tokens = s.split(/[^A-Za-z0-9_'\\]+/).filter(Boolean);
    for (const t of tokens) {
        if (t.length >= 3 && !/^(theorem|example|import|by|sorry)$/.test(t)) identifiers.add(t);
    }
    const heavyImport = imports.filter(i => /BigOperators|Topology|MeasureTheory|Analysis|Algebra\.(Group|Ring)\.Finset/.test(i)).length;
    return {
        defNodes: identifiers.size,
        importCount: imports.length,
        heavyImports: heavyImport,
        probeChecks: probes.length,
        estimate: identifiers.size + imports.length * 2 + heavyImport * 4 + probes.length,
        unit: 'relative (estimate, not a measured cost)'
    };
}

// A swiss-rankable judge over formalized STATEMENTS (fidelity to the prose), the A↔B consensus
// comparator. Reuses the swiss ranker; verdicts parse exactly like tactic-pair judgments.
export function buildStatementJudge(prose, { llm } = {}) {
    if (!llm) throw new Error('buildStatementJudge requires an llm client');
    return async (a, b) => {
        try {
            const response = await llm.complete([
                { role: 'system', content: 'You judge which Lean 4 formalization is more faithful to the prose problem statement. Return only A, B, or EQUAL.' },
                { role: 'user', content: `Prose:\n${prose}\n\nFormalization A:\n${a}\n\nFormalization B:\n${b}\n\nMore faithful: A, B, or EQUAL?` }
            ]);
            return parseJudgeVerdict(response.text);
        } catch {
            return null; // a null verdict is a draw — swissRank handles it
        }
    };
}
