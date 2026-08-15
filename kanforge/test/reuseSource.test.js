// buildReuseSource (§2.8 transitive reuse): dependency-closure inlining for fresh-env
// verification of retrieved proofs — the compression back-reference between DAG and store.
import test from 'node:test';
import assert from 'node:assert';
import { buildReuseSource, buildProofSource } from '../core/state.js';

const A = 'theorem a_lem : P := by sorry';
const B = 'theorem b_lem : Q := by sorry';
const T = 'theorem target : R := by sorry';

function mockStore(entries = {}) {
    return { get: hash => entries[hash] ?? null };
}

test('inlines the dependency closure (deepest first) before the target', () => {
    const store = mockStore({
        hA: { statement: A, proofScript: 'rfl', dependencies: [] },
        hB: { statement: B, proofScript: 'exact a_lem', dependencies: ['hA'] },
        hT: { statement: T, proofScript: 'exact b_lem', dependencies: ['hB'] }
    });
    const src = buildReuseSource({
        store, statement: T, proofScript: 'exact b_lem', closureOf: 'hT'
    });
    const aIdx = src.indexOf('theorem a_lem');
    const bIdx = src.indexOf('theorem b_lem');
    const tIdx = src.indexOf('theorem target');
    assert.ok(aIdx !== -1 && bIdx !== -1 && tIdx !== -1);
    assert.ok(aIdx < bIdx, 'deepest dependency must precede its dependent');
    assert.ok(bIdx < tIdx, 'target must come last');
    assert.ok(src.includes('exact a_lem'));
});

test('includeClosureRoot inlines the closure root itself (reuse-by-name)', () => {
    const store = mockStore({
        hB: { statement: B, proofScript: 'rfl', dependencies: [] }
    });
    const src = buildReuseSource({
        store, statement: T, proofScript: 'exact b_lem', closureOf: 'hB', includeClosureRoot: true
    });
    assert.ok(src.indexOf('theorem b_lem') < src.indexOf('theorem target'));
});

test('exact-hash reuse inlines only the deps, never the root (no duplicate declaration)', () => {
    const store = mockStore({
        hT: { statement: T, proofScript: 'rfl', dependencies: [] }
    });
    const src = buildReuseSource({
        store, statement: T, proofScript: 'rfl', closureOf: 'hT'
    });
    assert.strictEqual(src.match(/theorem target/g).length, 1);
});

test('cycle-guarded and count-capped', () => {
    const store = mockStore({
        hA: { statement: A, proofScript: 'exact b_lem', dependencies: ['hB'] },
        hB: { statement: B, proofScript: 'exact a_lem', dependencies: ['hA'] },
        hT: { statement: T, proofScript: 'rfl', dependencies: ['hA'] }
    });
    const src = buildReuseSource({ store, statement: T, proofScript: 'rfl', closureOf: 'hT' });
    assert.strictEqual(src.match(/theorem a_lem/g).length, 1);
    assert.strictEqual(src.match(/theorem b_lem/g).length, 1);
});

test('skips inlined entries whose declaration name collides', () => {
    const store = mockStore({
        hA1: { statement: A, proofScript: 'rfl', dependencies: [] },
        hA2: { statement: A, proofScript: 'sorry', dependencies: [] },
        hT: { statement: T, proofScript: 'rfl', dependencies: ['hA1', 'hA2'] }
    });
    const src = buildReuseSource({ store, statement: T, proofScript: 'rfl', closureOf: 'hT' });
    assert.strictEqual(src.match(/theorem a_lem/g).length, 1);
    assert.ok(!src.includes('sorry'), 'the colliding duplicate (with a sorry proof) must be skipped');
});

test('missing entries and malformed stubs degrade without throwing', () => {
    const store = mockStore({
        hT: { statement: 'not a stub', proofScript: 'x', dependencies: ['ghost'] }
    });
    const src = buildReuseSource({ store, statement: T, proofScript: 'rfl', closureOf: 'hT' });
    assert.strictEqual(src, buildProofSource(T, 'rfl'));
});

test('import lines are hoisted to the top exactly once (kernel rejects mid-source imports)', () => {
    const A_IMP = 'import Mathlib.Data.Nat.Basic\ntheorem a_lem : P := by sorry';
    const B_IMP = 'import Mathlib.Data.Nat.Basic\nimport Mathlib.Tactic.Linarith\ntheorem b_lem : Q := by sorry';
    const store = mockStore({
        hA: { statement: A_IMP, proofScript: 'rfl', dependencies: [] },
        hB: { statement: B_IMP, proofScript: 'exact a_lem', dependencies: ['hA'] },
        hT: { statement: 'import Mathlib.Data.Nat.Basic\ntheorem target : R := by sorry', proofScript: 'exact b_lem', dependencies: ['hB'] }
    });
    const src = buildReuseSource({ store, statement: 'theorem target : R := by sorry', proofScript: 'exact b_lem', closureOf: 'hT' });
    const lines = src.split('\n');
    const importIdx = lines.map((l, i) => /^import /.test(l.trim()) ? i : -1).filter(i => i >= 0);
    const firstDecl = lines.findIndex(l => /^theorem |^lemma /.test(l.trim()));
    assert.ok(importIdx.length > 0, 'imports present');
    assert.ok(importIdx.every(i => i < firstDecl), 'every import above the first declaration');
    assert.strictEqual(lines.filter(l => l.trim() === 'import Mathlib.Data.Nat.Basic').length, 1, 'deduped union');
    assert.strictEqual(lines.filter(l => l.trim() === 'import Mathlib.Tactic.Linarith').length, 1);
});
