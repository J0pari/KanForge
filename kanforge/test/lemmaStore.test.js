// LemmaStore persistence (build_order.md §2.3 / §6.4) — content-addressed on-disk store.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LemmaStore } from '../growth/lemmaStore.js';

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
