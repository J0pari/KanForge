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

// A worker that mirrors the real ReplWorker.request busy-guard AND its response dispatch:
// on resolving a non-lease request it clears busy and fires onIdle (which the pool wires to
// _wakeWaiters) — exactly like backendRepl.js _dispatch(). This is what made the _warm
// clobber reachable: the worker frees itself, gets handed to a waiter, and then _warm's
// finally would clear busy again and hand it out a second time.
function raceWorker(onIdle, delay = 10) {
    return {
        busy: false,
        _dead: false,
        _retired: false,
        _pending: null,
        pid: 9002,
        child: { exitCode: null, kill() {} },
        isAlive() { return !this._dead; },
        request(payload, { lease = false } = {}) {
            if (this._pending) return Promise.reject(new Error('repl worker busy'));
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
                    if (!lease) onIdle?.(this);
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

// Regression: _warm's finally used to reset worker.busy = false after the warmup response,
// clobbering the reservation _wakeWaiters set when it handed that worker to a leased session.
// A second extractGoals then acquired the SAME busy worker and tripped the request busy-guard
// (`repl worker busy`), failing every concurrent lemma after the first.
test('two concurrent leased sessions during warmup must not collide on one worker', { timeout: 15000 }, async () => {
    class RaceBackend extends BackendRepl {
        _spawnWorker() {
            const worker = raceWorker(() => this._wakeWaiters(), 10);
            this._workers.push(worker);
            if (this.warmupStatement) {
                worker.busy = true;
                this._warm(worker);
            }
            return worker;
        }
    }
    const pool = new RaceBackend({ concurrency: 2, timeoutMs: 5000, warmupStatement: 'example : True := by trivial' });
    try {
        // Both dispatch before either worker finishes warming: both queue as waiters.
        const [r1, r2] = await Promise.allSettled([
            pool.extractGoals('example : P := by sorry'),
            pool.extractGoals('example : Q := by sorry')
        ]);
        assert.strictEqual(r1.status, 'fulfilled', 'first lease must succeed, got: ' + (r1.reason?.message ?? ''));
        assert.strictEqual(r2.status, 'fulfilled', 'second lease must not get a busy worker, got: ' + (r2.reason?.message ?? ''));
        assert.strictEqual(pool.restarts, 0, 'no worker should be retired');
        // Each leased session must own a DISTINCT worker — sharing would mean the busy
        // reservation was clobbered by _warm's finally.
        const workers = new Set([...pool._sessions.values()].map(s => s.worker));
        assert.strictEqual(workers.size, pool._sessions.size, 'concurrent sessions must not share a worker');
    } finally {
        await pool.shutdown(3000);
    }
});
