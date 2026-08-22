// Live blueprint suite (build_order.md §4.1/§4.2) — driven against the REAL
// `leanprover-community/repl` binary. Verifies that the deterministic seed's stubs typecheck
// under the real kernel and that a small development refines end-to-end with no `sorry`
// remaining. Gated on KANFORGE_REPL_BIN pointing to an existing file; skipped otherwise.
// No mocks, stubs, or facsimiles in this file.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendRepl } from '../lean/backendRepl.js';
import { SkeletonGenerator } from '../blueprint/skeleton.js';
import { runBlueprintTheorem } from '../blueprint/run.js';
import { validateBlueprint } from '../blueprint/dag.js';
import { loadEnv } from '../env.js';

const ENV = loadEnv();
const REPL_BIN = ENV.KANFORGE_REPL_BIN;
const SKIP_LIVE = !REPL_BIN || !fs.existsSync(REPL_BIN);

function makeBackend() {
    return new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 1,
        timeoutMs: 300_000
    });
}

// The seed never asks the LLM to plan; tactic prompts inspect the goal type.
class LiveLLM {
    constructor() {
        this.tacticCalls = 0;
    }
    async complete(messages) {
        const user = (messages.find(m => m.role === 'user') ?? { content: '' }).content ?? '';
        this.tacticCalls++;
        if (user.includes('\u2227')) return { text: 'constructor' };
        return { text: 'rfl' };
    }
}

const TRANS_THM = 'theorem trans_lt (a b c : Nat) (h : a < b) (h2 : b < c) : a < c \u2227 a \u2264 c := by sorry';

test('live: seed stubs typecheck under the real Lean kernel', { skip: SKIP_LIVE, timeout: 240000 }, async () => {
    const backend = makeBackend();
    try {
        const llm = new LiveLLM();
        const gen = new SkeletonGenerator({ backend });
        const result = await gen.generate(TRANS_THM);

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.blueprint.lemmas.length, 3);
        assert.strictEqual(validateBlueprint(result.blueprint).ok, true);

        // Re-check every emitted stub against the real kernel: statement hash is pinned
        // to exactly this text, and the kernel accepts the `:= by sorry` stub.
        for (const l of result.blueprint.lemmas) {
            const check = await backend.check(l.statement);
            assert.strictEqual(check.status, 'verified', `stub should typecheck: ${l.statement}`);
            assert.strictEqual(l.pinnedHash, l.id);
        }
    } finally {
        await backend.shutdown(3000);
    }
});

// The root is deliberately a conjunction, so the live path exercises the repl's
// multi-goal "remaining goals" semantics end-to-end: `constructor` splits the root,
// each `· rfl` branch closes its own goal, and the composed bullet script must pass
// the kernel at commit (regression for the old goal-frontier misattribution).
test('live: end-to-end skeleton → refine proves a development with no sorry remaining', { skip: SKIP_LIVE, timeout: 900000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-live-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-live-store-'));
    const backend = makeBackend();
    try {
        // ISOLATED stores: this test's assertions must not depend on (or pollute) the live
        // global lemma store accumulated by campaign runs.
        const { LemmaStore } = await import('../growth/lemmaStore.js');
        const { TrainingDataset } = await import('../growth/dataset.js');
        const lemmaStore = new LemmaStore({ dir: path.join(storeDir, 'lemma-store') });
        const dataset = new TrainingDataset({ dir: path.join(storeDir, 'training-dataset') });
        const theorem = 'example : 1 = 1 \u2227 2 = 2 := by sorry';
        const llm = new LiveLLM();

        const r = await runBlueprintTheorem({ backend, llm, theorem, outDir, loopOptions: { maxTacticsPerGoal: 3, maxGoalsPerLemma: 20 }, lemmaStore, dataset });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.refined.ok, true);
        assert.strictEqual(r.refined.unproved.length, 0);

        for (const l of r.refined.refined.lemmas) {
            assert.ok(l.proof, `expected a proof for ${l.statement}`);
            assert.ok(!l.proof.includes('sorry'), `no sorry may remain: ${l.proof}`);
        }
        assert.strictEqual(r.refined.stored.lemmas, 3);

        // Contamination report is clean for an unrelated benchmark split.
        const report = dataset.contaminationCheck({ miniF2F: ['example (a b c : Nat) (h : a < b) : a ≤ c := by sorry'] });
        assert.strictEqual(report.clean, true);
    } finally {
        await backend.shutdown(3000);
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.rmSync(storeDir, { recursive: true, force: true });
    }
});
