// Derived symbol → defining-module index (architecture.md §0.1 item 6).
// The repair stage's "which mathlib module declares `X`" knowledge is DERIVED from the pinned
// mathlib source, not hand-maintained: this module scans every Mathlib/*.lean file once per pin
// and maps each top-level declaration (full dotted name, with namespace nesting and
// protected/private/noncomputable prefixes) to its defining module. Query tiers:
//   1. exact full-name match (e.g. `Set.Infinite` → Mathlib.Data.Finite.Defs)
//   2. last-segment match, preferring a module whose basename equals the segment
//   3. module-basename fallback for declarations with NO source line — to_additive-generated
//      names like `Even` never appear in a source file; mathlib's convention (the definition
//      lives in a file named after it, e.g. Algebra/Group/Even.lean) resolves them.
// The index is cached per mathlib pin (bench/buildSymbolIndex.js writes it); a missing cache
// degrades repair to the curated table in agent/roles/normalize.js (notation fixes only).

import fs from 'node:fs';
import path from 'node:path';

export const SYMBOL_INDEX_CACHE_NAME = 'symbol-index.json';

// 'Data/Set/Basic.lean' → 'Mathlib.Data.Set.Basic'
export function moduleFromPath(relPath) {
    return 'Mathlib.' + String(relPath).replace(/\\/g, '/').replace(/\.lean$/i, '').split('/').filter(Boolean).join('.');
}

// Track namespace/section nesting per file: namespace pushes, bare `end` pops the innermost
// opener, named `end X` pops through X. Declarations outside any namespace get no prefix.
// Approximate by design — tier 2/3 queries are the safety net.
function scanFile(text) {
    const decls = new Set();
    const stack = [];
    for (const line of text.split(/\r?\n/)) {
        const ns = line.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.']*)/);
        if (ns) {
            for (const part of ns[1].split('.')) stack.push(part);
            continue;
        }
        const end = line.match(/^\s*end\s+([A-Za-z_][A-Za-z0-9_.']*)/);
        if (end) {
            const name = end[1].split('.').pop();
            while (stack.length && stack[stack.length - 1] !== name) stack.pop();
            if (stack.length) stack.pop();
            continue;
        }
        if (/^\s*end\s*$/.test(line)) {
            stack.pop();
            continue;
        }
        const d = line.match(/^\s*(?:(?:protected|private|noncomputable)\s+)*(def|abbrev|theorem|lemma|inductive|structure|class)\s+([A-Za-z_][A-Za-z0-9_.']*)/);
        if (d) {
            // `def Multiset.{u}` captures `Multiset.` — strip the trailing dot (universe params).
            const name = d[2].replace(/\.+$/, '');
            decls.add([...stack, name].join('.'));
        }
    }
    return [...decls];
}

// Scan one mathlib root (the Mathlib/ directory) and return { decls: Map<name, module>, modules: Map<basename, module> }.
// onProgress(report) is called every `reportEvery` files with { files, decls, ms }.
export function buildSymbolIndex(mathlibRoot, { onProgress = null, reportEvery = 500 } = {}) {
    const decls = new Map();
    const moduleBasenames = new Map(); // basename → shortest module path
    const files = [];
    const t0 = Date.now();

    function walk(dir) {
        let ents;
        try {
            ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of ents) {
            if (e.isDirectory()) walk(path.join(dir, e.name));
            else if (e.name.endsWith('.lean') && e.name !== 'Mathlib.lean') files.push(path.join(dir, e.name));
        }
    }
    walk(mathlibRoot);

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const rel = path.relative(mathlibRoot, file).replace(/\\/g, '/');
        const mod = moduleFromPath(rel);
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const base = rel.split('/').pop().replace(/\.lean$/i, '');
        if (!moduleBasenames.has(base)) moduleBasenames.set(base, mod);
        else {
            const existing = moduleBasenames.get(base);
            if (mod.split('.').length < existing.split('.').length) moduleBasenames.set(base, mod);
        }
        for (const name of scanFile(text)) {
            // On name conflict, the SHORTEST module path wins: the canonical definition lives
            // at the shallowest path (e.g. `Multiset` → Mathlib.Data.Multiset.Defs over the QPF
            // placeholder in Data/QPF/Multivariate/Basic).
            const existing = decls.get(name);
            if (!existing || mod.split('.').length < existing.split('.').length) decls.set(name, mod);
        }
        if (onProgress && (i + 1) % reportEvery === 0) {
            onProgress({ files: i + 1, total: files.length, decls: decls.size, ms: Date.now() - t0 });
        }
    }
    return {
        decls,
        moduleBasenames,
        stats: { files: files.length, decls: decls.size, modules: moduleBasenames.size, builtMs: Date.now() - t0 }
    };
}

// Query the index. Returns { symbol, module, tier } or null.
// Tier 1: exact full-name match (e.g. `Set.Infinite` → Mathlib.Data.Finite.Defs).
// Tier 2: the module-basename convention — for UNQUALIFIED queries first (a declaration ending
//   in `.Even` like `Even.all` is a false friend; `Algebra/Group/Even.lean` is the intended
//   signal for to_additive-generated names with no source line), and for qualified queries as
//   the fallback when no last-segment declaration exists.
// Tier 3: last-segment declaration matches (`*.Prime` for `Prime`).
export function querySymbolIndex(index, token) {
    if (!index) return null;
    const t = String(token ?? '').trim();
    if (!t) return null;
    if (index.decls.has(t)) return { symbol: t, module: index.decls.get(t), tier: 1 };

    const lastSeg = t.split('.').pop();
    const matches = [];
    for (const [name, mod] of index.decls) {
        if (name === lastSeg || name.endsWith('.' + lastSeg)) matches.push({ name, mod });
    }
    const byBase = index.moduleBasenames.get(lastSeg);

    if (!t.includes('.')) {
        // Unqualified: the basename convention is the intended signal (to_additive names like
        // `Even` have no declaration line; the file named after them is the defining module).
        if (byBase) return { symbol: t, module: byBase, tier: 2 };
        if (matches.length) {
            matches.sort((a, b) => a.name.split('.').length - b.name.split('.').length || (a.name < b.name ? -1 : 1));
            return { symbol: matches[0].name, module: matches[0].mod, tier: 3 };
        }
        return null;
    }

    // Qualified: prefer last-segment declarations whose module basename matches the segment
    // (the `Finset.card`-style affinity), then any last-segment match, then the basename module.
    matches.sort((a, b) => {
        const sa = a.mod.split('.').pop() === lastSeg ? 0 : 1;
        const sb = b.mod.split('.').pop() === lastSeg ? 0 : 1;
        return sa - sb || a.name.split('.').length - b.name.split('.').length || (a.name < b.name ? -1 : 1);
    });
    if (matches.length) return { symbol: matches[0].name, module: matches[0].mod, tier: 3 };
    if (byBase) return { symbol: t, module: byBase, tier: 2 };
    return null;
}

// JSON round-trip (decls/moduleBasenames are Maps → plain objects on disk).
export function serializeIndex(index) {
    return {
        builtAt: new Date().toISOString(),
        stats: index.stats,
        decls: Object.fromEntries(index.decls),
        moduleBasenames: Object.fromEntries(index.moduleBasenames)
    };
}

export function deserializeIndex(json) {
    if (!json || typeof json !== 'object') return null;
    if (!json.decls || !json.moduleBasenames) return null;
    return {
        decls: new Map(Object.entries(json.decls)),
        moduleBasenames: new Map(Object.entries(json.moduleBasenames)),
        stats: json.stats ?? null
    };
}

export function saveSymbolIndex(index, cacheFile) {
    fs.mkdirSync(path.dirname(path.resolve(cacheFile)), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(serializeIndex(index), null, 1), 'utf8');
    return cacheFile;
}

export function loadSymbolIndex(cacheFile) {
    try {
        if (!fs.existsSync(cacheFile)) return null;
        return deserializeIndex(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    } catch {
        return null;
    }
}
