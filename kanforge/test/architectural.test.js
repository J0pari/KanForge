// Architectural verification (architecture.md §2.2, §4) — node:test form.
// - Level 1: Lemma DAG (dependency-ordered dispatch)
// - Level 2: Goal e-graph (tactic-level search within each lemma)
// - Each LLM call proposes ONE tactic for ONE goal; the backend applies it and returns subgoals
// - The proof is a tree of tactic applications; commit verifies the FULL statement source
// - No timeout possible by design (each operation is bounded)

import test from 'node:test';
import assert from 'node:assert';
import { TacticLoop } from '../agent/loop.js';

// Mock backend that tracks all operations (unit-level; the real-kernel contract is covered
// by the gated live suite in live.repl.test.js — never faked there).
export class MockBackend {
    constructor() {
        this.tacticCalls = [];
        this.verifyCalls = [];
        this.ended = [];
    }

    async applyTactic(goal, tactic) {
        this.tacticCalls.push({ goal, tactic });
        if (tactic === 'intro h') {
            return { status: 'ok', newGoals: [{ type: 'Q', context: [{ name: 'h', type: 'P' }] }] };
        } else if (tactic === 'omega') {
            return { status: 'ok', newGoals: [] };
        }
        return { status: 'error', newGoals: [], error: { message: `unknown tactic: ${tactic}` } };
    }

    async extractGoals(statement) {
        return [{ type: 'P → Q', context: [] }];
    }

    async verifyProof(source, key) {
        this.verifyCalls.push({ source, key });
        return { status: 'verified' };
    }

    endLemma(key) {
        this.ended.push(key);
    }

    pin() {
        return { toolchain: 'mock', normVersion: 1 };
    }

    getInfos() {
        return { backends: ['mock'] };
    }
}

export class MockLLM {
    constructor(tactics) {
        this.tactics = tactics;
        this.callIndex = 0;
    }

    async complete() {
        return { text: this.tactics[this.callIndex++ % this.tactics.length] };
    }
}

function quietLoop(opts) {
    return new TacticLoop({ onEvent: () => {}, ...opts });
}

test('backward decomposition: root goal → subgoal → solved', async () => {
    const backend = new MockBackend();
    const loop = quietLoop({ backend, llm: new MockLLM(['intro h', 'omega']), maxTacticsPerGoal: 2, maxGoalsPerLemma: 10 });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');

    const outcome = await loop.proveAll();
    const events = loop.events();
    const byType = t => events.filter(e => e.type === t);

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(byType('goal_selected').length, 2);
    assert.strictEqual(byType('tactic_applied').length, 2);
    assert.strictEqual(byType('subgoal_created').length, 1);
    assert.strictEqual(byType('goal_solved').length, 1);
    assert.strictEqual(backend.tacticCalls.length, 2); // each call: ONE tactic for ONE goal
});

test('atomic operations are bounded (no timeout)', async () => {
    const backend = new MockBackend();
    const loop = quietLoop({ backend, llm: new MockLLM(['omega']), maxTacticsPerGoal: 1 });
    loop.addLemma('example : 1 + 1 = 2 := by sorry');

    const start = Date.now();
    const outcome = await loop.proveAll();
    assert.ok(Date.now() - start < 1000);
    assert.strictEqual(outcome.ok, true);
});

test('proof tree straightens into the full statement source at commit', async () => {
    const backend = new MockBackend();
    const loop = quietLoop({ backend, llm: new MockLLM(['intro h', 'omega']), maxTacticsPerGoal: 2 });
    const lemmaId = loop.addLemma('example (P Q : Prop) : P → Q := by sorry');

    await loop.proveAll();
    const verified = loop.events().filter(e => e.type === 'lemma_verified').pop();

    assert.ok(verified);
    assert.ok(verified.proofScript.includes('intro h'));
    assert.ok(verified.proofScript.includes('omega'));

    // The kernel received the FULL source (statement + script), keyed to the lemma session.
    assert.strictEqual(backend.verifyCalls.length, 1);
    const { source, key } = backend.verifyCalls[0];
    assert.strictEqual(key, lemmaId);
    assert.ok(source.startsWith('example (P Q : Prop) : P → Q := by'));
    assert.ok(source.includes('intro h'));
    assert.ok(!/sorry/.test(source));

    // Session lifecycle: the leased worker was released exactly once.
    assert.deepStrictEqual(backend.ended, [lemmaId]);
});
