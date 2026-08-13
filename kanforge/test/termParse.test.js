// Term parser tests (lean/termParse.js, build_order.md §5.12): the e-graph's term structure is
// only as trustworthy as this parser. The conservative contract: anything unsure → null →
// opaque leaf (no merging); the printed form must re-parse to the same tree (the def-eq oracle
// checks exactly what the e-graph decided to compare).
import test from 'node:test';
import assert from 'node:assert';
import { parseGoalType, termToText } from '../lean/termParse.js';

const roundTrip = (text) => {
    const term = parseGoalType(text);
    assert.ok(term, `parse failed for: ${text}`);
    const printed = termToText(term);
    const reparsed = parseGoalType(printed);
    assert.deepStrictEqual(reparsed, term, `round-trip mismatch:\n  in:  ${text}\n  out: ${printed}`);
    return { term, printed };
};

test('binary comparisons parse to application nodes', () => {
    const { term } = roundTrip('a < b');
    assert.strictEqual(term.kind, 'app');
    assert.strictEqual(term.fn.name, 'Lt');
    assert.strictEqual(term.args[0].kind, 'const');
});

test('algebraic identities parse with correct precedence', () => {
    const t1 = roundTrip('0 + x = y').term;
    assert.strictEqual(t1.fn.name, 'Eq');
    assert.strictEqual(t1.args[0].fn.name, 'HAdd.hAdd');

    // (a + b) * c must NOT flatten to a + b * c
    const rt2 = roundTrip('(a + b) * c');
    assert.strictEqual(rt2.term.fn.name, 'HMul.hMul');
    assert.strictEqual(rt2.term.args[0].fn.name, 'HAdd.hAdd');
    assert.strictEqual(rt2.printed, '(a + b) * c');

    // right-assoc subtraction keeps parens
    const rt3 = roundTrip('a - (b - c)');
    assert.strictEqual(rt3.printed, 'a - (b - c)');
});

test('binder telescopes: forall with grouped binders and arrows', () => {
    const { term, printed } = roundTrip('∀ (a b : Nat), a < b → a ≤ b');
    assert.strictEqual(term.kind, 'forall');
    assert.strictEqual(term.binders.length, 2);
    assert.strictEqual(term.binders[0].name, 'a');
    assert.strictEqual(term.binders[0].type.name, 'Nat');
    assert.strictEqual(term.body.kind, 'arrow');
    assert.ok(printed.includes('∀ (a : Nat) (b : Nat)'), printed);
});

test('predicate binders (∀ x ∈ s) keep their marker and never merge with plain binders', () => {
    const pred = parseGoalType('∀ x ∈ s, p x');
    const plain = parseGoalType('∀ x : s, p x');
    assert.strictEqual(pred.binders[0].pred, '∈');
    assert.strictEqual(plain.binders[0].pred, null);
    assert.notDeepStrictEqual(pred, plain);
    roundTrip('∀ x ∈ s, p x');
});

test('unicode goal types normalize to the same structure as ASCII forms', () => {
    const unicode = parseGoalType('∀ n : ℕ, n ≤ n');
    const ascii = parseGoalType('∀ n : Nat, n ≤ n');
    assert.deepStrictEqual(unicode, ascii);
    roundTrip('∀ n : ℕ, n ≤ n');
    roundTrip('∃ x : Nat, p x ∧ q x');
    roundTrip('a ↔ b');
});

test('negation parenthesizes infix children', () => {
    const { printed } = roundTrip('¬ (p ∧ q)');
    assert.strictEqual(printed, '¬ (p ∧ q)');
    const simple = roundTrip('¬ p ∧ q');
    assert.strictEqual(simple.printed, '¬ p ∧ q');
});

test('implicit and instance arguments parse as marked children', () => {
    const { term, printed } = roundTrip('f {α : Type u} [Monoid α] a');
    assert.strictEqual(term.kind, 'app');
    assert.strictEqual(term.args[0].kind, 'implicit');
    assert.strictEqual(term.args[1].kind, 'instance');
    assert.strictEqual(printed, 'f {α : Type u} [Monoid α] a');
});

test('conservative failure: unparseable input returns null (opaque leaf path)', () => {
    assert.strictEqual(parseGoalType('x &*&^ y'), null);
    assert.strictEqual(parseGoalType('f (g x'), null);
    assert.strictEqual(parseGoalType('a + + b'), null);
});
