// Ranked-reuse fallback (§2.8 specialization/generalization) + proof-pattern transfer
// (session exact/apply/rw + trajectory replay): exact conclusion match first; ranked BM25
// candidates second; transfer operators before source inlining — all kernel-verified.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReuseEngine } from '../agent/reuseEngine.js';
import { LemmaStore } from '../growth/lemmaStore.js';
import { hashStatement } from '../lean/pin.js';

const TARGET = 'theorem goal_lem (n : Nat) : Even (2 ^ (2 ^ (n + 1))) := by sorry';
const A = 'theorem twopow_even_exp (n : Nat) : Even (2 ^ n) := by sorry';
const B = 'theorem mod_three_step (n : Nat) : n % 3 = 1 := by sorry';

// Minimal graph honoring the GoalStateGraph contract surface the reuse engine uses.
function mockGraph(rootType, { applyOk = () => true, closer = () => false } = {}) {
    const classes = new Map();
    const rootId = 'root';
    classes.set(rootId, { state: 'OPEN' });
    const graph = {
        rootId,
        classes,
        isRootSolved: () => classes.get(rootId).state === 'SOLVED',
        currentGoal: () => ({ type: classes.get(rootId).goalType ?? rootType, context: [] }),
        setDirectProof: (id, proof) => { classes.get(id).directProof = proof; },
        applyPatch: (patch) => {
            if (!applyOk(patch)) return { carriedOver: [], created: 0, subgoalClasses: [] };
            const closes = closer(patch) || (patch.meta?.newGoals?.length ?? 1) === 0;
            if (closes) classes.get(rootId).state = 'SOLVED';
            return { carriedOver: [], created: patch.meta?.newGoals?.length ?? 0, subgoalClasses: [] };
        }
    };
    return graph;
}

function mockStore(entries, { findFail = false, ranked = [] } = {}) {
    return {
        findByGoal: () => (findFail ? null : entries[0] ?? null),
        rankByGoal: (type, ctx, opts) => ranked
    };
}

test('exact match wins and never consults the ranker', async () => {
    const stored = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'rfl', tacticTrajectory: [] };
    const store = mockStore([stored]);
    let rankedCalled = false;
    store.rankByGoal = () => { rankedCalled = true; return []; };
    const backend = {
        check: async () => ({ status: 'verified' }),
        applyTactic: async () => ({ status: 'error', newGoals: [], error: { message: 'no' } })
    };
    const engine = new ReuseEngine({ backend, store });
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Even (2 ^ (2 ^ (n + 1)))'), onReuse: () => {} });
    assert.ok(r);
    assert.strictEqual(r.lemma, 'twopow_even_exp');
    assert.strictEqual(rankedCalled, false, 'ranker must not run when exact matches');
});

test('session transfer: apply <name> closes via the elaborator (specialization)', async () => {
    const stored = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'rfl', tacticTrajectory: [] };
    const store = mockStore([stored]);
    const backend = {
        check: async () => ({ status: 'error', error: { message: 'never reached' } }),
        applyTactic: async (goal, tactic) => (tactic === 'apply twopow_even_exp')
            ? { status: 'ok', newGoals: [] }
            : { status: 'error', newGoals: [], error: { message: 'no' } }
    };
    const engine = new ReuseEngine({ backend, store });
    const graph = mockGraph('Even (2 ^ (2 ^ (n + 1)))');
    const events = [];
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph, onReuse: e => events.push(e) });
    assert.ok(r, 'apply-transfer should close the goal');
    assert.strictEqual(r.lemma, 'twopow_even_exp');
    assert.strictEqual(graph.classes.get(graph.rootId).state, 'SOLVED');
    assert.ok(events.some(e => e.type === 'store_reuse_transfer' && e.via === 'apply'));
    assert.ok(events.some(e => e.type === 'store_reuse' && e.via === 'exact'));
});

test('trajectory replay transfers multi-step reasoning to a new goal', async () => {
    const stored = {
        lemmaName: 'twopow_even_exp', statement: A, proofScript: 'by\n  intro k\n  rw [Nat.pow_two]',
        tacticTrajectory: ['intro k', 'rw [Nat.pow_two]', 'rfl']
    };
    const store = mockStore([stored]);
    const backend = {
        check: async () => ({ status: 'error', error: { message: 'never reached' } }),
        applyTactic: async (goal, tactic) => {
            if (tactic === 'intro k') return { status: 'ok', newGoals: [{ type: 'inner' }] };
            if (tactic === 'rw [Nat.pow_two]') return { status: 'ok', newGoals: [] };
            return { status: 'error', newGoals: [], error: { message: 'no' } };
        }
    };
    const engine = new ReuseEngine({ backend, store });
    const graph = mockGraph('∀ k : Nat, Even (2 ^ k)');
    const events = [];
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph, onReuse: e => events.push(e) });
    assert.ok(r, 'trajectory replay should close');
    const transfers = events.filter(e => e.type === 'store_reuse_transfer' && e.via === 'trajectory');
    assert.ok(transfers.length >= 2, 'both replay steps should emit transfer events');
});

test('ranked fallback proves when exact match is absent; body variant carries the stored proof', async () => {
    const cand = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'by\n  exact Nat.even_iff', tacticTrajectory: [] };
    const store = mockStore([], { findFail: true, ranked: [{ score: 9, ...cand }] });
    const backend = {
        check: async (source) => {
            if (source.includes('by exact twopow_even_exp')) return { status: 'error', error: { message: 'Unknown identifier `twopow_even_exp`' } };
            if (source.includes('exact Nat.even_iff')) return { status: 'verified' };
            return { status: 'error', error: { message: 'no' } };
        },
        applyTactic: async () => ({ status: 'error', newGoals: [], error: { message: 'no' } })
    };
    const engine = new ReuseEngine({ backend, store });
    const graph = mockGraph('Even (2 ^ (2 ^ (n + 1)))');
    const events = [];
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph, onReuse: e => events.push(e) });
    assert.ok(r, 'ranked fallback should prove');
    assert.strictEqual(r.lemma, 'twopow_even_exp');
    assert.strictEqual(r.directProof, 'by\n  exact Nat.even_iff', 'body variant must carry the STORED proof');
    assert.ok(events.some(e => e.type === 'store_reuse' && e.via === 'ranked'));
});

test('ranked fallback respects the global check cap', async () => {
    const store = mockStore([], {
        findFail: true,
        ranked: [1, 2, 3].map(i => ({ score: 10 - i, lemmaName: `cand_${i}`, statement: `theorem cand_${i} : P${i} := by sorry`, proofScript: 'rfl', tacticTrajectory: [] }))
    });
    let checks = 0;
    const backend = {
        check: async () => { checks++; return { status: 'error', error: { message: 'no' } }; },
        applyTactic: async () => ({ status: 'error', newGoals: [], error: { message: 'no' } })
    };
    const engine = new ReuseEngine({ backend, store, rankLimit: 3, maxRankedChecks: 2 });
    await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Q'), onReuse: () => {} });
    assert.strictEqual(checks, 2, 'cap must bound total fresh checks across candidates');
});

test('rankedReuse: false disables the fallback entirely (exact path only)', async () => {
    const store = mockStore([], { findFail: true, ranked: [{ score: 9, lemmaName: 'cand', statement: A, proofScript: 'rfl', tacticTrajectory: [] }] });
    let checks = 0;
    const backend = {
        check: async () => { checks++; return { status: 'verified' }; },
        applyTactic: async () => ({ status: 'error', newGoals: [], error: { message: 'no' } })
    };
    const engine = new ReuseEngine({ backend, store, rankedReuse: false });
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Q'), onReuse: () => {} });
    assert.strictEqual(r, null, 'no exact match and fallback disabled -> null');
    assert.strictEqual(checks, 0, 'no kernel check must fire with the fallback off');
});

test('reuseTransfer: false skips session ops (inlining-only)', async () => {
    const stored = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'rfl', tacticTrajectory: ['rfl'] };
    const store = mockStore([stored]);
    let applied = 0;
    const backend = {
        check: async () => ({ status: 'verified' }),
        applyTactic: async () => { applied++; return { status: 'ok', newGoals: [] }; }
    };
    const engine = new ReuseEngine({ backend, store, reuseTransfer: false });
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Q'), onReuse: () => {} });
    assert.ok(r);
    assert.strictEqual(applied, 0, 'no session tactic may fire with transfer off');
});

test('LemmaStore.rankByGoal ranks relevant entries and invalidates on put', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-rank-'));
    try {
        const store = new LemmaStore({ dir });
        const put = (statement, proofScript) => store.put(hashStatement(statement), {
            statementHash: hashStatement(statement), statement, proofScript,
            lemmaName: (statement.match(/theorem\s+([A-Za-z_][A-Za-z0-9_']*)/) ?? [])[1] ?? null,
            deps: []
        });
        put(A, 'rfl');
        put(B, 'rfl');
        put('theorem unrelated_set (s : Set Nat) : s = s := by sorry', 'rfl');
        put('theorem unproved_one : X := by sorry', 'by\n  sorry');

        const ranked = store.rankByGoal('Even (2 ^ n)', [], { limit: 2 });
        assert.ok(ranked.length >= 1);
        assert.strictEqual(ranked[0].lemmaName, 'twopow_even_exp');
        assert.ok(ranked.every(r => !String(r.proofScript).includes('sorry')), 'unproved entries never rank');

        const rankedMod = store.rankByGoal('n % 3 = 1', [], { limit: 2 });
        assert.strictEqual(rankedMod[0].lemmaName, 'mod_three_step');

        put('theorem twopow_even_exp_2 (n : Nat) : Even (2 ^ n) := by sorry', 'rfl');
        const rankedAfter = store.rankByGoal('Even (2 ^ n)', [], { limit: 3 });
        assert.ok(rankedAfter.some(r => r.lemmaName === 'twopow_even_exp_2'), 'rank index must invalidate on put');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
