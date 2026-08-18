// Gap-aware proof assembly (architecture.md §4 assembly audit). The DAG's value is the
// FORWARD-ASSEMBLY CONDITION, not its node count: a branch matters only if its proved leaves
// can be assembled through valid derivation edges back to the original theorem. This module
// rebuilds the entire working DAG into ONE Lean file — the original problem statement as the
// root, every lemma in dependency (topological) order, proved lemmas carrying their proofs,
// unproved ones carrying explicit `sorry` gaps — and submits the whole file to the kernel.
// `sorry` is Lean's announced-and-acknowledged gap: the assembled file typechecks exactly when
// every edge is well-typed and every gap is a declared sorry. The pertinence audit then walks
// the reference graph from the root: any lemma no proved proof references (transitively) is an
// ORPHAN branch — a disconnected subgraph that contributes nothing to assembling the proof.
//
// CLI: node blueprint/assemble.js --problem=<id> --statement-file=<path> [--out=<dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologicalOrder } from './dag.js';
import { hashStatement } from '../lean/pin.js';
import { buildProofSource } from '../core/state.js';
import { extractIdentifiers } from '../search/premises.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Declaration name of a statement (theorem/lemma), or null.
function declName(statement) {
    const m = String(statement ?? '').match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.']*)/);
    return m ? m[1] : null;
}

// One assembled file + the gap inventory + the pertinence audit. Pure over the lemmas array —
// the kernel verification runs in the CLI (and is the caller's authority).
// The assembled file is lean4web-pasteable: imports at top, dependency order, the root LAST.
// The only issues lean4web should raise for the emitted file are the `sorry` warnings —
// anything else is a REAL defect (an ill-typed edge, a duplicate name, a drifted root) and is
// reported, never papered over.
export function assembleGapAnnotated({ lemmas, rootStatement, rootId = null, store = null }) {
    const byId = new Map(lemmas.map(l => [l.id, l]));
    // Ordering constraint: a lemma's declaration must precede every lemma whose PROOF
    // references it — dependency edges alone are not enough (proof-level references without a
    // deps edge produce forward references, which the kernel rejects). Augment the edges with
    // proof-reference ownership, then topologically order the union; fall back to the deps-only
    // order if the augmented graph is cyclic (the kernel then reports the residual defect).
    const ownerByName = new Map();
    for (const l of lemmas) {
        const n = declName(l.statement);
        if (n && !ownerByName.has(n)) ownerByName.set(n, l.id);
    }
    const augmented = lemmas.map(l => {
        const extra = new Set();
        if (l.proof) {
            for (const id of extractIdentifiers(String(l.proof))) {
                const o = ownerByName.get(id);
                if (o && o !== l.id) extra.add(o);
            }
        }
        return { id: l.id, deps: [...new Set([...(l.deps ?? []), ...extra])] };
    });
    const order = topologicalOrder(augmented) ?? topologicalOrder(lemmas);
    if (!order) throw new Error('assemble: dependency DAG is cyclic — nothing coherent to assemble');

    const rootLemma = rootId ? byId.get(rootId) : lemmas.find(l => l.id === hashStatement(rootStatement));
    if (!rootLemma) throw new Error('assemble: root lemma not found in the DAG');
    if (hashStatement(rootLemma.statement) !== hashStatement(rootStatement)) {
        throw new Error('assemble: root statement drifted from the mission statement');
    }

    // Imports: the union of every lemma's import lines, in first-seen order.
    const imports = new Set();
    for (const l of lemmas) {
        for (const line of String(l.statement ?? '').split(/\r?\n/)) {
            if (/^\s*import\s+\S/.test(line)) imports.add(line.trim());
        }
    }

    // Duplicate declaration names: Lean rejects a file with two same-named declarations. The
    // DAG can hold them (each lemma verified in isolation), so the assembly renames later
    // duplicates deterministically and reports the rename — a rename is a surface-level edit
    // only; the kernel's verdict on the assembled file stays the authority.
    const seenNames = new Map();
    const renamed = [];
    const nameFor = (l) => {
        const n = declName(l.statement);
        if (!n) return null;
        if (!seenNames.has(n)) { seenNames.set(n, 1); return n; }
        const k = seenNames.get(n) + 1;
        seenNames.set(n, k);
        const fresh = `${n}_v${k}`;
        // A PROVED duplicate's rename is a reference-ambiguity hazard: any proof referencing
        // the name resolves to the FIRST declaration in file order — if the referent meant the
        // renamed one, the kernel flags a type mismatch on the assembled file (reported, never
        // masked). Unproved duplicates rename freely (sorries reference nothing).
        renamed.push({ id: l.id, from: n, to: fresh, proved: !!l.proof, ambiguityHazard: !!l.proof });
        return fresh;
    };

    // Pertinence walk FIRST (structure drives emission, not the other way around): backward
    // reachability from the ROOT over dependency edges AND proof-script references. Every
    // pertinent lemma gets { depth } = distance from the root; everything else is an orphan
    // branch. Also compute usedBy (which lemmas reference this one) for the annotation cues.
    const stripImports = (s) => String(s).split(/\r?\n/).filter(l => !/^\s*import\s+\S/.test(l)).join('\n');
    const nameById = new Map();
    for (const l of lemmas) {
        const n = declName(l.statement);
        if (n) nameById.set(l.id, n);
    }
    const usedBy = new Map();
    for (const l of lemmas) usedBy.set(l.id, new Set());
    for (const l of lemmas) {
        const ownerName = declName(l.statement);
        const refs = new Set([...(l.deps ?? [])]);
        if (l.proof) {
            for (const id of extractIdentifiers(String(l.proof))) refs.add(id);
        }
        for (const [cid, cname] of nameById) {
            if (refs.has(cname) && ownerName && ownerName !== cname) {
                usedBy.get(cid)?.add(ownerName);
            }
        }
    }
    for (const [id, s] of usedBy) usedBy.set(id, [...s]);
    const pertinent = new Map([[rootLemma.id, { depth: 0 }]]);
    let frontier = [rootLemma.id];
    let depth = 0;
    while (frontier.length) {
        depth++;
        const next = [];
        for (const lid of frontier) {
            const l = byId.get(lid);
            if (!l) continue;
            const targets = new Set([...(l.deps ?? [])]);
            if (l.proof) {
                for (const id of extractIdentifiers(String(l.proof))) {
                    for (const [candId, candName] of nameById) {
                        if (candName === id) targets.add(candId);
                    }
                }
            }
            for (const t of targets) {
                if (!pertinent.has(t) && byId.has(t)) {
                    pertinent.set(t, { depth });
                    next.push(t);
                }
            }
        }
        frontier = next;
    }

    // ---- Structured emission: the file reads as the proof plan, not a findings list. ----
    const sections = [];
    const banner = (text) => `/- ${text} -/`;
    const gaps = [];
    const emitLemma = (l, { isRoot = false, isOrphan = false } = {}) => {
        const name = nameFor(l);
        let stmt = stripImports(l.statement.trim());
        if (name && name !== declName(l.statement)) {
            stmt = stmt.replace(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.']*)/, `theorem ${name}`);
        }
        const d = isRoot ? 0 : (pertinent.get(l.id)?.depth ?? null);
        const users = usedBy.get(l.id) ?? [];
        const role = isRoot
            ? `ROOT — the mission statement; everything above assembles forward into this`
            : (l.proof
                ? `[depth ${d}] ${name} — used by: ${users.length ? users.join(', ') : '(nothing yet — near the frontier)'}`
                : `[depth ${d}] GAP (sorry) ${name} — needed by: ${users.length ? users.join(', ') : '(no current users — pending parent re-split)'}`);
        sections.push(banner(role), l.proof ? buildProofSource(stmt, l.proof) : stmt);
        if (!l.proof) {
            gaps.push({ id: l.id, name, statement: stmt, stalled: !!l.stalled, root: !!isRoot, depth: d, usedBy: users });
        }
    };

    sections.push(banner('==============================================================================='));
    sections.push(banner('GAP-ANNOTATED PROOF ASSEMBLY — the whole working DAG, structured as a derivation'));
    sections.push(banner(`root: ${declName(rootLemma.statement)}`));
    sections.push(banner(`proved ${lemmas.filter(l => l.proof).length}/${lemmas.length} — gaps (sorries): every unproved lemma below`));
    sections.push(banner('reading order: dependency order, leaves first, the ROOT last — every declaration'));
    sections.push(banner('is annotated with its distance to the root and the lemmas that use it.'));
    sections.push(banner('every `sorry` below is an ACKNOWLEDGED gap — the ONLY open points this file'));
    sections.push(banner('should present to the kernel.'));
    sections.push(banner('==============================================================================='));

    for (const id of order) {
        const l = byId.get(id);
        if (!l || id === rootLemma.id || !pertinent.has(id)) continue;
        emitLemma(l);
    }
    sections.push(banner('==============================================================================='));
    sections.push(banner('ROOT — the mission statement. Everything above assembles forward into this.'));
    sections.push(banner('==============================================================================='));
    emitLemma(rootLemma, { isRoot: true });

    const orphanIds = order.filter(id => id !== rootLemma.id && !pertinent.has(id));
    if (orphanIds.length) {
        sections.push(banner('==============================================================================='));
        sections.push(banner(`ORPHAN BRANCHES (${orphanIds.length}) — no derivation path to the root. Assembled for`));
        sections.push(banner('typechecking completeness only; they are NOT part of the proof plan.'));
        sections.push(banner('==============================================================================='));
        for (const id of orphanIds) emitLemma(byId.get(id), { isOrphan: true });
    }

    // Closure appendix: names referenced by reuse-proved lemmas whose declarations live only in
    // the store (not the DAG). Recursively appended, deduped against names already declared.
    const declaredHere = new Set(seenNames.keys());
    let appendix = [];
    if (store && typeof store.get === 'function') {
        const all = typeof store.list === 'function' ? store.list() : [];
        const byName = new Map();
        for (const e of all) {
            const n = declName(e?.statement ?? '');
            if (n && !byName.has(n)) byName.set(n, e);
        }
        const referenced = () => {
            const names = new Set();
            for (const part of [...sections, ...appendix]) {
                for (const id of extractIdentifiers(String(part))) names.add(id);
            }
            return names;
        };
        let guard = 0;
        for (;;) {
            if (guard++ > 50) break;
            const missing = [...referenced()].filter(n => !declaredHere.has(n) && byName.has(n));
            if (!missing.length) break;
            for (const n of missing) {
                const entry = byName.get(n);
                if (!entry?.proofScript || String(entry.proofScript).includes('sorry')) continue;
                try {
                    appendix.push(stripImports(buildProofSource(entry.statement, entry.proofScript)));
                    declaredHere.add(n);
                } catch { /* malformed store entry — the kernel reports the residual error */ }
            }
        }
    }
    if (appendix.length) {
        sections.push(banner('==============================================================================='));
        sections.push(banner('CLOSURE APPENDIX — store declarations referenced by reuse-proved lemmas above.'));
        sections.push(banner('==============================================================================='));
        for (const decl of appendix) sections.push(decl);
    }

    const source = `${[...imports].join('\n')}\n\n${sections.join('\n\n')}\n`;

    const orphans = orphanIds
        .map(id => { const l = byId.get(id); return { id: l.id, name: declName(l.statement), proved: !!l.proof, stalled: !!l.stalled, statement: l.statement.split('\n').pop() }; });

    return {
        source,
        rootId: rootLemma.id,
        rootName: declName(rootLemma.statement),
        imports: [...imports],
        lemmaCount: lemmas.length,
        provedCount: lemmas.filter(l => l.proof).length,
        gapCount: gaps.length,
        gaps,
        orphans,
        orphanCount: orphans.length,
        pertinentCount: pertinent.size,
        renamed,
        maxDepth: Math.max(0, ...[...pertinent.values()].map(v => v.depth ?? 0)),
        allProved: gaps.length === 0,
        lean4webNote: 'paste assembled.lean into https://live.lean-lang.org/ — the ONLY issues raised should be the sorry warnings (yellow). Any red error is a real defect: an ill-typed edge, a duplicate-name conflict, or a drifted root statement.'
    };
}

async function main() {
    const { loadEnv } = await import('../env.js');
    const { createBackend } = await import('../lean/backend.js');
    const ENV = loadEnv();
    const args = process.argv.slice(2);
    const pick = (p) => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };
    const problem = pick('--problem=');
    const statementFile = pick('--statement-file=');
    const outDir = pick('--out=');
    if (!problem || !statementFile) {
        console.error('usage: node blueprint/assemble.js --problem=<id> --statement-file=<path> [--out=<dir>]');
        process.exit(2);
    }
    const rootStatement = fs.readFileSync(statementFile, 'utf8').trim();
    const checkpointPath = path.join(PACKAGE_ROOT, '..', 'runs', problem, 'checkpoint.json');
    const ck = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const { LemmaStore } = await import('../growth/lemmaStore.js');
    const store = new LemmaStore({ dir: path.join(PACKAGE_ROOT, '..', 'runs', 'lemma-store') });
    const report = assembleGapAnnotated({ lemmas: ck.lemmas, rootStatement, store });

    const backend = createBackend({
        type: 'repl',
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 2,
        timeoutMs: 600_000
    });
    try {
        const check = await backend.check(report.source, { useWarmEnv: false, timeoutMs: 600_000 });
        report.kernelStatus = check.status;
        report.kernelError = check.status !== 'verified' ? (check.error?.message ?? 'verification failed') : null;
    } finally {
        await backend.shutdown(3000);
    }

    console.log(`assembled: ${report.lemmaCount} lemmas | proved ${report.provedCount} | gaps ${report.gapCount} | orphans ${report.orphanCount} | kernel: ${report.kernelStatus}`);
    if (report.orphanCount) {
        console.log('orphan branches (no assembly path to the root):');
        for (const o of report.orphans) console.log(`  ${o.id.slice(0, 10)}… ${o.name ?? '(anon)'} proved=${o.proved} stalled=${o.stalled} :: ${String(o.statement).slice(0, 60)}`);
    }
    if (report.gapCount) {
        console.log('acknowledged gaps (sorry sites):');
        for (const g of report.gaps) console.log(`  ${g.id.slice(0, 10)}… ${g.name ?? '(anon)'}${g.root ? ' (ROOT)' : ''}`);
    }

    if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'assembled.lean'), report.source, 'utf8');
        fs.writeFileSync(path.join(outDir, 'assembly-report.json'), JSON.stringify(report, null, 2), 'utf8');
        console.log(`written -> ${outDir}`);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('blueprint/assemble.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
