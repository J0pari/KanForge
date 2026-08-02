// LIVE suite against the real `leanprover-community/repl` binary (build_order.md P0.3).
// This is the resilience gate: normal runs must hold restarts = hangs = parseErrors = 0,
// and every failure mode (crash, hang, drain, dedup) is exercised against the real kernel.
// No fakes: if the binary is unavailable (KANFORGE_REPL_BIN not set), the whole suite skips.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BackendRepl } from '../lean/backendRepl.js';
import { Scheduler } from '../core/scheduler.js';
import { PullGraph } from '../core/pullgraph.js';
import { ENV } from './loadEnv.js';

function findReplBin() {
    const fromEnv = ENV.KANFORGE_REPL_BIN;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    return null;
}

const REPL_BIN = findReplBin();
const VERIFIED = 'example : 1 + 1 = 2 := by rfl';
const VERIFIED2 = 'example : True := by trivial';
const SLOW = 'example (n : Nat) : n + 0 = n := by omega'; // long enough to interrupt mid-check
const ERROR_STMT = 'example : 1 = 2 := by rfl';           // clean type-mismatch error
const SORRY_STMT = 'example : 1 + 1 = 2 := by sorry';

const pools = [];
after(async () => {
    for (const p of pools) {
        try { await p.shutdown(2000); } catch { /* already down */ }
    }
});

function replPool(opts = {}) {
    const pool = new BackendRepl({
        replBin: REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency: 1,
        // Generous: the gate is counters==0, not latency; the whole suite runs concurrently with
        // other test files on this machine, so tight timeouts would trip on load, not on hangs.
        timeoutMs: 60_000,
        ...opts
    });
    pools.push(pool);
    return pool;
}

describe('real repl binary resilience suite', { skip: !REPL_BIN && 'repl binary not found (set KANFORGE_REPL_BIN)' }, () => {
    test('normal run: verified/error/sorries, counters restarts=hangs=parseErrors=0', async () => {
        const pool = replPool({ concurrency: 3 });
        const results = await Promise.all([
            pool.check(VERIFIED),
            pool.check(VERIFIED2),
            pool.check(ERROR_STMT),
            pool.check(SORRY_STMT)
        ]);
        assert.equal(results[0].status, 'verified');
        assert.equal(results[1].status, 'verified');
        assert.equal(results[2].status, 'error');
        assert.ok(results[2].error.message.length > 0, 'error message must not be empty');
        assert.equal(results[3].status, 'verified', 'a sorry leaves an open goal, not a kernel error');
        assert.equal(results[3].goals.length, 1);
        assert.ok(results[3].goals[0].type.includes('1 + 1 = 2'), `goal text: ${results[3].goals[0].type}`);

        const infos = pool.getInfos();
        assert.equal(infos.poolSize, 3);
        assert.equal(infos.restarts, 0);
        assert.equal(infos.hangs, 0);
        assert.equal(infos.timeouts, 0);
        assert.equal(infos.parseErrors, 0);
    });

    test('concurrency: pool of 3 handles 6 distinct verified checks', async () => {
        const pool = replPool({ concurrency: 3 });
        const stmts = [
            'example : 1 + 1 = 2 := by rfl',
            'example (x : Nat) : x = x := by rfl',
            'example : True := by trivial',
            'example (a b : Nat) : a + b = b + a := by omega',
            'example : 2 + 2 = 4 := by rfl',
            'example (x : Nat) : x + 0 = x := by omega'
        ];
        const results = await Promise.all(stmts.map(s => pool.check(s)));
        for (const r of results) assert.equal(r.status, 'verified', r.error?.message);
        const infos = pool.getInfos();
        assert.equal(infos.poolSize, 3);
        assert.equal(infos.restarts, 0);
        assert.equal(infos.hangs, 0);
        assert.equal(infos.parseErrors, 0);
    });

    test('single-flight: 3 identical checks share one in-flight kernel invocation', async () => {
        const pool = replPool({ concurrency: 1 });
        const p1 = pool.check(SLOW);
        const p2 = pool.check(SLOW);
        const p3 = pool.check(SLOW);
        assert.equal(pool._inflight.size, 1, 'identical statements must dedup to one promise');
        const results = await Promise.all([p1, p2, p3]);
        for (const r of results) assert.equal(r.status, 'verified');
        assert.equal(pool._inflight.size, 0, 'in-flight map cleared after completion');
    });

    test('crash replace: kill a real worker mid-check -> replaced, retried, completes, restarts>0', async () => {
        const pool = replPool({ concurrency: 1 });
        const pending = pool.check(SLOW);
        const deadline = Date.now() + 10_000;
        while (!pool._workers[0]?._pending && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1));
        }
        assert.ok(pool._workers[0]._pending, 'request must reach a worker before we kill it');
        pool._workers[0].kill('SIGKILL'); // real process death mid-check
        const res = await pending;
        assert.equal(res.status, 'verified', 'pool must retry the killed check on a fresh worker');
        const infos = pool.getInfos();
        assert.equal(infos.poolSize, 1);
        assert.ok(infos.restarts >= 1, `expected restarts>=1, got ${infos.restarts}`);
        assert.equal(infos.parseErrors, 0);
    });

    test('kill-on-hang: worker exceeding timeout is killed+replaced, check fails loudly', async () => {
        const pool = replPool({ concurrency: 1, timeoutMs: 1 });
        await assert.rejects(
            () => pool.check(SLOW),
            err => err.kind === 'timeout'
        );
        const infos = pool.getInfos();
        assert.equal(infos.timeouts, 2, 'attempt + one retry both exceed the 1ms budget');
        assert.equal(infos.hangs, 2);
        assert.ok(infos.restarts >= 2, `two killed workers must be replaced, got ${infos.restarts}`);
        assert.equal(infos.poolSize, 1);
    });

    test('graceful drain: in-flight check finishes, workers killed, new checks rejected', async () => {
        const pool = replPool({ concurrency: 1 });
        const pending = pool.check(VERIFIED);
        await new Promise(r => setImmediate(r)); // let the check acquire a worker first
        const drained = pool.shutdown(10_000);
        const res = await pending;
        assert.equal(res.status, 'verified', 'drain must let in-flight checks finish');
        const summary = await drained;
        assert.ok(summary.killed.length >= 1, 'workers must be killed on drain');
        await assert.rejects(() => pool.check(VERIFIED2), /draining/);
    });

    test('extractGoals + verifyProof + pin round-trip', async () => {
        const pool = replPool({ concurrency: 1 });
        const goals = await pool.extractGoals('example : True := by sorry');
        assert.equal(goals.length, 1);
        assert.ok(goals[0].type.includes('True'), `goal text: ${goals[0].type}`);

        assert.equal((await pool.verifyProof(VERIFIED)).status, 'verified');
        const unproven = await pool.verifyProof(SORRY_STMT);
        assert.equal(unproven.status, 'error');

        const pin = pool.pinStatement(VERIFIED);
        assert.equal(pin.statementHash.length, 64);
        assert.ok(pin.normVersion >= 1);
        assert.ok(pool.getInfos().poolUptime >= 0);
    });

    test('scheduler + real pool: failed dep blocks dependents without dispatch; counters stay 0', async () => {
        const pool = replPool({ concurrency: 2 });
        const graph = new PullGraph();
        const stmts = new Map([
            ['a', VERIFIED],
            ['b', ERROR_STMT],
            ['c', VERIFIED2]
        ]);
        for (const id of stmts.keys()) graph.register(id, () => stmts.get(id));
        graph.morphism('a', 'c'); // c depends on a
        graph.morphism('b', 'c'); // c also depends on b (which fails)

        const scheduler = new Scheduler(graph, {
            concurrency: 2,
            check: async (id) => {
                const res = await pool.check(stmts.get(id));
                if (res.status === 'error') throw new Error(`verify failed: ${res.error.message}`);
                return res;
            }
        });

        scheduler.enqueue(['a', 'b', 'c']);
        const { ok, results, failures } = await scheduler.run();
        assert.equal(ok, false);
        assert.equal(results.get('a').status, 'verified');
        assert.ok(failures.has('b'), 'b fails');
        assert.ok(failures.has('c'), 'dependent c blocked by failed b');
        assert.equal(scheduler.status('c'), 'FAILED');

        const infos = pool.getInfos();
        assert.equal(infos.restarts, 0, 'a normal scheduler run must not restart workers');
        assert.equal(infos.hangs, 0);
        assert.equal(infos.parseErrors, 0);
    });
});
