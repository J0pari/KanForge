// Autoformalizer unit tests (architecture.md §0.1, build_order.md §7.1).
// Pure-function coverage: static validation (zero-kernel-cost gate), strict JSON parsing,
// statement assembly, probe parsing. The kernel path is covered by the live suite.
import test from 'node:test';
import assert from 'node:assert';
import {
    staticValidateStatement,
    parseFormalizationJson,
    assembleStatement,
    parseProbeJson,
    extractTestInstancesFromFc,
    instanceStringsFor,
    Autoformalizer
} from '../agent/roles/autoformalizer.js';

test('extractTestInstancesFromFc parses test-category membership theorems', () => {
    const fc = `/- header -/\nnamespace Erdos9\ndef Erdos9A : Set ℕ := ∅\n@[category test, AMS 5 11]\ntheorem erdos9A_contains_one : 1 ∈ Erdos9A := by\n  sorry\n@[category test, AMS 5 11]\ntheorem erdos9A_not_contains_five : 5 ∉ Erdos9A := by\n  sorry\n@[category research solved]\ntheorem erdos_9.variants.infinite : Erdos9A.Infinite := by\n  sorry\nend Erdos9`;
    const facts = extractTestInstancesFromFc(fc);
    assert.deepStrictEqual(facts, [{ n: 1, in: true }, { n: 5, in: false }]);
});

test('extractTestInstancesFromFc ignores non-test theorems and malformed blocks', () => {
    assert.deepStrictEqual(extractTestInstancesFromFc('theorem plain : True := by sorry'), []);
    assert.deepStrictEqual(extractTestInstancesFromFc(''), []);
});

test('instanceStringsFor phrases membership facts generically for the ledger', () => {
    const out = instanceStringsFor([{ n: 1, in: true }, { n: 5, in: false }]);
    assert.deepStrictEqual(out, [
        'the number 1 is an element of the set described in the statement',
        'the number 5 is not an element of the set described in the statement'
    ]);
});

test('staticValidateStatement accepts a well-formed sorry-stub', () => {
    const ok = staticValidateStatement('import Mathlib.Data.Nat.Prime\n\ntheorem t (n : Nat) : Nat.Prime n → n > 1 := by sorry');
    assert.strictEqual(ok.ok, true);
});

test('staticValidateStatement rejects the flounder-class errors BEFORE the kernel', () => {
    // the exact failure class seen live: inline `open scoped` sneaking past the parser
    assert.strictEqual(staticValidateStatement('import Mathlib.Data.Nat.Prime\n\nopen scoped BigOperators\n\ntheorem t : True := by sorry').ok, false);
    // missing `:= by sorry`
    assert.strictEqual(staticValidateStatement('theorem t : True := by trivial').ok, false);
    // unbalanced brackets
    assert.strictEqual(staticValidateStatement('theorem t : (True := by sorry').ok, false);
    // `sorry` in the middle, not just the body
    assert.strictEqual(staticValidateStatement('theorem t : sorry := by sorry').ok, false);
    // empty
    assert.strictEqual(staticValidateStatement('').ok, false);
});

test('parseFormalizationJson accepts the strict contract and tolerates fences', () => {
    const r = parseFormalizationJson('```json\n{"imports": ["Mathlib.Data.Nat.Prime"], "theorem": "theorem t : True := by sorry"}\n```');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.imports, ['Mathlib.Data.Nat.Prime']);
    assert.strictEqual(r.theorem, 'theorem t : True := by sorry');
});

test('parseFormalizationJson rejects malformed output deterministically', () => {
    assert.strictEqual(parseFormalizationJson('no json here').ok, false);
    assert.strictEqual(parseFormalizationJson('{"imports": []}').ok, false); // missing theorem
    assert.strictEqual(parseFormalizationJson('not { valid').ok, false);
});

test('assembleStatement joins imports + theorem; no imports → theorem alone', () => {
    assert.strictEqual(assembleStatement(['A', 'B'], 'theorem t : True := by sorry'), 'import A\nimport B\n\ntheorem t : True := by sorry');
    assert.strictEqual(assembleStatement([], 'theorem t : True := by sorry'), 'theorem t : True := by sorry');
});

test('parseProbeJson requires exactly the expected number of examples', () => {
    const r = parseProbeJson('{"examples": ["example a : 1 = 1 := by rfl", "example b : 2 = 2 := by rfl"]}', 2);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.examples.length, 2);
    const bad = parseProbeJson('{"examples": ["example a : 1 = 1 := by rfl"]}', 2);
    assert.strictEqual(bad.ok, false);
});

// Shape classification (§0.2) through the entry builder: the `:= by sorry` suffix and binder
// colons must not count as a shape-classifying equality.
const AF = new Autoformalizer({ llm: {}, backend: {} });

test('shapeOf: universal/infinity claims classify as universal-claim, not closed-form', () => {
    const s = 'import Mathlib.Algebra.Group.Even\n\ntheorem t : Set.Infinite { n : Nat | Even n ∧ ∀ p a b : Nat, Nat.Prime p → n ≠ p + 2 ^ a + 2 ^ b } := by sorry';
    const e = AF._entry(s, 'prose', { attempts: 1 });
    assert.strictEqual(e.justification.shape, 'universal-claim');
});

test('shapeOf: closed-form claims with propositional equality classify as closed-form', () => {
    const s = 'theorem t (n : Nat) : n * 2 = n + n := by sorry';
    const e = AF._entry(s, 'prose', { attempts: 1 });
    assert.strictEqual(e.justification.shape, 'closed-form');
});

test('shapeOf: witness-discovery (∃) and equivalence (↔) classify correctly', () => {
    const w = AF._entry('theorem t : ∃ n : Nat, n > 5 := by sorry', 'p', { attempts: 1 });
    assert.strictEqual(w.justification.shape, 'witness-discovery');
    const eq = AF._entry('theorem t : True ↔ False := by sorry', 'p', { attempts: 1 });
    assert.strictEqual(eq.justification.shape, 'equivalence');
});
