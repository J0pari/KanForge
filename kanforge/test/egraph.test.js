// Goal e-graph frontier semantics (architecture.md §2.2).
// The repl tactic API reports the FULL remaining frontier after a tactic, not just the
// subgoals it created. These tests pin the carry-over behavior: closing one branch must not
// re-attach its still-open siblings under it, or the extracted proof tree double-counts a
// goal and the committed script is rejected by the kernel.
import test from 'node:test';
import assert from 'node:assert';
import { GoalEGraph } from '../core/egraph.js';
import { straighten, assertRoundTrip } from '../core/state.js';

test('carries over siblings instead of double-attaching them (constructor case)', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: '1 = 1 ∧ 2 = 2', context: [] });

    const left = { type: '1 = 1', context: [], proofState: 1 };
    const right = { type: '2 = 2', context: [], proofState: 1 };
    const rec = egraph.applyTactic(rootId, 'constructor', [left, right]);
    assert.strictEqual(rec.subgoalClasses.length, 2);
    const leftId = rec.subgoalClasses[0];
    const rightId = rec.subgoalClasses[1];
    assert.deepStrictEqual(egraph.getOpenGoals().map(g => g.id), [leftId, rightId]);

    // rfl on the left branch: the repl reports the remaining right goal — carried over,
    // NOT a child of left. Its concrete instance is refreshed to the new proofState.
    const r1 = egraph.applyTactic(leftId, 'rfl', [{ type: '2 = 2', context: [], proofState: 2 }]);
    assert.deepStrictEqual(r1.subgoalClasses, []);
    assert.deepStrictEqual(r1.carriedOver, [rightId]);
    assert.strictEqual(egraph.currentGoal(rightId).proofState, 2);
    assert.deepStrictEqual(egraph.getOpenGoals().map(g => g.id), [rightId]);

    egraph.applyTactic(rightId, 'rfl', []);
    assert.strictEqual(egraph.isRootSolved(), true);

    // The extracted tree has TWO independent branches — no nested rfl under left.
    assert.deepStrictEqual(egraph.extractProof(), {
        tactic: 'constructor',
        subproofs: [
            { tactic: 'rfl', subproofs: [] },
            { tactic: 'rfl', subproofs: [] }
        ]
    });
});

test('new children precede carried siblings in the frontier', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: 'A ∧ B', context: [] });

    const A = { type: 'A', context: [] };
    const B = { type: 'B', context: [] };
    const rec = egraph.applyTactic(rootId, 'constructor', [A, B]);
    const [aId, bId] = rec.subgoalClasses;

    // Splitting A returns its two children PLUS the still-open B sibling.
    const r2 = egraph.applyTactic(aId, 'constructor', [
        { type: 'A1', context: [] },
        { type: 'A2', context: [] },
        { type: 'B', context: [] }
    ]);
    assert.strictEqual(r2.subgoalClasses.length, 2);
    assert.deepStrictEqual(r2.carriedOver, [bId]);
    assert.deepStrictEqual(egraph.getOpenGoals().map(g => g.id), [...r2.subgoalClasses, bId]);

    egraph.applyTactic(r2.subgoalClasses[0], 'rfl', []);
    egraph.applyTactic(r2.subgoalClasses[1], 'rfl', []);
    egraph.applyTactic(bId, 'rfl', []);
    assert.strictEqual(egraph.isRootSolved(), true);

    const tree = egraph.extractProof();
    assert.strictEqual(assertRoundTrip(tree), true);
    assert.strictEqual(straighten(tree).script.split('rfl').length - 1, 3);
});

test('transposed reuse: an already-solved class referenced again stays a leaf occurrence', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: 'A ∧ (B → A)', context: [] });

    const A = { type: 'A', context: [] };
    const imp = { type: 'B → A', context: [] };
    const rec = egraph.applyTactic(rootId, 'constructor', [A, imp]);
    const [aId, impId] = rec.subgoalClasses;

    // Left A solved by rfl; the B → A sibling carries.
    egraph.applyTactic(aId, 'rfl', []);
    const r2 = egraph.applyTactic(impId, 'intro h', [{ type: 'A', context: [{ name: 'h', type: 'B' }] }]);
    // The new A has a context binder, so it is a DIFFERENT class from the left A — a child.
    assert.strictEqual(r2.subgoalClasses.length, 1);
    const a2Id = r2.subgoalClasses[0];
    egraph.applyTactic(a2Id, 'rfl', []);
    assert.strictEqual(egraph.isRootSolved(), true);

    const tree = egraph.extractProof();
    assert.strictEqual(tree.subproofs.length, 2);
    assert.strictEqual(tree.subproofs[1].subproofs[0].tactic, 'rfl');
    assert.strictEqual(assertRoundTrip(tree), true);
});

test('extractProof terminates on a self-referential tactic result (no-progress tactic)', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: 'X', context: [] });
    // A tactic that reports the very same goal back (carried to head again).
    const rec = egraph.applyTactic(rootId, 'hack', [{ type: 'X', context: [] }]);
    assert.deepStrictEqual(rec.subgoalClasses, []);
    assert.deepStrictEqual(rec.carriedOver, [rootId]);
    assert.strictEqual(egraph.isRootSolved(), false);
    // Extraction must not hang; there is no solved path.
    assert.strictEqual(egraph.extractProof(), null);
});

test('isSolved terminates on a goal-class cycle (subgoal hashes back to an ancestor)', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: 'b * a = c', context: [] });
    // rw [Nat.mul_comm] moves the frontier to a new class...
    const child = { type: 'a * b = c', context: [], proofState: 1 };
    const rec1 = egraph.applyTactic(rootId, 'rw [Nat.mul_comm]', [child]);
    const childId = rec1.subgoalClasses[0];
    assert.notStrictEqual(childId, rootId);
    // ...and applying it again reports the root goal back, which hashes to the ROOT class
    // (not in the frontier, so it is attached as a child): a cycle root -> child -> root.
    const rec2 = egraph.applyTactic(childId, 'rw [Nat.mul_comm]', [{ type: 'b * a = c', context: [], proofState: 2 }]);
    assert.deepStrictEqual(rec2.subgoalClasses, [rootId]);
    // Must not blow the stack; there is no solved path.
    assert.strictEqual(egraph.isRootSolved(), false);
    assert.strictEqual(egraph.extractProof(), null);
});

test('serialize/deserialize preserves the frontier', () => {
    const egraph = new GoalEGraph();
    const rootId = egraph.setRoot({ type: 'A ∧ B', context: [] });
    const rec = egraph.applyTactic(rootId, 'constructor', [{ type: 'A', context: [] }, { type: 'B', context: [] }]);
    const restored = GoalEGraph.deserialize(egraph.serialize());
    assert.deepStrictEqual(restored.frontier, [rec.subgoalClasses[0], rec.subgoalClasses[1]]);
    assert.deepStrictEqual(restored.getOpenGoals().map(g => g.id), restored.frontier);
});
