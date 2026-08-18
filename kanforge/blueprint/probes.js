// Probe generation (architecture.md §0.1 instance ledger): a mission statement may not enter
// the pipeline without kernel-verified instance probes. This tool produces them — first from
// the source's own test-category theorems when a FormalConjectures file exists (those ARE the
// ledger), else via LLM-proposed instances kernel-verified through `decide` (the falsification
// machinery's instance discipline, applied at intake).
//
// CLI: node blueprint/probes.js --statement-file=<path> [--fc-file=<path>] --out=<probes.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

// The set literal from the mission statement (`Set.Infinite { ... }`) — instance probes
// evaluate membership against exactly this set, with the same imports.
export function extractSetLiteral(statement) {
    const m = String(statement ?? '').match(/Set\.Infinite\s*(\{[\s\S]*?\})(?=\s*:=|$)/);
    return m ? m[1] : null;
}

// Test-category theorems from a FormalConjectures source file (the intake ledger): each
// membership claim `<term> ∈ <SetName>` or `∉` becomes a probe instance against the mission's
// set literal — kernel-decidable for small numerals.
export function extractTestInstances(fcText) {
    const out = [];
    for (const m of String(fcText ?? '').matchAll(/theorem\s+\w+\s*:\s*(\d+)\s*(∈|∉)\s*([A-Za-z0-9_.']+)/g)) {
        out.push({ n: m[1], kind: m[2], setName: m[3] });
    }
    return out;
}

// Build the probe examples for a mission statement + instance list. Each probe is a decidable
// `example` carrying the mission's imports — the kernel verifies membership mechanically.
export function buildProbeExamples(statement, instances) {
    const imports = String(statement).split(/\r?\n/).filter(l => /^\s*import\s+\S/.test(l)).join('\n');
    const setLit = extractSetLiteral(statement);
    const probes = [];
    for (const inst of instances) {
        if (!setLit) break;
        const op = inst.kind === '∉' ? '∉' : '∈';
        probes.push({
            instance: `${inst.n} ${op} <set>`,
            source: `${imports}\n\nexample : (${inst.n} : Nat) ${op} ${setLit} := by decide`,
            expected: true
        });
    }
    return probes;
}

// Verify probes against the backend; every one must pass for the mission to be runnable.
export async function verifyProbes(probes, backend) {
    const results = [];
    for (const p of probes) {
        let status = 'error';
        let error = null;
        try {
            const r = await backend.check(p.source, { useWarmEnv: false });
            status = r.status;
            if (r.status !== 'verified') error = r.error?.message ?? 'verification failed';
        } catch (err) {
            error = String(err?.message ?? err);
        }
        results.push({ instance: p.instance, status, error });
    }
    return results;
}

export async function buildAndVerifyProbes({ statement, fcText = null, backend, llm = null }) {
    const instances = fcText ? extractTestInstances(fcText) : [];
    let probes = buildProbeExamples(statement, instances);
    if (!probes.length && llm) {
        // LLM instance generation (candidate generation only; the kernel decides).
        const setLit = extractSetLiteral(statement);
        if (setLit) {
            const imports = String(statement).split(/\r?\n/).filter(l => /^\s*import\s+\S/.test(l)).join('\n');
            const prompt = [
                { role: 'system', content: 'You are a Lean 4 proof engineer. Given a `Set.Infinite { n : Nat | P n }` statement, list 4-6 SMALL natural numbers (0-6) and whether each is in the set, as decidable examples. Reply with ONLY lines of the form `example : (1 : Nat) ∈ { n : Nat | P n } := by decide` or with ∉. Use the set literal VERBATIM.' },
                { role: 'user', content: `Statement:\n${statement}\n\nThe set literal is:\n${setLit}\n\nReturn the example lines.` }
            ];
            try {
                const r = await llm.complete(prompt);
                for (const line of String(r?.text ?? '').split(/\r?\n/)) {
                    const m = line.match(/^\s*example\s*:\s*\((\d+)\s*:\s*Nat\)\s*(∈|∉)\s*(\{[\s\S]*?\})\s*:=\s*by\s*decide\s*$/);
                    if (m) probes.push({ instance: `${m[1]} ${m[2]} <set>`, source: `${imports}\n\nexample : (${m[1]} : Nat) ${m[2]} ${m[3]} := by decide`, expected: true });
                }
            } catch { /* LLM failure -> no probes; the gate will refuse the mission */ }
        }
    }
    const results = await verifyProbes(probes, backend);
    return { probes, results, allVerified: results.length > 0 && results.every(r => r.status === 'verified') };
}

async function main() {
    const { loadEnv } = await import('../env.js');
    const { createBackend } = await import('../lean/backend.js');
    const ENV = loadEnv();
    const args = process.argv.slice(2);
    const pick = (p) => { const a = args.find(x => x.startsWith(p)); return a ? a.slice(p.length) : null; };
    const statementFile = pick('--statement-file=');
    const fcFile = pick('--fc-file=');
    const out = pick('--out=');
    if (!statementFile || !out) {
        console.error('usage: node blueprint/probes.js --statement-file=<path> [--fc-file=<path>] --out=<probes.json>');
        process.exit(2);
    }
    const statement = fs.readFileSync(statementFile, 'utf8').trim();
    const fcText = fcFile && fs.existsSync(fcFile) ? fs.readFileSync(fcFile, 'utf8') : null;
    const backend = createBackend({
        type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency: 2, timeoutMs: 300_000
    });
    try {
        const r = await buildAndVerifyProbes({ statement, fcText, backend });
        for (const res of r.results) console.log(`${res.status === 'verified' ? 'PASS' : 'FAIL'}  ${res.instance}${res.error ? '  (' + res.error.slice(0, 80) + ')' : ''}`);
        if (!r.allVerified) {
            console.error(`probes did not all verify (${r.results.filter(x => x.status === 'verified').length}/${r.results.length}) — the mission may not enter the pipeline`);
            process.exit(1);
        }
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ statement, statementHash: null, probes: r.results.map(x => ({ instance: x.instance, status: x.status })), generatedAt: new Date().toISOString() }, null, 2), 'utf8');
        console.log(`probes verified and written -> ${out}`);
    } finally {
        await backend.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('blueprint/probes.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
