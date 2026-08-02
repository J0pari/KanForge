// Smoke harness: run the 20-problem set (bench/smoke.js) through the REAL loop (MinimalLoop over a
// real backend + real LLM) and report per-problem outcomes, tactic families, and pass@8.
// CLI: node bench/run.js [id...]  — optional problem-id filter for quick smoke runs.

import { MinimalLoop, buildLemmaId } from '../agent/loop.js';
import { SMOKE_PROBLEMS, tacticFamily, validateSmokeSet } from './smoke.js';

export async function runSmokeSet({ backend, llm, problems = SMOKE_PROBLEMS, concurrency = 2, attemptsPerLemma = 8, timeoutMs = 300_000, maxTokens = 512, onEvent = null } = {}) {
    if (!backend || !llm) throw new Error('runSmokeSet requires a real backend and a real llm client');
    validateSmokeSet(problems);

    const loop = new MinimalLoop({
        backend,
        llm,
        concurrency,
        attemptsPerLemma,
        timeoutMs,
        maxTokens,
        stopAfterFailures: null, // pass@N needs every problem attempted, no early stop
        onEvent: onEvent ?? (e => console.log(`[smoke] ${JSON.stringify(e)}`))
    });

    for (const p of problems) loop.addLemma(p.statement, { context: p.context });

    const t0 = Date.now();
    const outcome = await loop.proveAll();
    const wallMs = Date.now() - t0;

    const byId = new Map(problems.map(p => [buildLemmaId(p.statement), p]));
    const results = [];
    const seen = new Set();
    for (const e of loop.events()) {
        if (e.type !== 'lemma_verified' && e.type !== 'lemma_failed') continue;
        if (seen.has(e.nodeId)) continue;
        seen.add(e.nodeId);
        const p = byId.get(e.nodeId);
        if (!p) continue;
        if (e.type === 'lemma_verified') {
            results.push({ id: p.id, tier: p.tier, solved: true, attempts: e.attempts, ms: e.ms, form: e.form, proof: e.proof, family: tacticFamily(e.proof) });
        } else {
            results.push({ id: p.id, tier: p.tier, solved: false, attempts: e.attempts, ms: e.ms, family: '—', error: e.lastError });
        }
    }

    const solved = results.filter(r => r.solved);
    const accounted = new Set(results.map(r => r.id));
    // Completeness: a lemma abandoned by the scheduler (kill-on-hang timeout, stop budget) may
    // lack a terminal event in the trace — it must still be counted, never vanish from the report.
    for (const p of problems) {
        if (!accounted.has(p.id)) {
            results.push({ id: p.id, tier: p.tier, solved: false, attempts: 0, ms: null, family: '—', error: 'no terminal event (lemma abandoned by scheduler timeout/stop)' });
        }
    }
    const families = [...new Set(solved.map(r => r.family))].sort();
    const tier2Plus = solved.filter(r => r.tier >= 2).length;
    const summary = {
        problems: results,
        solved: solved.length,
        total: results.length,
        pass8: results.length ? solved.length / results.length : 0,
        distinctFamilies: families.length,
        families,
        tier2Plus,
        wallMs,
        outcome,
        loop: loop.getInfos()
    };
    return summary;
}

export function printSmokeSummary(s) {
    console.log('\n===== SMOKE SET RESULTS =====');
    for (const r of s.problems) {
        const ok = r.solved ? 'OK  ' : 'FAIL';
        const family = r.solved ? `[${r.family}]` : `[${r.error?.slice(0, 60) ?? 'failed'}]`;
        console.log(`${ok} t${r.tier} ${r.id.padEnd(14)} attempts=${r.attempts} ms=${r.ms} ${family}`);
        if (r.solved) console.log(`      proof: ${r.proof}`);
    }
    console.log(`\npass@8: ${s.solved}/${s.total} (${(s.pass8 * 100).toFixed(1)}%), families used: ${s.families.join(', ') || '(none)'}, tier>=2 solved: ${s.tier2Plus}, wall: ${(s.wallMs / 1000).toFixed(0)}s`);
    console.log(`llmCalls=${s.loop.llmCalls} verifyCalls=${s.loop.verifyCalls} pool=${JSON.stringify(s.loop.backend)}`);
}

async function main() {
    const { BackendRepl } = await import('../lean/backendRepl.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { ENV } = await import('../test/loadEnv.js');

    const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const problems = ids.length ? SMOKE_PROBLEMS.filter(p => ids.includes(p.id)) : SMOKE_PROBLEMS;
    if (ids.length && problems.length !== ids.length) {
        const known = SMOKE_PROBLEMS.map(p => p.id).join(', ');
        console.error(`unknown problem id; known ids: ${known}`);
        process.exit(2);
    }
    // Local/CPU-only backends are RAM-limited: let the operator cap parallelism and attempts.
    const concurrency = Number(process.env.KANFORGE_SMOKE_CONCURRENCY ?? 2);
    const attempts = Number(process.env.KANFORGE_SMOKE_ATTEMPTS ?? 8);

    const pool = new BackendRepl({
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        concurrency,
        timeoutMs: 60_000
    });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    try {
        const s = await runSmokeSet({ backend: pool, llm, problems, concurrency, attemptsPerLemma: attempts });
        printSmokeSummary(s);
    } finally {
        await pool.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/run.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
