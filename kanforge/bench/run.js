// Smoke harness: run the 20-problem set (bench/smoke.js) through the REAL tactic-level loop
// (TacticLoop over a real backend + real LLM) and report per-problem outcomes.
// 
// Architecture (architecture.md §2.2, §4):
// - Level 1: Lemma DAG (dependency-ordered dispatch)
// - Level 2: Goal search tree (tactic-level search within each lemma)
//
// Each problem is proved via backward decomposition:
// - Extract the root goal from the statement
// - Work backwards: propose ONE tactic per LLM call, apply it, get subgoals
// - Repeat until all goals are solved (lemma proved)
//
// CLI: node bench/run.js [id...]  — optional problem-id filter for quick smoke runs.

import { TacticLoop } from '../agent/loop.js';
import { SMOKE_PROBLEMS, tacticFamily, validateSmokeSet } from './smoke.js';
import { MATHLIB_PROBLEMS } from './mathlibSmoke.js';

export async function runSmokeSet({ backend, llm, problems = SMOKE_PROBLEMS, concurrency = 2, maxTacticsPerGoal = 8, maxGoalsPerLemma = 100, onEvent = null, checkpointDir = null, resumeFrom = null } = {}) {
    if (!backend || !llm) throw new Error('runSmokeSet requires a real backend and a real llm client');
    validateSmokeSet(problems);

    const loop = new TacticLoop({
        backend,
        llm,
        concurrency,
        maxTacticsPerGoal,
        maxGoalsPerLemma,
        onEvent: onEvent ?? (e => console.log(`[smoke] ${JSON.stringify(e)}`)),
        checkpointDir
    });

    for (const p of problems) loop.addLemma(p.statement);

    // Resume from checkpoint if specified (P2.2)
    if (resumeFrom) {
        const cachedCount = loop.resume(resumeFrom);
        console.log(`[smoke] Resumed from checkpoint: ${cachedCount} cached lemmas`);
    }

    const t0 = Date.now();
    const outcome = await loop.proveAll();
    const wallMs = Date.now() - t0;

    const byId = new Map(problems.map(p => [p.statement, p]));
    const results = [];
    const seen = new Set();
    for (const e of loop.events()) {
        if (e.type !== 'lemma_verified' && e.type !== 'lemma_failed') continue;
        const statement = e.statement;
        const p = byId.get(statement);
        if (!p || seen.has(p.id)) continue;
        seen.add(p.id);
        
        if (e.type === 'lemma_verified') {
            results.push({
                id: p.id,
                tier: p.tier,
                solved: true,
                goalCount: e.goalCount,
                ms: e.ms,
                proofScript: e.proofScript,
                families: extractFamilies(e.proofScript)
            });
        } else {
            results.push({
                id: p.id,
                tier: p.tier,
                solved: false,
                error: e.error
            });
        }
    }

    // Completeness: any problem without a terminal event is marked as failed
    for (const p of problems) {
        if (!seen.has(p.id)) {
            results.push({ id: p.id, tier: p.tier, solved: false, error: 'no terminal event' });
        }
    }

    const solved = results.filter(r => r.solved);
    const allFamilies = [...new Set(solved.flatMap(r => r.families))].sort();
    const tier2Plus = solved.filter(r => r.tier >= 2).length;
    
    const summary = {
        problems: results,
        solved: solved.length,
        total: results.length,
        passRate: results.length ? solved.length / results.length : 0,
        distinctFamilies: allFamilies.length,
        families: allFamilies,
        tier2Plus,
        wallMs,
        outcome,
        loop: loop.getInfos()
    };
    return summary;
}

function extractFamilies(proofScript) {
    // Extract tactic families from the proof script
    const families = new Set();
    const tactics = proofScript.split('\n').map(t => t.trim()).filter(t => t);
    for (const tactic of tactics) {
        const family = tacticFamily(tactic);
        if (family !== 'empty' && family !== 'other') {
            families.add(family);
        }
    }
    return [...families];
}

export function printSmokeSummary(s) {
    console.log('\n===== SMOKE SET RESULTS =====');
    for (const r of s.problems) {
        const ok = r.solved ? 'OK  ' : 'FAIL';
        const detail = r.solved 
            ? `goals=${r.goalCount} families=[${r.families.join(', ')}]`
            : `error: ${r.error}`;
        console.log(`${ok} t${r.tier} ${r.id.padEnd(14)} ms=${r.ms} ${detail}`);
        if (r.solved) {
            console.log(`      proof: ${r.proofScript.split('\n').slice(0, 3).join(' | ')}${r.proofScript.split('\n').length > 3 ? ' ...' : ''}`);
        }
    }
    console.log(`\nSolved: ${s.solved}/${s.total} (${(s.passRate * 100).toFixed(1)}%), families used: ${s.families.join(', ') || '(none)'}, tier>=2 solved: ${s.tier2Plus}, wall: ${(s.wallMs / 1000).toFixed(0)}s`);
    console.log(`llmCalls=${s.loop.llmCalls} tacticCalls=${s.loop.tacticCalls} pool=${JSON.stringify(s.loop.backend)}`);
}

async function main() {
    const { createBackend } = await import('../lean/backend.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

    const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const setArg = process.argv.find(a => a.startsWith('--set='));
    const resumeArg = process.argv.find(a => a.startsWith('--resume='));
    const checkpointArg = process.argv.find(a => a.startsWith('--checkpoint-dir='));

    const set = setArg ? setArg.split('=')[1] : 'core';
    if (set !== 'core' && set !== 'mathlib') {
        console.error('unknown problem set; known sets: core, mathlib');
        process.exit(2);
    }
    const problemsSource = set === 'mathlib' ? MATHLIB_PROBLEMS : SMOKE_PROBLEMS;
    const problems = ids.length ? problemsSource.filter(p => ids.includes(p.id)) : problemsSource;
    if (ids.length && problems.length !== ids.length) {
        const known = problemsSource.map(p => p.id).join(', ');
        console.error(`unknown problem id; known ids: ${known}`);
        process.exit(2);
    }

    const concurrency = Number(process.env.KANFORGE_SMOKE_CONCURRENCY ?? 2);
    const maxTactics = Number(process.env.KANFORGE_SMOKE_MAX_TACTICS ?? 8);
    const maxGoals = Number(process.env.KANFORGE_SMOKE_MAX_GOALS ?? 100);

    const pool = createBackend({
        type: 'repl',
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency,
        // Mathlib imports take 5-35s cold; the core set is near-instant.
        timeoutMs: set === 'mathlib' ? 180_000 : 60_000,
        // Mathlib imports accumulate in the repl until it OOMs; give each problem a fresh process.
        workerPerProblem: set === 'mathlib'
    });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    const checkpointDir = checkpointArg ? checkpointArg.split('=')[1] : null;
    const resumeFrom = resumeArg ? resumeArg.split('=')[1] : null;

    try {
        const s = await runSmokeSet({ backend: pool, llm, problems, concurrency, maxTacticsPerGoal: maxTactics, maxGoalsPerLemma: maxGoals, checkpointDir, resumeFrom });
        printSmokeSummary(s);
    } finally {
        await pool.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/run.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
