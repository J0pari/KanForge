// Premise retrieval tests (architecture.md §5, build_order.md §5.2):
// lexical (BM25) relevance scoring, premise-locked prompting, the commit-time premise-lock
// guard, and TacticLoop integration (premises_retrieved events + lock trip).

import test from 'node:test';
import assert from 'node:assert';
import {
    PremiseRetriever,
    tokenize,
    buildPremisePrompt,
    findPremiseLockViolations,
    premisesUsedIn,
    extractIdentifiers
} from '../search/premises.js';
import { TacticLoop } from '../agent/loop.js';

const CORPUS = [
    { name: 'Nat.add_comm', type: '(a b : Nat) : a + b = b + a' },
    { name: 'Nat.add_assoc', type: '(a b c : Nat) : (a + b) + c = a + (b + c)' },
    { name: 'Nat.mul_comm', type: '(a b : Nat) : a * b = b * a' },
    { name: 'unrelated', type: '(p : Prop) : p → p' }
];

test('tokenize splits dotted/camel identifiers and keeps math variables', () => {
    assert.deepStrictEqual(
        tokenize('Nat.add_comm (a b : Nat) : a + b = b + a'),
        ['nat', 'add', 'comm', 'a', 'b', 'nat', 'a', 'b', 'b', 'a']
    );
    assert.deepStrictEqual(tokenize('List.filterMap_id'), ['list', 'filter', 'map', 'id']);
    assert.ok(tokenize('').length === 0);
});

test('extractIdentifiers returns full dotted identifiers', () => {
    assert.deepStrictEqual(extractIdentifiers('rw [Nat.add_comm]; exact foo.bar'), ['rw', 'Nat.add_comm', 'exact', 'foo.bar']);
});

test('retrieve ranks the matching premise first with descending scores', () => {
    const r = new PremiseRetriever(CORPUS);
    const goal = { type: 'a + b = b + a', context: [{ name: 'a', type: 'Nat' }, { name: 'b', type: 'Nat' }] };
    const hits = r.retrieve(goal, 3);

    assert.strictEqual(hits[0].name, 'Nat.add_comm');
    for (let i = 1; i < hits.length; i++) {
        assert.ok(hits[i - 1].score >= hits[i].score, 'scores must be descending');
    }
    assert.ok(hits.length <= 3);
    assert.ok(hits.every(h => h.score > 0));
});

test('retrieve returns topK most relevant and is deterministic', () => {
    const r = new PremiseRetriever(CORPUS);
    const goal = { type: 'a * b = b * a', context: [] };
    const a = r.retrieve(goal, 1);
    const b = r.retrieve(goal, 1);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].score, b[0].score);
});

test('retrieve handles empty corpus and goals with no lexical overlap', () => {
    const empty = new PremiseRetriever([]);
    assert.deepStrictEqual(empty.retrieve({ type: 'a = a', context: [] }, 3), []);

    const r = new PremiseRetriever(CORPUS);
    assert.deepStrictEqual(r.retrieve({ type: 'Quux → Quux', context: [] }, 3), []);
});

test('buildPremisePrompt injects premises and honors the premise-locked flag', () => {
    const goal = { type: 'a + b = b + a', context: [{ name: 'a', type: 'Nat' }] };
    const premises = [{ name: 'Nat.add_comm', type: '(a b : Nat) : a + b = b + a' }];

    const open = buildPremisePrompt(goal, premises, { attempt: 1, maxAttempts: 8, premiseLocked: false });
    assert.ok(open[1].content.includes('Premises'));
    assert.ok(open[1].content.includes('Nat.add_comm'));
    assert.ok(!open[0].content.includes('ONLY use the premises'));

    const locked = buildPremisePrompt(goal, premises, { attempt: 1, maxAttempts: 8, premiseLocked: true });
    assert.ok(locked[0].content.includes('ONLY use the premises'));

    const bare = buildPremisePrompt(goal, [], { attempt: 1, maxAttempts: 8 });
    assert.ok(!bare[1].content.includes('Premises'));
    assert.ok(bare[1].content.includes('Propose ONE tactic'));
});

test('premisesUsedIn resolves dotted-suffix aliases', () => {
    assert.deepStrictEqual(premisesUsedIn('by\n  exact mul_comm', CORPUS), ['Nat.mul_comm']);
    assert.deepStrictEqual(premisesUsedIn('by\n  rw [Nat.add_comm]', CORPUS), ['Nat.add_comm']);
});

test('findPremiseLockViolations flags unretrieved corpus premises only', () => {
    const src = 'by\n  rw [Nat.add_comm]';
    assert.deepStrictEqual(findPremiseLockViolations(src, CORPUS, ['Nat.add_comm']), []);
    assert.deepStrictEqual(findPremiseLockViolations(src, CORPUS, ['Nat.add_assoc']), ['Nat.add_comm']);
    assert.deepStrictEqual(findPremiseLockViolations('by\n  omega', CORPUS, []), []);
});

// --- TacticLoop integration ---

function lockBackend(tactics) {
    return {
        tacticCalls: [],
        async applyTactic(goal, tactic) {
            this.tacticCalls.push(tactic);
            if (tactics.includes(tactic)) return { status: 'ok', newGoals: [] };
            return { status: 'error', newGoals: [], error: { message: `unknown tactic: ${tactic}` } };
        },
        async extractGoals(statement) {
            return [{ type: '(x y z : Nat) → (x + y) + z = x + (y + z)', context: [] }];
        },
        async verifyProof(source, key) {
            return { status: 'verified' };
        },
        endLemma() {},
        pin() { return {}; }
    };
}

class RecordingLLM {
    constructor(tactic) {
        this.tactic = tactic;
        this.messages = [];
    }
    async complete(messages) {
        this.messages.push(messages);
        return { text: this.tactic };
    }
}

const LOCK_CORPUS = [
    { name: 'nat.add_assoc', type: '(a b c : Nat) : (a + b) + c = a + (b + c)' },
    { name: 'list.append_assoc', type: '(xs ys zs : List α) : (xs ++ ys) ++ zs = xs ++ (ys ++ zs)' }
];

test('TacticLoop retrieves premises, injects them into the prompt, and passes the lock', async () => {
    const backend = lockBackend(['rw [nat.add_assoc]']);
    const llm = new RecordingLLM('rw [nat.add_assoc]');
    const loop = new TacticLoop({ backend, llm, premises: LOCK_CORPUS, premiseLocked: true, premiseTopK: 5, maxTacticsPerGoal: 1, onEvent: () => {} });

    loop.addLemma('example : (x y z : Nat) → (x + y) + z = x + (y + z) := by sorry');
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, true);

    const events = loop.events();
    const retrieved = events.filter(e => e.type === 'premises_retrieved');
    assert.ok(retrieved.length >= 1);
    assert.ok(retrieved[0].names.includes('nat.add_assoc'));
    assert.ok(!retrieved[0].names.includes('list.append_assoc'), 'unrelated premise filtered out');

    const prompt = llm.messages[0];
    assert.ok(prompt[1].content.includes('Premises'));
    assert.ok(prompt[1].content.includes('nat.add_assoc'));
    assert.ok(prompt[0].content.includes('ONLY use the premises'));

    assert.strictEqual(events.filter(e => e.type === 'guardrail_trip').length, 0);
});

test('TacticLoop premise-lock trips the commit guardrail on unretrieved usage', async () => {
    const backend = lockBackend(['rw [list.append_assoc]']);
    const llm = new RecordingLLM('rw [list.append_assoc]');
    const loop = new TacticLoop({ backend, llm, premises: LOCK_CORPUS, premiseLocked: true, premiseTopK: 5, maxTacticsPerGoal: 1, onEvent: () => {} });

    loop.addLemma('example : (x y z : Nat) → (x + y) + z = x + (y + z) := by sorry');
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, false);

    const events = loop.events();
    const trip = events.find(e => e.type === 'guardrail_trip');
    assert.ok(trip);
    assert.strictEqual(trip.violation.type, 'PREMISE_LOCK_VIOLATION');
    assert.ok(trip.violation.names.includes('list.append_assoc'));
});

test('premise retrieval is a no-op when no corpus is configured', async () => {
    const backend = lockBackend(['omega']);
    const loop = new TacticLoop({ backend, llm: new RecordingLLM('omega'), maxTacticsPerGoal: 1, onEvent: () => {} });
    loop.addLemma('example : 1 = 1 := by sorry');
    const outcome = await loop.proveAll();
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(loop.events().filter(e => e.type === 'premises_retrieved').length, 0);
});

// --- §5.4 step-tier corpus (build_order.md §5.4 open item) ---

import { PREMS_STEP_1, PREMS_STEP_1_NO_RW, PREMISE_CORPORA } from '../bench/premisesCorpus.js';
import { STEP_PROBLEMS } from '../bench/stepSmoke.js';

// Named premises each step problem's golden chain requires (tactic-only chains have none).
const STEP_NEEDED = {
    or_elim: [], or_comm: ['Or.inl', 'Or.inr'], and_intro_chain: [], imp_trans: [], modus_tollens: [],
    distrib_twice: ['Nat.mul_add', 'Nat.add_mul'], square_expand: ['Nat.mul_add', 'Nat.add_mul'],
    mul_comm_rw: ['Nat.mul_comm'], func_compose: [], eq_trans_chain: []
};

test('step premise corpus is well-formed: name+type on every entry, all names unique', () => {
    const names = new Set();
    for (const p of PREMS_STEP_1) {
        assert.ok(typeof p.name === 'string' && p.name.length > 0, 'name present');
        assert.ok(typeof p.type === 'string' && p.type.length > 0, 'type present');
        assert.ok(!names.has(p.name), `duplicate premise name ${p.name}`);
        names.add(p.name);
    }
    assert.strictEqual(PREMS_STEP_1.length, names.size);
});

test('step-no-rw control drops exactly the T5 rewrite identities', () => {
    assert.deepStrictEqual(
        PREMS_STEP_1.filter(p => !PREMS_STEP_1_NO_RW.some(q => q.name === p.name)).map(p => p.name).sort(),
        ['Nat.add_mul', 'Nat.mul_add', 'Nat.mul_comm']
    );
    assert.strictEqual(PREMS_STEP_1_NO_RW.length, PREMS_STEP_1.length - 3);
    assert.strictEqual(PREMISE_CORPORA['step-no-rw'], PREMS_STEP_1_NO_RW);
    assert.strictEqual(PREMISE_CORPORA.step, PREMS_STEP_1);
});

test('step corpus retrieves every chain-required premise for its problem at top-8 (quality floor)', () => {
    const retriever = new PremiseRetriever(PREMS_STEP_1);
    for (const p of STEP_PROBLEMS) {
        const goalType = p.statement.replace(/^example\s+(.*?):\s*/, '').replace(/\s*:= by sorry\s*$/, '').trim();
        const top = new Set(retriever.retrieve({ type: goalType }, 8).map(h => h.name));
        const missing = STEP_NEEDED[p.id].filter(n => !top.has(n));
        assert.deepStrictEqual(missing, [], `${p.id} must retrieve ${STEP_NEEDED[p.id].join(', ')} in top-8`);
    }
});
