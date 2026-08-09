// Normalizer + module resolver unit tests (architecture.md §0.1, build_order.md §7.1).
// The autoformalizer must be input-format-agnostic: unicode, LaTeX, and ASCII all normalize to
// the same canonical Lean statement, and proposed imports resolve to modules that exist in the
// pinned mathlib.
import test from 'node:test';
import assert from 'node:assert';
import { normalizeStatement, normalizeStatementText, normalizeFormalization } from '../agent/roles/normalize.js';
import { resolveModule, resolveImports } from '../lean/moduleResolver.js';

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

test('normalizeFormalization resolves imports + normalizes the theorem', () => {
    const r = normalizeFormalization(['Mathlib.Data.Nat.Prime'], 'theorem t : ∃ n : ℕ, Nat.Prime n := by sorry');
    assert.deepStrictEqual(r.imports, ['Mathlib.Data.Nat.Prime.Defs']);
    assert.strictEqual(r.theorem, 'theorem t : ∃ n : Nat, Nat.Prime n := by sorry');
    assert.strictEqual(r.statement, 'import Mathlib.Data.Nat.Prime.Defs\n\ntheorem t : ∃ n : Nat, Nat.Prime n := by sorry');
});

test('module resolver maps directory aliases to real modules, drops unresolvable', () => {
    assert.strictEqual(resolveModule('Mathlib.Data.Nat.Prime'), 'Mathlib.Data.Nat.Prime.Defs');
    assert.strictEqual(resolveModule('Mathlib.Data.Nat.Prime.Defs'), 'Mathlib.Data.Nat.Prime.Defs');
    assert.strictEqual(resolveModule('Mathlib.Data.Real.Basic'), 'Mathlib.Data.Real.Basic');
    assert.strictEqual(resolveModule('Mathlib.Data.Nope'), null);
    assert.deepStrictEqual(resolveImports(['Mathlib.Data.Nat.Prime', 'Mathlib.Data.Real.Basic', 'Mathlib.Nope.X']), ['Mathlib.Data.Nat.Prime.Defs', 'Mathlib.Data.Real.Basic']);
});
