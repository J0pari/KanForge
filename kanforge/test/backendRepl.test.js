// BackendRepl pool-resilience unit tests (architecture.md §3.1) — no live repl needed.
// Injects fake workers so the kill-on-hang and warmup contracts are verified without spawning
// a real `repl` process (the real-binary contract is covered by live.repl.test.js).
//
// Regression covered: a leased-session (extractGoals) timeout used to leave worker._pending
// set, so the repl's FIFO response would never be consumed and the worker stayed "busy"
// forever — starving every subsequent row with `repl worker busy`. The fix retires+replaces
// the worker on ANY timeout (kill-on-hang), keeping the pool usable.

import test from 'node:test';
import assert from 'node:assert';
import { BackendRepl } from '../lean/backendRepl.js';

// The base constructor spawns workers via this._spawnWorker(); the subclass swaps in fake
// workers. `factoryOverride` is read by the override at construction time, so set it before
// `new FakeBackend(...)`.
let factoryOverride = null;

class FakeBackend extends BackendRepl {
    _spawnWorker() {
        const worker = factoryOverride();
        this._workers.push(worker);
        if (this.warmupStatement) {
            worker.busy = true;
            this._warm(worker);
        }
        return worker;
    }
}

function neverWorker() {
    return {
        busy: false,
        _dead: false,
        _retired: false,
        _pending: null,
        pid: 9000,
        child: { exitCode: null, kill() {} },
        isAlive() { return !this._dead; },
        request(payload, { lease = false } = {}) {
            return new Promise((resolve, reject) => {
                this._pending = { resolve, reject, lease, payload };
                this.busy = true;
            });
        },
        kill(signal) {
            this._dead = true;
            this.busy = false;
            const p = this._pending;
            this._pending = null;
            if (p) p.reject(Object.assign(new Error('repl worker killed'), { kind: 'worker-exit' }));
        }
    };
}

function respondingWorker(delay = 5) {
    return {
        busy: false,
        _dead: false,
        _retired: false,
        _pending: null,
        pid: 9001,
        child: { exitCode: null, kill() {} },
        isAlive() { return !this._dead; },
        request(payload, { lease = false } = {}) {
            return new Promise((resolve, reject) => {
                this._pending = { resolve, reject, lease, payload };
                this.busy = true;
                setTimeout(() => {
                    const p = this._pending;
                    this._pending = null;
                    if (p) {
                        this.busy = p.lease ? this.busy : false;
                        p.resolve({ env: 0, messages: [], sorries: [] });
                    }
                }, delay);
            });
        },
        kill(signal) {
            this._dead = true;
            this.busy = false;
            const p = this._pending;
            this._pending = null;
            if (p) p.reject(Object.assign(new Error('repl worker killed'), { kind: 'worker-exit' }));
        }
    };
}

test('leased-session timeout retires the worker instead of wedging the pool', { timeout: 15000 }, async () => {
    let spawn = 0;
    // First worker never answers (the wedged repl); the replacement is healthy.
    factoryOverride = () => (spawn++ === 0 ? neverWorker() : respondingWorker());
    const pool = new FakeBackend({ concurrency: 1, timeoutMs: 200 });
    try {
        await assert.rejects(pool.extractGoals('example : True := by sorry'), /timeout/);
        assert.strictEqual(pool.restarts, 1, 'timed-out worker must be replaced');

        // The pool must remain usable: the replacement answers a stateless check. Before the
        // fix this rejected with `repl worker busy` (stale _pending on the wedged worker).
        const res = await pool.check('example : True := by trivial');
        assert.strictEqual(res.status, 'verified');
        assert.strictEqual(pool._workers.length, 1, 'exactly one replacement worker');
    } finally {
        factoryOverride = null;
        await pool.shutdown(3000);
    }
});

test('warmup absorbs the first-statement cold start so workers are ready on acquire', { timeout: 15000 }, async () => {
    factoryOverride = () => respondingWorker(20);
    const pool = new FakeBackend({ concurrency: 2, timeoutMs: 1000, warmupStatement: 'example : True := by trivial' });
    try {
        const res = await pool.check('example : True := by trivial');
        assert.strictEqual(res.status, 'verified');
        assert.strictEqual(pool.restarts, 0, 'warm workers must not time out');
        assert.strictEqual(pool._workers.length, 2);
        assert.ok(pool._workers.every(w => !w.busy), 'all workers warm and available');
    } finally {
        factoryOverride = null;
        await pool.shutdown(3000);
    }
});

test('without warmup, workers stay available and answer immediately', { timeout: 15000 }, async () => {
    factoryOverride = () => respondingWorker(5);
    const pool = new FakeBackend({ concurrency: 1, timeoutMs: 1000 });
    try {
        const res = await pool.check('example : True := by trivial');
        assert.strictEqual(res.status, 'verified');
        assert.strictEqual(pool.restarts, 0);
    } finally {
        factoryOverride = null;
        await pool.shutdown(3000);
    }
});
