// Watchdog supervisor: keeps the blueprint refine loop alive across process windows.
// Each pass spawns `node blueprint/run.js` (the same loop the operator would run by hand),
// captures its output to a numbered pass log, kills it at the pass wall-clock cap, and
// relaunches from the checkpoint while unproved lemmas remain. Stops when the checkpoint is
// fully proved, after --max-passes windows, or after --zero-progress-limit consecutive
// passes with no newly proved lemma (deadlock detection).
//
// Exit codes: 0 = mission complete, 2 = zero-progress stop, 3 = max passes reached, 4 = usage error.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function argValue(args, prefix) {
    const hit = args.find(a => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
}

function log(line) {
    console.log(`[${new Date().toISOString()}] ${line}`);
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function readCheckpoint(runDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8'));
    } catch {
        return null;
    }
}

function runPass(runDir, args, passIdx, passTimeoutMs) {
    return new Promise(resolve => {
        const logPath = path.join(runDir, `wd${passIdx}.log`);
        const out = fs.createWriteStream(logPath, { flags: 'a' });
        const child = spawn(process.execPath, ['blueprint/run.js', ...args], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        child.stdout.pipe(out);
        child.stderr.pipe(out);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            log(`pass ${passIdx}: wall-cap reached, terminating run.js`);
            child.kill('SIGTERM');
        }, passTimeoutMs);
        child.on('exit', async (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                await sleep(20000);
                if (child.exitCode === null) {
                    try { child.kill('SIGKILL'); } catch {}
                }
            }
            out.end();
            resolve({ code, signal, logPath, timedOut });
        });
        child.on('error', err => {
            clearTimeout(timer);
            out.end();
            resolve({ code: -1, signal: null, logPath, timedOut, spawnError: String(err) });
        });
    });
}

async function main() {
    const args = process.argv.slice(2);
    const problem = argValue(args, '--problem=');
    const statementFile = argValue(args, '--statement-file=');
    if (!problem || !statementFile) {
        console.error('usage: node watchdog.mjs --problem=<id> --statement-file=<path> [--pass-timeout-ms=<ms>] [--max-passes=<n>] [--zero-progress-limit=<n>] [--recipe=loop] [--max-tactics=8] [--concurrency=<n>] [--premises]');
        process.exit(4);
    }
    const passTimeoutMs = Number(argValue(args, '--pass-timeout-ms=') ?? 6 * 3600 * 1000);
    const maxPasses = Number(argValue(args, '--max-passes=') ?? 0);
    const zeroProgressLimit = Number(argValue(args, '--zero-progress-limit=') ?? 3);
    const recipe = argValue(args, '--recipe=') ?? 'loop';
    const maxTactics = argValue(args, '--max-tactics=') ?? '8';
    const concurrency = argValue(args, '--concurrency=');
    const runDir = path.join(ROOT, 'runs', problem);
    if (!fs.existsSync(runDir)) {
        console.error(`run dir not found: ${runDir}`);
        process.exit(4);
    }
    // Instance lock: exactly one watchdog per problem. A stale second instance would write the
    // same checkpoint from two refine loops (observed corruption hazard). The lock is a pid
    // file; a dead pid's file is taken over.
    const lockFile = path.join(runDir, 'watchdog.lock');
    try {
        const existing = fs.existsSync(lockFile) ? Number(fs.readFileSync(lockFile, 'utf8').trim()) : null;
        if (existing && Number.isInteger(existing)) {
            let alive = false;
            try { process.kill(existing, 0); alive = true; } catch {}
            if (alive) {
                console.error(`watchdog already running for ${problem} (pid ${existing}); refusing to start a second instance`);
                process.exit(4);
            }
        }
        fs.writeFileSync(lockFile, String(process.pid), 'utf8');
    } catch (err) {
        console.error(`watchdog lock failed: ${err?.message ?? err}`);
        process.exit(4);
    }
    const releaseLock = () => {
        try {
            if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) {
                fs.unlinkSync(lockFile);
            }
        } catch {}
    };
    process.on('exit', releaseLock);
    const runArgs = [`--problem=${problem}`, `--statement-file=${statementFile}`, `--recipe=${recipe}`, `--max-tactics=${maxTactics}`];
    if (concurrency) runArgs.push(`--concurrency=${concurrency}`);
    if (args.includes('--premises')) runArgs.push('--premises');

    const start = Date.now();
    let passIdx = 0;
    let zeroProgress = 0;
    let bestProved = 0;
    let total = null;

    log(`watchdog start: problem=${problem} passTimeout=${(passTimeoutMs / 3600000).toFixed(1)}h zeroProgressLimit=${zeroProgressLimit}`);
    for (;;) {
        const ck0 = readCheckpoint(runDir);
        total = ck0?.lemmas?.length ?? null;
        const proved0 = ck0?.lemmas?.filter(l => l.proof).length ?? 0;
        if (total !== null && proved0 >= total) {
            log(`mission complete: ${proved0}/${total} proved`);
            process.exit(0);
        }
        if (maxPasses > 0 && passIdx >= maxPasses) {
            log(`max passes reached (${maxPasses}); stopping with ${proved0}/${total ?? '?'} proved`);
            process.exit(3);
        }
        passIdx++;
        log(`pass ${passIdx} launching (checkpoint: ${proved0}/${total ?? '?'} proved)`);
        const result = await runPass(runDir, runArgs, passIdx, passTimeoutMs);
        const ck1 = readCheckpoint(runDir);
        const proved1 = ck1?.lemmas?.filter(l => l.proof).length ?? proved0;
        total = ck1?.lemmas?.length ?? total;
        const wallMin = ((Date.now() - start) / 60000).toFixed(1);
        log(`pass ${passIdx} ended: exit=${result.code}${result.timedOut ? ' (wall-cap)' : ''} proved=${proved1}/${total ?? '?'} wall=${wallMin}min`);
        if (total !== null && proved1 >= total) {
            log(`mission complete: ${proved1}/${total} proved`);
            process.exit(0);
        }
        if (proved1 > bestProved) {
            bestProved = proved1;
            zeroProgress = 0;
        } else {
            zeroProgress++;
            log(`no progress pass (${zeroProgress}/${zeroProgressLimit})`);
            if (zeroProgress >= zeroProgressLimit) {
                log(`stopping: ${zeroProgressLimit} consecutive passes without progress (${proved1}/${total ?? '?'} proved)`);
                process.exit(2);
            }
        }
    }
}

main().catch(e => {
    log(`watchdog fatal: ${e?.stack ?? e}`);
    process.exit(1);
});
