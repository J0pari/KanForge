// LemmaStore → retrieval index (build_order.md §5.7, architecture.md §2.8).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LemmaStore, buildLemmaIndex, extractGoalShape, extractTacticTrajectory, extractImports, extractFreeVariables } from '../growth/lemmaStore.js';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-lemmastore-'));
}

test('put/get round-trip', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        const data = { statement: 'lemma a : True := by sorry', proof: 'by trivial' };
        store.put('abc123', data);
        assert.deepStrictEqual(store.get('abc123'), data);
        assert.strictEqual(store.get('nope'), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('entries persist across instances (reload on construct)', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        store.put('abc123', { statement: 'lemma a : True := by sorry' });
        store.put('def456', { statement: 'lemma b : True := by sorry' });

        const reloaded = new LemmaStore({ dir });
        assert.strictEqual(reloaded.size, 2);
        assert.deepStrictEqual(reloaded.get('abc123'), { statement: 'lemma a : True := by sorry' });
        assert.deepStrictEqual(reloaded.get('def456'), { statement: 'lemma b : True := by sorry' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('list returns all stored values and has answers membership', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        store.put('a', { statement: 'A' });
        store.put('b', { statement: 'B' });
        assert.strictEqual(store.list().length, 2);
        assert.strictEqual(store.has('a'), true);
        assert.strictEqual(store.has('b'), true);
        assert.strictEqual(store.has('c'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('corrupt file is recorded, not fatal, and healthy entries still load', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        store.put('good1', { statement: 'lemma ok : True := by sorry' });

        const lemmasDir = path.join(dir, 'lemmas');
        fs.writeFileSync(path.join(lemmasDir, 'bad1.json'), '{ not valid json !!!');
        fs.writeFileSync(path.join(lemmasDir, 'bad2.json'), JSON.stringify({ hash: 'bad2', noData: true }));

        const reloaded = new LemmaStore({ dir });
        assert.strictEqual(reloaded.size, 1);
        assert.strictEqual(reloaded.get('good1').statement, 'lemma ok : True := by sorry');
        const corrupt = reloaded.getCorrupt();
        assert.strictEqual(corrupt.length, 2);
        const hashes = corrupt.map(c => c.hash).sort();
        assert.deepStrictEqual(hashes, ['bad1', 'bad2']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('put requires a hash string', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        assert.throws(() => store.put('', { x: 1 }), /requires a hash string/);
        assert.throws(() => store.put(null, { x: 1 }), /requires a hash string/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('buildLemmaIndex populates the §2.8 columns from statement + proof', () => {
    const stmt = 'import Mathlib.Data.Nat.Basic\n\ntheorem t (a b : Nat) (h : a * b = c) : b * a = c := by sorry';
    const proof = 'rw [Nat.mul_comm]\nexact h';
    const idx = buildLemmaIndex({ statementHash: 'h1', statement: stmt, proofScript: proof, deps: ['d1'] });
    assert.strictEqual(idx.statementHash, 'h1');
    assert.ok(idx.normalizedGoalShape.includes('b * a = c'));
    assert.deepStrictEqual(idx.imports, ['Mathlib.Data.Nat.Basic']);
    assert.deepStrictEqual(idx.dependencies, ['d1']);
    assert.ok(idx.proofLength >= 2);
    assert.deepStrictEqual(idx.tacticTrajectory, ['rw', 'exact']);
    assert.deepStrictEqual(idx.difficulty, { goalCount: null, ms: null });
    assert.strictEqual(idx.successConditions.verified, true);
});

test('buildLemmaIndex carries the §5.9 patch stream (transformation history)', () => {
    const idx = buildLemmaIndex({
        statementHash: 'h1',
        statement: 'theorem t : True := by sorry',
        proofScript: 'trivial',
        patchStream: [
            { op: 'tactic', node: 'g1', replacement: 'trivial', scope: 'goal', meta: { attempt: 1 } },
            { op: 'lemma', node: 'l1', scope: 'lemma' }
        ]
    });
    assert.strictEqual(idx.patchStream.length, 2);
    assert.strictEqual(idx.patchStream[0].op, 'tactic');
    assert.strictEqual(idx.patchStream[1].op, 'lemma');
});

test('extractGoalShape returns the proposition (binder telescope is context, not shape)', () => {
    assert.strictEqual(extractGoalShape('theorem t (a b : Nat) : a + b = b + a := by sorry'), 'a + b = b + a');
    assert.strictEqual(extractGoalShape('theorem t : True := by sorry'), 'True');
});

test('findSimilar ranks exact-shape matches above partial token overlap', () => {
    const dir = tmpDir();
    try {
        const store = new LemmaStore({ dir });
        store.put('exact', buildLemmaIndex({ statementHash: 'exact', statement: 'theorem t (a b : Nat) : a + b = b + a := by sorry', proofScript: 'ring' }));
        store.put('partial', buildLemmaIndex({ statementHash: 'partial', statement: 'theorem u (a b c : Nat) : a + (b + c) = (a + b) + c := by sorry', proofScript: 'ring' }));
        store.put('unrelated', buildLemmaIndex({ statementHash: 'unrelated', statement: 'theorem v (x : Real) : 0 < x ^ 2 + 1 := by sorry', proofScript: 'positivity' }));
        const hits = store.findSimilar('a + b = b + a', { limit: 3 });
        assert.strictEqual(hits[0].statementHash, 'exact');
        assert.ok(hits.length <= 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('extractFreeVariables returns distinct identifiers of the goal proposition', () => {
    const stmt = 'theorem t (a b c : Nat) (h : a * b = c) : b * a = c := by sorry';
    const fvs = extractFreeVariables(stmt);
    assert.ok(fvs.includes('a'));
    assert.ok(fvs.includes('b'));
    assert.ok(fvs.includes('c'));
    // hypothesis names live in the binder telescope (context), not the goal proposition
    assert.ok(!fvs.includes('h'));
    assert.strictEqual(new Set(fvs).size, fvs.length);
});
