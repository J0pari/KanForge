// Normalizer + module resolver unit tests (architecture.md §0.1, build_order.md §7.1).
// The autoformalizer must be input-format-agnostic: unicode, LaTeX, and ASCII all normalize to
// the same canonical Lean statement, and proposed imports resolve to modules that exist in the
// pinned mathlib.
import test from 'node:test';
import assert from 'node:assert';
import { normalizeStatement, normalizeStatementText, normalizeFormalization, suggestImportsForError } from '../agent/roles/normalize.js';
import { resolveModule, resolveImports } from '../lean/moduleResolver.js';
import { skipWithoutMathlib } from './mathlibEnv.js';

test('unicode math symbols normalize to ASCII Lean type names', () => {
    assert.strictEqual(normalizeStatement('example : ∃ n : ℕ, n = n := by sorry'), 'example : ∃ n : Nat, n = n := by sorry');
    assert.strictEqual(normalizeStatement('theorem t : ℤ → ℚ := by sorry'), 'theorem t : Int → Rat := by sorry');
    assert.strictEqual(normalizeStatement('example : ℝ × ℂ := by sorry'), 'example : Real × Complex := by sorry');
});

test('LaTeX macros normalize to Lean symbols', () => {
    assert.strictEqual(normalizeStatement('example : \\forall n : \\mathbb{N}, n \\le n := by sorry'), 'example : ∀ n : Nat, n ≤ n := by sorry');
    assert.strictEqual(normalizeStatement('example : \\mathbb{R} \\to \\mathbb{R} := by sorry'), 'example : Real → Real := by sorry');
    assert.strictEqual(normalizeStatement('example : \\exists x, P x \\land Q x := by sorry'), 'example : ∃ x, P x ∧ Q x := by sorry');
});

test('fenced and multiline statements collapse to a single canonical form', () => {
    assert.strictEqual(normalizeStatementText('```lean\ntheorem t : \\forall n : \\mathbb{N}, n \\le n := by\n  sorry\n```'), 'theorem t : ∀ n : Nat, n ≤ n := by sorry');
    assert.strictEqual(normalizeStatementText('  theorem t : True := by sorry  '), 'theorem t : True := by sorry');
    assert.strictEqual(normalizeStatementText('open scoped BigOperators\n\ntheorem t : True := by sorry'), 'theorem t : True := by sorry');
});

test('normalizeFormalization resolves imports + normalizes the theorem', { skip: skipWithoutMathlib('module resolution scans the mathlib source tree') }, () => {
    const r = normalizeFormalization(['Mathlib.Data.Nat.Prime'], 'theorem t : ∃ n : ℕ, Nat.Prime n := by sorry');
    assert.deepStrictEqual(r.imports, ['Mathlib.Data.Nat.Prime.Defs']);
    assert.strictEqual(r.theorem, 'theorem t : ∃ n : Nat, Nat.Prime n := by sorry');
    assert.strictEqual(r.statement, 'import Mathlib.Data.Nat.Prime.Defs\n\ntheorem t : ∃ n : Nat, Nat.Prime n := by sorry');
});

test('module resolver maps directory aliases to real modules, drops unresolvable', { skip: skipWithoutMathlib('module resolution scans the mathlib source tree') }, () => {
    assert.strictEqual(resolveModule('Mathlib.Data.Nat.Prime'), 'Mathlib.Data.Nat.Prime.Defs');
    assert.strictEqual(resolveModule('Mathlib.Data.Nat.Prime.Defs'), 'Mathlib.Data.Nat.Prime.Defs');
    assert.strictEqual(resolveModule('Mathlib.Data.Real.Basic'), 'Mathlib.Data.Real.Basic');
    assert.strictEqual(resolveModule('Mathlib.Data.Nope'), null);
    assert.deepStrictEqual(resolveImports(['Mathlib.Data.Nat.Prime', 'Mathlib.Data.Real.Basic', 'Mathlib.Nope.X']), ['Mathlib.Data.Nat.Prime.Defs', 'Mathlib.Data.Real.Basic']);
});

test('suggestImportsForError maps a missing symbol to its providing module', () => {
    const r = suggestImportsForError('Invalid field `sum`: The environment does not contain `Finset.sum`');
    assert.ok(r);
    assert.strictEqual(r.symbol, 'Finset.sum');
    assert.ok(r.modules.includes('Mathlib.Algebra.BigOperators.Ring.Finset'));
    assert.ok(r.notationFix.includes('∑'));
    assert.strictEqual(suggestImportsForError('no symbols here'), null);
});

// Synthetic derived index (the real one is built by bench/buildSymbolIndex.js from the pinned
// mathlib source): tests the query tiers mechanically, exactly as the autoformalizer uses them.
const SYNTHETIC_INDEX = {
    decls: new Map([
        ['Set.Infinite', 'Mathlib.Data.Finite.Defs'],
        ['Set.Finite', 'Mathlib.Data.Set.Finite.Defs'],
        ['Nat.Prime', 'Mathlib.Data.Nat.Prime.Defs'],
        ['Multiset', 'Mathlib.Data.Multiset.Basic']
    ]),
    moduleBasenames: new Map([
        ['Even', 'Mathlib.Algebra.Group.Even'],
        ['Odd', 'Mathlib.Algebra.Group.Even']
    ])
};

test('suggestImportsForError resolves via the derived index (tier 1: exact full name)', () => {
    const r = suggestImportsForError('Unknown constant `Set.Infinite`', { index: SYNTHETIC_INDEX });
    assert.ok(r && r.symbol === 'Set.Infinite');
    assert.ok(r.modules.includes('Mathlib.Data.Finite.Defs'));
    assert.strictEqual(r.derived, 1);
    const prime = suggestImportsForError('unknown identifier `Nat.Prime`', { index: SYNTHETIC_INDEX });
    assert.ok(prime && prime.modules.includes('Mathlib.Data.Nat.Prime.Defs'));
});

test('suggestImportsForError resolves via the derived index (tier 2: basename convention)', () => {
    // `Even` is to_additive-generated — no declaration line exists in any source file; only the
    // module-basename convention resolves it (unqualified query → basename tier).
    const r = suggestImportsForError("Hint: The identifier `Even` is unknown", { index: SYNTHETIC_INDEX });
    assert.ok(r && r.symbol === 'Even');
    assert.ok(r.modules.includes('Mathlib.Algebra.Group.Even'));
    assert.strictEqual(r.derived, 2);
});

test('suggestImportsForError: curated notation fix wins over the derived module', () => {
    // Finset.sum has a curated entry (light module + rewrite) — strictly more actionable.
    const r = suggestImportsForError('Invalid field `sum` on `Finset.sum`', { index: SYNTHETIC_INDEX });
    assert.strictEqual(r.symbol, 'Finset.sum');
    assert.ok(r.notationFix.includes('∑'));
    assert.strictEqual(r.derived, 0);
});

test('suggestImportsForError without an index degrades to the curated table only', () => {
    const r = suggestImportsForError('Unknown constant `Set.Infinite`');
    assert.strictEqual(r, null); // no index, no curated entry for Set.Infinite → null
    const sum = suggestImportsForError('Unknown constant `Finset.sum`');
    assert.ok(sum && sum.modules.includes('Mathlib.Algebra.BigOperators.Ring.Finset'));
});
