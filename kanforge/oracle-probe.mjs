import fs from 'node:fs';
import { loadEnv } from './env.js';
import { createBackend } from './lean/backend.js';

const E = loadEnv();
fs.appendFileSync('oracle-probe.log', 'starting\n');
const backend = createBackend({ type: 'repl', replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 600000 });

const probes = [
    '#check Nat.modEq_zero_iff_dvd',
    '#check ZMod.eq_zero_iff_dvd_nat',
    '#check Nat.dvd_iff_mod_eq_zero',
    '#check ZMod.val_eq_zero',
    '#check Int.natCast_dvd_natCast',
    '#check ZMod.natCast_eq_natCast_iff',
    '#check Nat.ModEq.dvd_of_modEq'
];
const src = [
    'import Mathlib.Data.ZMod.Basic',
    'import Mathlib.Data.Nat.ModEq',
    'import Mathlib.Algebra.Ring.Parity',
    ''
].join('\n') + probes.join('\n');
fs.appendFileSync('oracle-probe.log', 'checking...\n');
try {
    const r = await backend.check(src, { timeoutMs: 600000, useWarmEnv: false });
    fs.appendFileSync('oracle-probe.log', 'status: ' + r.status + '\n');
    fs.appendFileSync('oracle-probe.log', 'err: ' + (r.error?.message ?? '').slice(0, 300) + '\n');
    for (const d of (r.error?.detail ?? [])) {
        fs.appendFileSync('oracle-probe.log', '  ' + d.slice(0, 200) + '\n');
    }
} catch (err) {
    fs.appendFileSync('oracle-probe.log', 'THREW: ' + (err?.message ?? String(err)).slice(0, 300) + '\n');
}
fs.appendFileSync('oracle-probe.log', 'done\n');
process.exit(0);
