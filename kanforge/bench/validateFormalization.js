// Validate the autoformalizer on a corpus candidate (build_order.md §7.1) — the SINGLE
// ingestion path. Prose (or a FormalConjectures source file) → autoformalizer → shortlist
// entry; with --emit-mission, the mission artifacts (statement.txt + the fail-closed probes
// ledger) are written from the SAME entry, so no second ingestion mechanism exists.
//
// Usage:
//   node bench/validateFormalization.js --prose="<prose>" [--instances="a|b"] [--source=<id>] [--emit-mission=<dir>]
//   node bench/validateFormalization.js --fc-file=<path> [--fc-theorem=<name>] [--source=<id>] [--emit-mission=<dir>]
import { loadEnv } from '../env.js';
import { loadLLMConfig, createLLM } from '../agent/llm.js';
import { createBackend } from '../lean/backend.js';
import { Autoformalizer, extractTestInstancesFromFc, instanceStringsFor } from '../agent/roles/autoformalizer.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

const ENV = loadEnv();
const args = process.argv.slice(2);
const argV = (p) => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };

const fcFile = argV('--fc-file=');
const fcTheorem = argV('--fc-theorem=');
const proseArg = argV('--prose=');
const source = argV('--source=') ?? 'manual';
const instances = (argV('--instances=') ?? '').split('|').filter(Boolean);
const emitMission = argV('--emit-mission=');

let prose = proseArg;
let fcInstances = [];
let targetStatement = null;
let fcContext = null;
if (fcFile) {
    const text = fs.readFileSync(fcFile, 'utf8');
    const facts = extractTestInstancesFromFc(text);
    fcInstances = facts;
    // Prose from the target theorem's docstring; default: the first `research solved` theorem.
    const blocks = text.split(/(?=@\[category )/g);
    const target = fcTheorem
        ? blocks.find(b => new RegExp(`theorem\\s+${fcTheorem}`).test(b))
        : blocks.find(b => /research solved/.test(b));
    if (!target) {
        console.error(fcTheorem ? `no theorem named ${fcTheorem} in ${fcFile}` : 'no research-solved theorem found in the fc file');
        process.exit(2);
    }
    const doc = (target.match(/\/--([\s\S]*?)-?\*\//) ?? [])[1] ?? '';
    prose = doc.replace(/\s+/g, ' ').trim() || `the statement of the theorem in ${fcFile}`;
    // Statement grounding: fc-file targets carry the ACTUAL Lean statement. Extract it and hand
    // it to the formalizer so the port is faithful (the prose-only path once formalized the
    // famous open Erdős 10 from this file's solved variant — prose alone is not the statement).
    const stmtMatch = target.match(/theorem\s+([\w.']+)\s*:\s*([\s\S]*?):=\s*by/);
    if (stmtMatch) {
        targetStatement = `theorem ${stmtMatch[1]} : ${stmtMatch[2].replace(/\s+/g, ' ').trim()} := by sorry`;
        // Definition context: the file portion BEFORE the target block (namespace header,
        // imports, and the definitions the statement references) — bounded for prompt size.
        fcContext = text.slice(0, text.indexOf(target)).slice(0, 2500);
    }
}
if (!prose) { console.error('usage: --prose="..." or --fc-file=<path> [--instances=...] [--source=id] [--emit-mission=<dir>]'); process.exit(2); }

const llm = createLLM({ ...loadLLMConfig(ENV), retries: 0 });
const backend = createBackend({
    type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
    leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 300000
});
const af = new Autoformalizer({ llm, backend, checkTimeoutMs: 300000, maxAttempts: 4, onAttempt: a => console.log('[attempt]', JSON.stringify(a)) });

const t0 = Date.now();
const ledger = [...instances, ...instanceStringsFor(fcInstances)];
const r = await af.formalize(prose, { instances: ledger, source, targetStatement, context: fcContext });
console.log(JSON.stringify({ totalSec: +((Date.now() - t0) / 1000).toFixed(1), ok: r.ok }, null, 1));
if (r.ok) {
    console.log('statement:');
    console.log(r.statement);
    console.log('entry:', JSON.stringify({ hash: r.shortlistEntry.statementHash.slice(0, 12), shape: r.shortlistEntry.justification.shape, attempts: r.shortlistEntry.attempts, probes: r.shortlistEntry.probes.length }, null, 1));
    // Persist the shortlist entry — the one intake artifact.
    const dir = path.join(PACKAGE_ROOT, '..', 'corpus', 'shortlist');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${source}.json`);
    fs.writeFileSync(file, JSON.stringify(r.shortlistEntry, null, 2));
    console.log('shortlist entry ->', file);
    // Mission artifacts, written FROM the same entry (no second ingestion path).
    if (emitMission) {
        const missionDir = path.join(PACKAGE_ROOT, '..', 'runs', emitMission);
        fs.mkdirSync(missionDir, { recursive: true });
        fs.writeFileSync(path.join(missionDir, 'statement.txt'), r.statement + '\n', 'utf8');
        const probesLedger = {
            statement: r.statement,
            statementHash: r.shortlistEntry.statementHash,
            probes: r.shortlistEntry.probes.map(p => ({ instance: p.instance, status: p.verified ? 'verified' : 'unverified' })),
            generatedAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(missionDir, 'probes.json'), JSON.stringify(probesLedger, null, 2), 'utf8');
        console.log(`mission artifacts -> ${missionDir} (statement.txt + probes.json)`);
    }
} else {
    console.log('error:', r.error);
}
await backend.shutdown(3000);
