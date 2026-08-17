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
export function assembleGapAnnotated({ lemmas, rootStatement, rootId = null }) {
    const byId = new Map(lemmas.map(l => [l.id, l]));
    const order = topologicalOrder(lemmas);
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
        renamed.push({ id: l.id, from: n, to: fresh });
        return fresh;
    };

    // Body: topological order, deps first, root LAST (it is the target, everything feeds it).
    const body = [];
    const gaps = [];
    const emit = (l, isRoot) => {
        const name = nameFor(l);
        let stmt = l.statement.trim();
        if (name && name !== declName(l.statement)) {
            stmt = stmt.replace(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.']*)/, `theorem ${name}`);
        }
        if (l.proof) {
            body.push(buildProofSource(stmt, l.proof));
        } else {
            gaps.push({ id: l.id, name, statement: stmt, stalled: !!l.stalled, root: !!isRoot });
            body.push(stmt);
        }
    };
    for (const id of order) {
        const l = byId.get(id);
        if (!l || id === rootLemma.id) continue;
        emit(l, false);
    }
    emit(rootLemma, true);

    const source = `${[...imports].join('\n')}\n\n${body.join('\n\n')}\n`;

    // Pertinence audit: reference graph over declaration names (who references whom in proof
    // scripts), then reachability from the ROOT backwards to every lemma. A lemma is PERTINENT
    // when the root's assembly path references it (transitively); otherwise it is an orphan
    // branch — a disconnected subgraph with no derivation path to the root.
    const nameById = new Map();
    for (const l of lemmas) {
        const n = declName(l.statement);
        if (n) nameById.set(l.id, n);
    }
    // Backward reachability: start from the root lemma; a lemma is reachable if the root (or a
    // reachable lemma) references its name. The root itself is always pertinent.
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
    const orphans = lemmas
        .filter(l => l.id !== rootLemma.id && !pertinent.has(l.id))
        .map(l => ({ id: l.id, name: declName(l.statement), proved: !!l.proof, stalled: !!l.stalled, statement: l.statement.split('\n').pop() }));

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
    const report = assembleGapAnnotated({ lemmas: ck.lemmas, rootStatement });

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
