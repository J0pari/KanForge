// Batch autoformalizer validation (build_order.md §7.1).
// Picks N distinct Erdős problems at random from the corpus manifest, rerolling any whose goal
// shape is too similar to an already-picked one (so the test generalizes across problem shapes,
// not one neighborhood), extracts the prose from the DeepMind Lean docstring, and runs the
// autoformalizer on each. Reports per-problem outcome + timing.
//
// CLI: node bench/validateBatch.js [--count=5] [--seed=<n>]
import { loadEnv } from '../env.js';
import { loadLLMConfig, createLLM } from '../agent/llm.js';
import { createBackend } from '../lean/backend.js';
import { Autoformalizer } from '../agent/roles/autoformalizer.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(PACKAGE_ROOT, '..', 'corpus');
const MANIFEST = path.join(CORPUS, 'index', 'corpus.json');
const LEAN_DIR = path.join(CORPUS, 'sources', 'formal-conjectures', 'FormalConjectures', 'ErdosProblems');

const args = process.argv.slice(2);
const argV = (p) => { const a = args.find(x => x.startsWith(p)); return a ? Number(a.slice(p.length)) : null; };
const COUNT = argV('--count=') ?? 5;
const SEED = argV('--seed=') ?? Date.now() % 100000;

// Deterministic PRNG (mulberry32) so a seed reproduces the same 5-problem draw.
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Extract the problem statement from the DeepMind Lean docstring (the verbatim prose under the
// problem title, before the closing -/ or the first @[ attribute).
export function extractProseFromLean(num) {
    const file = path.join(LEAN_DIR, `${num}.lean`);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    // The theorem statement is the first /-- ... -/ docstring after `namespace Erdos<N>`.
    const ns = text.indexOf(`namespace Erdos${num}`);
    if (ns === -1) return null;
    const after = text.slice(ns);
    const m = after.match(/\/--([\s\S]*?)-/);
    if (!m) return null;
    return m[1]
        .replace(/^[ \t]*/, '')
        .replace(/\n\s*@\[[^]*$/, '')  // drop any trailing attribute block
        .replace(/[ \t\r\n]+/g, ' ')
        .trim() || null;
}

// Shape similarity: two problems are "too similar" if their tags overlap heavily (>50%).
function tooSimilar(a, b) {
    const ta = new Set(a.tags ?? []);
    const tb = new Set(b.tags ?? []);
    let overlap = 0;
    for (const t of ta) if (tb.has(t)) overlap++;
    const union = new Set([...ta, ...tb]).size || 1;
    return overlap / union > 0.5;
}

async function main() {
    const ENV = loadEnv();
    const llm = createLLM({ ...loadLLMConfig(ENV), retries: 0 });
    const backend = createBackend({
        type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 180000
    });
    try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
        const pool = manifest.missions;
        const rng = mulberry32(SEED);

        const picked = [];
        while (picked.length < COUNT && pool.length) {
            const cand = pool[Math.floor(rng() * pool.length)];
            if (picked.some(p => p.id === cand.id)) continue;
            if (picked.some(p => tooSimilar(p, cand))) continue; // reroll similar
            picked.push(cand);
        }

        console.log(`[batch] seed=${SEED} picked ${picked.length}/${COUNT}: ${picked.map(p => p.id).join(', ')}`);
        const af = new Autoformalizer({ llm, backend, checkTimeoutMs: 180000 });
        const results = [];
        for (const p of picked) {
            const prose = extractProseFromLean(p.id.replace('erdos-', ''));
            if (!prose) { console.log(`[batch] ${p.id}: NO PROSE (skip)`); results.push({ id: p.id, ok: false, error: 'no prose extracted' }); continue; }
            console.log(`[batch] ${p.id}: prose: ${prose.slice(0, 90)}...`);
            const t0 = Date.now();
            const r = await af.formalize(prose, { instances: [], source: p.id });
            const sec = +((Date.now() - t0) / 1000).toFixed(1);
            results.push({ id: p.id, ok: r.ok, sec, shape: r.shortlistEntry?.justification?.shape ?? null, error: r.error ?? null, statement: r.ok ? r.statement : null });
            console.log(`[batch] ${p.id}: ${r.ok ? 'OK' : 'FAIL'} ${sec}s ${r.ok ? r.shortlistEntry.justification.shape : r.error}`);
        }
        const ok = results.filter(r => r.ok);
        console.log(`\n[batch] SUMMARY: ${ok.length}/${results.length} formalized`);
        for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.id} ${r.sec}s ${r.shape ?? r.error ?? ''}`);
    } finally {
        await backend.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/validateBatch.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
