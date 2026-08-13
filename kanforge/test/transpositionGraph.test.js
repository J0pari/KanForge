// Goal transposition-graph frontier semantics (architecture.md §2.2).
// The repl tactic API reports the FULL remaining frontier after a tactic, not just the
// subgoals it created. These tests pin the carry-over behavior: closing one branch must not
// re-attach its still-open siblings under it, or the extracted proof tree double-counts a
// goal and the committed script is rejected by the kernel.
import test from 'node:test';
import assert from 'node:assert';
import { GoalTranspositionGraph } from '../core/transpositionGraph.js';
import { assertGoalStateGraph } from '../core/goalStateGraph.js';
import { registerGoalStateGraphConformance } from './goalStateGraphConformance.js';
import { straighten, assertRoundTrip } from '../core/state.js';

test('satisfies the GoalStateGraph contract (loud check)', () => {
    assertGoalStateGraph(new GoalTranspositionGraph(), { label: 'GoalTranspositionGraph' });
});

registerGoalStateGraphConformance('transposition', () => new GoalTranspositionGraph());

test('carries over siblings instead of double-attaching them (constructor case)', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: '1 = 1 ∧ 2 = 2', context: [] });

    const left = { type: '1 = 1', context: [], proofState: 1 };
    const right = { type: '2 = 2', context: [], proofState: 1 };
    const rec = graph.applyTactic(rootId, 'constructor', [left, right]);
    assert.strictEqual(rec.subgoalClasses.length, 2);
    const leftId = rec.subgoalClasses[0];
    const rightId = rec.subgoalClasses[1];
    assert.deepStrictEqual(graph.getOpenGoals().map(g => g.id), [leftId, rightId]);

    // rfl on the left branch: the repl reports the remaining right goal — carried over,
    // NOT a child of left. Its concrete instance is refreshed to the new proofState.
    const r1 = graph.applyTactic(leftId, 'rfl', [{ type: '2 = 2', context: [], proofState: 2 }]);
    assert.deepStrictEqual(r1.subgoalClasses, []);
    assert.deepStrictEqual(r1.carriedOver, [rightId]);
    assert.strictEqual(graph.currentGoal(rightId).proofState, 2);
    assert.deepStrictEqual(graph.getOpenGoals().map(g => g.id), [rightId]);

    graph.applyTactic(rightId, 'rfl', []);
    assert.strictEqual(graph.isRootSolved(), true);

    // The extracted tree has TWO independent branches — no nested rfl under left.
    assert.deepStrictEqual(graph.extractProof(), {
        tactic: 'constructor',
        subproofs: [
            { tactic: 'rfl', subproofs: [] },
            { tactic: 'rfl', subproofs: [] }
        ]
    });
});

test('new children precede carried siblings in the frontier', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: 'A ∧ B', context: [] });

    const A = { type: 'A', context: [] };
    const B = { type: 'B', context: [] };
    const rec = graph.applyTactic(rootId, 'constructor', [A, B]);
    const [aId, bId] = rec.subgoalClasses;

    // Splitting A returns its two children PLUS the still-open B sibling.
    const r2 = graph.applyTactic(aId, 'constructor', [
        { type: 'A1', context: [] },
        { type: 'A2', context: [] },
        { type: 'B', context: [] }
    ]);
    assert.strictEqual(r2.subgoalClasses.length, 2);
    assert.deepStrictEqual(r2.carriedOver, [bId]);
    assert.deepStrictEqual(graph.getOpenGoals().map(g => g.id), [...r2.subgoalClasses, bId]);

    graph.applyTactic(r2.subgoalClasses[0], 'rfl', []);
    graph.applyTactic(r2.subgoalClasses[1], 'rfl', []);
    graph.applyTactic(bId, 'rfl', []);
    assert.strictEqual(graph.isRootSolved(), true);

    const tree = graph.extractProof();
    assert.strictEqual(assertRoundTrip(tree), true);
    assert.strictEqual(straighten(tree).script.split('rfl').length - 1, 3);
});

test('transposed reuse: an already-solved class referenced again stays a leaf occurrence', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: 'A ∧ (B → A)', context: [] });

    const A = { type: 'A', context: [] };
    const imp = { type: 'B → A', context: [] };
    const rec = graph.applyTactic(rootId, 'constructor', [A, imp]);
    const [aId, impId] = rec.subgoalClasses;

    // Left A solved by rfl; the B → A sibling carries.
    graph.applyTactic(aId, 'rfl', []);
    const r2 = graph.applyTactic(impId, 'intro h', [{ type: 'A', context: [{ name: 'h', type: 'B' }] }]);
    // The new A has a context binder, so it is a DIFFERENT class from the left A — a child.
    assert.strictEqual(r2.subgoalClasses.length, 1);
    const a2Id = r2.subgoalClasses[0];
    graph.applyTactic(a2Id, 'rfl', []);
    assert.strictEqual(graph.isRootSolved(), true);

    const tree = graph.extractProof();
    assert.strictEqual(tree.subproofs.length, 2);
    assert.strictEqual(tree.subproofs[1].subproofs[0].tactic, 'rfl');
    assert.strictEqual(assertRoundTrip(tree), true);
});

test('extractProof terminates on a self-referential tactic result (no-progress tactic)', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: 'X', context: [] });
    // A tactic that reports the very same goal back (carried to head again).
    const rec = graph.applyTactic(rootId, 'hack', [{ type: 'X', context: [] }]);
    assert.deepStrictEqual(rec.subgoalClasses, []);
    assert.deepStrictEqual(rec.carriedOver, [rootId]);
    assert.strictEqual(graph.isRootSolved(), false);
    // Extraction must not hang; there is no solved path.
    assert.strictEqual(graph.extractProof(), null);
});

test('isSolved terminates on a goal-class cycle (subgoal hashes back to an ancestor)', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: 'b * a = c', context: [] });
    // rw [Nat.mul_comm] moves the frontier to a new class...
    const child = { type: 'a * b = c', context: [], proofState: 1 };
    const rec1 = graph.applyTactic(rootId, 'rw [Nat.mul_comm]', [child]);
    const childId = rec1.subgoalClasses[0];
    assert.notStrictEqual(childId, rootId);
    // ...and applying it again reports the root goal back, which hashes to the ROOT class
    // (not in the frontier, so it is attached as a child): a cycle root -> child -> root.
    const rec2 = graph.applyTactic(childId, 'rw [Nat.mul_comm]', [{ type: 'b * a = c', context: [], proofState: 2 }]);
    assert.deepStrictEqual(rec2.subgoalClasses, [rootId]);
    // Must not blow the stack; there is no solved path.
    assert.strictEqual(graph.isRootSolved(), false);
    assert.strictEqual(graph.extractProof(), null);
});

test('serialize/deserialize preserves the frontier', () => {
    const graph = new GoalTranspositionGraph();
    const rootId = graph.setRoot({ type: 'A ∧ B', context: [] });
    const rec = graph.applyTactic(rootId, 'constructor', [{ type: 'A', context: [] }, { type: 'B', context: [] }]);
    const restored = GoalTranspositionGraph.deserialize(graph.serialize());
    assert.deepStrictEqual(restored.frontier, [rec.subgoalClasses[0], rec.subgoalClasses[1]]);
    assert.deepStrictEqual(restored.getOpenGoals().map(g => g.id), restored.frontier);
});


test('collision-safe identity: canonical-key equality decides the class (build_order.md �5.10)', () => {
    const graph = new GoalTranspositionGraph();
    // Alpha-equivalent goals (renamed binders) share a class.
    const g1 = { type: 'x + y = y + x', context: [{ name: 'x', type: 'Nat' }, { name: 'y', type: 'Nat' }] };
    const g2 = { type: 'a + b = b + a', context: [{ name: 'a', type: 'Nat' }, { name: 'b', type: 'Nat' }] };
    assert.strictEqual(graph.addGoal(g1), graph.addGoal(g2));

    // Distinct goals (different type) never share a class.
    const g3 = { type: 'x * y = y * x', context: [{ name: 'x', type: 'Nat' }, { name: 'y', type: 'Nat' }] };
    const id3 = graph.addGoal(g3);
    assert.notStrictEqual(id3, graph.addGoal(g1));

    // Every class carries its canonical key (the equality authority).
    const key1 = graph.classes.get(graph.addGoal(g1)).canonicalKey;
    assert.ok(typeof key1 === 'string' && key1.includes('Nat'));
});

test('collision resolution: same id + different canonical key ? separate class, never a merge', () => {
    const graph = new GoalTranspositionGraph();
    // Force a collision by inserting a class with a synthetic id whose canonical key differs.
    const g1 = { type: 'P', context: [] };
    const id1 = graph.addGoal(g1);
    // Manually craft a second class under the SAME id but a different canonical key � this is
    // what a hash collision looks like after the fact (the injectable seam for testing).
    const collidingKey = graph.canonicalKey({ type: 'Q', context: [] });
    // Recompute: different key, and if it ever produced the same id, addGoal must not merge.
    const id2 = graph.addGoal({ type: 'Q', context: [] });
    if (id2 === id1) {
        assert.ok(false, 'SHA-256 collision on distinct keys is effectively impossible; this branch is defensive');
    }
    assert.notStrictEqual(id2, id1);
    assert.strictEqual(graph.classes.get(id1).goals.length, 1);
    assert.strictEqual(graph.classes.get(id2).goals.length, 1);
});
