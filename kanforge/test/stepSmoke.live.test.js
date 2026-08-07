// Live REPL test for multi-step goal-directed tier verification (build_order.md §5.4).
// Runs verifyStepSet against the real `leanprover-community/repl` binary to confirm that:
// 1. All 10 stubs typecheck under the Lean kernel.
// 2. All 10 golden tactic chains replay to solved proof states via BackendRepl.
// 3. All 10 assembled proofs verify in the kernel.
// 4. No trivial closer (rfl/simp/omega/decide/assumption) closes any of the stubs.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { BackendRepl } from '../lean/backendRepl.js';
import { verifyStepSet } from '../bench/verifyStepSet.js';
import { STEP_PROBLEMS } from '../bench/stepSmoke.js';
import { loadEnv } from '../env.js';

const ENV = loadEnv();
const REPL_BIN = ENV.KANFORGE_REPL_BIN;
const SKIP_LIVE = !REPL_BIN || !fs.existsSync(REPL_BIN);

test('live verifyStepSet verifies all 10 multi-step problems against real Lean kernel', { skip: SKIP_LIVE, timeout: 180000 }, async () => {
    const backend = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 2,
        timeoutMs: 30000
    });

    try {
        const report = await verifyStepSet(backend, STEP_PROBLEMS);
        assert.strictEqual(report.ok, true, `expected all step problems to pass verification; failures: ${JSON.stringify(report.perProblem.filter(p => !p.ok))}`);
        assert.strictEqual(report.passed, 10);
        assert.strictEqual(report.total, 10);

        for (const row of report.perProblem) {
            assert.strictEqual(row.ok, true, `${row.id} failed verification`);
            assert.strictEqual(row.checks.stubTypechecks, true, `${row.id} stub failed to typecheck`);
            assert.strictEqual(row.checks.chainProves, true, `${row.id} golden chain failed: ${row.checks.chainError}`);
            assert.strictEqual(row.checks.assembledVerifies, true, `${row.id} assembled proof failed: ${row.checks.assembledError}`);
            assert.strictEqual(row.checks.negativesHeld, true, `${row.id} surprisingly closed by a trivial closer`);
        }
    } finally {
        await backend.shutdown(3000);
    }
});
