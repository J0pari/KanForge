// Autoformalizer unit tests (architecture.md §0.1, build_order.md §7.1).
// Pure-function coverage: static validation (zero-kernel-cost gate), strict JSON parsing,
// statement assembly, probe parsing. The kernel path is covered by the live suite.
import test from 'node:test';
import assert from 'node:assert';
import {
    staticValidateStatement,
    parseFormalizationJson,
    assembleStatement,
    parseProbeJson
} from '../agent/roles/autoformalizer.js';

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
