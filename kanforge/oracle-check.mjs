import fs from 'node:fs';
import { loadEnv } from './env.js';
import { createBackend } from './lean/backend.js';

const E = loadEnv();
fs.appendFileSync('oracle-check.log', 'checking oracle.lean\n');
const backend = createBackend({ type: 'repl', replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 600000 });

const src = fs.readFileSync('../../oracle/erdos10-two-pows/oracle.lean', 'utf8');
try {
    // The repl's first-declaration-after-imports quirk (phantom `OfNat`/parse noise) is
    // intermittent — retry fresh-env checks a few times; a run free of the quirk reports the
    // REAL elaboration errors.
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        r = await backend.check(src, { timeoutMs: 1500000, useWarmEnv: false });
        const msg = r.error?.message ?? '';
        if (r.status === 'verified' || !/OfNat|expected token|Unknown constant `ZMod\.natCast_eq_natCast_iff\.mp`/.test(msg)) break;
        fs.appendFileSync('oracle-check.log', 'quirk run (attempt ' + attempt + '): ' + msg.slice(0, 120) + '\n');
    }
    fs.appendFileSync('oracle-check.log', 'status: ' + r.status + '\n');
    if (r.status === 'error') {
        fs.appendFileSync('oracle-check.log', 'ERROR: ' + (r.error?.message ?? '').slice(0, 1200) + '\n');
        fs.appendFileSync('oracle-check.log', 'SPAN: ' + JSON.stringify(r.error?.span ?? null) + '\n');
        for (const d of (r.error?.detail ?? []).slice(0, 4)) {
            fs.appendFileSync('oracle-check.log', '  detail: ' + d.slice(0, 400) + '\n');
        }
    }
} catch (err) {
    fs.appendFileSync('oracle-check.log', 'THREW: ' + (err?.message ?? String(err)).slice(0, 400) + '\n');
}
fs.appendFileSync('oracle-check.log', 'done\n');
process.exit(0);
