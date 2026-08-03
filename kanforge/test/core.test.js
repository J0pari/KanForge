import test from 'node:test';
import assert from 'node:assert';
import { Lazy } from '../core/lazy.js';
import { Pipeline } from '../core/pipeline.js';
import { PullGraph } from '../core/pullgraph.js';
import { Scheduler } from '../core/scheduler.js';
import { Guardrails } from '../core/guardrails.js';
import { straighten, unstraighten, assertRoundTrip } from '../core/state.js';
import { GoalEGraph } from '../core/egraph.js';

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
