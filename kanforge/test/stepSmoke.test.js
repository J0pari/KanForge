// Multi-step goal-directed tier tests (build_order.md §5.4).
// Validates problem structure, chain definitions, proof assembly, and verifyStepSet aggregation.

import test from 'node:test';
import assert from 'node:assert';
import { STEP_PROBLEMS, STEP_FAMILIES } from '../bench/stepSmoke.js';
import { validateSmokeSet } from '../bench/smoke.js';
import { assembleProofSource, replayChain, verifyStepSet } from '../bench/verifyStepSet.js';

class ScriptedStepBackend {
    constructor(rules) {
        this.rules = rules; // array of { type, tactic, newGoals }
        this.checkCalls = [];
        this.extractCalls = 0;
        this.endedKeys = [];
    }

    async check(statement) {
        this.checkCalls.push(statement);
        if (statement.includes('SORRY_FAIL')) return { status: 'error', error: { message: 'typecheck failed' } };
        if (statement.includes(':= by\n  simp') || statement.includes(':= by\n  rfl')) {
            return { status: 'error', error: { message: 'unsolved goals remain' } };
        }
        return { status: 'verified' };
    }

    async extractGoals(statement) {
        const key = `k_${this.extractCalls++}`;
        return [{ type: 'root_goal', context: [], sessionKey: key }];
    }

    async applyTactic(goal, tactic) {
        const rule = this.rules.find(r => r.type === goal.type && r.tactic === tactic);
        if (rule) {
            return { status: 'ok', newGoals: rule.newGoals.map(type => ({ type, context: [], sessionKey: goal.sessionKey })) };
        }
        return { status: 'error', newGoals: [], error: { message: `tactic rejected: ${tactic}` } };
    }

    async verifyProof(src) {
        return this.check(src);
    }

    endLemma(key) {
        this.endedKeys.push(key);
    }
}

test('STEP_PROBLEMS set is well-formed (stub shape, chains, known families)', () => {
    assert.doesNotThrow(() => validateSmokeSet(STEP_PROBLEMS));
    assert.strictEqual(STEP_PROBLEMS.length, 10, 'expected 10 multi-step problems');

    const ids = new Set();
    for (const p of STEP_PROBLEMS) {
        assert.ok(!ids.has(p.id), `duplicate id: ${p.id}`);
        ids.add(p.id);
        assert.ok([4, 5].includes(p.tier), `${p.id} tier must be 4 or 5`);
        assert.ok(STEP_FAMILIES.includes(p.family), `${p.id} family '${p.family}' not in ${STEP_FAMILIES.join('/')}`);
        assert.match(p.statement, /:= by sorry\s*$/, `${p.id} must be a by-sorry stub`);
        assert.ok(Array.isArray(p.chain) && p.chain.length >= 2, `${p.id} chain must have >= 2 tactics`);
        assert.ok(p.chain.every(t => typeof t === 'string' && t.trim()), `${p.id} chain tactics must be non-empty strings`);
    }
});

test('validateSmokeSet rejects invalid chain fields', () => {
    assert.throws(() => validateSmokeSet([{ id: 'bad1', tier: 4, statement: 'example : True := by sorry', chain: [] }]), /chain must be a non-empty array/);
    assert.throws(() => validateSmokeSet([{ id: 'bad2', tier: 4, statement: 'example : True := by sorry', chain: [''] }]), /chain must be a non-empty array/);
    assert.throws(() => validateSmokeSet([{ id: 'bad3', tier: 4, statement: 'example : True := by sorry', chain: [123] }]), /chain must be a non-empty array/);
});

test('assembleProofSource formats tactic chains correctly', () => {
    const statement = 'example (a b : Nat) : a + b = b + a := by sorry';
    const assembled = assembleProofSource(statement, ['rw [Nat.add_comm]', 'rfl']);
    assert.match(assembled, /:= by\n  rw \[Nat\.add_comm\]\n  rfl$/);
});

test('replayChain drives tactics through GoalEGraph and solves when chain matches', async () => {
    const rules = [
        { type: 'root_goal', tactic: 'step1', newGoals: ['sub_goal'] },
        { type: 'sub_goal', tactic: 'step2', newGoals: [] }
    ];
    const backend = new ScriptedStepBackend(rules);
    const result = await replayChain(backend, 'example : True := by sorry', ['step1', 'step2']);

    assert.strictEqual(result.solved, true);
    assert.strictEqual(result.trace.length, 2);
    assert.strictEqual(backend.endedKeys.length, 1, 'session key released');
});

test('replayChain reports error when a chain step fails', async () => {
    const rules = [{ type: 'root_goal', tactic: 'step1', newGoals: ['sub_goal'] }];
    const backend = new ScriptedStepBackend(rules);
    const result = await replayChain(backend, 'example : True := by sorry', ['step1', 'wrong_step']);

    assert.strictEqual(result.solved, false);
    assert.match(result.error, /wrong_step/);
    assert.strictEqual(backend.endedKeys.length, 1, 'session key released despite failure');
});

test('verifyStepSet runs end-to-end checks and aggregate status', async () => {
    const mockProblems = [
        {
            id: 'mock_p1', tier: 4, family: 'intro',
            statement: 'example : True := by sorry',
            chain: ['step1', 'step2']
        }
    ];
    const rules = [
        { type: 'root_goal', tactic: 'step1', newGoals: ['sub1'] },
        { type: 'sub1', tactic: 'step2', newGoals: [] }
    ];
    const backend = new ScriptedStepBackend(rules);
    const report = await verifyStepSet(backend, mockProblems, { negatives: ['simp', 'rfl'] });

    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.passed, 1);
    assert.strictEqual(report.perProblem[0].id, 'mock_p1');
    assert.strictEqual(report.perProblem[0].checks.stubTypechecks, true);
    assert.strictEqual(report.perProblem[0].checks.chainProves, true);
    assert.strictEqual(report.perProblem[0].checks.assembledVerifies, true);
    assert.strictEqual(report.perProblem[0].checks.negativesHeld, true);
});
