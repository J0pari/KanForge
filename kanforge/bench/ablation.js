// Search-strategy ablation harness (build_order.md §5.1/§5.2, §5.8).
// ORTHOGONAL by design (architecture.md §5.8): this is a measurement tool applied TO the live
// path, never a parallel implementation of it. Each cell is ONE TacticLoop constructed with a
// toggle configuration (recipe, repulsion, premises, menu, predictors, exemplars) — the same
// loop the open-problem pipeline runs — and the report is meta-analysis over the rows: pass
// rate with Wilson CI, per-cell cost, pairwise deltas, and (for --ablate) main effects +
// pairwise interactions over the component graph. The report's recommendations update the
// component registry's defaults (runs/defaults.json), which the live path and the GUI consume.
//
// Recipes (the recipe dropdown of the registry):
//   bestofn / swiss / swiss+repulsion        per-goal ranking strategies
//   bfs / mcgs (+repulsion variants)         whole-graph search strategies
//
// Cost model: the loop counts every LLM call and every kernel applyTactic itself (counting
// proxies inside the loop for delegated recipes); the shared budget is a hard maxLlmCalls stop.
//
// Benchmark discipline (§5.7/§5.8): fixed corpus, cost-normalized per cell, Wilson confidence
// interval on each pass rate (≥2 problems), and a full provenance block in the report config.

// Wilson score interval on a binomial pass rate (architecture.md §5.7). Returns [low, high] or
// null when the sample is too small to be meaningful (< 2 problems).
export function wilsonInterval(solved, total, z = 1.96) {
    if (total < 2) return null;
    const p = solved / total;
    const denom = 1 + (z * z) / total;
    const centre = (p + (z * z) / (2 * total)) / denom;
    const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom;
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// CLI: node bench/ablation.js [--set=core|mathlib|step] [--recipes=bestofn,swiss]
//                             [--problems=trans_lt,add_comm] [--N=8] [--max-llm-calls=400]
//                             [--out=bench/ablation]
//                             [--premises=on|off] [--premise-locked=on|off]
//                             [--premise-topk=5] [--corpus=full|no-mul-add|step|step-no-rw]
//                             [--menu=on|off] [--predictors=<path.json>]
// `--set=step` defaults its premise corpus to `step` (the §5.4 tier corpus); `--corpus=step-no-rw`
// is its lock-enforcement control.
// The mathlib set (--set=mathlib) imports specific Mathlib modules per statement (~10-50s each
// per problem per recipe), so prefer --problems=<subset> to bound wall time. The step set
// (--set=step) is the multi-step goal-directed tier (build_order.md §5.4; bench/stepSmoke.js):
// 2-4 tactic chains with no trivial closer, verified by bench/verifyStepSet.js against the real
// kernel before any run.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TacticLoop } from '../agent/loop.js';
import { SMOKE_PROBLEMS, validateSmokeSet } from './smoke.js';
import { MATHLIB_PROBLEMS } from './mathlibSmoke.js';
import { STEP_PROBLEMS } from './stepSmoke.js';
import { MISSION_PROBLEMS } from './missionSmoke.js';
import { PremiseRetriever } from '../search/premises.js';
import { PREMISE_CORPORA } from './premisesCorpus.js';
import { compilePredictors } from '../optimization/causal.js';
import { auditAblationReport } from './reportAudit.js';
import { saveRecommendedDefaults, loadRecommendedDefaults } from '../config/registry.js';

export const RECIPES = ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'bfs+repulsion', 'mcgs', 'mcgs+repulsion'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Recipe name → TacticLoop options (the recipe dropdown maps 1:1 onto the loop's searchRecipe
// toggle + repulsion flag — no reimplementation of any strategy lives here).
function recipeOptions(recipe, N, maxLlmCalls) {
    const searchRecipe = recipe === 'loop' ? 'loop'
        : recipe.startsWith('mcgs') ? 'mcgs'
        : recipe.startsWith('bfs') ? 'bfs'
        : recipe.startsWith('swiss') ? 'swiss'
        : 'bestofn';
    const repulsion = recipe.endsWith('repulsion');
    return {
        searchRecipe,
        repulsion,
        swissN: N,
        maxTacticsPerGoal: N,
        maxGoalsPerLemma: Math.max(1, Math.floor(maxLlmCalls / Math.max(1, N))),
        maxLlmCalls
    };
}

// Drive ONE (recipe, problem) cell: a real TacticLoop with the cell's toggle configuration.
// The loop counts its own cost (llmCalls / tacticCalls / predictorSkips) — the row is read
// straight from the loop, never recomputed by a parallel driver. `overrides` carries the
// component toggles the graph node configured (menu/exemplars/ttrl/monitor/repair/repulsion).
async function driveCell({ backend, llm, statement, recipe, N, maxLlmCalls, predictors = null, premiseConfig = null, overrides = {} }) {
    const loop = new TacticLoop({
        backend,
        llm,
        ...recipeOptions(recipe, N, maxLlmCalls),
        predictors,
        premises: premiseConfig ? premiseConfig.retriever.corpus : null,
        premiseLocked: premiseConfig?.locked ?? false,
        premiseTopK: premiseConfig?.topK ?? 5,
        menu: overrides.menu ?? false,
        exemplars: overrides.exemplars ?? false,
        ttrl: overrides.ttrl ?? false,
        monitor: overrides.monitor ?? false,
        repair: overrides.repair ?? true,
        searchStructure: overrides.searchStructure ?? 'transposition',
        writeAuditPacks: false, // the ablation report is the record; no per-cell audit-pack trees
        onEvent: () => {}
    });
    loop.addLemma(statement);
    const t0 = Date.now();
    const outcome = await loop.proveAll();
    const failed = [...outcome.failures.values()][0];
    return {
        solved: outcome.ok,
        error: outcome.ok ? null : (failed?.message ?? 'loop failed'),
        llmCalls: loop.llmCalls,
        tacticCalls: loop.tacticCalls,
        skipped: loop.predictorSkips,
        ms: Date.now() - t0
    };
}

export async function runAblation({ backend, llm, problems = SMOKE_PROBLEMS, recipes = RECIPES, N = 8, maxLlmCalls = 400, outDir = null, onRow = null, premises = null, overrides = {}, rowTimeoutMs = 300_000, predictors = null, predictorsProvenance = null, provenance = null } = {}) {
    if (!backend || !llm) throw new Error('runAblation requires a backend and an llm');
    validateSmokeSet(problems);
    for (const r of recipes) {
        if (!RECIPES.includes(r)) throw new Error(`unknown recipe: ${r}; known recipes: ${RECIPES.join(', ')}`);
    }

    // Premise-retrieval axis (§5.2): premiseConfig { retriever, locked, topK, corpusName } is
    // passed as LOOP OPTIONS (the loop's native retriever) — no prompt-wrapper chain lives in
    // this harness; the loop is the live path being measured.
    const premiseConfig = premises
        ? { retriever: premises.retriever ?? new PremiseRetriever(premises.corpus ?? []), locked: !!premises.locked, topK: premises.topK ?? 5, corpusName: premises.corpusName ?? null }
        : null;

    const rows = [];
    try {
        for (const recipe of recipes) {
            for (const p of problems) {
                const t0 = Date.now();
                let outcome;
                try {
                    outcome = await withTimeout(
                        driveCell({ backend, llm, statement: p.statement, recipe, N, maxLlmCalls, predictors, premiseConfig, overrides }),
                        rowTimeoutMs,
                        `${recipe}/${p.id}`
                    );
                } catch (err) {
                    // A single row must never kill the run: a repl/LLM hiccup on one problem is
                    // recorded as a failed row and the comparison continues (a wedged repl can
                    // HANG a row past its timeout, which a bare await would let freeze the run).
                    outcome = { solved: false, error: `driver crashed: ${err?.message ?? err}`, llmCalls: 0, tacticCalls: 0, ms: Date.now() - t0 };
                }
                const row = { recipe, id: p.id, tier: p.tier, ...outcome };
                rows.push(row);
                onRow?.(row);
            }
        }
    } finally {
        // Write whatever we have even on an early exit, so a crash never discards the run.
        if (outDir) writeReport(outDir, summarize(rows, { recipes, problems, N, maxLlmCalls, premises: premiseConfig, overrides, rowTimeoutMs, predictors, predictorsProvenance, provenance }));
    }

    const report = summarize(rows, { recipes, problems, N, maxLlmCalls, premises: premiseConfig, overrides, rowTimeoutMs, predictors, predictorsProvenance, provenance });
    return report;
}

// Race a driver against a wall clock. A wedged repl must not freeze the comparison: the losing
// promise keeps running in the background but its result is ignored, and workerPerProblem
// isolates its (eventually failing) worker from the next row.
function withTimeout(promise, ms, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`row timed out after ${ms}ms (${label})`)), ms);
    });
    const raced = Promise.race([promise, guard]);
    // The guard timer must be cleared once the race has a winner, otherwise a driver that
    // finishes normally leaves a pending timer (up to rowTimeoutMs) that keeps Node's event
    // loop alive — the full-suite run then hangs minutes past its last reported result.
    const settle = () => clearTimeout(timer);
    raced.then(settle, settle);
    return raced;
}

function writeReport(outDir, report) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report));
}

export { summarize, writeReport };

// Crash-safe progress: append each completed (recipe, problem) row to rows.ndjson inside the
// outDir, so a partial run survives a crash and can be inspected while it is still running.
function appendRow(outDir, row) {
    if (!outDir) return;
    try {
        mkdirSync(outDir, { recursive: true });
        appendFileSync(path.join(outDir, 'rows.ndjson'), `${JSON.stringify(row)}\n`);
    } catch (err) {
        console.error(`[ablation] failed to write progress row: ${err.message}`);
    }
}

function summarize(rows, { recipes, problems, N, maxLlmCalls, premises = null, overrides = {}, rowTimeoutMs = 300_000, predictors = null, predictorsProvenance = null, provenance = null }) {    const byRecipe = Object.fromEntries(recipes.map(r => [r, {
        recipe: r,
        solved: 0,
        total: problems.length,
        llmCalls: 0,
        tacticCalls: 0,
        skipped: 0,
        wallMs: 0,
        solvedLlmCalls: 0,
        problems: []
    }]));
    for (const row of rows) {
        const s = byRecipe[row.recipe];
        s.problems.push(row);
        s.llmCalls += row.llmCalls;
        s.tacticCalls += row.tacticCalls;
        s.skipped += row.skipped ?? 0;
        s.wallMs += row.ms;
        if (row.solved) {
            s.solved++;
            s.solvedLlmCalls += row.llmCalls;
        }
    }
    for (const s of Object.values(byRecipe)) {
        s.passRate = s.total ? s.solved / s.total : 0;
        s.passRateCI = wilsonInterval(s.solved, s.total); // [low, high] or null (< 2 problems)
        s.meanLlmCallsPerSolved = s.solved ? s.solvedLlmCalls / s.solved : null;
        s.problems.sort((a, b) => a.id.localeCompare(b.id));
    }
    const byProblem = problems.map(p => {
        const solvedBy = recipes.filter(r => byRecipe[r].problems.find(x => x.id === p.id)?.solved);
        return { id: p.id, tier: p.tier, solvedBy };
    });
    const report = {
        generatedAt: new Date().toISOString(),
        config: { recipes, N, maxLlmCalls, problemCount: problems.length, premises, overrides, rowTimeoutMs, predictors: predictors?.count ?? null, predictorsInert: predictors?.inert ?? null, predictorsProvenance, provenance },
        perRecipe: recipes.map(r => {
            const { problems: _p, ...s } = byRecipe[r];
            return s;
        }),
        perProblem: byProblem,
        detail: rows,
        pairwise: pairwiseDeltas(recipes, byRecipe)
    };
    report.audit = auditAblationReport(report);
    if (!report.audit.allOk) {
        const list = report.audit.violations.map(v => `${v.check} [${v.recipe ?? v.id ?? ''}]`).join('; ');
        console.error(`[ablation] AUDIT FAILED: ${list}`);
    }
    return report;
}

function pairwiseDeltas(recipes, byRecipe) {
    const deltas = [];
    for (const base of ['bestofn', 'swiss']) {
        if (!byRecipe[base]) continue;
        for (const r of recipes) {
            if (r === base) continue;
            const baseRate = byRecipe[base].passRate;
            const rate = byRecipe[r].passRate;
            deltas.push({
                base,
                recipe: r,
                passDelta: rate - baseRate,
                meanLlmCalls: byRecipe[r].meanLlmCallsPerSolved
            });
        }
    }
    return deltas;
}

export function renderMarkdown(report) {
    if (report.config?.kind === 'ablation-graph') return renderAblationGraphMarkdown(report);
    const { config, perRecipe, perProblem, pairwise } = report;
    const lines = [];
    lines.push('# Search-strategy ablation report');
    lines.push('');
    lines.push(`- Generated: ${report.generatedAt}`);
    lines.push(`- Budget: ${config.maxLlmCalls} LLM calls / lemma, N=${config.N}`);
    lines.push(`- Problems: ${config.problemCount}`);
    if (config.premises) {
        const p = config.premises;
        lines.push(`- Premises: ${p.locked ? 'locked' : 'augment'} / top-${p.topK} / corpus=${p.corpusName ?? (p.retriever?.corpus?.length ?? '?')} premises`);
    } else {
        lines.push('- Premises: off');
    }
    const ov = config.overrides ?? {};
    lines.push(`- Components: ${Object.entries(ov).map(([k, v]) => `${k}=${v}`).join(' ') || '(registry defaults)'}`);
    if (config.predictors) lines.push(`- Failure predictors: ${config.predictors} active`);
    lines.push('');
    lines.push('## Pass rate vs. budget');
    lines.push('');
    lines.push('| recipe | solved | pass rate (95% CI) | llm calls | kernel checks | predictor-skips | mean llm/solved |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const s of perRecipe) {
        const ci = s.passRateCI
            ? ` (${(s.passRateCI[0] * 100).toFixed(1)}–${(s.passRateCI[1] * 100).toFixed(1)})`
            : '';
        lines.push(`| ${s.recipe} | ${s.solved}/${s.total} | ${(s.passRate * 100).toFixed(1)}%${ci} | ${s.llmCalls} | ${s.tacticCalls} | ${s.skipped} | ${s.meanLlmCallsPerSolved === null ? '—' : s.meanLlmCallsPerSolved.toFixed(1)} |`);
    }
    lines.push('');
    lines.push('## Pairwise deltas (vs. baselines)');
    lines.push('');
    lines.push('| base | recipe | pass-rate delta | mean llm/solved |');
    lines.push('|---|---|---|---|');
    for (const d of pairwise) {
        lines.push(`| ${d.base} | ${d.recipe} | ${(d.passDelta * 100).toFixed(1)}% | ${d.meanLlmCalls === null ? '—' : d.meanLlmCalls.toFixed(1)} |`);
    }
    lines.push('');
    lines.push('## Per-problem solved-by');
    lines.push('');
    lines.push('| problem | tier | solved by |');
    lines.push('|---|---|---|');
    for (const p of perProblem) {
        lines.push(`| ${p.id} | ${p.tier} | ${p.solvedBy.join(', ') || '(none)'} |`);
    }
    lines.push('');
    lines.push('> Acceptance anchor (build_order.md §5.1): "MCGS ≥ best-of-N at equal budget on the');
    lines.push('> smoke set; merge rate reported. Compare, then decide." Ablations with/without');
    lines.push('> repulsion per §5.2 are logged in the per-recipe tables above.');
    return lines.join('\n');
}

// §5.7/§5.8: the component ablation GRAPH report — per-configuration pass rate (with CI), the
// component main effects, and the pairwise interactions (the additivity/commutativity test).
function renderAblationGraphMarkdown(report) {
    const lines = [];
    lines.push('# Component ablation graph');
    lines.push('');
    lines.push(`- Generated: ${report.generatedAt}`);
    lines.push(`- Corpus: ${report.config?.corpus ?? '?'}, problems: ${(report.config?.problems ?? []).join(', ')}`);
    lines.push(`- N=${report.config?.N ?? '?'}, budget=${report.config?.maxLlmCalls ?? '?'} LLM calls / lemma`);
    lines.push('');
    lines.push('## Configurations (full factorial)');
    lines.push('');
    lines.push('| mask | components | recipe | solved | pass rate (95% CI) | llm calls | kernel checks |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const n of report.nodes) {
        const ci = n.passRateCI
            ? ` (${(n.passRateCI[0] * 100).toFixed(1)}–${(n.passRateCI[1] * 100).toFixed(1)})`
            : '';
        const comps = Object.entries(n.components).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(' ');
        lines.push(`| ${n.mask} | ${comps} | ${n.recipe} | ${n.solved}/${n.total} | ${(n.passRate * 100).toFixed(1)}%${ci} | ${n.llmCalls} | ${n.kernelChecks} |`);
    }
    lines.push('');
    lines.push('## Main effects (mean pass-rate change with component ON)');
    lines.push('');
    lines.push('| component | main effect (pp) |');
    lines.push('|---|---|');
    for (const [c, e] of Object.entries(report.mainEffects)) {
        lines.push(`| ${c} | ${e === null ? '—' : (e * 100).toFixed(1)} |`);
    }
    lines.push('');
    lines.push('## Pairwise interactions (additivity / commutativity test)');
    lines.push('');
    lines.push('| pair | interaction |');
    lines.push('|---|---|');
    for (const [p, v] of Object.entries(report.interactions)) {
        lines.push(`| ${p} | ${v === null ? '—' : (v * 100).toFixed(1)} |`);
    }
    lines.push('');
    lines.push('> A nonzero interaction means the effect of one component depends on the other — the');
    lines.push('> components are NOT additive, and no rung ordering could have revealed that. A');
    lines.push('> component with no measured main effect is reported as such.');
    return lines.join('\n');
}

async function main() {
    const { createBackend } = await import('../lean/backend.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();
    let predictorsProvenance = null;

    const recipesArg = process.argv.find(a => a.startsWith('--recipes='));
    const setArg = process.argv.find(a => a.startsWith('--set='));
    const problemsArg = process.argv.find(a => a.startsWith('--problems='));
    const nArg = process.argv.find(a => a.startsWith('--N='));
    const budgetArg = process.argv.find(a => a.startsWith('--max-llm-calls='));
    const outArg = process.argv.find(a => a.startsWith('--out='));
    const premisesArg = process.argv.find(a => a.startsWith('--premises='));
    const premiseLockedArg = process.argv.find(a => a.startsWith('--premise-locked='));
    const premiseTopKArg = process.argv.find(a => a.startsWith('--premise-topk='));
    const corpusArg = process.argv.find(a => a.startsWith('--corpus='));
    const menuArg = process.argv.find(a => a.startsWith('--menu='));
    const rowTimeoutArg = process.argv.find(a => a.startsWith('--row-timeout-ms='));
    const predictorsArg = process.argv.find(a => a.startsWith('--predictors='));
    const ablateArg = process.argv.find(a => a.startsWith('--ablate'));

    const set = setArg ? setArg.split('=')[1] : 'core';
    const problemsSource = set === 'mathlib' ? MATHLIB_PROBLEMS
        : set === 'step' ? STEP_PROBLEMS
        : set === 'mission' ? MISSION_PROBLEMS
        : SMOKE_PROBLEMS;
    if (set !== 'core' && set !== 'mathlib' && set !== 'step' && set !== 'mission') {
        console.error('unknown problem set; known sets: core, mathlib, step, mission');
        process.exit(2);
    }
    const recipes = recipesArg ? recipesArg.split('=')[1].split(',') : RECIPES;
    const ids = problemsArg ? problemsArg.split('=')[1].split(',') : [];
    const problems = ids.length ? problemsSource.filter(p => ids.includes(p.id)) : problemsSource;
    if (ids.length && problems.length !== ids.length) {
        const known = problemsSource.map(p => p.id).join(', ');
        console.error(`unknown problem id; known ids: ${known}`);
        process.exit(2);
    }
    const N = nArg ? Number(nArg.split('=')[1]) : 8;
    const maxLlmCalls = budgetArg ? Number(budgetArg.split('=')[1]) : 400;
    const outDir = outArg ? outArg.split('=')[1] : path.join(__dirname, 'ablation', `ablation_${Date.now()}`);

    const premisesEnabled = premisesArg ? premisesArg.split('=')[1] === 'on' : false;
    const premiseLocked = premiseLockedArg ? premiseLockedArg.split('=')[1] === 'on' : false;
    const premiseTopK = premiseTopKArg ? Number(premiseTopKArg.split('=')[1]) : 5;
    const corpusName = corpusArg ? corpusArg.split('=')[1] : (set === 'step' ? 'step' : 'full');
    if (premisesEnabled && !(corpusName in PREMISE_CORPORA)) {
        console.error(`unknown premise corpus; known corpora: ${Object.keys(PREMISE_CORPORA).join(', ')}`);
        process.exit(2);
    }
    const premiseConfig = premisesEnabled
        ? { retriever: new PremiseRetriever(PREMISE_CORPORA[corpusName]), locked: premiseLocked, topK: premiseTopK, corpusName }
        : null;
    const menuEnabled = menuArg ? menuArg.split('=')[1] === 'on' : false;
    const rowTimeoutMs = rowTimeoutArg ? Number(rowTimeoutArg.split('=')[1]) : 300_000;

    // §5.3: pre-filter stage. --predictors=<path.json> loads a serialized predictor list
    // (the output of CausalAnalyzer.getFailurePredictors() or a hand-written pattern set);
    // compilePredictors turns it into the reject matcher the search recipes consult before
    // kernel verification.
    let predictors = null;
    if (predictorsArg) {
        const predictorsPath = predictorsArg.split('=')[1];
        const { readFile, stat } = await import('node:fs/promises');
        const rawText = await readFile(predictorsPath, 'utf8');
        const raw = JSON.parse(rawText);
        const list = Array.isArray(raw) ? raw : (raw.predictors ?? []);
        predictors = compilePredictors(list);
        console.log(`[ablation] loaded ${predictors.count} failure predictors from ${predictorsPath}`);
        // Record provenance so the report ties the matcher back to the exact trained file.
        const sha = await sha256(rawText);
        const meta = await stat(predictorsPath);
        predictorsProvenance = { path: predictorsPath, sha256: sha, bytes: meta.size, trainedAt: raw.generatedAt ?? null, count: predictors.count };
    }

    const pool = createBackend({
        type: 'repl',
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 2,
        // Mathlib imports take 5-35s cold (mission statements can take minutes under memory
        // pressure); the core set is near-instant.
        timeoutMs: (set === 'mathlib' || set === 'mission') ? 300_000 : 60_000,
        // Mathlib imports accumulate in the repl until it OOMs; give each problem a fresh process.
        workerPerProblem: set === 'mathlib' || set === 'mission',
        // A fresh repl takes ~60s to elaborate its first command; warm each worker so the first
        // row pays that cost off the timer (the failed `or_elim` row was exactly this: it timed
        // out at 60020ms before the LLM was ever called).
        warmupStatement: 'example : True := by trivial'
    });
    // Mission-shaped targets carry heavy mathlib imports: warm the pool with the problem's
    // import block (escalating timeouts — the same discipline as blueprint/run.js) so the
    // first extractGoals does not pay the cold import INSIDE the measured row. The mission
    // row that timed out at 600s with 0 llm / 0 kernel calls was exactly this.
    if (set === 'mission' && pool.warm) {
        const warmStmt = problems[0]?.statement?.split('\n')
            .filter(l => /^\s*import\s+\S/.test(l)).join('\n')
            + '\n\nexample : True := by trivial';
        let warmOk = false;
        for (const timeout of [300_000, 600_000]) {
            try {
                await pool.warm(warmStmt, { timeoutMs: timeout });
                console.log(`[ablation] mission pool warmed with target imports (${timeout / 1000}s)`);
                warmOk = true;
                break;
            } catch (err) {
                console.warn(`[ablation] mission warm attempt at ${timeout / 1000}s failed: ${err?.message ?? err}`);
            }
        }
        if (!warmOk) {
            console.warn('[ablation] mission warm failed; rows may time out on the cold import');
        }
    }
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    // Provenance block (§5.7): every run is reproducible from these fields + the report + digest.
    const provenance = {
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN ?? null,
        leanProject: ENV.KANFORGE_LEAN_PROJECT ?? null,
        model: llmConfig.model ?? null,
        provider: llmConfig.provider ?? null,
        promptVersion: null, // prompts are inline in agent/prompts.js; a version constant is §5.8 backlog
        corpus: set,
        problemIds: problems.map(p => p.id)
    };

    try {
        if (ablateArg) {
            // §5.7/§5.8 ablation GRAPH: full factorial over the named component toggles on the
            // fixed corpus at equal budget. Each node is a full configuration; edges connect
            // configurations differing in ONE toggle. Component effects are MEASURED as main
            // effects + pairwise interactions — never assumed additive/commutative by a rung order.
            const comps = ablateArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
            const nodes = buildAblationGraph(comps, { premiseConfig, predictors });
            const graphDir = path.join(outDir, 'graph');
            const results = [];
            for (const node of nodes) {
                const nodeOut = path.join(graphDir, node.mask);
                console.log(`\n[ablate] config ${node.mask} ...`);
                const report = await runAblation({
                    backend: pool, llm, problems, recipes: node.recipes, N, maxLlmCalls, outDir: nodeOut,
                    premises: node.premises, overrides: node.overrides, rowTimeoutMs, predictors: node.predictors, predictorsProvenance,
                    provenance: { ...provenance, componentMask: node.mask },
                    onRow: (row) => {
                        const line = `${row.recipe} ${row.id} ${row.solved ? 'SOLVED' : 'FAILED'} llm=${row.llmCalls} kernel=${row.tacticCalls} ms=${row.ms}${row.skipped ? ` skipped=${row.skipped}` : ''}`;
                        console.log(`[ablate ${node.mask}] ${line}`);
                        appendRow(nodeOut, row);
                    }
                });
                results.push({ mask: node.mask, components: node.components, report });
            }
            const graphSummary = summarizeAblationGraph(results, problems, { premiseConfig, predictors });
            writeReport(outDir, graphSummary);
            console.log(renderMarkdown(graphSummary));

            // Evidence → recommended defaults (registry output surface): measured main effects
            // update runs/defaults.json, which the live path and the GUI consume.
            const recs = recommendFromGraph(graphSummary);
            if (Object.keys(recs).length) {
                const defaultsFile = path.join(__dirname, '..', 'runs', 'defaults.json');
                saveRecommendedDefaults(defaultsFile, recs, { provenance: { ...provenance, kind: 'ablation-graph' } });
                console.log(`[ablate] recommended defaults written -> ${defaultsFile}: ${JSON.stringify(recs)}`);
            }
            return;
        }

        const report = await runAblation({
            backend: pool, llm, problems, recipes, N, maxLlmCalls, outDir, premises: premiseConfig, overrides: { menu: menuEnabled }, rowTimeoutMs, predictors, predictorsProvenance, provenance,
            onRow: (row) => {
                const line = `${row.recipe} ${row.id} ${row.solved ? 'SOLVED' : 'FAILED'} llm=${row.llmCalls} kernel=${row.tacticCalls} ms=${row.ms}${row.skipped ? ` skipped=${row.skipped}` : ''}`;
                console.log(`[ablation] ${line}`);
                appendRow(outDir, row);
            }
        });
        console.log(`\nAblation complete: ${recipes.length} recipes x ${problems.length} problems -> ${outDir}`);
        console.log(renderMarkdown(report));

        // Recipe recommendation: the cheapest recipe among those solving ≥ the best-rate-minus-
        // margin; written to defaults.json alongside any component recommendations.
        const recipeRec = recommendRecipe(report);
        if (recipeRec) {
            const defaultsFile = path.join(__dirname, '..', 'runs', 'defaults.json');
            const existing = loadRecommendedDefaults(defaultsFile)?.recommendations ?? {};
            saveRecommendedDefaults(defaultsFile, { ...existing, recipe: recipeRec }, { provenance: { ...provenance, kind: 'ablation-recipe' } });
            console.log(`[ablation] recommended recipe: ${recipeRec} -> ${defaultsFile}`);
        }
    } finally {
        await pool.shutdown(3000);
    }
}

// Measured main effects → toggle recommendations (registry output surface). A component's
// recommendation flips only when its main effect exceeds the decision threshold; effects near
// zero leave the recommendation unset (evidence is inconclusive, not a reason to toggle).
const DECISION_THRESHOLD = 0.05; // <5pp pass-rate change is not actionable

export function recommendFromGraph(summary) {
    const recs = {};
    for (const [name, effect] of Object.entries(summary.mainEffects ?? {})) {
        if (effect === null) continue;
        if (effect > DECISION_THRESHOLD) recs[name] = true;
        else if (effect < -DECISION_THRESHOLD) recs[name] = false;
    }
    if (summary.mainEffects?.search != null) {
        // the search axis maps to the recipe dropdown: a positive effect recommends a search
        // recipe (mcgs), a negative one recommends the per-goal default (loop).
        recs.recipe = summary.mainEffects.search > DECISION_THRESHOLD ? 'mcgs' : 'loop';
    }
    return recs;
}

export function recommendRecipe(report) {
    const rows = (report?.perRecipe ?? []).filter(r => r.passRate > 0);
    if (!rows.length) return null;
    rows.sort((a, b) => b.passRate - a.passRate
        || (a.meanLlmCallsPerSolved ?? Infinity) - (b.meanLlmCallsPerSolved ?? Infinity));
    return rows[0].recipe;
}

// Ablation graph (§5.7/§5.8): the full factorial over the named component toggles. Each node is
// a full configuration (a subset of the toggles); edges connect configurations differing in one
// toggle. The summary reports per-node pass rate (with CI) and per-component MAIN EFFECTS +
// PAIRWISE INTERACTIONS — the interaction terms are the additivity/commutativity test, because no
// fixed rung order presumes them. Component names come from the registry toggles
// (config/registry.js) plus the `search` axis (recipe: bestofn vs mcgs).
//
// Recognized component names (others are rejected loudly):
//   tacticMenu, premises, predictors, repulsion, exemplars, ttrl, monitor, repair, search,
//   searchStructure (transposition graph vs e-graph)
// 'on' nodes that need external config (premises corpus, predictor file) are skipped when that
// config is absent. The base node (all toggles off) is always included.
export function buildAblationGraph(comps, { premiseConfig = null, predictors = null } = {}) {
    const known = ['tacticMenu', 'premises', 'predictors', 'repulsion', 'exemplars', 'ttrl', 'monitor', 'repair', 'search', 'searchStructure'];
    const unknown = comps.filter(c => !known.includes(c));
    if (unknown.length) {
        throw new Error(`unknown ablation component(s): ${unknown.join(', ')}; known: ${known.join(', ')}`);
    }
    const bits = comps.length;
    const nodes = [];
    for (let mask = 0; mask < (1 << bits); mask++) {
        const components = {};
        for (let i = 0; i < bits; i++) components[comps[i]] = ((mask >> i) & 1) === 1;
        // 'on' nodes that need external config are invalid without it — skip loudly.
        if (components.premises && !premiseConfig) continue;
        if (components.predictors && !predictors) continue;
        const recipe = components.search ? 'mcgs' : 'bestofn';
        const recipeName = components.repulsion ? `${recipe}+repulsion` : recipe;
        const maskStr = comps.map((c, i) => (components[c] ? '1' : '0')).join('');
        nodes.push({
            mask: maskStr,
            components,
            recipes: [recipeName],
            overrides: {
                menu: !!components.tacticMenu,
                exemplars: !!components.exemplars,
                ttrl: !!components.ttrl,
                monitor: !!components.monitor,
                repair: !!components.repair,
                // searchStructure 'on' = the e-graph; 'off' = the transposition graph.
                searchStructure: components.searchStructure ? 'egraph' : 'transposition'
            },
            premises: components.premises ? premiseConfig : null,
            predictors: components.predictors ? predictors : null
        });
    }
    return nodes;
}

// Main effect of a component: mean pass rate with it ON minus OFF, over all configurations that
// differ only in that toggle (each pair counted once). A positive effect means the component
// helps at equal budget; zero/negative means it does not.
function mainEffects(nodes) {
    const effects = {};
    const comps = Object.keys(nodes[0]?.components ?? {});
    for (const c of comps) {
        let on = 0, off = 0, onN = 0, offN = 0;
        for (const n of nodes) {
            const rate = n.report?.perRecipe[0]?.passRate ?? 0;
            if (n.components[c]) { on += rate; onN++; } else { off += rate; offN++; }
        }
        effects[c] = onN && offN ? on / onN - off / offN : null;
    }
    return effects;
}

// Pairwise interactions: for components A,B, the average of (rate(AB) - rate(A¬B) - rate(¬AB) +
// rate(¬A¬B)) over all 4-node subgroups — the standard 2-factor interaction. Nonzero = the
// effect of A depends on whether B is on (non-additive, order-dependent).
function pairwiseInteractions(nodes) {
    const comps = Object.keys(nodes[0]?.components ?? {});
    const interactions = {};
    for (let i = 0; i < comps.length; i++) {
        for (let j = i + 1; j < comps.length; j++) {
            const a = comps[i], b = comps[j];
            const rate = n => n.report?.perRecipe[0]?.passRate ?? 0;
            // take the 4 corners over a,b (all other components vary — average over them)
            let ab = 0, anb = 0, nab = 0, nanb = 0, abN = 0, anbN = 0, nabN = 0, nanbN = 0;
            for (const n of nodes) {
                const r = rate(n);
                if (n.components[a] && n.components[b]) { ab += r; abN++; }
                else if (n.components[a] && !n.components[b]) { anb += r; anbN++; }
                else if (!n.components[a] && n.components[b]) { nab += r; nabN++; }
                else { nanb += r; nanbN++; }
            }
            if (abN && anbN && nabN && nanbN) {
                interactions[`${a} x ${b}`] = ab / abN - anb / anbN - nab / nabN + nanb / nanbN;
            } else {
                interactions[`${a} x ${b}`] = null;
            }
        }
    }
    return interactions;
}

export function summarizeAblationGraph(results, problems, { premiseConfig = null, predictors = null } = {}) {
    // Attach reports to nodes (order matches buildAblationGraph output, minus skipped 'on' nodes).
    const nodes = results.map((r, i) => ({ ...r, components: r.components ?? {}, report: r.report }));
    const effects = mainEffects(nodes);
    const interactions = pairwiseInteractions(nodes);
    const summary = {
        generatedAt: new Date().toISOString(),
        config: {
            kind: 'ablation-graph',
            corpus: results[0]?.report?.config?.provenance?.corpus ?? null,
            problems: problems.map(p => p.id),
            N: results[0]?.report?.config?.N ?? null,
            maxLlmCalls: results[0]?.report?.config?.maxLlmCalls ?? null,
            provenance: results[0]?.report?.config?.provenance ?? null
        },
        nodes: nodes.map(n => ({
            mask: n.mask,
            components: n.components,
            recipe: n.recipes?.[0] ?? 'bestofn',
            solved: n.report?.perRecipe[0]?.solved ?? 0,
            total: n.report?.perRecipe[0]?.total ?? problems.length,
            passRate: n.report?.perRecipe[0]?.passRate ?? 0,
            passRateCI: n.report?.perRecipe[0]?.passRateCI ?? null,
            llmCalls: n.report?.perRecipe[0]?.llmCalls ?? 0,
            kernelChecks: n.report?.perRecipe[0]?.tacticCalls ?? 0
        })),
        mainEffects: effects,
        interactions,
        detail: []
    };
    summary.audit = auditAblationGraph(summary);
    return summary;
}

// Ablation-graph audit: the graph has no per-row detail (each node is itself an audited ablation
// report), so the audit verifies what a graph CAN verify: each node's CI recomputes, main effects
// and interactions recompute from the node pass rates, and the provenance block is present.
export function auditAblationGraph(summary) {
    const checks = [];
    const violations = [];
    const ok = (name, passed, observed) => {
        checks.push({ check: name, ok: passed, observed });
        return passed;
    };
    const bad = (name, context) => violations.push({ check: name, ...context });

    const nodes = summary.nodes ?? [];
    for (const n of nodes) {
        const expectedCI = wilsonInterval(n.solved, n.total);
        const same = expectedCI === null && n.passRateCI === null
            ? true
            : expectedCI !== null && n.passRateCI !== null &&
              Math.abs(expectedCI[0] - n.passRateCI[0]) < 1e-9 && Math.abs(expectedCI[1] - n.passRateCI[1]) < 1e-9;
        if (!same) bad('graph_ci_recompute', { mask: n.mask, reported: n.passRateCI, recomputed: expectedCI });
    }
    ok('graph_ci_recompute', !violations.some(v => v.check === 'graph_ci_recompute'), {});

    const prov = summary.config?.provenance ?? null;
    const provMissing = prov ? ['toolchain', 'leanProject', 'model', 'provider', 'corpus'].filter(k => prov[k] == null) : ['entire block'];
    if (provMissing.length) bad('provenance_present', { missing: provMissing });
    ok('provenance_present', provMissing.length === 0, { missing: provMissing });

    // Interaction recompute from node rates (the additivity/commutativity diagnostic).
    const recomputedInteractions = pairwiseInteractions(nodes.map(n => ({ components: n.components, report: { perRecipe: [{ passRate: n.passRate }] } })));
    for (const [k, v] of Object.entries(recomputedInteractions)) {
        const reported = summary.interactions?.[k] ?? null;
        if (reported === null || v === null) {
            if (reported !== v) bad('interaction_recompute', { pair: k, reported, recomputed: v });
        } else if (Math.abs(reported - v) > 1e-9) {
            bad('interaction_recompute', { pair: k, reported, recomputed: v });
        }
    }
    ok('interaction_recompute', !violations.some(v => v.check === 'interaction_recompute'), {});

    return {
        schema: 'ablation-graph/audit.v1',
        checkCount: checks.length,
        passed: checks.filter(c => c.ok).length,
        checks,
        violations,
        allOk: violations.length === 0
    };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/ablation.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
