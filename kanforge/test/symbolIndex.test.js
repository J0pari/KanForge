// Derived symbol→module index (architecture.md §0.1 item 6): build/query/serialize round-trip,
// tier semantics, and the real-index integration check (skipped when the cache is absent).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    moduleFromPath, buildSymbolIndex, querySymbolIndex,
    serializeIndex, deserializeIndex, saveSymbolIndex, loadSymbolIndex,
    SYMBOL_INDEX_CACHE_NAME
} from '../lean/symbolIndex.js';
import { loadEnv } from '../env.js';

const SYNTHETIC = {
    decls: new Map([
        ['Set.Infinite', 'Mathlib.Data.Finite.Defs'],
        ['Nat.Prime', 'Mathlib.Data.Nat.Prime.Defs'],
        ['Multiset', 'Mathlib.Data.Multiset.Defs'],
        ['QPF.Multiset', 'Mathlib.Data.QPF.Multivariate.Basic'],
        ['Even.all', 'Mathlib.Algebra.CharP.Invertible']
    ]),
    moduleBasenames: new Map([
        ['Even', 'Mathlib.Algebra.Group.Even'],
        ['Defs', 'Mathlib.Data.Multiset.Defs']
    ])
};

test('moduleFromPath maps a relative path to a module name', () => {
    assert.strictEqual(moduleFromPath('Data/Set/Basic.lean'), 'Mathlib.Data.Set.Basic');
    assert.strictEqual(moduleFromPath('Data\\Set\\Finite\\Basic.lean'), 'Mathlib.Data.Set.Finite.Basic');
});

test('querySymbolIndex tier 1: exact full name', () => {
    const q = querySymbolIndex(SYNTHETIC, 'Set.Infinite');
    assert.deepStrictEqual(q, { symbol: 'Set.Infinite', module: 'Mathlib.Data.Finite.Defs', tier: 1 });
});

test('querySymbolIndex tier 2: basename convention for unqualified queries', () => {
    // `Even` has no declaration line (to_additive-generated); `Even.all` in another module is a
    // false friend — the basename convention is the intended signal and comes first.
    const q = querySymbolIndex(SYNTHETIC, 'Even');
    assert.deepStrictEqual(q, { symbol: 'Even', module: 'Mathlib.Algebra.Group.Even', tier: 2 });
});

test('querySymbolIndex tier 3: last-segment declaration matches', () => {
    const q = querySymbolIndex(SYNTHETIC, 'SomeToken');
    assert.strictEqual(q, null);
    // A qualified token with a last-segment declaration resolves to that declaration's module.
    const q2 = querySymbolIndex({ ...SYNTHETIC, decls: new Map([...SYNTHETIC.decls, ['Foo.Bar', 'Mathlib.Foo.Bar']]) }, 'X.Bar');
    assert.ok(q2 && q2.tier === 3);
    assert.strictEqual(q2.module, 'Mathlib.Foo.Bar');
});

test('serialize/deserialize round-trip preserves the maps', () => {
    const json = serializeIndex({ decls: SYNTHETIC.decls, moduleBasenames: SYNTHETIC.moduleBasenames, stats: { files: 1 } });
    const back = deserializeIndex(json);
    assert.strictEqual(back.decls.get('Set.Infinite'), 'Mathlib.Data.Finite.Defs');
    assert.strictEqual(back.moduleBasenames.get('Even'), 'Mathlib.Algebra.Group.Even');
    assert.strictEqual(deserializeIndex(null), null);
    assert.strictEqual(deserializeIndex({}), null);
});

test('buildSymbolIndex scans a real directory and save/load round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-idx-'));
    fs.mkdirSync(path.join(dir, 'Mathlib', 'Data', 'Set'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mathlib', 'Data', 'Set', 'Basic.lean'),
        'namespace Set\n\n  def Infinite (s : Set α) : Prop := ¬ s.Finite\n\nend Set\n' +
        'namespace Nat\n  def Prime (n : Nat) : Prop := n ≠ 1 ∧ ∀ d, d ∣ n → d = 1 ∨ d = n\nend Nat\n' +
        'def Multiset.{u} (α : Type u) : Type u := α\n');
    fs.writeFileSync(path.join(dir, 'Mathlib', 'Other.lean'), 'def Even.all (a : Nat) : Prop := True\n');

    const index = buildSymbolIndex(path.join(dir, 'Mathlib'));
    assert.strictEqual(index.decls.get('Set.Infinite'), 'Mathlib.Data.Set.Basic');
    assert.strictEqual(index.decls.get('Nat.Prime'), 'Mathlib.Data.Set.Basic');
    assert.strictEqual(index.decls.get('Multiset'), 'Mathlib.Data.Set.Basic'); // trailing-dot strip
    assert.strictEqual(index.decls.get('Even.all'), 'Mathlib.Other');

    const cache = path.join(dir, SYMBOL_INDEX_CACHE_NAME);
    saveSymbolIndex(index, cache);
    const loaded = loadSymbolIndex(cache);
    assert.strictEqual(loaded.decls.get('Set.Infinite'), 'Mathlib.Data.Set.Basic');
    assert.strictEqual(loadSymbolIndex(path.join(dir, 'missing.json')), null);
});

test('integration: the real index resolves the motivating symbols (skips when cache absent)', () => {
    const project = loadEnv().KANFORGE_LEAN_PROJECT;
    if (!project) {
        test.skip();
        return;
    }
    const index = loadSymbolIndex(path.join(project, SYMBOL_INDEX_CACHE_NAME));
    if (!index) {
        test.skip(); // run bench/buildSymbolIndex.js once to build the cache
        return;
    }
    const expect = (token, module) => {
        const q = querySymbolIndex(index, token);
        assert.ok(q, `${token} resolves`);
        assert.strictEqual(q.module, module, `${token} → ${module} (got ${q.module})`);
    };
    expect('Set.Infinite', 'Mathlib.Data.Finite.Defs');
    expect('Nat.Prime', 'Mathlib.Data.Nat.Prime.Defs');
    expect('Even', 'Mathlib.Algebra.Group.Even');
    expect('Odd', 'Mathlib.Algebra.Ring.Parity');
    expect('Multiset', 'Mathlib.Data.Multiset.Defs');
});
