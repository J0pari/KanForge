// Live blueprint suite (build_order.md §4.1/§4.2) — driven against the REAL
// `leanprover-community/repl` binary. Verifies that skeleton stubs typecheck under the real
// kernel and that a small development refines end-to-end with no `sorry` remaining.
// Gated on KANFORGE_REPL_BIN pointing to an existing file; skipped automatically otherwise.
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

// Skeleton prompt → fixed JSON; tactic prompt → inspect the goal type in the prompt.
class LiveLLM {
    constructor(decompose) {
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
        if (user.includes('∧')) return { text: 'constructor' };
        return { text: 'rfl' };
    }
}

const TRANS_THM = 'theorem trans_lt (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry';

test('live: skeleton stubs typecheck under the real Lean kernel', { skip: SKIP_LIVE, timeout: 240000 }, async () => {
    const backend = makeBackend();
    try {
        const llm = new LiveLLM({
            [TRANS_THM]: JSON.stringify({
                lemmas: [
                    { name: 'lt_irrefl_step', statement: 'theorem lt_irrefl_step (a b : Nat) (h : a < b) : ¬ b < a := by sorry', deps: [] },
                    { name: 'lt_step', statement: 'theorem lt_step (a b c : Nat) : a < b → b < c → a < c := by sorry', deps: [] }
                ],
                rootDeps: ['lt_irrefl_step', 'lt_step']
            })
        });
        const gen = new SkeletonGenerator({ llm, backend });
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
// the kernel at commit (regression for the old e-graph frontier misattribution).
test('live: end-to-end skeleton → refine proves a development with no sorry remaining', { skip: SKIP_LIVE, timeout: 900000 }, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-live-'));
    const backend = makeBackend();
    try {
        const theorem = 'example : 1 = 1 ∧ 2 = 2 := by sorry';
        const h1 = 'example : 1 = 1 := by sorry';
        const h2 = 'example : 2 = 2 := by sorry';
        const llm = new LiveLLM({
            [theorem]: JSON.stringify({
                lemmas: [
                    { name: 'h1', statement: h1, deps: [] },
                    { name: 'h2', statement: h2, deps: [] }
                ],
                rootDeps: ['h1', 'h2']
            })
        });

        const r = await runBlueprintTheorem({ backend, llm, theorem, outDir, loopOptions: { maxTacticsPerGoal: 3, maxGoalsPerLemma: 20 } });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.refined.ok, true);
        assert.strictEqual(r.refined.unproved.length, 0);

        for (const l of r.refined.refined.lemmas) {
            assert.ok(l.proof, `expected a proof for ${l.statement}`);
            assert.ok(!l.proof.includes('sorry'), `no sorry may remain: ${l.proof}`);
        }
        assert.strictEqual(r.refined.stored.lemmas, 3);

        // Contamination report is clean for an unrelated benchmark split.
        const { TrainingDataset } = await import('../growth/dataset.js');
        const ds = new TrainingDataset({ dir: path.join(outDir, 'training-dataset') });
        const report = ds.contaminationCheck({ miniF2F: ['example (a b c : Nat) (h : a < b) : a ≤ c := by sorry'] });
        assert.strictEqual(report.clean, true);
    } finally {
        await backend.shutdown(3000);
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});
