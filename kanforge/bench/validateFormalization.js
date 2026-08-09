// Validate the autoformalizer on a corpus candidate (build_order.md §7.1).
// Usage: node bench/validateFormalization.js --prose="<prose>" [--instances="a|b|c"] [--source=<id>]
import { loadEnv } from '../env.js';
import { loadLLMConfig, createLLM } from '../agent/llm.js';
import { createBackend } from '../lean/backend.js';
import { Autoformalizer } from '../agent/roles/autoformalizer.js';
import fs from 'node:fs';
import path from 'node:path';

const ENV = loadEnv();
const args = process.argv.slice(2);
const argV = (p) => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };

const prose = argV('--prose=');
const source = argV('--source=') ?? 'manual';
const instances = (argV('--instances=') ?? '').split('|').filter(Boolean);

if (!prose) { console.error('usage: --prose="..." [--instances=a|b] [--source=id]'); process.exit(2); }

const llm = createLLM({ ...loadLLMConfig(ENV), retries: 0 });
const backend = createBackend({
    type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
    leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 180000
});
const af = new Autoformalizer({ llm, backend, checkTimeoutMs: 180000 });

const t0 = Date.now();
const r = await af.formalize(prose, { instances, source });
console.log(JSON.stringify({ totalSec: +((Date.now() - t0) / 1000).toFixed(1), ok: r.ok }, null, 1));
if (r.ok) {
    console.log('statement:');
    console.log(r.statement);
    console.log('entry:', JSON.stringify({ hash: r.shortlistEntry.statementHash.slice(0, 12), shape: r.shortlistEntry.justification.shape, attempts: r.shortlistEntry.attempts, probes: r.shortlistEntry.probes }, null, 1));
    // persist a shortlist entry
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'corpus', 'shortlist');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${source}.json`);
    fs.writeFileSync(file, JSON.stringify(r.shortlistEntry, null, 2));
    console.log('shortlist entry ->', file);
} else {
    console.log('error:', r.error);
}
await backend.shutdown(3000);
