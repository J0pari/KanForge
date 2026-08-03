// `lean` CLI backend (architecture.md §3) — one real `lean` invocation per check, writing the
// statement to a temp file. No process pool; used for CI batch verification. The binary is the
// real `lean` from the pinned elan toolchain (KANFORGE_LEAN_BIN override or `lean` on PATH).
//
// Tactic mode on a stateless CLI: the repl is the primary tactic-mode backend (§3), but the
// LeanBackend interface is honored here too — extractGoals re-runs the statement with
// `trace_state` and parses the printed goal, and applyTactic reconstructs a full
// `example <binders> : <type> := by <tactic>` source and reads the "unsolved goals" error
// blocks as the resulting subgoals. Both parse goal text through lean/goalText.js, the same
// contract the repl uses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makePin, NORM_VERSION } from './pin.js';
import { parseGoalText, formatBinders, splitGoalBlocks } from './goalText.js';

// Windows spawn does not do PATHEXT resolution (`lean` -> `lean.exe` fails), so resolve the
// binary to a real path via where.exe before spawning. Failures are surfaced, never swallowed.
export function resolveLeanBin(bin) {
    if (path.extname(bin)) return bin;
    if (process.platform !== 'win32') return bin;
    const r = spawnSync('where.exe', [bin], { encoding: 'utf8', timeout: 10_000 });
    if (r.error) {
        throw new Error(`could not resolve '${bin}' via where.exe: ${r.error.message}`);
    }
    const first = (r.stdout ?? '').split(/\r?\n/).find(l => l.trim());
    if (r.status === 0 && first) return first.trim();
    // Not on PATH: keep the caller's explicit value so its own spawn fails loudly with ENOENT.
    return bin;
}

// Extract a diagnostic message body from lean CLI output: lines following
// `<file>:<line>:<col>: <severity>:` up to the next diagnostic header or EOF.
function extractDiagnosticBodies(output) {
    const lines = String(output).split(/\r?\n/);
    const bodies = [];
    let current = null;
    for (const line of lines) {
        if (/^\S.*?:\d+:\d+:\s*(error|warning|information|info):/.test(line)) {
            if (current) bodies.push(current);
            current = { header: line, body: line.replace(/^\S.*?:\d+:\d+:\s*(error|warning|information|info):\s*/, '') };
        } else if (current) {
            current.body += '\n' + line;
        }
    }
    if (current) bodies.push(current);
    return bodies;
}

export class BackendCli {
    constructor(options = {}) {
        this.type = 'cli';
        this.leanBin = resolveLeanBin(options.leanBin ?? process.env.KANFORGE_LEAN_BIN ?? 'lean');
        this.toolchain = options.toolchain ?? null;
        this.mathlibHash = options.mathlibHash ?? null;
        this.leanVersion = options.leanVersion ?? null;
        this.tmpDir = options.tmpDir ?? path.join(os.tmpdir(), 'kanforge-lean');
    }

    _runLean(args) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.leanBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            child.stdout.on('data', d => { out += d.toString(); });
            child.stderr.on('data', d => { err += d.toString(); });
            child.on('error', reject);
            child.on('close', code => resolve({ code, stdout: out, stderr: err }));
        });
    }

    async _runSource(source) {
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const file = path.join(this.tmpDir, `check-${process.pid}-${Math.random().toString(36).slice(2)}.lean`);
        fs.writeFileSync(file, source);
        try {
            const { code, stdout, stderr } = await this._runLean([file]);
            return { code, output: stdout + '\n' + stderr };
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    async check(statement, opts = {}) {
        const { code, output } = await this._runSource(statement);
        return this._classify(code, output);
    }

    _classify(code, output) {
        const errorLines = output.split(/\r?\n/).filter(l => /error/i.test(l));
        if (code !== 0 || errorLines.length) {
            return {
                status: 'error',
                goals: [],
                error: {
                    message: errorLines[0]?.trim() || `lean exited ${code}`,
                    detail: output.slice(0, 2000)
                },
                warnings: []
            };
        }
        return { status: 'verified', goals: [], warnings: [] };
    }

    // Goals at the statement's sorry: re-run with `trace_state` and parse the printed goal.
    async extractGoals(src, position) {
        const traced = src.replace(/:=\s*by\s+sorry\s*$/, ':= by\n  trace_state\n  sorry');
        if (traced === src) return [];
        const { output } = await this._runSource(traced);
        const bodies = extractDiagnosticBodies(output);
        const goals = [];
        for (const b of bodies) {
            if (!/info/.test(b.header) || !b.body.includes('⊢')) continue;
            for (const block of splitGoalBlocks(b.body)) {
                const parsed = parseGoalText(block);
                if (parsed.type) goals.push({ type: parsed.type, context: parsed.context, caseName: parsed.caseName ?? undefined, pos: null });
            }
        }
        return goals;
    }

    // Apply ONE tactic to ONE goal: rebuild a full example from the goal telescope and read
    // the resulting subgoals from the "unsolved goals" error block.
    async applyTactic(goal, tactic, opts = {}) {
        const binders = formatBinders(goal.context ?? []);
        const source = `example ${binders} : ${goal.type} := by\n  ${String(tactic).trim()}\n`;
        const { code, output } = await this._runSource(source);
        const bodies = extractDiagnosticBodies(output);
        const errorBodies = bodies.filter(b => /error/.test(b.header));
        if (!errorBodies.length && code === 0) {
            return { status: 'ok', newGoals: [] };
        }
        const unsolved = errorBodies.find(b => /unsolved goals/i.test(b.body));
        if (unsolved) {
            const newGoals = splitGoalBlocks(unsolved.body.replace(/^.*?unsolved goals/i, ''))
                .map(block => parseGoalText(block))
                .filter(g => g.type)
                .map(g => ({ type: g.type, context: g.context, caseName: g.caseName ?? undefined, pos: null }));
            return { status: 'ok', newGoals };
        }
        const first = errorBodies[0];
        return {
            status: 'error',
            newGoals: [],
            error: { message: (first?.body ?? `lean exited ${code}`).trim().slice(0, 2000), detail: output.slice(0, 2000) }
        };
    }

    async verifyProof(script) {
        const res = await this.check(script);
        if (res.status !== 'verified') return { status: 'error', error: res.error };
        return { status: 'verified', error: undefined };
    }

    getInfos() {
        return {
            toolchain: this.toolchain ?? 'unknown',
            mathlibHash: this.mathlibHash ?? null,
            backends: ['cli'],
            poolSize: 1
        };
    }

    pin() {
        return { toolchain: this.toolchain ?? null, mathlibHash: this.mathlibHash, leanVersion: this.leanVersion, normVersion: NORM_VERSION, statementHash: null };
    }

    pinStatement(statement) {
        return makePin(statement, { toolchain: this.toolchain, mathlibHash: this.mathlibHash, leanVersion: this.leanVersion });
    }

    async shutdown() {
        return { killed: [], abortedInflight: 0 };
    }
}
