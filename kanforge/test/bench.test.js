// Unit tests for the smoke set module (bench/smoke.js): the set is well-formed, every stub is a
// `:= by sorry` statement, tiers are valid, and the tactic-family classifier is stable.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SMOKE_PROBLEMS, tacticFamily, validateSmokeSet } from '../bench/smoke.js';

describe('bench/smoke.js', () => {
    test('smoke set is the 20-problem provisional target (build_order.md §1.2)', () => {
        assert.equal(SMOKE_PROBLEMS.length, 20);
        assert.ok([1, 2, 3, 4].every(t => SMOKE_PROBLEMS.some(p => p.tier === t)), 'all four tiers present');
    });

    test('every statement is a well-formed `:= by sorry` stub', () => {
        validateSmokeSet(); // throws on malformed
        const ids = new Set();
        for (const p of SMOKE_PROBLEMS) {
            assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
            ids.add(p.id);
            assert.match(p.statement, /^example .* := by sorry\s*$/, `${p.id} must be a sorry stub`);
            assert.ok(p.family.length > 0, `${p.id} declares an expected tactic family`);
        }
    });

    test('tacticFamily classifies representative proofs', () => {
        assert.equal(tacticFamily('omega'), 'omega');
        assert.equal(tacticFamily('rcases h with ⟨hp, hq⟩'), 'rcases');
        assert.equal(tacticFamily('by_cases hp : p'), 'by_cases');
        assert.equal(tacticFamily('intro hp'), 'intro');
        assert.equal(tacticFamily('rw [h]'), 'rw');
        assert.equal(tacticFamily('induction n with'), 'induction');
        assert.equal(tacticFamily('exact Nat.le_of_lt h'), 'exact');
        assert.equal(tacticFamily(''), 'empty');
        assert.equal(tacticFamily('   '), 'empty');
        assert.equal(tacticFamily('some_random_term'), 'other');
    });

    test('family classifier prefers non-omega specificities when multiple tactics appear', () => {
        // proof that uses rcases must be classed rcases, not omega (order matters)
        assert.equal(tacticFamily('rcases h with ⟨k, hk⟩; omega'), 'rcases');
        assert.equal(tacticFamily('induction n with; omega'), 'induction');
    });
});
