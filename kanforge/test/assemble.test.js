// blueprint/assemble.js — the gap-annotated, lean4web-pasteable reassembly of the whole DAG
// (the forward-assembly audit: gaps explicit, orphans flagged, root last).
import test from 'node:test';
import assert from 'node:assert';
import { assembleGapAnnotated } from '../blueprint/assemble.js';
import { hashStatement } from '../lean/pin.js';

const ROOT = 'theorem mission_root (a : Nat) : a + 0 = a := by sorry';
const H1 = 'theorem helper_one (a : Nat) : a + 0 = a := by sorry';
const H2 = 'theorem helper_two (a : Nat) : 0 + a = a := by sorry';
const ORPH = 'theorem orphan_branch (a : Nat) : a * 1 = a := by sorry';

function lem(statement, deps = [], proof = null, extra = {}) {
    return { id: hashStatement(statement), statement, deps, proof, pinnedHash: hashStatement(statement), ...extra };
}

test('assembly orders deps first, root last, proved lemmas carry proofs', () => {
    const lemmas = [
        lem(H1, [], 'by\n  rfl'),
        lem(ROOT, [hashStatement(H1)], null),
        lem(H2, [], 'by\n  simp')
    ];
    const r = assembleGapAnnotated({ lemmas, rootStatement: ROOT });
    assert.ok(r.source.indexOf('theorem helper_one') < r.source.indexOf('theorem mission_root'), 'deps before root');
    assert.ok(r.source.indexOf('by\n  rfl') !== -1, 'proved lemma carries its proof');
    assert.strictEqual(r.gapCount, 1);
    assert.strictEqual(r.gaps[0].root, true);
    assert.strictEqual(r.allProved, false);
    assert.ok(r.source.includes('ROOT — the mission statement'), 'root section marker present');
    assert.ok(r.source.includes('theorem mission_root (a : Nat) : a + 0 = a := by sorry'), 'root gap acknowledged with sorry');
});

test('orphan branches are flagged as orphan branches, never counted as pertinence', () => {
    const lemmas = [
        lem(H1, [], 'by\n  rfl'),
        lem(ORPH, [], null),
        lem(ROOT, [hashStatement(H1)], null)
    ];
    const r = assembleGapAnnotated({ lemmas, rootStatement: ROOT });
    assert.strictEqual(r.orphanCount, 1);
    assert.strictEqual(r.orphans[0].name, 'orphan_branch');
    assert.strictEqual(r.pertinentCount, 2, 'root + helper_one');
    assert.ok(!r.source.includes('orphan_branch') === false, 'orphans still assemble (they typecheck as sorry stubs)');
});

test('transitive pertinence: a helper referenced only by an orphan is itself orphan', () => {
    const H3 = 'theorem deep_helper (a : Nat) : a = a := by sorry';
    const lemmas = [
        lem(H3, [], 'by\n  rfl'),
        lem(ORPH, [hashStatement(H3)], 'by\n  exact deep_helper'),
        lem(ROOT, [], null)
    ];
    const r = assembleGapAnnotated({ lemmas, rootStatement: ROOT });
    assert.strictEqual(r.orphanCount, 2, 'orphan_branch AND deep_helper are off the root path');
});

test('duplicate declaration names are renamed deterministically and reported', () => {
    // Same NAME, different statement (the DAG dedupes identical statements by hash, so a
    // name collision only survives with distinct statements).
    const DUP = 'theorem helper_one (a : Nat) : a + 1 = a + 1 := by sorry';
    const lemmas = [
        lem(H1, [], 'by\n  rfl'),
        lem(DUP, [], null),
        lem(ROOT, [hashStatement(H1)], null)
    ];
    const r = assembleGapAnnotated({ lemmas, rootStatement: ROOT });
    assert.strictEqual(r.renamed.length, 1);
    assert.strictEqual(r.renamed[0].from, 'helper_one');
    assert.strictEqual(r.renamed[0].to, 'helper_one_v2');
    assert.ok(r.source.includes('theorem helper_one_v2'), 'later duplicate renamed');
});

test('cyclic DAG refuses to assemble', () => {
    const lemmas = [
        lem(H1, [hashStatement(ROOT)], null),
        lem(ROOT, [hashStatement(H1)], null)
    ];
    assert.throws(() => assembleGapAnnotated({ lemmas, rootStatement: ROOT }), /cyclic/);
});

test('drifted root statement refuses to assemble', () => {
    // The lemma occupies the ROOT id but its statement text drifted from the mission statement.
    const lemmas = [{ id: hashStatement(ROOT), statement: 'theorem impostor (a : Nat) : a = a := by sorry', deps: [], proof: null, pinnedHash: hashStatement(ROOT) }];
    assert.throws(() => assembleGapAnnotated({ lemmas, rootStatement: ROOT }), /drifted/);
});

test('registry overrides act on any component and win over defaults', async () => {
    const { applyOverrides, effectiveValue, COMPONENTS } = await import('../config/registry.js');
    assert.strictEqual(effectiveValue('reSplitBaseBudget'), COMPONENTS.reSplitBaseBudget.default);
    const applied = applyOverrides('reSplitBaseBudget=7,rankedReuse=false');
    assert.strictEqual(applied, 2);
    assert.strictEqual(effectiveValue('reSplitBaseBudget'), 7);
    assert.strictEqual(effectiveValue('rankedReuse'), false);
    assert.throws(() => applyOverrides('reSplitBaseBudget=99'), /out of range/);
    assert.throws(() => applyOverrides('nonsense=1'), /unknown registry component/);
});
