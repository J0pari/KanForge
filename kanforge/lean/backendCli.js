// `lean` CLI backend (architecture.md §3) — one real `lean` invocation per check, writing the
// statement to a temp file. No process pool; used for CI batch verification. The binary is the
// real `lean` from the pinned elan toolchain (KANFORGE_LEAN_BIN override or `lean` on PATH).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makePin, NORM_VERSION } from './pin.js';

// Windows spawn does not do PATHEXT resolution (`lean` -> `lean.exe` fails), so resolve the
// binary to a real path via where.exe before spawning. Failures are surfaced, never swallowed:
// either the binary resolves to a real path or the caller sees exactly why it cannot.
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

    async check(statement, opts = {}) {
        fs.mkdirSync(this.tmpDir, { recursive: true });
        const file = path.join(this.tmpDir, `check-${process.pid}-${Math.random().toString(36).slice(2)}.lean`);
        fs.writeFileSync(file, statement);
        try {
            const { code, stdout, stderr } = await this._runLean([file]);
            return this._classify(code, stdout + '\n' + stderr);
        } finally {
            fs.rmSync(file, { force: true });
        }
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

    async extractGoals(src, position) {
        const res = await this.check(`set_option pp.all true in\n${src}`);
        return res.goals;
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
