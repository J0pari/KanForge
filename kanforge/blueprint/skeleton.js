// Deterministic structural seed (architecture audit S2).
//
// Contract: from the theorem's SYNTAX alone, produce (a) the root stub and (b) mechanical
// unfoldings of the theorem's own statement — top-level conjunctions/iff/quantifier splits
// and the membership definitions of the set expressions the statement mentions. There is no
// planning essay and no LLM call in this module: the DAG seed contains no claim the kernel
// has not engaged with, and every child is kernel-typechecked and falsification-gated before
// it is merged. The search engine grows the DAG from here via kernel-verified artifacts only.
import fs from 'node:fs';
import path from 'node:path';
import { hashStatement } from '../lean/pin.js';
import { stripImports } from '../agent/roles/autoformalizer.js';
import { resolveModule, mathlibTreePresent } from '../lean/moduleResolver.js';
import { validateBlueprint } from './dag.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';

const AND = '\u2227'; // ∧
const IFF = '\u2194'; // ↔
const FORALL = '\u2200'; // ∀
const EXISTS = '\u2203'; // ∃
const IN = '\u2208'; // ∈
const NOTIN = '\u2209'; // ∉

// ---- pure statement-text parsing -------------------------------------------------------

// Strip the trailing `:= by sorry` (any body, really) from a stub.
export function stripStubBody(text) {
    return String(text ?? '').replace(/\s*:=\s*(?:by\s+.*?)?\s*$/s, '').trim();
}

// `theorem <name>` — the declaration name (first token after the keyword). Import lines may
// precede the declaration, so the match is not anchored to the start of the text.
export function theoremNameOf(statement) {
    const m = /(?:theorem|example)\s+([^\s:(]+)/.exec(String(statement ?? ''));
    return m ? m[1] : null;
}

// The proposition TYPE of a stub: everything after the first top-level colon (binder
// parentheses are at depth ≥ 1, so their colons are skipped), body already stripped.
export function typeOf(statement) {
    const text = stripStubBody(statement);
    const kw = /(?:theorem|example)\b/.exec(text);
    if (!kw) return null;
    let nameEnd = kw.index + kw[0].length;
    while (nameEnd < text.length && /\s/.test(text[nameEnd])) nameEnd++;
    while (nameEnd < text.length && !/[\s:(]/.test(text[nameEnd])) nameEnd++;
    let depth = 0;
    for (let i = nameEnd; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (ch === ':' && depth === 0) {
            return { type: text.slice(i + 1).trim(), binders: text.slice(nameEnd, i).trim() };
        }
    }
    return null;
}

// Top-level occurrences of a symbol (depth 0, outside any bracket group).
function topLevelSplits(text, sym) {
    const out = [];
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (depth === 0 && text.startsWith(sym, i)) out.push(i);
    }
    return out;
}

// The set expression after `Set.Infinite` in a statement (handles `<|`, `(`, and bare forms).
function setExpressionOf(statement) {
    const text = stripStubBody(statement);
    const k = text.indexOf('Set.Infinite');
    if (k === -1) return null;
    let i = k + 'Set.Infinite'.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('<|', i)) i += 2;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] === '(') {
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '(') depth++;
            else if (text[j] === ')') {
                depth--;
                if (depth === 0) return text.slice(i + 1, j).trim();
            }
        }
        return null;
    }
    return text.slice(i).trim();
}

// Substitute a variable name in a proposition text (token-boundary aware).
function replaceIdent(text, name, replacement) {
    const isIdChar = c => /[A-Za-z0-9_'.\u03b1-\u03c9\u03b1\u0391-\u03a9]/.test(c);
    let out = '';
    let i = 0;
    while (i < text.length) {
        const j = text.indexOf(name, i);
        if (j === -1) {
            out += text.slice(i);
            break;
        }
        const before = j > 0 ? text[j - 1] : '';
        const after = text[j + name.length] ?? '';
        if (!isIdChar(before) && !isIdChar(after)) {
            out += text.slice(i, j) + replacement;
        } else {
            out += text.slice(i, j + name.length);
        }
        i = j + name.length;
    }
    return out;
}

// Binder groups of a top-level quantifier: `∀ (x : T) (y : U), rest` or the bare
// `∀ x y : T, rest` form. Returns { binders: [{name, type, prop?}], rest } for the first
// quantifier, or null when a binder is untyped (the mechanical seed never guesses a type).
function isIdentStart(c) {
    return /[A-Za-z_\u03b1-\u03c9\u0391-\u03a9]/.test(c);
}

function isIdentChar(c) {
    return /[A-Za-z0-9_\u03b1-\u03c9\u0391-\u03a9']/.test(c);
}

function quantifierHead(typeText, qsym) {
    const text = typeText.trim();
    if (!text.startsWith(qsym)) return null;
    let i = qsym.length;
    const binders = [];
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === '(') {
            let depth = 0;
            let j = i;
            for (; j < text.length; j++) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            if (j >= text.length) return null;
            const inner = text.slice(i + 1, j).trim();
            const colon = inner.indexOf(':');
            if (colon === -1) return null;
            const names = inner.slice(0, colon).trim().split(/\s+/).filter(Boolean);
            const type = inner.slice(colon + 1).trim();
            if (!names.length || !type) return null;
            if (names.length === 1 && names[0] === '_') {
                binders.push({ name: null, type, prop: true });
            } else {
                for (const n of names) binders.push({ name: n, type, prop: false });
            }
            i = j + 1;
        } else if (isIdentStart(text[i] ?? '')) {
            // bare binder form `name+ : Type` — the type runs to the top-level comma
            const names = [];
            let k = i;
            while (k < text.length) {
                let k2 = k;
                while (k2 < text.length && isIdentChar(text[k2])) k2++;
                names.push(text.slice(k, k2));
                k = k2;
                while (k < text.length && /\s/.test(text[k])) k++;
                if (k < text.length && text[k] === ':') break;
                if (k < text.length && isIdentStart(text[k])) continue;
                return null; // untyped binder — refuse to guess
            }
            if (k >= text.length || text[k] !== ':') return null;
            k++;
            while (k < text.length && /\s/.test(text[k])) k++;
            let depth = 0;
            let tEnd = k;
            for (; tEnd < text.length; tEnd++) {
                const ch = text[tEnd];
                if (ch === '(' || ch === '{' || ch === '[') depth++;
                else if (ch === ')' || ch === '}' || ch === ']') depth--;
                else if (ch === ',' && depth === 0) break;
            }
            const type = text.slice(k, tEnd).trim();
            if (!type) return null;
            for (const n of names) binders.push({ name: n, type, prop: false });
            i = tEnd;
        } else {
            break; // the body begins — binder list ended
        }
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === ',') {
            i++;
            continue;
        }
        break;
    }
    const rest = text.slice(i).replace(/^\s*,\s*/, '').trim();
    if (!rest) return null;
    return { binders, rest };
}

// Membership unfolding for the set-expression shapes the statement may mention:
//   A \ B          →  x ∈ A ∧ x ∉ B
//   {v : T | P}    →  P[v := x]
// Returns [{ name, claim }] — the claim is the proposition type (binders applied by the
// caller), one child per set node. Any other shape is left for the search engine.
function unfoldSetMembership(setExpr, theoremName, xVar) {
    const children = [];
    let counter = 0;
    const nextName = () => `${theoremName}_mem${counter++}`;

    const visit = (S) => {
        const s = S.trim();
        // Difference at top level.
        const diffSplits = topLevelSplits(s, '\\');
        const diff = diffSplits.find(idx => {
            const left = s.slice(0, idx).trim();
            return left.length > 0;
        });
        if (diff !== undefined && diff > 0) {
            const A = s.slice(0, diff).trim();
            const B = s.slice(diff + 1).trim();
            if (A && B) {
                children.push({
                    name: nextName(),
                    claim: `\u2200 ${xVar}, ${xVar} ${IN} (${s}) \u2194 ${xVar} ${IN} (${A}) ${AND} ${xVar} ${NOTIN} (${B})`
                });
            }
            visit(A);
            visit(B);
            return;
        }
        // Set-of: {v : T | P}
        if (s.startsWith('{')) {
            let depth = 0;
            let bar = -1;
            for (let i = 0; i < s.length; i++) {
                if (s[i] === '{') depth++;
                else if (s[i] === '}') {
                    depth--;
                    if (depth === 0) {
                        if (bar === -1) return;
                        const binderText = s.slice(1, bar).trim();
                        const P = s.slice(bar + 1, i).trim();
                        const colon = binderText.indexOf(':');
                        const v = colon === -1 ? binderText : binderText.slice(0, colon).trim();
                        if (!P || !v) return;
                        children.push({
                            name: nextName(),
                            claim: `\u2200 ${xVar}, ${xVar} ${IN} (${s}) \u2194 ${replaceIdent(P, v, xVar)}`
                        });
                        return;
                    }
                } else if (s[i] === '|' && depth === 1) {
                    bar = i;
                }
            }
            return;
        }
        // Named set (identifier): nothing mechanical to unfold.
    };

    visit(setExpr);
    return children;
}

// The full deterministic split of a theorem statement. Returns child stubs that are
// pure unfoldings of the statement's own syntax — nothing else. Declaration binders are
// lifted into every child so each stub is self-contained.
export function syntacticSplit(statement) {
    const children = [];
    const rootDeps = [];
    const parsed = typeOf(statement);
    if (!parsed) return { children, rootDeps };
    const type = parsed.type;
    const binders = parsed.binders;
    const binderPrefix = binders ? ` ${binders} ` : ' ';
    const name = theoremNameOf(statement) ?? 'seed';

    // 1. Top-level iff: two direction implications.
    const iffSplits = topLevelSplits(type, IFF);
    if (iffSplits.length > 0) {
        const i = iffSplits[0];
        const L = type.slice(0, i).trim();
        const R = type.slice(i + 1).trim();
        if (L && R) {
            children.push(
                { name: `${name}_mp`, statement: `theorem ${name}_mp${binderPrefix}: ${L} \u2192 ${R} := by sorry` },
                { name: `${name}_mpr`, statement: `theorem ${name}_mpr${binderPrefix}: ${R} \u2192 ${L} := by sorry` }
            );
            rootDeps.push(`${name}_mp`, `${name}_mpr`);
            return { children, rootDeps };
        }
    }

    // 2. Top-level conjunction: the conjuncts.
    const andSplits = topLevelSplits(type, AND);
    if (andSplits.length > 0) {
        const parts = [];
        let start = 0;
        for (const i of andSplits) {
            parts.push(type.slice(start, i).trim());
            start = i + 1;
        }
        parts.push(type.slice(start).trim());
        if (parts.every(p => p.length > 0)) {
            parts.forEach((p, j) => {
                const childName = `${name}_conj${j}`;
                children.push({ name: childName, statement: `theorem ${childName}${binderPrefix}: ${p} := by sorry` });
                rootDeps.push(childName);
            });
            return { children, rootDeps };
        }
    }

    // 3. Top-level universal: the body as a child carrying the binders.
    const uni = quantifierHead(type, FORALL);
    if (uni) {
        const qbinders = uni.binders.map(b => b.prop ? `(_ : ${b.type})` : `(${b.name} : ${b.type})`).join(' ');
        const childName = `${name}_body`;
        children.push({ name: childName, statement: `theorem ${childName}${binderPrefix}${qbinders} : ${uni.rest} := by sorry` });
        rootDeps.push(childName);
        return { children, rootDeps };
    }

    // 4. Top-level existential: the witness body as a child carrying the binders.
    const exi = quantifierHead(type, EXISTS);
    if (exi) {
        const qbinders = exi.binders.map(b => b.prop ? `(_ : ${b.type})` : `(${b.name} : ${b.type})`).join(' ');
        const childName = `${name}_witness`;
        children.push({ name: childName, statement: `theorem ${childName}${binderPrefix}${qbinders} : ${exi.rest} := by sorry` });
        rootDeps.push(childName);
        return { children, rootDeps };
    }

    // 5. Set.Infinite: the membership unfoldings of the set expression the theorem names.
    const setExpr = setExpressionOf(statement);
    if (setExpr) {
        for (const c of unfoldSetMembership(setExpr, name, 'x')) {
            children.push({ name: c.name, statement: `theorem ${c.name}${binderPrefix}: ${c.claim} := by sorry` });
            rootDeps.push(c.name);
        }
    }

    return { children, rootDeps };
}

// ---- stub normalization (unchanged contract) ------------------------------------------

export function normalizeStub(statement) {
    let s = String(statement).trim();
    s = s.replace(/\s*:=\s*(?:by\s+.*?)?\s*$/s, '').trim();
    s = s.replace(/^\s*lemma\s+/m, 'theorem ');
    return `${s} := by sorry`;
}

export function extractImports(statement) {
    const lines = String(statement ?? '').split(/\r?\n/);
    return lines.filter(l => /^\s*import\s+\S/.test(l)).join('\n');
}

// ---- the generator --------------------------------------------------------------------

export class SkeletonGenerator {
    constructor({ backend, outDir = null } = {}) {
        if (!backend) {
            throw new Error('SkeletonGenerator requires a real backend');
        }
        this.backend = backend;
        this.outDir = outDir;
    }

    async _tryCheck(statement) {
        const stripped = stripImports(statement);
        const fast = await this.backend.check(stripped, { useWarmEnv: true });
        if (fast.status === 'verified') return fast;
        return this.backend.check(statement);
    }

    async generate(theoremStatement, opts = {}) {
        const rootStatement = normalizeStub(theoremStatement);
        const rootCheck = await this._tryCheck(rootStatement);
        if (rootCheck.status !== 'verified') {
            return { ok: false, error: `theorem does not typecheck: ${rootCheck.error?.message ?? rootCheck.error ?? 'unknown error'}`, blueprint: null };
        }

        const theoremImports = extractImports(theoremStatement).split('\n').map(l => l.replace(/^\s*import\s+/, '').trim()).filter(Boolean);
        const groundedTactic = mathlibTreePresent()
            ? STUB_TACTIC_MODULES.map(resolveModule).filter(Boolean)
            : STUB_TACTIC_MODULES;
        const allImports = [...new Set([...theoremImports, ...groundedTactic])];
        const imports = allImports.map(m => `import ${m}`).join('\n');

        const warnings = [];
        const rootId = hashStatement(rootStatement);
        const byId = new Map([[rootId, { id: rootId, statement: rootStatement, name: 'theorem', deps: [] }]]);
        const nameToId = new Map();

        const { children, rootDeps } = syntacticSplit(rootStatement);
        for (const cand of children) {
            const withImports = imports.length ? imports + '\n\n' + cand.statement : cand.statement;
            const stub = normalizeStub(withImports);
            const id = hashStatement(stub);
            if (id === rootId || byId.has(id)) {
                nameToId.set(cand.name, id);
                continue;
            }
            const check = await this._tryCheck(stub);
            if (check.status !== 'verified') {
                warnings.push(`dropped child ${cand.name}: does not typecheck (${check.error?.message ?? check.error})`);
                continue;
            }
            // Falsification gate: even a syntactic unfolding is kernel-gated before merge.
            if (opts.falsify && typeof opts.falsify.enabled === 'function') {
                const verdict = await opts.falsify.enabled(stub);
                if (verdict.falsified) {
                    warnings.push(`FALSIFIED child ${cand.name}: counterexample \`${verdict.counterexample}\` verified by the kernel`);
                    continue;
                }
            }
            byId.set(id, { id, statement: stub, name: cand.name, deps: [] });
            nameToId.set(cand.name, id);
        }

        const root = byId.get(rootId);
        root.deps = [...new Set(rootDeps.map(d => nameToId.get(d)).filter(id => id && id !== rootId))];

        const lemmas = [...byId.values()].map(n => ({ id: n.id, statement: n.statement, deps: n.deps, pinnedHash: n.id }));
        const blueprint = { theorem: rootStatement, lemmas };

        const audit = validateBlueprint(blueprint);
        if (!audit.ok) {
            return { ok: false, errors: audit.errors, warnings };
        }
        if (this.outDir) this._write(blueprint);
        return { ok: true, blueprint, warnings };
    }

    _write(blueprint) {
        fs.mkdirSync(this.outDir, { recursive: true });
        fs.writeFileSync(path.join(this.outDir, 'blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
        fs.writeFileSync(path.join(this.outDir, 'blueprint.md'), this._renderMarkdown(blueprint));
    }

    _renderMarkdown(blueprint) {
        const lines = ['# Blueprint', '', '## Theorem', '', '```lean', blueprint.theorem, '```', '', `## Lemmas (${blueprint.lemmas.length})`, ''];
        for (const l of blueprint.lemmas) {
            lines.push(`### ${l.id.slice(0, 10)}\u2026`, '', '```lean', l.statement, '```', '', `- Deps: ${l.deps.map(d => `\`${d.slice(0, 10)}\u2026\``).join(', ') || '(none)'}`, `- Pin: \`${l.pinnedHash}\``, '');
        }
        return lines.join('\n');
    }
}
