// Failure-predictor training harness (build_order.md §5.3).
//
// Runs the REAL tactic-level loop (TacticLoop over a real backend + real LLM) over a problem
// set, keeps the loop's traced event store, mines it with CausalAnalyzer.getFailurePredictors(),
// and writes a predictors JSON that bench/ablation.js consumes via --predictors=<path.json>.
//
// CLI: node bench/trainPredictors.js [--set=core|mathlib|step] [id...] [--window=3]
//                                    [--min-support=2] [--min-confidence=0.5] [--out=<path.json>]
//
// The loop events carry id/t/parent/lemmaId (causal chain), so the mined patterns are grounded
// in what actually failed in this run — the same stream causal.js consumes at inference time.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TacticLoop } from '../agent/loop.js';
import { SMOKE_PROBLEMS, validateSmokeSet } from './smoke.js';
import { MATHLIB_PROBLEMS } from './mathlibSmoke.js';
import { STEP_PROBLEMS } from './stepSmoke.js';
import { CausalAnalyzer } from '../optimization/causal.js';
import { auditTrainerReport } from './reportAudit.js';

export async function trainPredictors({ backend, llm, problems = SMOKE_PROBLEMS, window = 3, minSupport = 2, minConfidence = 0.5 } = {}) {
    if (!backend || !llm) throw new Error('trainPredictors requires a real backend and a real llm client');
    validateSmokeSet(problems);

    const loop = new TacticLoop({
        backend,
        llm,
        concurrency: Number(process.env.KANFORGE_SMOKE_CONCURRENCY ?? 2),
        maxTacticsPerGoal: Number(process.env.KANFORGE_SMOKE_MAX_TACTICS ?? 8),
        maxGoalsPerLemma: Number(process.env.KANFORGE_SMOKE_MAX_GOALS ?? 100),
        onEvent: () => {} // null would fall through to the loop's default console logger
    });

    const lemmaIds = new Map();
    for (const p of problems) lemmaIds.set(p.id, loop.addLemma(p.statement));
    await loop.proveAll();

    const events = loop.events();
    const analyzer = new CausalAnalyzer(events);
    const predictors = analyzer.getFailurePredictors({ window, minSupport, minConfidence });
    const matrix = analyzer.getTransitionMatrix();
    const anomalies = analyzer.getAnomalies();

    const solved = events.filter(e => e.type === 'lemma_verified').length;
    const failed = events.filter(e => e.type === 'lemma_failed').length;

    // Per-lemma outcome summary so the report is self-contained: a human can see exactly which
    // problem verified/failed and how long it took, independent of the raw event store.
    const terminalById = new Map();
    for (const e of events) {
        if (e.type !== 'lemma_verified' && e.type !== 'lemma_failed') continue;
        terminalById.set(e.lemmaId, e);
    }
    const lemmas = problems.map(p => {
        const t = terminalById.get(lemmaIds.get(p.id));
        return {
            id: p.id,
            lemmaId: lemmaIds.get(p.id),
            outcome: t ? (t.type === 'lemma_verified' ? 'verified' : 'failed') : 'none',
            ms: t?.ms ?? null,
            error: t?.error ?? null
        };
    });

    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            window, minSupport, minConfidence, maxConfidence: 0.95, problemCount: problems.length, solved, failed,
            // Provenance (architecture.md §5.7): the model that produced this training run.
            model: llm?.getModel?.() ?? null,
            provider: llm?.getProvider?.() ?? null
        },
        problems: problems.map(p => ({ id: p.id, tier: p.tier, family: p.family })),
        lemmas,
        predictors,
        transitionMatrix: matrix.matrix,
        anomalies,
        events: events.length
    };

    const audit = auditTrainerReport(report, { events, problems, lemmaIds, analyzer });
    report.audit = audit;
    if (!audit.allOk) {
        const list = audit.violations.map(v => `${v.check}${v.pattern ? ` [${v.pattern.join(' → ')}]` : ''}`).join('; ');
        console.error(`[trainPredictors] AUDIT FAILED: ${list}`);
    }
    return report;
}

async function main() {
    const { createBackend } = await import('../lean/backend.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

    const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const setArg = process.argv.find(a => a.startsWith('--set='));
    const windowArg = process.argv.find(a => a.startsWith('--window='));
    const supportArg = process.argv.find(a => a.startsWith('--min-support='));
    const confArg = process.argv.find(a => a.startsWith('--min-confidence='));
    const outArg = process.argv.find(a => a.startsWith('--out='));

    const set = setArg ? setArg.split('=')[1] : 'core';
    const problemsSource = set === 'mathlib' ? MATHLIB_PROBLEMS : set === 'step' ? STEP_PROBLEMS : SMOKE_PROBLEMS;
    const problems = ids.length ? problemsSource.filter(p => ids.includes(p.id)) : problemsSource;
    if (ids.length && problems.length !== ids.length) {
        const known = problemsSource.map(p => p.id).join(', ');
        console.error(`unknown problem id; known ids: ${known}`);
        process.exit(2);
    }

    const pool = createBackend({
        type: 'repl',
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 2,
        timeoutMs: set === 'mathlib' ? 180_000 : 60_000,
        workerPerProblem: set === 'mathlib',
        warmupStatement: 'example : True := by trivial'
    });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    const outPath = outArg ? outArg.split('=')[1] : path.join(process.cwd(), 'bench', 'ablation', `predictors_${set}_${Date.now()}.json`);

    try {
        const report = await trainPredictors({
            backend: pool, llm, problems,
            window: windowArg ? Number(windowArg.split('=')[1]) : 3,
            minSupport: supportArg ? Number(supportArg.split('=')[1]) : 2,
            minConfidence: confArg ? Number(confArg.split('=')[1]) : 0.5
        });
        mkdirSync(path.dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log(`[trainPredictors] solved=${report.config.solved} failed=${report.config.failed} events=${report.events}`);
        console.log(`[trainPredictors] ${report.predictors.length} predictors written to ${outPath}`);
        for (const p of report.predictors) {
            console.log(`  ${p.pattern.join(' → ')}  support=${p.support} fails=${p.fails} conf=${p.confidence.toFixed(2)}`);
        }
        if (report.anomalies.length) {
            console.log(`[trainPredictors] anomalies: ${report.anomalies.map(a => `${a.kind}(${a.count})`).join(', ')}`);
        }
        const audit = report.audit;
        console.log(`[trainPredictors] audit: ${audit.passed}/${audit.checkCount} checks ${audit.allOk ? 'PASS' : 'FAIL'}`);
    } finally {
        await pool.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/trainPredictors.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
