// Statement normalization (architecture.md §0.1, build_order.md §7.1).
// Conversion helpers that make the autoformalizer input-format-agnostic: the LLM may emit
// unicode math (ℕ ∀ ∃), LaTeX (\mathbb{N}, \forall, \exists), or ASCII (Nat, forall, Exists).
// normalizeStatement maps any of these to a canonical Lean form the kernel accepts.
//
// The repl has a known fragility: `∃`/`∀` with unicode type symbols (ℕ) in a statement that
// FOLLOWS a mathlib import can parse as "expected token". Normalizing to ASCII type names
// (Nat, Int) and keeping quantifier symbols (∃/∀ are valid Lean) avoids the failure, and the
// module resolver ensures the import itself is valid.

import { resolveModule, mathlibTreePresent } from '../../lean/moduleResolver.js';
import { loadSymbolIndex, querySymbolIndex, SYMBOL_INDEX_CACHE_NAME } from '../../lean/symbolIndex.js';
import path from 'node:path';

// Unicode math type symbols → ASCII Lean type names (only in type positions; these symbols do
// not appear as identifiers elsewhere, so global replacement is safe).
const UNICODE_TYPES = {
    'ℕ': 'Nat', 'ℤ': 'Int', 'ℝ': 'Real', 'ℚ': 'Rat', 'ℂ': 'Complex',
    '𝔽': 'F', 'ℍ': 'Hamiltonian', '𝕊': 'S', '𝔸': 'A', '𝔹': 'B',
    'ℙ': 'P', 'ℤ₊': 'PNat', 'ℕ₊': 'PNat'
};

// LaTeX math macros → Lean/unicode symbols.
const LATEX_MACROS = [
    [/\\mathbb\{N\}/g, 'Nat'], [/\\mathbb\{Z\}/g, 'Int'], [/\\mathbb\{R\}/g, 'Real'],
    [/\\mathbb\{Q\}/g, 'Rat'], [/\\mathbb\{C\}/g, 'Complex'],
    [/\\mathbb\{F\}/g, 'F'],
    [/\\exists/g, '∃'], [/\\forall/g, '∀'], [/\\leq|\\leqslant|\\le/g, '≤'],
    [/\\geq|\\geqslant|\\ge/g, '≥'], [/\\neq|\\ne/g, '≠'], [/\\in/g, '∈'],
    [/\\notin/g, '∉'], [/\\subseteq/g, '⊆'], [/\\to|\\rightarrow|\\implies/g, '→'],
    [/\\wedge|\\land/g, '∧'], [/\\vee|\\lor/g, '∨'], [/\\neg/g, '¬'],
    [/\\sum/g, '∑'], [/\\prod/g, '∏'], [/\\infty/g, '∞'],
    [/\\cdot/g, '·'], [/\\times/g, '×'], [/\\circ/g, '∘'],
    [/\\left/g, ''], [/\\right/g, ''], [/\\,/g, ' '],
    [/\\\{/g, '{'], [/\\\}/g, '}'], [/\\_/g, '_'], [/\\&/g, '&'],
    [/\\\(/g, ''], [/\\\)/g, ''], [/\\\[/g, ''], [/\\\]/g, '']
];

// ASCII keywords → Lean symbols (for LaTeX-ish ASCII: forall → ∀, exists → ∃, le → ≤).
const ASCII_KEYWORDS = [
    [/\bforall\b/g, '∀'], [/\bexists\b/g, '∃'], [/\bimplies\b/g, '→'],
    [/\band\b/g, '∧'], [/\bor\b/g, '∨'], [/\bnot\b/g, '¬'],
    [/\ble\b/g, '≤'], [/\bge\b/g, '≥'], [/\bne\b/g, '≠'], [/\bin\b/g, '∈']
];

// Apply the conversion layers in dependency order: LaTeX first (it emits unicode), then unicode
// types → ASCII, then ASCII keywords → symbols (guarded so it does not double-convert).
export function normalizeStatement(text) {
    let s = String(text ?? '');
    // 1. LaTeX macros → unicode symbols.
    for (const [re, rep] of LATEX_MACROS) s = s.replace(re, rep);
    // 2. Unicode type symbols → ASCII Lean type names.
    for (const [u, a] of Object.entries(UNICODE_TYPES)) s = s.split(u).join(a);
    // 3. ASCII math keywords → symbols (only whole-word, so `forall` in an identifier stays).
    for (const [re, rep] of ASCII_KEYWORDS) s = s.replace(re, rep);
    // 4. Structural cleanup: collapse whitespace, ensure single-line `:= by sorry`.
    s = s.replace(/[ \t\r\n]+/g, ' ').trim();
    s = s.replace(/:=\s*by\s+sorry\s*$/i, ':= by sorry');
    return s;
}

// Normalize a single theorem/example statement's structure: strip `open scoped`/`open` lines,
// strip fences, and ensure the statement is a single `theorem|example ... := by sorry`.
export function normalizeStatementText(text) {
    let s = String(text ?? '').trim();
    s = s.replace(/^```(?:lean)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Remove `open` / `open scoped` lines (modules come via imports only).
    s = s.split(/\r?\n/).filter(l => !/^\s*open\s+(scoped\s+)?\w/.test(l)).join('\n');
    return normalizeStatement(s);
}

// Normalize the full statement (imports + theorem): resolve imports via the module resolver and
// normalize the theorem text. Returns { ok, imports, theorem, statement }.
export function normalizeFormalization(imports, theorem) {
    const resolvedImports = (imports ?? []).map(i => resolveModule(i)).filter(Boolean);
    const theoremText = normalizeStatementText(theorem);
    const statement = (resolvedImports.length ? resolvedImports.map(i => `import ${i}`).join('\n') + '\n\n' : '') + theoremText;
    return { ok: true, imports: resolvedImports, theorem: theoremText, statement };
}

// Missing-symbol → mathlib module suggestions. The primary path is the DERIVED symbol index
// (lean/symbolIndex.js, built from the pinned mathlib source — architecture.md §0.1 item 6):
// any constant/identifier the kernel rejects is looked up mechanically. The curated table below
// keeps ONLY what the index cannot derive: notation fixes (a module version changed the
// notation, e.g. `s.sum f` → `∑ x ∈ s, f x`) and non-constant type symbols (`ℕ`).
export const SYMBOL_MODULES = {
    'Finset.sum': { modules: ['Mathlib.Algebra.BigOperators.Ring.Finset'], notationFix: 'use the big-operator notation `∑ x ∈ s, f x` instead of `s.sum f`' },
    'Finset.card': { modules: ['Mathlib.Data.Finset.Card'], notationFix: 'use `s.card` (valid) — or `Finset.card s`' },
    'Set.Infinite': { modules: ['Mathlib.Data.Set.Finite'] },
    'Even': { modules: ['Mathlib.Algebra.Ring.Parity'] },
    'ℕ': { modules: ['Mathlib.Data.Nat.Basic'] }
};

// Lazy default index: loaded once from the lean project cache. A missing cache degrades to the
// curated table (and the build script bench/buildSymbolIndex.js produces the cache).
let _defaultIndex = undefined;
export function defaultSymbolIndex() {
    if (_defaultIndex !== undefined) return _defaultIndex;
    try {
        const env = globalThis.process?.env;
        const project = env?.KANFORGE_LEAN_PROJECT;
        _defaultIndex = project ? loadSymbolIndex(path.join(project, SYMBOL_INDEX_CACHE_NAME)) : null;
    } catch {
        _defaultIndex = null;
    }
    return _defaultIndex;
}

// Given a Lean error message, return { symbol, modules, notationFix?, derived, treeVerified }
// for the first recognized missing symbol, or null. Curated notation fixes take precedence when
// they exist (they point to the light module AND carry the rewrite — strictly more actionable
// than the derived module); otherwise the derived index resolves any mathlib symbol
// mechanically. Modules are grounded against the materialized mathlib tree when it is present
// (treeVerified: true). WITHOUT the tree, the curated module names are returned AS-IS —
// they are authored constants against the pinned mathlib (grounded by curation), never filtered
// through a resolver that cannot run — and flagged treeVerified: false. The derived index
// cannot exist without the tree (it is BUILT from it), so derived hits only occur grounded.
export function suggestImportsForError(message, { index } = {}) {
    const msg = String(message ?? '');
    // Context-sensitive repair: a `sum` projection failing on a Multiset expression is the
    // multiset-sum module, whatever the error names the field's owner (e.g. `Quot.sum`).
    if (/Multiset/i.test(msg) && /\bsum\b/i.test(msg)) {
        return { symbol: 'Multiset.sum', modules: ['Mathlib.Algebra.BigOperators.Group.Multiset.Defs'], notationFix: 'Multiset.sum needs Mathlib.Algebra.BigOperators.Group.Multiset.Defs', derived: 0, treeVerified: mathlibTreePresent() };
    }
    // Prefer the LONGEST backticked token (e.g. `Finset.sum` over `sum`).
    const tokens = [...msg.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)].map(m => m[1]);
    // Explicit `index: null` disables the derived index; the default (undefined) loads the
    // cached index from the lean project.
    const activeIndex = index === undefined ? defaultSymbolIndex() : index;
    const tree = mathlibTreePresent();
    const grounded = (names) => tree ? names.map(resolveModule).filter(Boolean) : names;

    for (const t of tokens) {
        const curated = SYMBOL_MODULES[t];
        if (curated) {
            const resolved = grounded(curated.modules);
            if (resolved.length) return { symbol: t, modules: resolved, notationFix: curated.notationFix ?? null, derived: 0, treeVerified: tree };
        }
        const hit = activeIndex ? querySymbolIndex(activeIndex, t) : null;
        if (hit) {
            const resolved = grounded([hit.module]);
            if (resolved.length) return { symbol: hit.symbol, modules: resolved, notationFix: null, derived: hit.tier, treeVerified: tree };
        }
    }
    if (!activeIndex) {
        // No index: fall back to the curated table's qualified-token heuristic.
        const qualified = tokens.filter(t => t.includes('.')).sort((a, b) => b.length - a.length)[0];
        const entry = SYMBOL_MODULES[qualified];
        if (entry) {
            const resolved = grounded(entry.modules);
            if (resolved.length) return { symbol: qualified, modules: resolved, notationFix: entry.notationFix ?? null, derived: 0, treeVerified: tree };
        }
    }
    return null;
}
