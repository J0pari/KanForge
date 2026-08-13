// Shared GoalStateGraph conformance scenarios (core/goalStateGraph.js): every structure that
// implements the contract runs these. The scenarios assert INTERFACE behavior — frontier
// semantics, tactic records, solved propagation, proof extraction, serialization round-trips,
// parent edges, shared stats — and leave each structure's IDENTITY rule (which goals merge) to
// itself. The single required merge is alpha-equivalent contexts (both structures must treat
// binder renaming as the same state, or transposition merging is meaningless).
import assert from 'node:assert';
import test from 'node:test';

export const CONTRACT_SCENARIOS = [
    {
        name: 'root registers and exposes the frontier',
        run: (make) => {
            const g = make();
            const id = g.setRoot({ type: '1 = 1 ∧ 2 = 2', context: [] });
            assert.strictEqual(g.rootId, id);
            assert.strictEqual(g.getOpenGoals().length, 1);
            assert.strictEqual(g.getOpenGoals()[0].id, id);
        }
    },
    {
        name: 'applyTactic records children, advances the frontier, carried-over siblings get no parent edge',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'A ∧ B', context: [] });
            const rec = g.applyTactic(rootId, 'constructor', [
                { type: 'A', context: [] },
                { type: 'B', context: [] }
            ]);
            assert.strictEqual(rec.subgoalClasses.length, 2);
            assert.strictEqual(rec.carriedOver.length, 0);
            assert.deepStrictEqual(g.getOpenGoals().map(c => c.id), rec.subgoalClasses);
            // Carried-over sibling: re-applying a tactic that returns a goal already on the
            // frontier must NOT attach a parent edge to it.
            const rec2 = g.applyTactic(rec.subgoalClasses[0], 'rfl', [
                { type: 'B', context: [] } // B is a sibling, not a child of A's rfl
            ]);
            assert.strictEqual(rec2.carriedOver.length, 1);
            const bClass = g.classes.get(rec.subgoalClasses[1]);
            assert.ok(!bClass.parents.includes(rec.subgoalClasses[0]), 'carried-over sibling must not acquire a false parent');
        }
    },
    {
        name: 'solved chain produces a proof tree via extractProof',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'A ∧ B', context: [] });
            const rec = g.applyTactic(rootId, 'constructor', [{ type: 'A', context: [] }, { type: 'B', context: [] }]);
            g.applyTactic(rec.subgoalClasses[0], 'rfl', []);
            g.applyTactic(rec.subgoalClasses[1], 'rfl', []);
            assert.strictEqual(g.isRootSolved(), true);
            assert.deepStrictEqual(g.extractProof(), {
                tactic: 'constructor',
                subproofs: [
                    { tactic: 'rfl', subproofs: [] },
                    { tactic: 'rfl', subproofs: [] }
                ]
            });
        }
    },
    {
        name: 'cycle guard: a self-referential subgoal terminates isSolved and does not fake a proof',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'b * a = c', context: [] });
            const rec = g.applyTactic(rootId, 'rw [Nat.mul_comm]', [{ type: 'b * a = c', context: [] }]);
            // The subgoal re-attaches the root class (rw of mul_comm twice returns to the start).
            assert.strictEqual(rec.subgoalClasses.length <= 1, true);
            assert.strictEqual(g.isRootSolved(), false);
            assert.strictEqual(g.extractProof(), null);
        }
    },
    {
        name: 'markFailed removes a class from the open goals',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'X', context: [] });
            g.applyTactic(rootId, 'constructor', [{ type: 'X1', context: [] }, { type: 'X2', context: [] }]);
            const [a, b] = g.getOpenGoals();
            g.markFailed(a.id);
            const open = g.getOpenGoals();
            assert.ok(!open.some(c => c.id === a.id), 'failed class excluded from open goals');
            assert.ok(open.some(c => c.id === b.id), 'sibling stays open');
        }
    },
    {
        name: 'serialize/deserialize round-trip preserves solved state and extraction',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'A ∧ B', context: [] });
            const rec = g.applyTactic(rootId, 'constructor', [{ type: 'A', context: [] }, { type: 'B', context: [] }]);
            g.applyTactic(rec.subgoalClasses[0], 'rfl', []);
            g.applyTactic(rec.subgoalClasses[1], 'rfl', []);
            const restored = g.constructor.deserialize(g.serialize());
            assert.strictEqual(restored.isRootSolved(), true);
            assert.deepStrictEqual(restored.extractProof(), g.extractProof());
        }
    },
    {
        name: 'transposition: alpha-equivalent contexts share one class with shared stats',
        run: (make) => {
            const g = make();
            const id1 = g.addGoal({ type: 'a < b', context: [{ name: 'x', type: 'Nat' }] });
            const id2 = g.addGoal({ type: 'a < b', context: [{ name: 'y', type: 'Nat' }] });
            assert.strictEqual(id1, id2, 'alpha-equivalent contexts must merge');
            const cls = g.classes.get(id1);
            assert.strictEqual(cls.goals.length, 2);
            assert.strictEqual(g.getStats(id1).visits, 0);
            g.updateValue(id1, 3);
            assert.strictEqual(g.getStats(id2).value, 3, 'stats shared across the class');
        }
    },
    {
        name: 'parents: genuine children carry the parent id (MCGS backprop walks ancestry)',
        run: (make) => {
            const g = make();
            const rootId = g.setRoot({ type: 'A ∧ B', context: [] });
            const rec = g.applyTactic(rootId, 'constructor', [{ type: 'A', context: [] }, { type: 'B', context: [] }]);
            for (const childId of rec.subgoalClasses) {
                const cls = g.classes.get(childId);
                assert.ok(cls.parents.includes(rootId), `child ${childId} must carry parent ${rootId}`);
            }
        }
    }
];

// Register every scenario as a node:test case for a labeled structure factory.
export function registerGoalStateGraphConformance(label, makeStructure) {
    for (const scenario of CONTRACT_SCENARIOS) {
        test(`[contract] ${label}: ${scenario.name}`, () => scenario.run(makeStructure));
    }
}
