// Module resolver (architecture.md §0.1, build_order.md §7.1).
// The LLM proposes imports that may be stale or directory-alias paths (e.g.
// `Mathlib.Data.Nat.Prime` maps to a DIRECTORY in v4.33.0-rc1, not a module). The resolver maps a
// proposed module path to the actual `.lean` file in the installed mathlib checkout, preferring
// `Defs`/`Basic`/`Init` variants when the exact path is a directory or missing.
//
// Grounded, not guessed: it scans the real mathlib source tree under the pinned lean-project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MATHLIB_SRC = path.join(PACKAGE_ROOT, '..', 'lean-project', '.lake', 'packages', 'mathlib', 'Mathlib');

// Preferred fallback file names within a module directory, in order.
const FALLBACKS = ['Defs', 'Basic', 'Init', 'Core'];

function moduleToRelPath(mod) {
    return String(mod ?? '').replace(/^Mathlib\./, '').replace(/\./g, '/');
}

function fileExists(rel) {
    return fs.existsSync(path.join(MATHLIB_SRC, `${rel}.lean`));
}

// Resolve a proposed import to a module that actually exists in the pinned mathlib.
// Returns null when no candidate exists (caller reports it as an unresolvable import).
export function resolveModule(proposed) {
    const mod = String(proposed ?? '').trim();
    if (!mod) return null;
    // `Mathlib` (the whole library) is a real top-level module.
    if (mod === 'Mathlib') return 'Mathlib';
    // Exact module file exists → use as-is.
    const exact = moduleToRelPath(mod);
    if (fileExists(exact)) return mod;

    // Maybe the module is a directory: try <dir>.<Fallback> for each preferred fallback.
    const dir = path.join(MATHLIB_SRC, exact);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        for (const fb of FALLBACKS) {
            const cand = `${mod}.${fb}`;
            if (fileExists(moduleToRelPath(cand))) return cand;
        }
    }

    // Maybe a sibling/parent variant: strip the last segment and try parent.<segment> or
    // parent.<last>.<Fallback> (e.g. Mathlib.Data.Nat.Prime → Mathlib.Data.Nat.Prime.Defs already
    // covered above; also try Mathlib.Data.Nat.PrimeBasic style: keep grounded, try the last
    // segment as a submodule of the parent).
    const dot = mod.lastIndexOf('.');
    if (dot > 0) {
        const parent = mod.slice(0, dot);
        const leaf = mod.slice(dot + 1);
        const candidates = [
            `${parent}.${leaf}`,       // exact (already tried)
            `${parent}.${leaf}Defs`,
            `${parent}.${leaf}Basic`,
            `${parent}.${leaf}Init`,
            `${parent}.${leaf}Core`
        ];
        for (const cand of candidates) {
            if (fileExists(moduleToRelPath(cand))) return cand;
        }
    }

    // CamelCase-segment split: `GroupPower` → `Group.Power` (mathlib splits compound module
    // names into directories). Try every split point of the final segment.
    const lastSeg = mod.slice(mod.lastIndexOf('.') + 1);
    if (lastSeg.length > 2) {
        for (let i = 1; i < lastSeg.length; i++) {
            const a = lastSeg.slice(0, i), b = lastSeg.slice(i);
            if (!/^[A-Z]/.test(b)) continue; // split only before an uppercase
            const parent = dot > 0 ? mod.slice(0, dot + 1) : '';
            const cand = `${parent}${a}.${b}`;
            if (fileExists(moduleToRelPath(cand))) return cand;
            for (const fb of FALLBACKS) {
                const c2 = `${cand}.${fb}`;
                if (fileExists(moduleToRelPath(c2))) return c2;
            }
        }
    }
    return null;
}

// Resolve an array of proposed imports; drops unresolvable ones (returning the resolvable set).
export function resolveImports(imports) {
    const out = [];
    const seen = new Set();
    for (const imp of imports ?? []) {
        const r = resolveModule(imp);
        if (r && !seen.has(r)) { out.push(r); seen.add(r); }
    }
    return out;
}
