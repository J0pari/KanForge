// State bijectivity & proof source construction tests (core/state.js).

import test from 'node:test';
import assert from 'node:assert';
import { straighten, unstraighten, assertRoundTrip, buildProofSource } from '../core/state.js';

test('straighten/unstraighten round-trips linear tactic chains', () => {
    const tree = {
        tactic: 'intro h',
        subproofs: [
            { tactic: 'cases h', subproofs: [
                { tactic: 'omega', subproofs: [] }
            ]}
        ]
    };
    assert.strictEqual(assertRoundTrip(tree), true);
});

test('straighten keeps linear chains at the same column (Lean-valid)', () => {
    const tree = {
        tactic: 'intro h',
        subproofs: [{ tactic: 'omega', subproofs: [] }]
    };
    const { script } = straighten(tree);
    assert.strictEqual(script, 'by\n  intro h\n  omega');
});

test('straighten places multi-branch bullets at the opener\'s column', () => {
    const tree = {
        tactic: 'constructor',
        subproofs: [
            { tactic: 'rfl', subproofs: [] },
            { tactic: 'constructor', subproofs: [
                { tactic: 'rfl', subproofs: [] },
                { tactic: 'rfl', subproofs: [] }
            ]}
        ]
    };
    const { script } = straighten(tree);
    assert.strictEqual(script, 'by\n  constructor\n  · rfl\n  · constructor\n    · rfl\n    · rfl');
});

test('straighten/unstraighten round-trips nested multi-branch tactic trees', () => {
    const tree = {
        tactic: 'induction n',
        subproofs: [
            { tactic: 'rfl', subproofs: [] },
            { tactic: 'rw [add_zero]', subproofs: [
                { tactic: 'omega', subproofs: [] }
            ]}
        ]
    };
    assert.strictEqual(assertRoundTrip(tree), true);
});

test('buildProofSource splices composed proof script into pinned statement stub', () => {
    const statement = 'example (p q : Prop) (h : p ∧ q) : q ∧ p := by sorry';
    const script = 'by\n  rcases h with ⟨hp, hq⟩\n  exact ⟨hq, hp⟩';
    const source = buildProofSource(statement, script);

    assert.strictEqual(source, 'example (p q : Prop) (h : p ∧ q) : q ∧ p := by\n  rcases h with ⟨hp, hq⟩\n  exact ⟨hq, hp⟩');
});

test('buildProofSource throws if statement is not a by-sorry stub', () => {
    assert.throws(() => buildProofSource('example : 1 = 1 := rfl', 'by rfl'), /:= by sorry/);
});
