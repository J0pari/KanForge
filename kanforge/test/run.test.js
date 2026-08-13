// blueprint/run.js — end-to-end skeleton → refine orchestration with storage capture.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBlueprintTheorem } from '../blueprint/run.js';
import { normalizeStub } from '../blueprint/skeleton.js';
import { hashStatement } from '../lean/pin.js';

const THM = 'theorem thm : P := by sorry';
const H1 = 'theorem h1 : P := by sorry';

class MockBackend {
    async extractGoals(statement) {
        return [{ type: 'P', context: [], sessionKey: hashStatement(statement) }];
    }
    async applyTactic(goal, tactic) {
        if (tactic === 'rfl') return { status: 'ok', newGoals: [] };
        return { status: 'error', newGoals: [], error: { message: 'stuck' } };
    }
    async verifyProof(src, key) {
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

class LLM {
    async complete(messages) {
        const user = (messages.find(m => m.role === 'user') ?? { content: '' }).content ?? '';
        if (user.includes('Decompose this theorem into')) {
            return { text: JSON.stringify({
                lemmas: [{ name: 'h1', statement: H1, deps: [] }],
                rootDeps: ['h1']
            }) };
        }
        return { text: 'rfl' };
    }
}

test('runBlueprintTheorem drives skeleton → refine and persists everything', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-run-'));
    try {
        const r = await runBlueprintTheorem({
            backend: new MockBackend(),
            llm: new LLM(),
            theorem: THM,
            outDir,
            loopOptions: { maxTacticsPerGoal: 1 }
        });

        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.stage, 'refine');
        assert.strictEqual(r.refined.ok, true);
        assert.strictEqual(r.refined.proved.length, 2);
        assert.strictEqual(r.refined.stored.lemmas, 2);
        assert.ok(r.refined.stored.samples >= 2);

        // artifact layout under the work dir
        assert.ok(fs.existsSync(path.join(outDir, 'blueprint.json')));
        assert.ok(fs.existsSync(path.join(outDir, 'blueprint.md')));
        assert.ok(fs.existsSync(path.join(outDir, 'refined.json')));
        // lemma store + training dataset are GLOBAL (shared across problems), not per-workdir
        assert.ok(fs.existsSync(path.join('runs', 'lemma-store', 'lemmas')));
        assert.ok(fs.existsSync(path.join('runs', 'training-dataset', 'samples.jsonl')));

        // the on-disk blueprint pins and DAGs match the refined result
        const blueprint = JSON.parse(fs.readFileSync(path.join(outDir, 'blueprint.json'), 'utf8'));
        assert.strictEqual(blueprint.theorem, normalizeStub(THM));
        assert.strictEqual(blueprint.lemmas.length, 2);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});
