// One-time symbol→module index build (architecture.md §0.1 item 6, build_order.md §7.1).
// Scans the pinned mathlib source and writes the cached index next to the lean project
// (lean-project/symbol-index.json). Rebuild whenever the mathlib pin changes; the cache is
// derived data, never hand-edited.
// Usage: node bench/buildSymbolIndex.js [--project=<lean-project-dir>]
import { loadEnv } from '../env.js';
import { buildSymbolIndex, saveSymbolIndex, querySymbolIndex, SYMBOL_INDEX_CACHE_NAME } from '../lean/symbolIndex.js';
import path from 'node:path';

const args = process.argv.slice(2);
const argV = (p) => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };

const ENV = loadEnv();
const project = argV('--project=') ?? ENV.KANFORGE_LEAN_PROJECT;
if (!project) {
    console.error('no lean project (set KANFORGE_LEAN_PROJECT or pass --project=)');
    process.exit(2);
}
const mathlibRoot = path.join(project, '.lake', 'packages', 'mathlib', 'Mathlib');
const cacheFile = path.join(project, SYMBOL_INDEX_CACHE_NAME);

const t0 = Date.now();
console.log(`[symbol-index] scanning ${mathlibRoot}`);
const index = buildSymbolIndex(mathlibRoot, {
    onProgress: p => console.log(`[symbol-index] ${p.files}/${p.total} files, ${p.decls} declarations (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
});
saveSymbolIndex(index, cacheFile);
console.log(`[symbol-index] built ${index.stats.decls} declarations in ${index.stats.modules} modules, ${index.stats.files} files, ${(index.stats.builtMs / 1000).toFixed(1)}s`);
console.log(`[symbol-index] cache -> ${cacheFile}`);

// Self-check: the query tiers must resolve the symbols that motivated the design.
for (const token of ['Set.Infinite', 'Nat.Prime', 'Even', 'Odd', 'Multiset', 'Finset.sum']) {
    const q = querySymbolIndex(index, token);
    console.log(`[symbol-index] check ${token} -> ${q ? `${q.module} (tier ${q.tier})` : 'NOT FOUND'}`);
}
