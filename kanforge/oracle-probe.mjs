import fs from 'node:fs';
import { loadEnv } from './env.js';
import { createBackend } from './lean/backend.js';

const E = loadEnv();
fs.appendFileSync('oracle-probe.log', 'starting batch 2\n');
const backend = createBackend({ type: 'repl', replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 600000 });

const probes = [
    '#check Nat.exists_eq_two_pow_mul_odd',
    '#check Nat.dvd_sub',
    '#check Nat.Prime.eq_one_or_self_of_dvd',
    '#check Nat.Prime.eq_one_of_dvd',
    '#check Nat.pow_le_pow_right',
    '#check Nat.sub_eq_iff_eq_add',
    '#check Nat.dvd_mul_right',
    '#check Nat.Prime.two_le',
    '#check Nat.le_of_dvd',
    '#check Nat.pos_of_dvd_of_pos'
];
const src = [
    'import Mathlib.Data.ZMod.Basic',
    'import Mathlib.Data.Nat.ModEq',
    'import Mathlib.Algebra.Ring.Parity',
    'import Mathlib.Algebra.BigOperators.Group.Finset.Defs',
    'import Mathlib.Data.Nat.Basic',
    'import Mathlib.Tactic.Positivity',
    'import Mathlib.Tactic.Ring',
    ''
].join('\n') + probes.join('\n');
fs.appendFileSync('oracle-probe.log', 'checking...\n');
try {
    const r = await backend.check(src, { timeoutMs: 600000, useWarmEnv: false });
    fs.appendFileSync('oracle-probe.log', 'status: ' + r.status + '\n');
    fs.appendFileSync('oracle-probe.log', 'err: ' + (r.error?.message ?? '').slice(0, 300) + '\n');
    for (const d of (r.error?.detail ?? [])) {
        fs.appendFileSync('oracle-probe.log', '  ' + d.slice(0, 250) + '\n');
    }
} catch (err) {
    fs.appendFileSync('oracle-probe.log', 'THREW: ' + (err?.message ?? String(err)).slice(0, 300) + '\n');
}
fs.appendFileSync('oracle-probe.log', 'done\n');
process.exit(0);
