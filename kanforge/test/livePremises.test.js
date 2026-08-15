// search/livePremises.js — the live premise corpus source (§5.2 live wiring).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    premiseFromStatement,
    harvestableIdentifiers,
    mergePremiseCorpora,
    premisesFromLemmas,
    loadHarvestFile,
    appendHarvestFile
} from '../search/livePremises.js';

test('premiseFromStatement parses name + type from a stub with imports', () => {
    const stmt = 'import Mathlib.Data.Nat.Prime.Defs\n\ntheorem twopow_strict_mono_nat : ∀ {n m : Nat}, n < m → 2 ^ n < 2 ^ m := by sorry';
    const p = premiseFromStatement(stmt);
    assert.deepStrictEqual(p, { name: 'twopow_strict_mono_nat', type: '∀ {n m : Nat}, n < m → 2 ^ n < 2 ^ m' });
});

test('premiseFromStatement handles explicit binders and multiline types', () => {
    const stmt = 'theorem add_step (a b : Nat) :\n  a + b = b + a := by sorry';
    const p = premiseFromStatement(stmt);
    assert.deepStrictEqual(p, { name: 'add_step', type: 'a + b = b + a' });
});

test('premiseFromStatement returns null for non-stub shapes', () => {
    assert.strictEqual(premiseFromStatement('def foo : Nat := 3'), null);
    assert.strictEqual(premiseFromStatement('example : True := by trivial'), null);
    assert.strictEqual(premiseFromStatement(''), null);
});

test('harvestableIdentifiers keeps declaration references and drops tactics/locals', () => {
    const proof = 'by\n  rw [Nat.mul_comm]\n  exact h\n  omega\n  refine Nat.pow_lt_pow_left ?_\n  rfl';
    const out = harvestableIdentifiers(proof, new Set());
    assert.ok(out.includes('Nat.mul_comm'));
    assert.ok(out.includes('Nat.pow_lt_pow_left'));
    assert.ok(!out.includes('rw'));
    assert.ok(!out.includes('exact'));
    assert.ok(!out.includes('h'));
    assert.ok(!out.includes('omega'));
    assert.ok(!out.includes('refine'));
    assert.ok(!out.includes('rfl'));
});

test('harvestableIdentifiers skips already-known names', () => {
    const proof = 'by exact Nat.mul_comm';
    assert.deepStrictEqual(harvestableIdentifiers(proof, new Set(['Nat.mul_comm'])), []);
});

test('mergePremiseCorpora dedupes by name, first insertion wins', () => {
    const merged = mergePremiseCorpora([
        [{ name: 'A', type: 't1' }],
        [{ name: 'A', type: 't2' }, { name: 'B', type: 't3' }]
    ]);
    assert.deepStrictEqual(merged, [{ name: 'A', type: 't1' }, { name: 'B', type: 't3' }]);
});

test('premisesFromLemmas takes only proved lemmas', () => {
    const stmt = 'theorem x_one : x = 1 := by sorry';
    const out = premisesFromLemmas([
        { statement: stmt, proof: 'rfl' },
        { statement: 'theorem y_two : y = 2 := by sorry', proof: null }
    ]);
    assert.deepStrictEqual(out, [{ name: 'x_one', type: 'x = 1' }]);
});

test('harvest file round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-harvest-'));
    try {
        const file = path.join(dir, 'premise-harvest.jsonl');
        appendHarvestFile(file, [{ name: 'Nat.mul_comm', type: 'a * b = b * a' }]);
        appendHarvestFile(file, []);
        const loaded = loadHarvestFile(file);
        assert.deepStrictEqual(loaded, [{ name: 'Nat.mul_comm', type: 'a * b = b * a' }]);
        assert.deepStrictEqual(loadHarvestFile(path.join(dir, 'missing.jsonl')), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
