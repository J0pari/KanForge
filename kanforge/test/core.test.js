import test from 'node:test';
import assert from 'node:assert';
import { Lazy } from '../core/lazy.js';
import { Pipeline } from '../core/pipeline.js';
import { PullGraph } from '../core/pullgraph.js';
import { Scheduler } from '../core/scheduler.js';
import { Guardrails } from '../core/guardrails.js';
import { straighten, unstraighten, assertRoundTrip } from '../core/state.js';
import { GoalEGraph } from '../core/egraph.js';
import { PullCache } from '../core/cache.js';
import { LazyStream } from '../core/stream.js';
import { LazyTemplate } from '../core/template.js';

test('Lazy evaluation and memoization', () => {
    let count = 0;
    const lazy = new Lazy(() => ++count);
    assert.strictEqual(lazy.value, 1);
    assert.strictEqual(lazy.value, 1); // memoized
    lazy.reset();
    assert.strictEqual(lazy.value, 2);
});

test('State straightening and round-trip bijectivity', () => {
    const tree = {
        tactic: 'intro h',
        subproofs: [
            { tactic: 'omega', subproofs: [] }
        ]
    };
    const { script, map } = straighten(tree);
    assert.ok(script.includes('intro h'));
    assert.ok(script.includes('omega'));
    assert.strictEqual(assertRoundTrip(tree), true);
});

test('Goal e-graph normalization and transposition merging', () => {
    const egraph = new GoalEGraph();
    const g1 = { type: 'P → Q', context: [{ name: 'h', type: 'P' }] };
    const g2 = { type: 'P → Q', context: [{ name: 'h', type: 'P' }] };
    const id1 = egraph.addGoal(g1);
    const id2 = egraph.addGoal(g2);
    assert.strictEqual(id1, id2);
});

test('Guardrails invariant checks', () => {
    const graph = new PullGraph();
    graph.register('node1', () => ({ statement: { hash: 'abc' } }));
    const check = Guardrails.checkAll(graph);
    assert.strictEqual(check.ok, true);
});

test('PullCache memoizes and hits', () => {
    let calls = 0;
    const cache = new PullCache(k => { calls += 1; return k * 2; });
    assert.strictEqual(cache.get(3), 6);
    assert.strictEqual(cache.get(3), 6);
    assert.strictEqual(calls, 1);
    assert.strictEqual(cache.get(5), 10);
    assert.strictEqual(calls, 2);
});

test('LazyStream forces tail lazily and take/map', () => {
    let forced = 0;
    const inner = new LazyStream(2, () => { forced += 1; return new LazyStream(3, null); });
    const stream = new LazyStream(1, () => inner);
    assert.strictEqual(stream.head, 1);
    assert.strictEqual(forced, 0);
    assert.deepStrictEqual(stream.take(3), [1, 2, 3]);
    assert.strictEqual(forced, 1);
    const mapped = new LazyStream(1, () => new LazyStream(2, null)).map(x => x * 10);
    assert.deepStrictEqual(mapped.take(2), [10, 20]);
});

test('LazyTemplate defers and concatenates lazy parts', () => {
    let forced = 0;
    const lazy = new Lazy(() => { forced += 1; return 'world'; });
    const tmpl = new LazyTemplate(['hello ', lazy]);
    assert.strictEqual(tmpl.toString(), 'hello world');
    assert.strictEqual(forced, 1);
    assert.strictEqual(tmpl.toString(), 'hello world');
    assert.strictEqual(forced, 1);
});

test('Scheduler: timeoutMs null disables the timeout (each operation is bounded by its backend)', { timeout: 10000 }, async () => {
    const graph = new PullGraph();
    graph.register('slow', () => 'x');
    let checkRuns = 0;
    const scheduler = new Scheduler(graph, {
        check: async () => {
            checkRuns++;
            await new Promise(r => setTimeout(r, 1500)); // longer than any default timer
            return { ok: true };
        },
        concurrency: 1,
        timeoutMs: null
    });
    scheduler.enqueue(['slow']);
    const outcome = await scheduler.run();
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.results.size, 1);
    assert.strictEqual(checkRuns, 1);
});

test('Scheduler: a fired timeout records the node as failed', { timeout: 10000 }, async () => {
    const graph = new PullGraph();
    graph.register('hang', () => 'x');
    const scheduler = new Scheduler(graph, {
        check: async () => { await new Promise(r => setTimeout(r, 5000)); return { ok: true }; },
        concurrency: 1,
        timeoutMs: 100
    });
    scheduler.enqueue(['hang']);
    const outcome = await scheduler.run();
    assert.strictEqual(outcome.ok, false);
    assert.ok(outcome.failures.has('hang'));
    assert.match(String(outcome.failures.get('hang')), /timeout after 100ms/);
});
