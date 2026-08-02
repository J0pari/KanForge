// REPL pool over the real `leanprover-community/repl` binary (architecture.md §3 + §3.1).
// Wire protocol (verified against the actual binary, built at the pinned toolchain):
//   stdin:  one compact JSON object per command, followed by a blank line.
//   stdout: one compact JSON object per response, followed by a blank line.
//   request:  { "cmd": "<lean command>", "env": null }   // env null = fresh session
//   response: { "env": n, "messages": [{pos, endPos, severity, data}], "sorries": [...],
//               "tactics": [...], "infotree": ... }
//   a failed command that raises an IO error returns { "message": "..." } instead.
// The pool is the correctness bottleneck, so its failure modes are explicit:
//   - warm worker pool; a check is a single request/response over one worker
//   - kill-on-hang: every check has a timeout; a worker exceeding it is killed and replaced
//   - crash replace with <= 1 retry per job, then it fails loudly
//   - per-line parse resilience: a malformed JSON line is skipped and counted (never drops the batch)
//   - single-flight: identical statements dedup to one kernel invocation
//   - graceful drain: shutdown() kills workers, pending requests are aborted
//   - health counters via getInfos(): { poolSize, restarts, hangs, timeouts, parseErrors, poolUptime }

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { hashStatement, makePin, NORM_VERSION } from './pin.js';

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

function resolveReplEnv(toolchain) {
    const bin = toolchainBinDir(toolchain);
    if (!bin) return process.env;
    const current = process.env.PATH ?? '';
    return { ...process.env, PATH: `${bin}${current ? path.delimiter + current : ''}` };
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

        // Framing: each response is one JSON document terminated by a blank line. Pretty-printed
        // responses span many physical lines (only `{"env": n}` fits on one), so accumulate lines
        // and parse the whole document when the blank line arrives.
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
            // Malformed response document: counted, and the job is retried on a fresh worker —
            // never silently dropped.
            onParseError?.(text);
            const pending = this._pending;
            this._pending = null;
            this.busy = false;
            if (pending) pending.reject(Object.assign(new Error('repl returned a malformed response document'), { kind: 'parse-error' }));
            return;
        }
        const pending = this._pending;
        this._pending = null;
        this.busy = false;
        if (pending) pending.resolve(parsed);
        onIdle?.(this);
    }

    request(cmd) {
        if (!this.isAlive()) {
            return Promise.reject(Object.assign(new Error('repl worker not running'), { kind: 'worker-exit' }));
        }
        if (this._pending) {
            return Promise.reject(new Error('repl worker busy'));
        }
        return new Promise((resolve, reject) => {
            this._pending = { resolve, reject };
            this.busy = true;
            try {
                // Real repl protocol: compact JSON + blank line. env null = fresh session, so
                // every check verifies its statement against a clean kernel environment.
                this.child.stdin.write(JSON.stringify({ cmd, env: null }) + '\n\n');
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
        this.mathlibHash = options.mathlibHash ?? null;
        this.leanVersion = options.leanVersion ?? null;
        this.startedAt = Date.now();
        this._env = resolveReplEnv(this.toolchain);

        this._workers = [];
        this._inflight = new Map();   // statementHash -> shared promise (single-flight)
        this._waiters = [];           // pending _acquire() resolvers
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

    async _checkOnce(statement, timeoutMs) {
        const worker = await this._acquire();
        let timer;
        try {
            return await new Promise((resolve, reject) => {
                worker.request(statement).then(resolve, reject);
                timer = setTimeout(() => {
                    this.timeouts++;
                    this.hangs++;
                    this._retire(worker); // kill-on-hang + replace
                    reject(Object.assign(new Error(`lean repl timeout after ${timeoutMs}ms`), { kind: 'timeout' }));
                }, timeoutMs);
            });
        } finally {
            clearTimeout(timer);
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
        // Real repl can answer either a CommandResponse {env, messages, sorries, ...} or a
        // hard error {message} (unknown env, IO failure). Classify both.
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
        const goals = (resp?.sorries ?? []).map(s => ({
            type: s.goal ?? '',
            context: [],
            pos: s.pos ?? null
        }));
        return {
            status: errors.length ? 'error' : 'verified',
            goals,
            error: errors.length ? leanErrorFromMessages(messages) : undefined,
            warnings
        };
    }

    async extractGoals(src, position) {
        const res = await this.check(`set_option pp.all true in\n${src}`);
        return res.goals;
    }

    async verifyProof(script) {
        const res = await this.check(script);
        if (res.status !== 'verified' || res.goals.length) {
            return { status: 'error', error: res.error ?? { message: 'unproven goals remain' } };
        }
        return { status: 'verified', error: undefined };
    }

    getInfos() {
        return {
            toolchain: this.toolchain ?? 'unknown',
            mathlibHash: this.mathlibHash ?? null,
            backends: ['repl'],
            poolSize: this._workers.length,
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
