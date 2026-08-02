import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lazy } from '../core/lazy.js';
import { LazyTemplate } from '../core/template.js';
import { LazyFunctor } from '../core/functor.js';
import { Pipeline } from '../core/pipeline.js';
import { ConfigContext } from '../core/context.js';
import { LazyStream } from '../core/stream.js';
import { lazify } from '../core/lazify.js';
import { fix } from '../core/fix.js';
import { PullGraph } from '../core/pullgraph.js';
import { PullPromise } from '../core/promise.js';
import { PullCache } from '../core/cache.js';
import { StateSerializer } from '../core/serialize.js';
import { Hasher } from '../core/hasher.js';

test('Lazy memoizes and evaluates once', () => {
    let calls = 0;
    const lazy = new Lazy(() => { calls++; return 21 * 2; });
    assert.equal(lazy.isEvaluated(), false);
    assert.equal(lazy.value, 42);
    assert.equal(lazy.value, 42);
    assert.equal(calls, 1);
    assert.equal(lazy.isEvaluated(), true);
});

test('Lazy.map and flatMap compose', () => {
    const lazy = new Lazy(() => 2).map(x => x * 3);
    assert.equal(lazy.value, 6);
    const flat = new Lazy(() => 2).flatMap(x => new Lazy(() => x * 4));
    assert.equal(flat.value, 8);
    const flat2 = new Lazy(() => 2).flatMap(x => x * 5);
    assert.equal(flat2.value, 10);
});

test('Lazy rethrows thunk errors', () => {
    const lazy = new Lazy(() => { throw new Error('boom'); });
    assert.throws(() => lazy.value, /boom/);
    assert.throws(() => lazy.value, /boom/);
});

test('LazyTemplate renders lazily from Lazy/LazyTemplate parts', () => {
    const name = new Lazy(() => 'world');
    const t = new LazyTemplate(['hello ', name, '!']);
    assert.equal(String(t), 'hello world!');
});

test('LazyFunctor maps and extracts recursively', () => {
    const struct = { a: new Lazy(() => 1), b: { c: new Lazy(() => 2) } };
    const mapped = LazyFunctor.map(x => x * 10, struct);
    assert.equal(mapped.a.value, 10);
    assert.equal(mapped.b.c.value, 20);
    const extracted = LazyFunctor.extract({ a: new Lazy(() => 1), b: 2 });
    assert.deepEqual(extracted, { a: 1, b: 2 });
});

test('LazyStream take/filter/map over lazy tails', () => {
    const s = LazyStream.fromArray([1, 2, 3, 4, 5]);
    assert.deepEqual(s.take(3), [1, 2, 3]);
    const evens = s.filter(x => x % 2 === 0);
    assert.deepEqual(evens.take(10), [2, 4]);
    assert.deepEqual(s.map(x => x * 2).take(2), [2, 4]);
});

test('LazyStream.fromArray empty yields null', () => {
    assert.equal(LazyStream.fromArray([]), null);
    assert.equal(LazyStream.empty(), null);
});

test('fix builds a self-referential lazy stream', () => {
    const naturals = fix(self => new LazyStream(0, () => self.value.map(x => x + 1)));
    assert.deepEqual(naturals.value.take(4), [0, 1, 2, 3]);
});

test('lazify memoizes function results by args', () => {
    let calls = 0;
    const obj = { add: (a, b) => { calls++; return a + b; } };
    const proxied = lazify(obj);
    assert.equal(proxied.add(1, 2), 3);
    assert.equal(proxied.add(1, 2), 3);
    assert.equal(calls, 1);
    assert.equal(proxied.add(2, 2), 4);
    assert.equal(calls, 2);
});

test('Pipeline.kleisli composes Lazy stages', () => {
    const pipeline = Pipeline.kleisli(
        x => new Lazy(() => x + 1),
        x => x * 2
    );
    assert.equal(pipeline(5).value, 12);
});

test('Pipeline.kleisli composes PullPromise stages', async () => {
    const pipeline = Pipeline.kleisli(
        x => new PullPromise(async () => x + 1),
        x => x * 2
    );
    const result = pipeline(5);
    assert.ok(result instanceof PullPromise);
    assert.equal(await result.pull(), 12);
});

test('Pipeline.kleisli mixes Lazy and PullPromise stages', async () => {
    const pipeline = Pipeline.kleisli(
        x => new PullPromise(async () => x + 1),
        x => new Lazy(() => x * 2)
    );
    const result = pipeline(5);
    assert.ok(result instanceof PullPromise);
    assert.equal(await result.pull(), 12);
});

test('ConfigContext threads environment lazily', () => {
    const ctx = new ConfigContext(null, { limit: 3 });
    assert.equal(ctx.asks(e => e.limit).value, 3);
    const derived = ctx.derive(env => env.limit + 1);
    assert.equal(derived.value.value, 4);
});

test('PullGraph.pull computes and caches with dep propagation', () => {
    const g = new PullGraph();
    let aCalls = 0;
    g.register('a', () => { aCalls++; return 1; });
    g.register('b', () => 2);
    g.register('sum', () => g.pull('a') + g.pull('b'));
    g.dependsOn('sum', 'a');
    g.dependsOn('sum', 'b');

    assert.equal(g.pull('sum'), 3);
    assert.equal(g.pull('sum'), 3);
    assert.equal(aCalls, 1);
});

test('PullGraph error boundary routes to handler', () => {
    const g = new PullGraph();
    g.register('bad', () => { throw new Error('nope'); }, (err, id) => ({ fallback: true, from: id }));
    assert.deepEqual(g.pull('bad'), { fallback: true, from: 'bad' });
});

test('PullGraph.invalidate clears dependents transitively', () => {
    const g = new PullGraph();
    let aCalls = 0;
    g.register('a', () => { aCalls++; return 1; });
    g.register('b', () => g.pull('a') + 1);
    g.register('c', () => g.pull('b') + 1);
    g.dependsOn('b', 'a');
    g.dependsOn('c', 'b');

    assert.equal(g.pull('c'), 3);
    assert.equal(aCalls, 1);

    g.invalidate('a');
    assert.equal(g.pull('c'), 3);
    assert.equal(aCalls, 2);
});

test('PullGraph.serialize/deserialize round-trips a cached DAG', () => {
    const g = new PullGraph();
    g.register('a', () => 1);
    g.register('b', () => 2);
    g.register('sum', () => g.pull('a') + g.pull('b'));
    g.dependsOn('sum', 'a');
    g.dependsOn('sum', 'b');
    g.pull('sum');

    const registry = new Map([
        ['a', () => 1],
        ['b', () => 2],
        ['sum', () => 0],
    ]);
    const restored = PullGraph.deserialize(g.serialize(), registry);
    assert.equal(restored.pull('sum'), 3);
});

test('PullGraph.deserialize restores cached values without recompute', () => {
    let aCalls = 0;
    const g = new PullGraph();
    g.register('a', () => { aCalls++; return 1; });
    g.register('b', () => 2);
    g.register('sum', () => g.pull('a') + g.pull('b'));
    g.dependsOn('sum', 'a');
    g.dependsOn('sum', 'b');
    g.pull('sum');
    assert.equal(aCalls, 1);

    const registry = new Map([
        ['a', () => { aCalls++; return 1; }],
        ['b', () => 2],
        ['sum', () => { throw new Error('sum should be restored from cache'); }],
    ]);
    const restored = PullGraph.deserialize(g.serialize(), registry);
    assert.equal(restored.pull('sum'), 3);
    assert.equal(aCalls, 1); // 'a' restored from cache, not recomputed
});

test('PullGraph progress callback fires', () => {
    const g = new PullGraph();
    let events = 0;
    g.setProgressCallback(() => events++);
    g.register('a', () => 1);
    g.pull('a');
    assert.ok(events >= 1);
});

test('PullPromise memoizes the async thunk', async () => {
    let calls = 0;
    const p = new PullPromise(async () => { calls++; return 'done'; });
    assert.equal(await p.pull(), 'done');
    assert.equal(await p.pull(), 'done');
    assert.equal(calls, 1);
});

test('PullPromise then/map chain', async () => {
    const p = new PullPromise(async () => 1).map(x => x + 1);
    assert.equal(await p.pull(), 2);
});

test('PullCache computes lazily and reports has()', () => {
    let calls = 0;
    const cache = new PullCache((key) => { calls++; return key.length; });
    assert.equal(cache.has('ab'), false);
    assert.equal(cache.get('ab'), 2);
    assert.equal(cache.has('ab'), true);
    assert.equal(cache.get('ab'), 2);
    assert.equal(calls, 1);
});

test('StateSerializer registers per-type serializers', () => {
    const s = new StateSerializer();
    s.register('point', (p) => `${p.x},${p.y}`);
    assert.equal(s.serialize('point', { x: 1, y: 2 }), '1,2');
    assert.deepEqual(s.serialize('unknown', { x: 1 }), { x: 1 });
});

test('Hasher chains content hashes deterministically', () => {
    const h1 = new Hasher();
    const h2 = new Hasher();
    h1.absorb('alpha', 'statement');
    h2.absorb('alpha', 'statement');
    const a = h1.contentHash('pin').value;
    const b = h2.contentHash('pin').value;
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);

    // second absorb changes the chain
    h1.absorb('beta', 'proof');
    assert.notEqual(h1.contentHash('pin').value, a);
});

test('Hasher.verify compares hashes', () => {
    const h = new Hasher();
    h.absorb('x', 'statement');
    const hash = h.contentHash('pin').value;
    assert.equal(h.verify(hash, hash), true);
    assert.equal(h.verify(hash, hash.slice(0, 10)), false);
});
