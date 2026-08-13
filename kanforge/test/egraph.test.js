// Genuine equality-saturation e-graph tests (core/egraph.js, build_order.md §5.12).
// The structure must do three things: (1) congruence closure — same head + equal child classes
// merge, including AFTER a child union (rebuild); (2) kernel-gated rule unions — a rule fire
// merges only when the oracle confirms definitional equality; (3) honest degradation —
// unparseable goals become opaque leaves that never merge across different text. Plus the
// GoalStateGraph conformance suite, run against BOTH structures (the transposition graph runs
// the same scenarios in test/transpositionGraph.test.js).
import test from 'node:test';
import assert from 'node:assert';
import { GoalEGraph, DEFAULT_EGRAPH_RULES } from '../core/egraph.js';
import { parseGoalType } from '../lean/termParse.js';
import { assertGoalStateGraph } from '../core/goalStateGraph.js';
import { registerGoalStateGraphConformance } from './goalStateGraphConformance.js';

test('satisfies the GoalStateGraph contract (loud check)', () => {
    assertGoalStateGraph(new GoalEGraph(), { label: 'GoalEGraph' });
});

test('congruence closure: same structure merges without any oracle', () => {
    const g = new GoalEGraph();
    const t1 = parseGoalType('f (a + b)');
    const t2 = parseGoalType('f (a + b)');
    const c1 = g.addTerm(t1);
    const c2 = g.addTerm(t2);
    assert.ok(g.sameClass(c1, c2), 'identical terms are hashconsed to one class');
    assert.strictEqual(g.unions, 0);
});

test('congruence closure rebuild: merging children unions the parents', () => {
    const g = new GoalEGraph();
    const fa = g.addTerm(parseGoalType('f (a + b)'));
    const fc = g.addTerm(parseGoalType('f (c + b)'));
    assert.ok(!g.sameClass(fa, fc), 'distinct child constants keep parents apart');
    const a = g.addTerm(parseGoalType('a'));
    const c = g.addTerm(parseGoalType('c'));
    g.union(a, c, { reason: 'test: assume a = c' });
    assert.ok(g.sameClass(fa, fc), 'rebuild must propagate the child union to the parents');
});

test('rule fires are kernel-gated: no oracle → no unions', async () => {
    const g = new GoalEGraph(); // oracle omitted on purpose
    const goal = { type: 'x + 0 = y', context: [] };
    const id = g.addGoal(goal);
    const merged = await g.saturateGoalClass(id);
    assert.strictEqual(merged, 0);
    assert.ok(g.ruleFires > 0, 'the rule matched and fired');
    assert.ok(g.ruleRejections > 0, 'the fire was rejected, not assumed');
    const plain = g.addGoal({ type: 'x = y', context: [] });
    assert.notStrictEqual(id, plain, 'unconfirmed pairs must NOT merge');
});

test('oracle-confirmed rule fire unions the goal classes', async () => {
    const confirmed = new Set(['x + 0::x']);
    const oracle = { confirm: async (l, r) => confirmed.has(`${l}::${r}`) };
    const g = new GoalEGraph({ oracle });
    const id1 = g.addGoal({ type: 'x + 0 = y', context: [] });
    const id2 = g.addGoal({ type: 'x = y', context: [] });
    assert.notStrictEqual(id1, id2, 'distinct before the oracle');
    const merged = await g.saturateGoalClass(id1);
    assert.strictEqual(merged, 1);
    // After a kernel-confirmed union both spellings are one state (ids are internal).
    const r1 = g.addGoal({ type: 'x = y', context: [] });
    const r2 = g.addGoal({ type: 'x + 0 = y', context: [] });
    assert.strictEqual(r1, r2, 'after a confirmed union both spellings share one class');
});

test('oracle rejection keeps the classes apart (the e-graph cannot BS)', async () => {
    const oracle = { confirm: async () => false };
    const g = new GoalEGraph({ oracle });
    const id1 = g.addGoal({ type: 'x + 0 = y', context: [] });
    await g.saturateGoalClass(id1);
    const id2 = g.addGoal({ type: 'x = y', context: [] });
    assert.notStrictEqual(id1, id2);
    assert.strictEqual(g.ruleRejections, 1);
});

test('unparseable goals degrade to opaque leaves: identical text merges, different text never does', () => {
    const g = new GoalEGraph();
    const id1 = g.addGoal({ type: 'x &*&^ y', context: [] });
    const id2 = g.addGoal({ type: 'x &*&^ y', context: [] });
    const id3 = g.addGoal({ type: 'z &*&^ w', context: [] });
    assert.strictEqual(id1, id2);
    assert.notStrictEqual(id1, id3);
});

test('alternative successful expansions are RETAINED on the class', () => {
    const g = new GoalEGraph();
    const rootId = g.setRoot({ type: 'A ∨ B', context: [] });
    g.applyTactic(rootId, 'left', [{ type: 'A', context: [] }]);
    g.applyTactic(rootId, 'right', [{ type: 'B', context: [] }]);
    const cls = g.classes.get(rootId);
    assert.strictEqual(cls.tactics.length, 2, 'both alternatives remain first-class records');
});

test('serialize/deserialize replays confirmed unions without oracle calls', async () => {
    const confirmed = new Set(['x + 0::x']);
    const oracle = { confirm: async (l, r) => confirmed.has(`${l}::${r}`) };
    const g = new GoalEGraph({ oracle });
    const id1 = g.addGoal({ type: 'x + 0 = y', context: [] });
    await g.saturateGoalClass(id1);
    assert.strictEqual(g.addGoal({ type: 'x = y', context: [] }), id1);

    const restored = GoalEGraph.deserialize(g.serialize(), { oracle: { confirm: async () => { throw new Error('oracle must not be called on deserialize'); } } });
    // The invariant: the recorded union is re-established — both spellings land in ONE class.
    // (Class ids are internal; the representative choice is order-dependent across graphs.)
    const r1 = restored.addGoal({ type: 'x = y', context: [] });
    const r2 = restored.addGoal({ type: 'x + 0 = y', context: [] });
    assert.strictEqual(r1, r2, 'recorded unions are replayed, not re-queried');
    const r3 = restored.addGoal({ type: 'x = y', context: [] });
    assert.strictEqual(r1, r3, 'the merged class is stable under repeated lookups');
});

registerGoalStateGraphConformance('egraph', () => new GoalEGraph());
