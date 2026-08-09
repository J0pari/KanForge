// Statement normalization (architecture.md §0.1, build_order.md §7.1).
// Conversion helpers that make the autoformalizer input-format-agnostic: the LLM may emit
// unicode math (ℕ ∀ ∃), LaTeX (\mathbb{N}, \forall, \exists), or ASCII (Nat, forall, Exists).
// normalizeStatement maps any of these to a canonical Lean form the kernel accepts.
//
// The repl has a known fragility: `∃`/`∀` with unicode type symbols (ℕ) in a statement that
// FOLLOWS a mathlib import can parse as "expected token". Normalizing to ASCII type names
// (Nat, Int) and keeping quantifier symbols (∃/∀ are valid Lean) avoids the failure, and the
// module resolver ensures the import itself is valid.

import { resolveModule } from '../../lean/moduleResolver.js';

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
