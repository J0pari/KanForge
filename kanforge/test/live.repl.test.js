// Live REPL suite (architecture.md §3, §3.1 pool resilience; build_order.md P0.3).
// Driven against the REAL `leanprover-community/repl` binary — no mocks, stubs, or facsimiles.
// Gated on KANFORGE_REPL_BIN pointing to an existing file; skipped automatically if unavailable.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { BackendRepl } from '../lean/backendRepl.js';
import { TacticLoop } from '../agent/loop.js';
import { loadEnv } from '../env.js';

const ENV = loadEnv();
const REPL_BIN = ENV.KANFORGE_REPL_BIN;
const SKIP_LIVE = !REPL_BIN || !fs.existsSync(REPL_BIN);
// Mathlib imports additionally need LEAN_PATH, which the backend reconstructs from
// KANFORGE_LEAN_PROJECT. Skip the Mathlib case unless the project is configured.
const SKIP_MATHLIB = SKIP_LIVE || !ENV.KANFORGE_LEAN_PROJECT || !fs.existsSync(ENV.KANFORGE_LEAN_PROJECT);

test('live REPL backend round-trip (P0.1 deliverable & P0.3 resilience)', { skip: SKIP_LIVE, timeout: 60000 }, async () => {
    const backend = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 2,
        timeoutMs: 30000,
        // Absorb the fresh-process first-elaboration (~1-3 min on a cold box) off the caller's
        // clock — the pool's own production pattern (warmupStatement in the bench CLI).
        warmupStatement: 'example : True := by trivial'
    });

    try {
        // 1. extractGoals on trans_lt
        const statement = 'example (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry';
        const goals = await backend.extractGoals(statement);
        assert.strictEqual(goals.length, 1);
        assert.strictEqual(goals[0].type, 'a < c');
        assert.strictEqual(goals[0].context.length, 5);
        assert.ok(goals[0].sessionKey);

        // 2. applyTactic omega
        const res = await backend.applyTactic(goals[0], 'omega');
        assert.strictEqual(res.status, 'ok');
        assert.strictEqual(res.newGoals.length, 0); // omega solved goal completely

        // 3. verifyProof full source
        const fullSource = statement.replace(/:=\s*by\s+sorry$/, ':= by\n  omega');
        const v = await backend.verifyProof(fullSource, goals[0].sessionKey);
        assert.strictEqual(v.status, 'verified');

        // 4. Health counters
        const infos = backend.getInfos();
        assert.strictEqual(infos.restarts, 0);
        assert.strictEqual(infos.hangs, 0);
        assert.strictEqual(infos.parseErrors, 0);
    } finally {
        await backend.shutdown(3000);
    }
});

test('live REPL loads a Mathlib module (P0.1 build; LEAN_PATH wiring)', { skip: SKIP_MATHLIB, timeout: 420000 }, async () => {
    const backend = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 1,
        timeoutMs: 300000
    });

    try {
        // `Real` is Mathlib-only: it resolves only if the repl found Mathlib's oleans via
        // the LEAN_PATH that KANFORGE_LEAN_PROJECT enables.
        const res = await backend.check('import Mathlib.Data.Real.Basic\n#check Real');
        assert.strictEqual(res.status, 'verified', JSON.stringify(res.error));
        assert.ok(res.warnings.some(w => w.data.includes('Real : Type')), `expected #check Real info, got ${JSON.stringify(res.warnings)}`);
    } finally {
        await backend.shutdown(3000);
    }
});

test('live REPL tactic-mode multi-goal decomposition (induction)', { skip: SKIP_LIVE, timeout: 60000 }, async () => {
    const backend = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 1,
        timeoutMs: 30000
    });

    try {
        const statement = 'example (n : Nat) : n + 0 = n := by sorry';
        const goals = await backend.extractGoals(statement);
        assert.strictEqual(goals.length, 1);

        // Apply induction -> produces 2 subgoals (case zero and case succ)
        const res = await backend.applyTactic(goals[0], 'induction n');
        assert.strictEqual(res.status, 'ok');
        assert.strictEqual(res.newGoals.length, 2);
        assert.strictEqual(res.newGoals[0].caseName, 'zero');
        assert.strictEqual(res.newGoals[1].caseName, 'succ');

        // Apply rfl to first subgoal (case zero: 0 + 0 = 0)
        const resZero = await backend.applyTactic(res.newGoals[0], 'rfl');
        assert.strictEqual(resZero.status, 'ok');
        assert.strictEqual(resZero.newGoals.length, 1); // succ case remains

        // Apply rfl to remaining subgoal (case succ)
        const resSucc = await backend.applyTactic(resZero.newGoals[0], 'rfl');
        assert.strictEqual(resSucc.status, 'ok');
        assert.strictEqual(resSucc.newGoals.length, 0); // fully solved
    } finally {
        await backend.shutdown(3000);
    }
});

test('live end-to-end TacticLoop proof of Tier-1 lemma via REPL', { skip: SKIP_LIVE, timeout: 300000 }, async () => {
    const backend = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 1,
        timeoutMs: 30000
    });

    class ScriptedLLM {
        async complete() {
            return { text: 'omega' };
        }
    }

    const loop = new TacticLoop({ backend, llm: new ScriptedLLM(), maxTacticsPerGoal: 2 });
    loop.addLemma('example (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry');

    try {
        const outcome = await loop.proveAll();
        assert.strictEqual(outcome.ok, true);

        const verified = loop.events().find(e => e.type === 'lemma_verified');
        assert.ok(verified);
        assert.ok(verified.proofScript.includes('omega'));

        const infos = backend.getInfos();
        assert.strictEqual(infos.restarts, 0);
        assert.strictEqual(infos.hangs, 0);
        assert.strictEqual(infos.parseErrors, 0);
    } finally {
        await backend.shutdown(3000);
    }
});
