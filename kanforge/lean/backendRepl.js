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

// Timestamped log prefix for pool lifecycle diagnostics.
function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

        child.on('error', err => {
            this._dead = true;
            this._rl?.close();
            const pending = this._pending;
            this._pending = null;
            if (pending) pending.reject(Object.assign(new Error(`repl worker spawn error: ${err.message}`), { kind: 'spawn-error' }));
            onExit?.(this, { code: null, signal: null });
        });

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
        // The WARM worker serves every one-shot check and never gets retired by workerPerProblem,
        // so its env accumulation is unbounded across a long pass. Recycle it after this many
        // cold (env: null) checks — the replacement spawns and re-warms from the pool's last
        // warmup automatically. A long verification sweep can no longer OOM the box.
        this.coldCheckRecycleThreshold = options.coldCheckRecycleThreshold ?? 8;
        this.coldChecks = 0;
        this.warmCheckTotal = 0;
        this.coldCheckTotal = 0;
        // A fresh repl process takes tens of seconds to elaborate its FIRST command (initial
        // environment build), which otherwise lands on the first caller's clock and trips its
        // timeout before any real work. warmup fires a trivial statement on each worker at
        // spawn, absorbing the cold start so leased sessions never pay it.
        this.warmupStatement = options.warmupStatement ?? null;
        this.warmupTimeoutMs = options.warmupTimeoutMs ?? 180_000;
        this.startedAt = Date.now();
        this._env = resolveReplEnv(this.toolchain, this.leanProject);

        this._workers = [];
        this._inflight = new Map();   // statementHash -> shared promise (single-flight)
        this._waiters = [];           // pending _acquire() resolvers
        this._sessions = new Map();   // lemmaKey -> { worker }
        this._draining = false;
        this.warmEnvId = null;        // statement-mode session env (warm → check continuation)

        this.restarts = 0;
        this.hangs = 0;
        this.timeouts = 0;
        this.parseErrors = 0;

        for (let i = 0; i < this.concurrency; i++) this._spawnWorker();
    }

    _spawnWorker() {
        let worker;
        try {
            worker = new ReplWorker({
                replBin: this.replBin,
                env: this._env,
                onParseError: () => { this.parseErrors++; },
                onExit: w => this._retire(w),
                onIdle: () => this._wakeWaiters()
            });
        } catch (err) {
            // Process spawn can fail under system memory pressure. The pool must NEVER shrink
            // silently (a missing warm worker starves one-shot checks behind leased sessions —
            // observed as multi-hour _acquire livelock). Retry with backoff until a worker
            // exists; the retry loop is capped and drains on shutdown.
            console.log(`[${ts()}] [repl-pool] worker spawn failed (${err?.message ?? err}); retrying in 15s`);
            this._spawnRetries = (this._spawnRetries ?? 0) + 1;
            if (this._spawnRetries <= 24 && !this._draining) {
                this._spawnRetryTimer = setTimeout(() => {
                    this._spawnRetryTimer = null;
                    if (!this._draining) this._spawnWorker();
                }, 15000);
            }
            return null;
        }
        this._workers.push(worker);
        // The first worker is the warm worker: it holds the warm env for fast chained checks
        // and never handles leased sessions (extractGoals). Loop workers are spawned
        // subsequently and handle leased sessions; they're killed after each lemma.
        const becomesWarm = !this._warmWorker;
        if (becomesWarm) this._warmWorker = worker;
        // Warm the new worker in the background (also covers retire-replacements). The worker
        // stays busy until its warmup response lands, so _acquire never hands it out cold.
        // Role split: the WARM worker carries the mission import block (its warm env is the
        // chained continuation for one-shot checks). LOOP workers only serve leased sessions,
        // whose extractGoals always runs env: null (fresh) — the mission-import warm on them is
        // wasted elaboration, so they absorb the process cold start with a TRIVIAL statement
        // instead (seconds, not minutes under load). A caller-configured warmupStatement always
        // wins for every worker (tests/bench contract).
        let warmupStmt = this.warmupStatement;
        if (!warmupStmt) {
            warmupStmt = becomesWarm ? (this._lastWarmup ?? null) : 'example : True := by trivial';
        }
        if (warmupStmt) {
            worker.busy = true;
            this._warm(worker, warmupStmt);
        }
        return worker;
    }

    // Send one trivial statement on a fresh worker so the first-elaboration cold start happens
    // off the caller's clock. Failures retire+replace the worker, which re-warms itself.
    async _warm(worker, statement) {
        const stmt = statement ?? this.warmupStatement;
        try {
            const resp = await this._requestOnWorker(worker, { cmd: stmt, env: null }, { timeoutMs: this.warmupTimeoutMs });
            // A replacement warm worker's freshly built env becomes the warm chain id, so the
            // next warm check continues from it instead of rebuilding inline.
            if (worker === this._warmWorker && resp && Number.isInteger(resp.env)) {
                this.warmEnvId = resp.env;
            }
        } catch {
            // timeout path already retired the worker and spawned a warm replacement
        } finally {
            // Do NOT clear worker.busy here: _dispatch already freed it after the non-lease
            // warmup response, and onIdle may have handed it to a waiter (reserved, busy=true).
            // Re-clearing would clobber that reservation and let a second extractGoals acquire
            // the same worker, tripping the ReplWorker.request "repl worker busy" guard.
            if (worker.isAlive() && !worker._retired) {
                this._wakeWaiters();
            }
        }
    }

    _retire(worker) {
        if (worker._retired) return;
        worker._retired = true;
        const wasWarm = this._warmWorker === worker;
        if (wasWarm) this.warmEnvId = null; // the env died with the worker
        if (worker.isAlive()) worker.kill();
        const idx = this._workers.indexOf(worker);
        if (idx !== -1) this._workers.splice(idx, 1);
        if (wasWarm) this._warmWorker = null; // replacement becomes warm
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

    _acquire(timeoutMs, { lease = false } = {}) {
        if (this._draining) return Promise.reject(new Error('backend draining'));
        // Role separation (architecture.md §0.3): the warm worker (first spawned) serves
        // non-leased checks (fast chained env). Leased sessions (extractGoals) prefer other
        // workers — the leased worker is killed after endLemma, so the warm worker survives.
        const preferWarm = !lease && this._warmWorker && this._warmWorker.isAlive() && !this._warmWorker.busy;
        const preferLoop = lease && this._workers.some(w => w !== this._warmWorker && w.isAlive() && !w.busy);
        let free;
        if (preferWarm) free = this._warmWorker;
        else if (preferLoop) free = this._workers.find(w => w !== this._warmWorker && !w.busy && w.isAlive());
        else free = this._workers.find(w => !w.busy && w.isAlive());
        if (free) {
            free.busy = true;
            return Promise.resolve(free);
        }
        console.log(`[${ts()}] [repl-pool] _acquire blocked: ${this._workers.length} workers (${this._workers.filter(w=>w.isAlive()).length} alive), ${this._waiters.length} waiters`);
        const guard = timeoutMs ?? 60_000;
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this._waiters.push(waiter);
            setTimeout(() => {
                const idx = this._waiters.indexOf(waiter);
                if (idx !== -1) this._waiters.splice(idx, 1);
                reject(Object.assign(new Error(`no repl worker available after ${guard}ms`), { kind: 'acquire-timeout' }));
            }, guard);
        });
    }

    // One request on one worker with kill-on-hang (§3.1). Shared by stateless checks and
    // leased session calls. On timeout, stateless checks kill the worker; leased sessions
    // just fail the request (the session is broken, but the worker stays alive for other sessions).
    async _requestOnWorker(worker, payload, { timeoutMs, lease = false } = {}) {
        let timer;
        const reqStart = Date.now();
        const desc = payload.cmd ? 'check' : (payload.tactic ? 'tactic' : 'inspect');
        try {
            return await new Promise((resolve, reject) => {
                worker.request(payload, { lease }).then(resolve, reject);
                timer = setTimeout(() => {
                    this.timeouts++;
                    this.hangs++;
                    // Reject first so the caller sees the timeout, not the kill's worker-exit.
                    reject(Object.assign(new Error(`lean repl ${lease ? 'session ' : ''}timeout after ${timeoutMs}ms`), { kind: 'timeout' }));
                    // The repl answers requests FIFO on one pipe. A request that timed out is
                    // still in flight, so its response would desync any request we send next on
                    // this worker. Kill and replace the worker — leased or not — so the pool
                    // never hands out a wedged worker (header contract: kill-on-hang).
                    this._retire(worker);
                }, timeoutMs);
            });
        } finally {
            clearTimeout(timer);
            const ms = Date.now() - reqStart;
            if (ms > 5000) console.log(`[${ts()}] [repl-pool] ${desc} request completed in ${(ms/1000).toFixed(1)}s`);
        }
    }

    async _checkOnce(statement, timeoutMs, envId = null) {
        // Every env: null request builds a fresh repl environment that the process retains
        // forever (the repl's documented OOM failure mode). This counts cold checks, warm
        // checks falling back to fresh, and background re-warms alike, and recycles the warm
        // worker past the threshold (its replacement spawns and re-warms itself). Runs BEFORE
        // _acquire so the retiring worker can never be handed out to this request.
        if (envId === null && !this._draining) {
            this.coldChecks++;
            if (this.coldChecks >= this.coldCheckRecycleThreshold && this._warmWorker && !this._warmWorker.busy) {
                this.coldChecks = 0;
                this._retire(this._warmWorker);
            }
        }
        const worker = await this._acquire(timeoutMs, { lease: false });
        try {
            // envId: continue the statement-mode session from a prior env (the repl is stateful:
            // `env: null` rebuilds from scratch; `env: n` continues from environment n). This is
            // what makes warm→check→probes pay the import cost once.
            return await this._requestOnWorker(worker, { cmd: statement, env: envId }, { timeoutMs });
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
        const useWarmEnv = !!opts.useWarmEnv;
        // Verification-throughput KPI counters (§5.7 KPIs): warm (env continuation) vs cold
        // (fresh env build) check totals — the warm/cold ratio is the leading indicator of
        // kernel-import waste. Never reset (unlike the recycle counter).
        if (useWarmEnv && this.warmEnvId !== null) this.warmCheckTotal++;
        else this.coldCheckTotal++;
        // A new request cancels a pending background re-warm: the rebuild must run in GAPS
        // between work, not interleave with (and pad) the requests that follow a cold check.
        if (this._rewarmTimer) {
            clearTimeout(this._rewarmTimer);
            this._rewarmTimer = null;
        }
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const resp = await this._checkOnce(statement, timeoutMs, useWarmEnv ? this.warmEnvId : null);
                if (useWarmEnv && resp && Number.isInteger(resp.env)) {
                    this.warmEnvId = resp.env; // continue the session from the returned env
                } else if (!useWarmEnv) {
                    // A fresh (env: null) check rebuilt the repl environment from scratch, so any
                    // previously established chain id is stale — subsequent chained checks would
                    // hit "Unknown environment". Drop it, then rebuild the warm session in the
                    // background so the next warm check doesn't pay the import cost inline.
                    this.warmEnvId = null;
                    this._rewarmInBackground();
                }
                return this._classify(resp);
            } catch (err) {
                lastErr = err;
                // A worker crash invalidates the session env (the replacement worker is fresh).
                if (useWarmEnv) this.warmEnvId = null;
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

    // Re-establish the warm statement-mode session after a fresh (env: null) check wiped it.
    // Debounced: bursts of cold checks (e.g. a verification sweep) coalesce into ONE re-warm at
    // the end of the burst, so the warm env is not rebuilt between cold checks that ignore it.
    // The next warm check either finds the env ready or queues behind this warmup. Errors are
    // swallowed (the next warm check rebuilds inline if this failed). Never re-warms while draining.
    _rewarmInBackground() {
        if (this._draining || !this._lastWarmup) return;
        clearTimeout(this._rewarmTimer);
        this._rewarmTimer = setTimeout(() => {
            this._rewarmTimer = null;
            if (this._draining || this._rewarming || this.warmEnvId !== null) return;
            this._rewarming = true;
            this.warm(this._lastWarmup)
                .catch(() => {})
                .finally(() => { this._rewarming = false; });
        }, 1500);
    }

    // Establish (or refresh) the statement-mode session: warm the repl with the statement's
    // imports, capturing the resulting env id so subsequent checks with `useWarmEnv: true`
    // continue from it instead of re-importing. The warmup keeps ONLY the import lines plus a
    // trivial example (the theorem body is irrelevant to warming). Runs WITH useWarmEnv so the
    // response's env id is captured into warmEnvId (it continues an existing session if any).
    async warm(statement, opts = {}) {
        const imports = String(statement ?? '').split(/\r?\n/).filter(l => /^\s*import\s+\S/.test(l)).join('\n');
        const warmup = (imports ? imports + '\n\n' : '') + 'example : True := by trivial';
        this._lastWarmup = warmup; // a replacement warm worker re-warms from this automatically
        const res = await this.check(warmup, { ...opts, useWarmEnv: true });
        return res;
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
        const worker = await this._acquire(timeoutMs, { lease: true });
        try {
            const resp = await this._requestOnWorker(worker, { cmd: src, env: null }, { timeoutMs, lease: true });
            const messages = resp?.messages ?? [];
            const { errors } = parseLeanMessages(messages);
            if (errors.length) {
                const msg = typeof errors[0] === 'string' ? errors[0] : JSON.stringify(errors[0]);
                console.log(`[${ts()}] [repl-pool] extractGoals parse error: ${msg}`);
                worker.busy = false;
                this._wakeWaiters();
                throw Object.assign(new Error(`extractGoals parse error: ${msg}`), { kind: 'parse-error', messages: errors });
            }
            this._sessions.set(key, { worker });
            const goals = (resp?.sorries ?? []).map(s => ({ ...goalFromSorry(s), sessionKey: key }));
            if (goals.length === 0 && (resp?.sorries?.length ?? 0) === 0) {
                console.log(`[${ts()}] [repl-pool] extractGoals returned 0 sorries for src: ${src.slice(0, 100)}`);
            }
            return goals;
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
            warmChecks: this.warmCheckTotal,
            coldChecks: this.coldCheckTotal,
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
        if (this._rewarmTimer) {
            clearTimeout(this._rewarmTimer);
            this._rewarmTimer = null;
        }
        if (this._spawnRetryTimer) {
            clearTimeout(this._spawnRetryTimer);
            this._spawnRetryTimer = null;
        }
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
