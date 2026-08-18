import fs from 'node:fs';

const p = './blueprint/refine.js';
const t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 1. Import the gate helpers.
if (!t.includes("import { falsifyCandidate } from './falsify.js';")) {
    throw new Error('falsify import missing');
}
const importFix = t.split("import { falsifyCandidate } from './falsify.js';")
    .join("import { falsifyCandidate, isFalsifiableStatement } from './falsify.js';");

// 2. Per-pass state next to the other loop locals.
const anchor2 = '        const inFlight = new Set();';
const stateBlock = [
    '        const inFlight = new Set();',
    '        const falsifiedEvidence = []; // accumulated across the pass: kernel-verified falsifications',
    '        const falsifiedChecked = new Set(); // stubs already gate-checked this pass'
].join('\n');
if (!importFix.includes(anchor2)) throw new Error('anchor2 missing');
const t2 = importFix.split(anchor2).join(stateBlock);

// 3. Attempt-entry falsification: before the reuse fast-path, gate the stub itself.
const anchor3 = '        const stmtHash = hashStatement(stub.statement);\n        const reused = this.lemmaStore?.get(stmtHash);';
if (!t2.includes(anchor3)) throw new Error('anchor3 missing');
const gateBlock = [
    '        const stmtHash = hashStatement(stub.statement);',
    '        // Attempt-entry falsification: a stub that survived into the DAG (resumed from an',
    '        // older run, or a child of an older decomposition) is itself gated before any',
    '        // search — a kernel-verified counterexample prunes it and the evidence feeds its',
    '        // parent\'s re-split. Memoized per pass.',
    '        if (this.loopOptions.falsify && !stub.proof && !falsifiedChecked.has(stub.id) && isFalsifiableStatement(stub.statement)) {',
    '            falsifiedChecked.add(stub.id);',
    '            const verdict = await falsifyCandidate(stub.statement, { llm: this.llm, backend: this.backend, maxInstances: this.loopOptions.falsifyMaxInstances ?? 6 });',
    '            if (verdict.falsified) {',
    '                console.log(`[refine]   FALSIFIED stub ${stub.id.slice(0, 10)}… by kernel counterexample: ${verdict.counterexample}`);',
    '                return { proved: false, resplit: false, added: 0, children: [], falsified: true, counterexample: verdict.counterexample };',
    '            }',
    '        }',
    '        const reused = this.lemmaStore?.get(stmtHash);'
].join('\n');
const t3 = t2.split(anchor3).join(gateBlock);

// 4. Thread the evidence array into the re-split skeleton calls.
const oldGen = 'const sub = opts.resplitAllowed !== false\n            ? await this.skeleton.generate(stub.statement, opts.retry ? { priorChildren, falsify: falsifyGate } : { falsify: falsifyGate })';
if (!t3.includes(oldGen)) throw new Error('gen call missing');
const newGen = 'const sub = opts.resplitAllowed !== false\n            ? await this.skeleton.generate(stub.statement, { priorChildren, falsify: falsifyGate, falsifiedEvidence: this._falsifiedEvidence ?? [] })';
const t4 = t3.split(oldGen).join(newGen);

// 5. Merge handling: on r.falsified, prune the stub and record the evidence.
const anchor5 = '                const addedNow = Math.max(0, working.lemmas.length - before);';
if (!t4.includes(anchor5)) throw new Error('anchor5 missing');
const pruneBlock = [
    '                if (r.falsified) {',
    '                    this._falsifiedEvidence = this._falsifiedEvidence ?? [];',
    '                    this._falsifiedEvidence.push({ name: declNameOf(stub.statement), statement: stub.statement, counterexample: r.counterexample });',
    '                    const idx = working.lemmas.indexOf(stub);',
    '                    if (idx !== -1) working.lemmas.splice(idx, 1);',
    '                    for (const l of working.lemmas) {',
    '                        l.deps = (l.deps ?? []).filter(d => d !== stub.id);',
    '                    }',
    '                    console.log(`[refine]   pruned falsified stub ${stub.id.slice(0, 10)}…; evidence recorded for parent re-splits`);',
    '                }',
    '                const addedNow = Math.max(0, working.lemmas.length - before);'
].join('\n');
const t5 = t4.split(anchor5).join(pruneBlock);

// 6. declNameOf helper (avoid importing across modules).
const helperAnchor = 'export function repairCycles(lemmas) {';
if (!t5.includes(helperAnchor)) throw new Error('helper anchor missing');
const helper = [
    'function declNameOf(statement) {',
    '    const m = String(statement ?? "").match(/^(?:theorem|lemma)\\s+([A-Za-z_][A-Za-z0-9_.\']*)/m);',
    '    return m ? m[1] : null;',
    '}',
    '',
    'export function repairCycles(lemmas) {'
].join('\n');
const t6 = t5.split(helperAnchor).join(helper);

fs.writeFileSync(p, t6, 'utf8');
console.log('refine patched');
