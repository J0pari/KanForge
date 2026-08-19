import fs from 'node:fs';
import { loadEnv } from './env.js';
import { loadLLMConfig, createLLM } from './agent/llm.js';
import { createBackend } from './lean/backend.js';
import { Autoformalizer } from './agent/roles/autoformalizer.js';

const E = loadEnv();
const llm = createLLM({ ...loadLLMConfig(E), retries: 0 });
const backend = createBackend({ type: 'repl', replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 300000 });
const af = new Autoformalizer({ llm, backend, checkTimeoutMs: 300000 });

const statement = fs.readFileSync('runs/erdos10-variant-two-pows/statement.txt', 'utf8');
const candidates = [];
for (const n of [1, 2, 3, 4, 5]) {
    candidates.push(`the number ${n} is an element of the set`);
}
fs.appendFileSync('probe-diag2.log', 'verify call\n');
const pr = await af._verifyProbes(statement, candidates, { allowPartial: true });
fs.appendFileSync('probe-diag2.log', 'ok=' + pr.ok + ' error=' + (pr.error ?? '') + '\n');
for (const r of pr.results ?? []) {
    fs.appendFileSync('probe-diag2.log', `- verified=${r.verified} label=${r.instance} err=${(r.error ?? '').slice(0, 200)}\n`);
}
fs.appendFileSync('probe-diag2.log', 'done\n');
process.exit(0);
