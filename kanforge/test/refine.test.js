// BlueprintRefiner (build_order.md §4.2): bottom-up fill, re-split (never edit statements),
// drift detection, no-progress termination, statement-set invariance.
import test from 'node:test';
import assert from 'node:assert';
import { BlueprintRefiner } from '../blueprint/refine.js';
import { checkDrift } from '../blueprint/drift.js';
import { hashStatement } from '../lean/pin.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';
import { resolveModule } from '../lean/moduleResolver.js';

const THM = 'theorem thm : P := by sorry';
const H1 = 'theorem h1 : P := by sorry';
const H2 = 'theorem h2 : P := by sorry';
const HARD = 'theorem hard_helper : P := by sorry';
const EASY = 'theorem easy_child : P := by sorry';

// Re-split children are emitted with the canonical tactic imports prepended.
const TACTIC_IMPORTS = STUB_TACTIC_MODULES.map(resolveModule).filter(Boolean);
const stubOf = s => TACTIC_IMPORTS.map(m => `import ${m}`).join('\n') + '\n\n' + s;

const idOf = s => hashStatement(s);

class RefineMockBackend {
    constructor() {
        this.verified = [];
    }
    async extractGoals(statement) {
        const hard = statement.includes('hard');
        return [{ type: hard ? 'Q' : 'P', context: [], sessionKey: idOf(statement) }];
    }
    async applyTactic(goal, tactic) {
        if (goal.type === 'P' && (tactic === 'rfl' || /^exact\s+\w/.test(tactic))) {
            return { status: 'ok', newGoals: [] };
        }
        return { status: 'error', newGoals: [], error: { message: 'stuck' } };
    }
    async verifyProof(src, key) {
        this.verified.push({ src, key });
        return { status: 'verified' };
    }
    async check(statement) {
        return { status: 'verified', goals: [] };
    }
    endLemma() {}
    pin() {
        return { toolchain: 'mock', normVersion: 1 };
    }
    getInfos() {
        return { backends: ['mock'] };
    }
}

// Dispatches by prompt: skeleton prompts get the JSON decomposition for that theorem,
// tactic prompts get 'rfl' (the mock solves 'P' goals with it).
class DispatchLLM {
    constructor(decompose = {}) {
        this.decompose = decompose;
        this.tacticCalls = 0;
    }
    async complete(messages) {
        const user = (messages.find(m => m.role === 'user') ?? { content: '' }).content ?? '';
        if (user.includes('Decompose this theorem into')) {
            const theorem = user.slice(user.indexOf(':\n\n') + 3).split('\n\nReturn the JSON')[0].trim();
            return { text: this.decompose[theorem] ?? JSON.stringify({ lemmas: [], rootDeps: [] }) };
        }
        this.tacticCalls++;
        return { text: 'rfl' };
    }
}

function makeBlueprint(theorem, lemmas) {
    return { theorem, lemmas: lemmas.map(l => ({ id: idOf(l.statement), ...l, pinnedHash: idOf(l.statement) })) };
}

test('refines a multi-lemma blueprint bottom-up, proving everything', async () => {
    const bp = makeBlueprint(THM, [
        { statement: H1, deps: [] },
        { statement: H2, deps: [] },
        { statement: THM, deps: [idOf(H1), idOf(H2)] }
    ]);
    const refiner = new BlueprintRefiner({ llm: new DispatchLLM({}), backend: new RefineMockBackend(), loopOptions: { maxTacticsPerGoal: 1 } });
    const res = await refiner.refine(bp);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.proved.length, 3);
    assert.deepStrictEqual(res.rounds.map(r => r.id), [idOf(H1), idOf(H2), idOf(THM)]);
    assert.ok(res.refined.lemmas.every(l => typeof l.proof === 'string' && l.proof.length > 0));
});

test('re-splits a stuck stub into children, never editing existing statements', async () => {
    const bp = makeBlueprint(THM, [
        { statement: HARD, deps: [] },
        { statement: THM, deps: [idOf(HARD)] }
    ]);
    const decompose = {
        [HARD]: JSON.stringify({
            lemmas: [{ name: 'easy_child', statement: EASY, deps: [] }],
            rootDeps: ['easy_child']
        })
    };
    const refiner = new BlueprintRefiner({ llm: new DispatchLLM(decompose), backend: new RefineMockBackend(), loopOptions: { maxTacticsPerGoal: 1 } });
    const res = await refiner.refine(bp);

    assert.strictEqual(res.ok, false);
    assert.ok(res.unproved.includes(idOf(HARD)));
    assert.ok(res.unproved.includes(idOf(THM)));

    // child was added and proved
    const child = res.refined.lemmas.find(l => l.statement === stubOf(EASY));
    assert.ok(child, 'easy_child should have been added');
    assert.ok(child.proof, 'easy_child should have been proved');

    // existing statements are untouched (statement set invariant)
    const original = new Set([H1 ? '' : '', HARD, THM].filter(Boolean));
    const onDisk = new Set(res.refined.lemmas.map(l => l.statement));
    for (const s of [HARD, THM]) assert.ok(onDisk.has(s), `statement should be unchanged: ${s}`);

    // hard stub's deps now point at its child
    const hard = res.refined.lemmas.find(l => l.statement === HARD);
    assert.deepStrictEqual(hard.deps, [idOf(stubOf(EASY))]);

    // terminated by no-progress, not by the round cap
    assert.strictEqual(res.maxRoundsReached, false);
    const resplitRounds = res.rounds.filter(r => r.resplit);
    assert.ok(resplitRounds.length >= 1);
});

test('rejects an invalid blueprint up front', async () => {
    const bad = {
        theorem: THM,
        lemmas: [{ id: 'a', statement: H1, deps: ['ghost'], pinnedHash: idOf(H1) }]
    };
    const refiner = new BlueprintRefiner({ llm: new DispatchLLM({}), backend: new RefineMockBackend() });
    const res = await refiner.refine(bad);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'invalid blueprint');
    assert.ok(res.errors.some(e => e.includes('unknown lemma ghost')));
});

test('drift detection re-hashes pinned statements', () => {
    const stub = { id: 'x', statement: H1, deps: [], pinnedHash: idOf(H1) };
    assert.strictEqual(checkDrift([stub]).ok, true);

    const tampered = { ...stub, statement: 'lemma h1 : Q := by sorry' };
    const drift = checkDrift([tampered]);
    assert.strictEqual(drift.ok, false);
    assert.strictEqual(drift.drifts.length, 1);
    assert.strictEqual(drift.drifts[0].id, 'x');
});

test('fully proved blueprint emits refined.json when outDir set', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-refine-'));
    try {
        const bp = makeBlueprint(THM, [
            { statement: H1, deps: [] },
            { statement: THM, deps: [idOf(H1)] }
        ]);
        const refiner = new BlueprintRefiner({ llm: new DispatchLLM({}), backend: new RefineMockBackend(), loopOptions: { maxTacticsPerGoal: 1 }, outDir });
        const res = await refiner.refine(bp);
        assert.strictEqual(res.ok, true);
        const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'refined.json'), 'utf8'));
        assert.strictEqual(onDisk.lemmas.length, 2);
        assert.ok(onDisk.lemmas.every(l => typeof l.proof === 'string'));
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});

test('verified lemmas are captured into LemmaStore and TrainingDataset via loop events', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-capture-'));
    try {
        const { LemmaStore } = await import('../growth/lemmaStore.js');
        const { TrainingDataset } = await import('../growth/dataset.js');
        const lemmaStore = new LemmaStore({ dir: path.join(dir, 'lemmas') });
        const dataset = new TrainingDataset({ dir: path.join(dir, 'dataset') });

        const bp = makeBlueprint(THM, [
            { statement: H1, deps: [] },
            { statement: THM, deps: [idOf(H1)] }
        ]);
        const refiner = new BlueprintRefiner({
            llm: new DispatchLLM({}),
            backend: new RefineMockBackend(),
            loopOptions: { maxTacticsPerGoal: 1 },
            lemmaStore,
            dataset
        });
        const res = await refiner.refine(bp);
        assert.strictEqual(res.ok, true);

        assert.strictEqual(lemmaStore.size, 2);
        assert.ok(lemmaStore.has(idOf(H1)));
        assert.ok(lemmaStore.has(idOf(THM)));
        // Lemma-store lookup (§0.3): THM's goal matches H1's conclusion, so the loop reuses
        // H1 via `exact h1` instead of re-proposing rfl.
        assert.ok(lemmaStore.get(idOf(THM)).proofScript.includes('exact h1'));

        const verified = dataset.samples.filter(s => s.outcome === 'verified');
        assert.strictEqual(verified.length, 2);
        assert.ok(res.stored.lemmas >= 2);
        assert.ok(res.stored.samples >= 2);

        // reload from disk proves persistence end-to-end
        const reloadedStore = new LemmaStore({ dir: path.join(dir, 'lemmas') });
        const reloadedDs = new TrainingDataset({ dir: path.join(dir, 'dataset') });
        assert.strictEqual(reloadedStore.size, 2);
        assert.strictEqual(reloadedDs.samples.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
