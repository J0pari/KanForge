import fs from 'node:fs';

const full = `import Mathlib.Algebra.BigOperators.Group.Multiset.Defs
import Mathlib.Data.Set.Finite.Basic
import Mathlib.Data.Nat.Prime.Defs
import Mathlib.Algebra.Ring.Parity

theorem erdos_10.variants.two_pows : Set.Infinite <| {n : Nat | Even n} \\ {x : Nat | \u2203 (p : Nat) (pows : Multiset Nat), p.Prime \u2227 pows.card \u2264 2 \u2227 x = p + (pows.map (2 ^ \u00b7)).sum} := by sorry`;

const { BackendRepl } = await import('./lean/backendRepl.js');
const { loadEnv } = await import('./env.js');
const E = loadEnv();
const b = new BackendRepl({ replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 300000 });
fs.appendFileSync('stmt-check.log', 'checking\n');
const r = await b.check(full, { timeoutMs: 300000, useWarmEnv: false });
fs.appendFileSync('stmt-check.log', 'status: ' + r.status + '\n' + (r.error?.message ?? '').slice(0, 300) + '\n');

fs.appendFileSync('stmt-check.log', 'done\n');
process.exit(0);
