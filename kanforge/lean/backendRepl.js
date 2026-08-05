// REPL pool over the real `leanprover-community/repl` binary (architecture.md §3 + §3.1).
// Wire protocol (verified against the actual binary, rev 1d23837, pinned toolchain):
//   statement mode:  { "cmd": "<lean command>", "env": null }
//     -> { "env": n, "messages": [...], "sorries": [{ proofState, pos, goal, endPos }] }
//   tactic mode:     { "tactic": "<tactic>", "proofState": n }
//     -> { "proofStatus": "Completed" | "Incomplete: ...", "proofState": n+1, "goals": [...] }
//     -> { "message": "Lean error: ..." }                       on tactic failure
//     -> { "message": "Unknown proof state." }                  on stale proofState
// Framing: one compact JSON object per request, followed by a blank line; responses are
// pretty-printed JSON documents terminated by a blank line.
//
// Proof sessions: tactic mode is stateful per worker (proofStates are session-local), so
// extractGoals leases one worker per lemma until endLemma(key) releases it. verifyProof for a
// leased lemma runs on the same worker, so concurrent lemmas never deadlock the pool (pool
// size may equal scheduler concurrency). check() keeps its stateless single-flight contract.
//
// Pool resilience (§3.1): warm workers; kill-on-hang timeout replaces the worker and fails the
// job; crash replace with <= 1 retry for stateless checks; per-document parse resilience;
// graceful drain; health counters via getInfos().

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { hashStatement, makePin, NORM_VERSION } from './pin.js';
import { parseGoalText } from './goalText.js';

// The repl binary links against Lean's runtime DLLs (libleanshared.dll & friends), which live
// in the toolchain bin dir. On Windows they must be on PATH or the exe dies with
// STATUS_DLL_NOT_FOUND at startup. Resolve that bin dir once and prepend it to the child env.
function toolchainBinDir(toolchain) {
    const override = process.env.KANFORGE_LEAN_TOOLCHAIN_BIN;
    if (override && fs.existsSync(override)) return override;
    const root = path.join(os.homedir(), '.elan', 'toolchains');
    let dirs;
    try {
        dirs = fs.readdirSync(root);
    } catch {
        return null;
    }
    if (toolchain) {
        const name = toolchain.replace(/\//g, '--').replace(/:/g, '---');
        for (const d of dirs) {
            if (d === name || d.replace(/--/g, '/').replace(/---/g, ':') === toolchain) {
                const bin = path.join(root, d, 'bin');
                if (fs.existsSync(bin)) return bin;
            }
        }
    }
    for (const d of dirs) {
        const bin = path.join(root, d, 'bin');
        if (fs.existsSync(path.join(bin, 'libleanshared.dll')) || fs.existsSync(path.join(bin, 'libleanshared'))) {
            return bin;
        }
    }
    return null;
}

// The repl's `main` calls `initSearchPath (← Lean.findSysroot)`, which replaces the embedded
// workspace search path with the toolchain sysroot plus the LEAN_PATH env var (repl README:
// "run as `lake env <repl>`"). Mathlib and its deps live in
// <project>/.lake/build/lib/lean and <project>/.lake/packages/<pkg>/.lake/build/lib/lean, so
// we reconstruct LEAN_PATH from the project layout instead of shelling out to `lake env`.
function leanProjectLibDirs(leanProject) {
    const dirs = [];
    const root = path.join(leanProject, '.lake', 'build', 'lib', 'lean');
    if (fs.existsSync(root)) dirs.push(root);
    let packages;
    try {
        packages = fs.readdirSync(path.join(leanProject, '.lake', 'packages'));
    } catch {
        return dirs;
    }
    for (const pkg of packages) {
        const dir = path.join(leanProject, '.lake', 'packages', pkg, '.lake', 'build', 'lib', 'lean');
        if (fs.existsSync(dir)) dirs.push(dir);
    }
    return dirs;
}

function resolveReplEnv(toolchain, leanProject) {
    const env = { ...process.env };
    const bin = toolchainBinDir(toolchain);
    if (bin) {
        const current = env.PATH ?? '';
        env.PATH = `${bin}${current ? path.delimiter + current : ''}`;
    }
    if (leanProject) {
        const dirs = leanProjectLibDirs(leanProject);
        if (dirs.length) env.LEAN_PATH = dirs.join(path.delimiter);
    }
    return env;
}

export function parseLeanMessages(messages) {
    const errors = messages.filter(m => m.severity === 'error');
    const warnings = messages.filter(m => m.severity === 'warning' || m.severity === 'info');
    return { errors, warnings };
}

export function leanErrorFromMessages(messages) {
    const first = messages.find(m => m.severity === 'error') ?? messages[0];
    const pos = first?.pos;
    const endPos = first?.endPos;
    return {
        span: pos
            ? { line: pos.line, col: pos.column, endLine: endPos?.line ?? pos.line, endCol: endPos?.column ?? pos.column }
            : undefined,
        message: first?.data ?? 'lean error',
        subErrors: [],
        detail: messages.filter(m => m.severity === 'error').map(m => m.data)
    };
}

// One sorry entry -> one Goal (§3): the repl goal string is the full telescope, parsed into
// context entries + target so the e-graph can normalize and the LLM prompt can render it.
function goalFromSorry(s) {
    const parsed = parseGoalText(s.goal ?? '');
    return {
        type: parsed.type,
        context: parsed.context,
        caseName: parsed.caseName ?? undefined,
        pos: s.pos ?? null,
        proofState: s.proofState ?? null
    };
}

export class ReplWorker {
    constructor({ replBin, env, onParseError, onExit, onIdle }) {
        this.replBin = replBin;
        this.busy = false;
        this._dead = false;
        this._retired = false;
        this._pending = null;
        this._buf = []; // response documents arrive pretty-printed across lines
        this.stderr = '';
        this.pid = null;

        const child = spawn(replBin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
        this.child = child;
        this.pid = child.pid ?? null;

        this._rl = readline.createInterface({ input: child.stdout });
        this._rl.on('line', line => {
            if (!line.trim()) {
                if (this._buf.length) {
                    const text = this._buf.join('\n');
                    this._buf = [];
                    this._dispatch(text, onParseError, onIdle);
                }
                return;
            }
            this._buf.push(line);
        });
        child.stderr?.on('data', d => { this.stderr += d.toString(); });
        child.on('exit', (code, signal) => {
            this._dead = true;
            this._rl.close();
            const pending = this._pending;
            this._pending = null;
            this.busy = false;
            if (pending) {
                pending.reject(Object.assign(new Error(`repl worker exited (code=${code}, signal=${signal})`), { kind: 'worker-exit' }));
            }
            onExit?.(this, { code, signal });
        });
    }

    _dispatch(text, onParseError, onIdle) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            onParseError?.(text);
            const pending = this._pending;
            this._pending = null;
            this.busy = false;
            if (pending) pending.reject(Object.assign(new Error('repl returned a malformed response document'), { kind: 'parse-error' }));
            return;
        }
        const pending = this._pending;
        this._pending = null;
        // busy is owned by the caller (leased sessions stay busy); only free it for one-shot requests.
        if (pending) {
            this.busy = pending.lease ? this.busy : false;
            pending.resolve(parsed);
        } else {
            this.busy = false;
        }
        onIdle?.(this);
    }

    // payload is the full request object: { cmd, env } for statement mode,
    // { tactic, proofState } for tactic mode. lease=true keeps the worker reserved after the
    // response (proof sessions); the pool releases it via release().
    request(payload, { lease = false } = {}) {
        if (!this.isAlive()) {
            return Promise.reject(Object.assign(new Error('repl worker not running'), { kind: 'worker-exit' }));
        }
        if (this._pending) {
            return Promise.reject(new Error('repl worker busy'));
        }
        return new Promise((resolve, reject) => {
            this._pending = { resolve, reject, lease };
            this.busy = true;
            try {
                this.child.stdin.write(JSON.stringify(payload) + '\n\n');
            } catch (err) {
                this._pending = null;
                this.busy = false;
                reject(Object.assign(err, { kind: 'worker-exit' }));
            }
        });
    }

    kill(signal = 'SIGKILL') {
        try {
            if (this.child && this.child.exitCode === null) this.child.kill(signal);
        } catch { /* already dead */ }
        this._dead = true;
        const pending = this._pending;
        this._pending = null;
        this.busy = false;
        if (pending) pending.reject(Object.assign(new Error('repl worker killed'), { kind: 'worker-exit' }));
    }

    isAlive() {
        return !this._dead && !!this.child && this.child.exitCode === null;
    }
}

export class BackendRepl {
    constructor(options = {}) {
        this.type = 'repl';
        this.concurrency = options.concurrency ?? 4;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.replBin = options.replBin ?? process.env.KANFORGE_REPL_BIN ?? 'repl';
        this.toolchain = options.toolchain ?? process.env.KANFORGE_LEAN_TOOLCHAIN ?? null;
        this.leanProject = options.leanProject ?? process.env.KANFORGE_LEAN_PROJECT ?? null;
        this.mathlibHash = options.mathlibHash ?? null;
        this.leanVersion = options.leanVersion ?? null;
        // The repl keeps every environment snapshot forever (REPL.Main cmdStates), so a worker
        // reused across many Mathlib imports eventually dies with "INTERNAL PANIC: out of
        // memory". workerPerProblem retires a session's worker when its lemma ends, giving each
        // problem a fresh process (use for Mathlib-heavy workloads).
        this.workerPerProblem = options.workerPerProblem ?? false;
        this.startedAt = Date.now();
        this._env = resolveReplEnv(this.toolchain, this.leanProject);

        this._workers = [];
        this._inflight = new Map();   // statementHash -> shared promise (single-flight)
        this._waiters = [];           // pending _acquire() resolvers
        this._sessions = new Map();   // lemmaKey -> { worker }
        this._draining = false;

        this.restarts = 0;
        this.hangs = 0;
        this.timeouts = 0;
        this.parseErrors = 0;

        for (let i = 0; i < this.concurrency; i++) this._spawnWorker();
    }

    _spawnWorker() {
        const worker = new ReplWorker({
            replBin: this.replBin,
            env: this._env,
            onParseError: () => { this.parseErrors++; },
            onExit: w => this._retire(w),
            onIdle: () => this._wakeWaiters()
        });
        this._workers.push(worker);
        return worker;
    }

    _retire(worker) {
        if (worker._retired) return;
        worker._retired = true;
        if (worker.isAlive()) worker.kill();
        const idx = this._workers.indexOf(worker);
        if (idx !== -1) this._workers.splice(idx, 1);
        // Any session on this worker is broken; drop it so the next call fails loudly
        // instead of waiting on a dead process.
        for (const [key, session] of this._sessions) {
            if (session.worker === worker) this._sessions.delete(key);
        }
        if (!this._draining) {
            this.restarts++;
            this._spawnWorker();
        }
        this._wakeWaiters();
    }

    _wakeWaiters() {
        if (this._waiters.length === 0) return;
        const free = this._workers.find(w => !w.busy && w.isAlive());
        if (!free) return;
        free.busy = true; // reserve before handing out, so a concurrent free event can't double-hand
        const waiter = this._waiters.shift();
        waiter.resolve(free);
    }

    _acquire() {
        if (this._draining) return Promise.reject(new Error('backend draining'));
        const free = this._workers.find(w => !w.busy && w.isAlive());
        if (free) {
            free.busy = true; // reserve at handout
            return Promise.resolve(free);
        }
        return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
    }

    // One request on one worker with kill-on-hang (§3.1). Shared by stateless checks and
    // leased session calls. On timeout, stateless checks kill the worker; leased sessions
    // just fail the request (the session is broken, but the worker stays alive for other sessions).
    async _requestOnWorker(worker, payload, { timeoutMs, lease = false } = {}) {
        let timer;
        try {
            return await new Promise((resolve, reject) => {
                worker.request(payload, { lease }).then(resolve, reject);
                timer = setTimeout(() => {
                    this.timeouts++;
                    this.hangs++;
                    if (!lease) {
                        // Stateless check: kill worker and replace
                        this._retire(worker);
                        reject(Object.assign(new Error(`lean repl timeout after ${timeoutMs}ms`), { kind: 'timeout' }));
                    } else {
                        // Leased session: fail request but keep worker alive
                        reject(Object.assign(new Error(`lean repl session timeout after ${timeoutMs}ms`), { kind: 'timeout' }));
                    }
                }, timeoutMs);
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async _checkOnce(statement, timeoutMs) {
        const worker = await this._acquire();
        try {
            return await this._requestOnWorker(worker, { cmd: statement, env: null }, { timeoutMs });
        } finally {
            if (worker.isAlive() && !worker._retired) {
                worker.busy = false;
                this._wakeWaiters();
            }
        }
    }

    async _doCheck(statement, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const maxRetries = opts.maxRetries ?? 1; // crash/hang retries on a fresh worker
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const resp = await this._checkOnce(statement, timeoutMs);
                return this._classify(resp);
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    check(statement, opts = {}) {
        const key = hashStatement(statement);
        const shared = this._inflight.get(key);
        if (shared) return shared; // single-flight: one kernel invocation, rest are cache hits
        const p = this._doCheck(statement, opts).finally(() => this._inflight.delete(key));
        this._inflight.set(key, p);
        return p;
    }

    _classify(resp) {
        // Statement mode: either a CommandResponse {env, messages, sorries, ...} or a hard
        // error {message} (unknown env, IO failure).
        if (resp && !('env' in resp) && typeof resp.message === 'string') {
            return {
                status: 'error',
                goals: [],
                error: { message: resp.message, detail: resp.message },
                warnings: []
            };
        }
        const messages = resp?.messages ?? [];
        const { errors, warnings } = parseLeanMessages(messages);
        const goals = (resp?.sorries ?? []).map(goalFromSorry);
        return {
            status: errors.length ? 'error' : 'verified',
            goals,
            error: errors.length ? leanErrorFromMessages(messages) : undefined,
            warnings
        };
    }

    // ---- Proof sessions (tactic mode) ----

    // Open a proof session for a lemma statement and return its goals. Leases one worker
    // until endLemma(key). The session key is hashStatement(src); the loop already keys
    // lemmas by exactly that hash (agent/loop.js addLemma).
    async extractGoals(src, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const key = hashStatement(src);
        const worker = await this._acquire();
        try {
            const resp = await this._requestOnWorker(worker, { cmd: src, env: null }, { timeoutMs, lease: true });
            const messages = resp?.messages ?? [];
            const { errors } = parseLeanMessages(messages);
            if (errors.length) {
                worker.busy = false;
                this._wakeWaiters();
                return [];
            }
            this._sessions.set(key, { worker });
            return (resp?.sorries ?? []).map(s => ({ ...goalFromSorry(s), sessionKey: key }));
        } catch (err) {
            if (worker.isAlive() && !worker._retired) {
                worker.busy = false;
                this._wakeWaiters();
            }
            throw err;
        }
    }

    // Apply ONE tactic to ONE goal (§3, §4). Uses the repl tactic API against the goal's
    // proofState on the leased session worker.
    async applyTactic(goal, tactic, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const key = goal?.sessionKey;
        const session = key ? this._sessions.get(key) : null;
        if (!session) {
            return {
                status: 'error',
                newGoals: [],
                error: { message: 'no proof session for goal (extractGoals must open one)' }
            };
        }
        let resp;
        try {
            resp = await this._requestOnWorker(session.worker, { tactic: String(tactic).trim(), proofState: goal.proofState }, { timeoutMs, lease: true });
        } catch (err) {
            return { status: 'error', newGoals: [], error: { message: err.message, detail: err.message } };
        }
        if (typeof resp?.message === 'string') {
            // "Lean error: ..." (tactic failed) or "Unknown proof state." (stale goal)
            return {
                status: 'error',
                newGoals: [],
                error: { message: resp.message, detail: resp.message }
            };
        }
        const newGoals = (resp?.goals ?? []).map(g => {
            const parsed = parseGoalText(g);
            return {
                type: parsed.type,
                context: parsed.context,
                caseName: parsed.caseName ?? undefined,
                pos: null,
                proofState: resp.proofState,
                sessionKey: key
            };
        });
        return { status: 'ok', newGoals, error: undefined };
    }

    // Kernel check of a full proof source (statement + composed script). Runs on the leased
    // session worker when a session key is given, so pool size may equal loop concurrency
    // without starving verification; otherwise a stateless single-flight check.
    async verifyProof(src, key = null) {
        let res;
        const session = key ? this._sessions.get(key) : null;
        if (session && session.worker.isAlive()) {
            const resp = await this._requestOnWorker(session.worker, { cmd: src, env: null }, { timeoutMs: this.timeoutMs, lease: true });
            res = this._classify(resp);
        } else {
            res = await this.check(src);
        }
        if (res.status !== 'verified' || res.goals.length) {
            return { status: 'error', error: res.error ?? { message: 'unproven goals remain' } };
        }
        return { status: 'verified', error: undefined };
    }

    // Release the leased session worker for a lemma. Idempotent. With workerPerProblem the
    // worker is retired and replaced instead of returned to the pool, so Mathlib-heavy runs get
    // a fresh process per problem (the repl accumulates environments until it OOMs otherwise).
    endLemma(key) {
        const session = this._sessions.get(key);
        if (!session) return;
        this._sessions.delete(key);
        const { worker } = session;
        if (this.workerPerProblem) {
            if (worker.isAlive() && !worker._retired) this._retire(worker);
            return;
        }
        if (worker.isAlive() && !worker._retired) {
            worker.busy = false;
            this._wakeWaiters();
        }
    }

    getInfos() {
        return {
            toolchain: this.toolchain ?? 'unknown',
            mathlibHash: this.mathlibHash ?? null,
            backends: ['repl'],
            poolSize: this._workers.length,
            sessions: this._sessions.size,
            restarts: this.restarts,
            hangs: this.hangs,
            timeouts: this.timeouts,
            parseErrors: this.parseErrors,
            poolUptime: Date.now() - this.startedAt
        };
    }

    pin() {
        return { toolchain: this.toolchain ?? null, mathlibHash: this.mathlibHash, leanVersion: this.leanVersion, normVersion: NORM_VERSION, statementHash: null };
    }

    pinStatement(statement) {
        return makePin(statement, { toolchain: this.toolchain, mathlibHash: this.mathlibHash, leanVersion: this.leanVersion });
    }

    async shutdown(timeoutMs = this.timeoutMs) {
        this._draining = true;
        for (const w of this._waiters) w.reject(new Error('backend draining'));
        this._waiters = [];
        this._sessions.clear();
        const deadline = Date.now() + timeoutMs;
        while (this._workers.some(w => w.busy) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 25));
        }
        const killed = [];
        for (const w of this._workers) {
            if (w.isAlive()) {
                w.kill();
                killed.push(w.pid);
            }
        }
        this._workers = [];
        return { killed, abortedInflight: this._inflight.size };
    }
}
