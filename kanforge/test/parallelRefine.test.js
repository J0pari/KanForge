// Frontier-parallel refine: batch dispatch of independent ready lemmas, serial merge, and the
// deadlock-release retry lane (reduced tactic budget + deepened re-split feeding prior children).
import test from 'node:test';
import assert from 'node:assert';
import { BlueprintRefiner } from '../blueprint/refine.js';
import { hashStatement } from '../lean/pin.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';
import { resolveModule } from '../lean/moduleResolver.js';
import { MATHLIB_PRESENT } from './mathlibEnv.js';

const THM = 'theorem thm : P := by sorry';
const H1 = 'theorem h1 : P := by sorry';
const H2 = 'theorem h2 : P := by sorry';
const HARD = 'theorem hard_helper : P := by sorry';
const CHILD = 'theorem helper_child : P := by sorry';

const TACTIC_IMPORTS = MATHLIB_PRESENT
    ? STUB_TACTIC_MODULES.map(resolveModule).filter(Boolean)
    : STUB_TACTIC_MODULES;
const stubOf = s => TACTIC_IMPORTS.map(m => `import ${m}`).join('\n') + '\n\n' + s;

const idOf = s => hashStatement(s);

class MockBackend {
    async extractGoals(statement) {
        const hard = statement.includes('hard_helper :');
        return [{ type: hard ? 'Q' : 'P', context: [], sessionKey: idOf(statement) }];
    }
    async applyTactic(goal, tactic) {
        if (goal.type === 'P' && (tactic === 'rfl' || /^exact\s+\w/.test(tactic))) {
            return { status: 'ok', newGoals: [] };
        }
        return { status: 'error', newGoals: [], error: { message: 'stuck' } };
    }
    async verifyProof(src, key) { return { status: 'verified' }; }
    async check(statement) { return { status: 'verified', goals: [] }; }
    endLemma() {}
    pin() { return { toolchain: 'mock', normVersion: 1 }; }
    getInfos() { return { backends: ['mock'] }; }
}

// Records every prompt so the test can assert the retry-lane budget behavior.
class RecordingLLM {
    constructor() {
        this.prompts = [];
    }
    async complete(messages) {
        const user = (messages.find(m => m.role === 'user') ?? { content: '' }).content ?? '';
        this.prompts.push(user);
        return { text: 'rfl' };
    }
}

function makeBlueprint(theorem, lemmas) {
    return { theorem, lemmas: lemmas.map(l => ({ id: idOf(l.statement), ...l, pinnedHash: idOf(l.statement) })) };
}

test('parallel lanes prove independent ready lemmas in one batch, merge serially', async () => {
    const bp = makeBlueprint(THM, [
        { statement: H1, deps: [] },
        { statement: H2, deps: [] },
        { statement: THM, deps: [idOf(H1), idOf(H2)] }
    ]);
    const refiner = new BlueprintRefiner({
        llm: new RecordingLLM({}), backend: new MockBackend(),
        loopOptions: { maxTacticsPerGoal: 1, concurrency: 3 }
    });
    const res = await refiner.refine(bp);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.proved.length, 3);
    // H1 and H2 dispatched in one batch (both ready), THM after — deterministic merge order.
    assert.deepStrictEqual(res.rounds.map(r => r.id), [idOf(H1), idOf(H2), idOf(THM)]);
});

test('deadlock-release retries stalled lemmas with the reduced budget; no invented children', async () => {
    const bp = makeBlueprint(THM, [
        { statement: HARD, deps: [] },
        { statement: THM, deps: [idOf(HARD)] }
    ]);
    // HARD is atomic (no mechanical split): the deterministic seed adds nothing. The
    // deadlock-release lane must still retry it with the reduced tactic budget.
    const llm = new RecordingLLM({});
    const refiner = new BlueprintRefiner({
        llm, backend: new MockBackend(),
        loopOptions: { maxTacticsPerGoal: 8, concurrency: 2 }
    });
    const res = await refiner.refine(bp);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stopReason, 'no-ready-lemma');
    // HARD was attempted multiple times: initial and the deadlock-release retry.
    const hardAttempts = res.rounds.filter(r => r.id === idOf(HARD)).length;
    assert.ok(hardAttempts >= 2, `expected >=2 attempts on HARD, got ${hardAttempts}`);
    // The retry ran with the reduced budget: a proposal prompt asked for attempt k/4 (or less).
    const reducedBudgetPrompt = llm.prompts.some(p => /Propose ONE tactic \(attempt \d+\/([1-4])\)/.test(p));
    assert.ok(reducedBudgetPrompt, 'retry lane should cap the tactic budget at 4');
    // No planning essay: the stalled stub gained no children.
    assert.strictEqual(res.refined.lemmas.length, 2);
});

test('a lane crash degrades to a failed round without re-split or DAG corruption', async () => {
    const bp = makeBlueprint(THM, [
        { statement: H1, deps: [] },
        { statement: THM, deps: [idOf(H1)] }
    ]);
    class CrashingBackend extends MockBackend {
        async extractGoals(statement) {
            if (statement === H1) throw new Error('simulated lane crash');
            return super.extractGoals(statement);
        }
    }
    const refiner = new BlueprintRefiner({
        llm: new RecordingLLM({}), backend: new CrashingBackend(),
        loopOptions: { maxTacticsPerGoal: 1, concurrency: 2 }
    });
    const res = await refiner.refine(bp);
    assert.strictEqual(res.ok, false);
    // The crash round carries the error and no re-split ran for it.
    const h1Rounds = res.rounds.filter(r => r.id === idOf(H1));
    assert.ok(h1Rounds.length >= 1);
    assert.ok(h1Rounds.every(r => r.resplit === false), 'a crashed lane must not re-split');
    assert.ok(h1Rounds[0].error.includes('simulated lane crash'), `error was: ${h1Rounds[0].error}`);
    // No children leaked from the crashed lane.
    assert.strictEqual(res.refined.lemmas.length, 2);
    // THM stayed blocked; the loop stopped on the deadlock release, not on a crash.
    assert.strictEqual(res.stopReason, 'no-ready-lemma');
});
