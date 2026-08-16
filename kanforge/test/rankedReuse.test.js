// Ranked-reuse fallback (§2.8 specialization/generalization, live): exact conclusion match
// first; BM25-ranked store candidates second, kernel-verified, cap-bounded.
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

function mockGraph(rootType) {
    const classes = new Map();
    const rootId = 'root';
    classes.set(rootId, { state: 'OPEN' });
    return {
        rootId,
        classes,
        isRootSolved: () => classes.get(rootId).state === 'SOLVED',
        currentGoal: () => ({ type: rootType, context: [] }),
        setDirectProof: (id, proof) => { classes.get(id).directProof = proof; }
    };
}

function mockStore(entries, { findFail = false, ranked = [] } = {}) {
    return {
        findByGoal: () => (findFail ? null : entries[0] ?? null),
        rankByGoal: (type, ctx, opts) => ranked
    };
}

test('exact match wins and never consults the ranker', async () => {
    const stored = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'rfl' };
    const store = mockStore([stored]);
    let rankedCalled = false;
    store.rankByGoal = () => { rankedCalled = true; return []; };
    const backend = { check: async () => ({ status: 'verified' }) };
    const engine = new ReuseEngine({ backend, store });
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Even (2 ^ (2 ^ (n + 1)))'), onReuse: () => {} });
    assert.ok(r);
    assert.strictEqual(r.lemma, 'twopow_even_exp');
    assert.strictEqual(rankedCalled, false, 'ranker must not run when exact matches');
});

test('ranked fallback proves when exact match is absent; body variant carries the stored proof', async () => {
    const cand = { lemmaName: 'twopow_even_exp', statement: A, proofScript: 'by\n  exact Nat.even_iff' };
    const store = mockStore([], { findFail: true, ranked: [{ score: 9, ...cand }] });
    // The kernel rejects every by-exact source and accepts only the body-inline variant:
    // the body variant is variant 2 (index 1) of the candidate chain.
    let checks = [];
    const backend = {
        check: async (source) => {
            checks.push(source);
            if (source.includes('by exact twopow_even_exp')) return { status: 'error', error: { message: 'Unknown identifier `twopow_even_exp`' } };
            if (source.includes('exact Nat.even_iff')) return { status: 'verified' };
            return { status: 'error', error: { message: 'no' } };
        }
    };
    const engine = new ReuseEngine({ backend, store });
    const graph = mockGraph('Even (2 ^ (2 ^ (n + 1)))');
    const events = [];
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph, onReuse: e => events.push(e) });
    assert.ok(r, 'ranked fallback should prove');
    assert.strictEqual(r.lemma, 'twopow_even_exp');
    assert.strictEqual(r.directProof, 'by\n  exact Nat.even_iff', 'body variant must carry the STORED proof, not a by-exact reference');
    assert.strictEqual(graph.classes.get(graph.rootId).state, 'SOLVED');
    assert.ok(events.some(e => e.type === 'store_reuse' && e.via === 'ranked'));
});

test('ranked fallback respects the global check cap', async () => {
    const store = mockStore([], {
        findFail: true,
        ranked: [1, 2, 3].map(i => ({ score: 10 - i, lemmaName: `cand_${i}`, statement: `theorem cand_${i} : P${i} := by sorry`, proofScript: 'rfl' }))
    });
    let checks = 0;
    const backend = { check: async () => { checks++; return { status: 'error', error: { message: 'no' } }; } };
    const engine = new ReuseEngine({ backend, store, rankLimit: 3, maxRankedChecks: 2 });
    await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Q'), onReuse: () => {} });
    assert.strictEqual(checks, 2, 'cap must bound total fresh checks across candidates');
});

test('rankedReuse: false disables the fallback entirely (exact path only)', async () => {
    const store = mockStore([], { findFail: true, ranked: [{ score: 9, lemmaName: 'cand', statement: A, proofScript: 'rfl' }] });
    let checks = 0;
    const backend = { check: async () => { checks++; return { status: 'verified' }; } };
    const engine = new ReuseEngine({ backend, store, rankedReuse: false });
    const r = await engine.tryRoot({ statement: TARGET, lemmaId: 'x', graph: mockGraph('Q'), onReuse: () => {} });
    assert.strictEqual(r, null, 'no exact match and fallback disabled -> null');
    assert.strictEqual(checks, 0, 'no kernel check must fire with the fallback off');
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
