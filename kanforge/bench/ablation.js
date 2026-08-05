// Search-strategy ablation harness (build_order.md §5.1/§5.2).
// Runs the smoke set through every tactic/search recipe under a SHARED budget and reports the
// comparison the phase gates demand: "MCGS ≥ best-of-N at equal budget ... compare, then
// decide" (§5.1) and "ablations logged with/without each" (§5.2). This is what makes "swiss is
// the best choice" a measured claim instead of an assumption.
//
// Recipes:
//   bestofn          naive best-of-N per goal (search/bestofn.js)          — ranking baseline
//   swiss            Swiss-tournament best-of-N per goal (search/swiss.js) — OPC App. B
//   swiss+repulsion  swiss whose proposals pass a diversity sampler        — Goedel penalty
//   bfs              best-first goal selection over the e-graph            — search axis
//   bfs+repulsion    bfs that refuses duplicate tactic re-checks
//   mcgs             UCB rollouts over the e-graph                         — search axis
//   mcgs+repulsion   mcgs that refuses duplicate tactic re-checks
//
// Cost model: every LLM call (proposal + swiss judge) and every kernel applyTactic is counted
// per problem per recipe, so the tables report pass rate AND budget, not pass rate alone.
//
// CLI: node bench/ablation.js [--set=core|mathlib] [--recipes=bestofn,swiss]
//                             [--problems=trans_lt,add_comm] [--N=8] [--max-llm-calls=400]
//                             [--out=bench/ablation]
// The mathlib set (--set=mathlib) imports specific Mathlib modules per statement (~10-50s each
// per problem per recipe), so prefer --problems=<subset> to bound wall time.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoalEGraph } from '../core/egraph.js';
import { bestOfN } from '../search/bestofn.js';
import { bestOfNWithSwiss, swissRank, buildPairwiseJudge } from '../search/swiss.js';
import { RepulsionSampler } from '../search/repulsion.js';
import { BestFirstSearch } from '../search/bfs.js';
import { MCGS } from '../search/mcgs.js';
import { SMOKE_PROBLEMS, validateSmokeSet } from './smoke.js';
import { MATHLIB_PROBLEMS } from './mathlibSmoke.js';

export const RECIPES = ['bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'bfs+repulsion', 'mcgs', 'mcgs+repulsion'];
export const RANKING_RECIPES = ['bestofn', 'swiss', 'swiss+repulsion'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Counting adapters: wrap the real clients so every strategy's true cost is observable without
// changing how the strategies call the interface.
function countingLLM(llm) {
    const counted = { ...llm };
    counted.llmCalls = 0;
    const complete = llm.complete.bind(llm);
    counted.complete = async (...args) => {
        counted.llmCalls++;
        return complete(...args);
    };
    return counted;
}

function countingBackend(backend) {
    const counted = { ...backend };
    counted.tacticCalls = 0;
    const applyTactic = backend.applyTactic.bind(backend);
    const extractGoals = backend.extractGoals.bind(backend);
    counted.applyTactic = async (goal, tactic) => {
        counted.tacticCalls++;
        return applyTactic(goal, tactic);
    };
    counted.extractGoals = async (statement) => extractGoals(statement);
    return counted;
}

function openRootEGraph(rootGoals) {
    const egraph = new GoalEGraph();
    egraph.addGoal(rootGoals[0]);
    egraph.setRoot(rootGoals[0]);
    return egraph;
}

// Repulsion-flavoured swiss: candidates are drawn through a RepulsionSampler seeded with every
// tactic already tried (and failed) anywhere in the lemma, then ranked and applied exactly as
// bestOfNWithSwiss does.
async function pickSwissWithRepulsion(goal, backend, llm, sampler, tried, N) {
    const candidates = [];
    const seen = new Set();
    for (let i = 0; i < N; i++) {
        const t = await sampler.propose(`Goal: ${goal.type}\nPropose tactic:`, { tried: [...tried] });
        if (t && !seen.has(t)) {
            seen.add(t);
            candidates.push(t);
        }
    }
    if (candidates.length === 0) return { ok: false };
    const judge = buildPairwiseJudge(goal, { llm });
    const ranking = await swissRank(candidates, judge);
    for (const { candidate } of ranking) {
        const result = await backend.applyTactic(goal, candidate);
        if (result.status === 'ok') return { ok: true, tactic: candidate, result };
    }
    return { ok: false, tactic: candidates[0] };
}

// Drive one lemma with a per-goal ranking strategy, mirroring TacticLoop's frontier-order
// discipline (open goal 0, currentGoal freshest instance) but isolating the strategy and
// counting its true cost.
async function driveLemmaByRanking({ backend, llm, statement, recipe, N, maxLlmCalls }) {
    const countedLLM = countingLLM(llm);
    const countedBackend = countingBackend(backend);
    const sampler = recipe === 'swiss+repulsion' ? new RepulsionSampler({ llm: countedLLM }) : null;
    const tried = new Set();

    const rootGoals = await countedBackend.extractGoals(statement);
    if (!rootGoals?.length) {
        return { solved: false, error: 'no root goal', llmCalls: 0, tacticCalls: 0, ms: 0 };
    }
    const egraph = openRootEGraph(rootGoals);
    const sessionKey = rootGoals[0].sessionKey;

    const t0 = Date.now();
    let goalCount = 0;
    while (!egraph.isRootSolved() && goalCount < 100) {
        if (countedLLM.llmCalls >= maxLlmCalls) break;
        const open = egraph.getOpenGoals();
        if (open.length === 0) break;
        const goalClass = open[0];
        const goal = egraph.currentGoal(goalClass.id);
        goalCount++;

        let pick;
        if (recipe === 'bestofn') {
            pick = await bestOfN(goal, countedBackend, countedLLM, N);
        } else if (recipe === 'swiss') {
            pick = await bestOfNWithSwiss(goal, countedBackend, countedLLM, { N });
        } else {
            pick = await pickSwissWithRepulsion(goal, countedBackend, countedLLM, sampler, tried, N);
        }

        if (pick.ok) {
            egraph.applyTactic(goalClass.id, pick.tactic, pick.result.newGoals);
        } else {
            egraph.markFailed(goalClass.id);
            if (pick.tactic) tried.add(pick.tactic);
        }
    }

    backend.endLemma(sessionKey);

    return {
        solved: egraph.isRootSolved(),
        error: egraph.isRootSolved() ? null : 'budget exhausted or frontier stuck',
        llmCalls: countedLLM.llmCalls,
        tacticCalls: countedBackend.tacticCalls,
        ms: Date.now() - t0
    };
}

// Drive one lemma with a search-level strategy (bfs / mcgs), which owns goal selection AND
// per-goal proposals over the e-graph. The rollout/expansion budget approximates the shared
// llm-call budget so recipes stay comparable.
async function driveLemmaBySearch({ backend, llm, statement, recipe, N, maxLlmCalls }) {
    const countedLLM = countingLLM(llm);
    const countedBackend = countingBackend(backend);
    const repulsion = recipe.endsWith('repulsion');

    const rootGoals = await countedBackend.extractGoals(statement);
    if (!rootGoals?.length) {
        return { solved: false, error: 'no root goal', llmCalls: 0, tacticCalls: 0, ms: 0 };
    }
    const egraph = openRootEGraph(rootGoals);
    const sessionKey = rootGoals[0].sessionKey;

    const t0 = Date.now();
    const approxBudget = Math.max(1, Math.floor(maxLlmCalls / Math.max(1, N)));
    if (recipe.startsWith('mcgs')) {
        const searcher = new MCGS({ backend: countedBackend, llm: countedLLM, maxTacticsPerGoal: N, repulsion });
        await searcher.search(egraph, { rollouts: approxBudget });
    } else {
        const searcher = new BestFirstSearch({ backend: countedBackend, llm: countedLLM, maxTacticsPerGoal: N, repulsion });
        await searcher.search(egraph, { maxExpansions: approxBudget });
    }

    backend.endLemma(sessionKey);

    return {
        solved: egraph.isRootSolved(),
        error: egraph.isRootSolved() ? null : 'budget exhausted or frontier stuck',
        llmCalls: countedLLM.llmCalls,
        tacticCalls: countedBackend.tacticCalls,
        ms: Date.now() - t0
    };
}

export async function runAblation({ backend, llm, problems = SMOKE_PROBLEMS, recipes = RECIPES, N = 8, maxLlmCalls = 400, outDir = null, onRow = null } = {}) {
    if (!backend || !llm) throw new Error('runAblation requires a backend and an llm');
    validateSmokeSet(problems);
    for (const r of recipes) {
        if (!RECIPES.includes(r)) throw new Error(`unknown recipe: ${r}; known recipes: ${RECIPES.join(', ')}`);
    }

    const rows = [];
    for (const recipe of recipes) {
        const driver = RANKING_RECIPES.includes(recipe) ? driveLemmaByRanking : driveLemmaBySearch;
        for (const p of problems) {
            const outcome = await driver({ backend, llm, statement: p.statement, recipe, N, maxLlmCalls });
            const row = { recipe, id: p.id, tier: p.tier, ...outcome };
            rows.push(row);
            onRow?.(row);
        }
    }

    const report = summarize(rows, { recipes, problems, N, maxLlmCalls });
    if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
        writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report));
    }
    return report;
}

function summarize(rows, { recipes, problems, N, maxLlmCalls }) {
    const byRecipe = Object.fromEntries(recipes.map(r => [r, {
        recipe: r,
        solved: 0,
        total: problems.length,
        llmCalls: 0,
        tacticCalls: 0,
        wallMs: 0,
        solvedLlmCalls: 0,
        problems: []
    }]));
    for (const row of rows) {
        const s = byRecipe[row.recipe];
        s.problems.push(row);
        s.llmCalls += row.llmCalls;
        s.tacticCalls += row.tacticCalls;
        s.wallMs += row.ms;
        if (row.solved) {
            s.solved++;
            s.solvedLlmCalls += row.llmCalls;
        }
    }
    for (const s of Object.values(byRecipe)) {
        s.passRate = s.total ? s.solved / s.total : 0;
        s.meanLlmCallsPerSolved = s.solved ? s.solvedLlmCalls / s.solved : null;
        s.problems.sort((a, b) => a.id.localeCompare(b.id));
    }
    const byProblem = problems.map(p => {
        const solvedBy = recipes.filter(r => byRecipe[r].problems.find(x => x.id === p.id)?.solved);
        return { id: p.id, tier: p.tier, solvedBy };
    });
    return {
        generatedAt: new Date().toISOString(),
        config: { recipes, N, maxLlmCalls, problemCount: problems.length },
        perRecipe: recipes.map(r => {
            const { problems: _p, ...s } = byRecipe[r];
            return s;
        }),
        perProblem: byProblem,
        detail: rows,
        pairwise: pairwiseDeltas(recipes, byRecipe)
    };
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
    const { config, perRecipe, perProblem, pairwise } = report;
    const lines = [];
    lines.push('# Search-strategy ablation report');
    lines.push('');
    lines.push(`- Generated: ${report.generatedAt}`);
    lines.push(`- Budget: ${config.maxLlmCalls} LLM calls / lemma, N=${config.N}`);
    lines.push(`- Problems: ${config.problemCount}`);
    lines.push('');
    lines.push('## Pass rate vs. budget');
    lines.push('');
    lines.push('| recipe | solved | pass rate | llm calls | kernel checks | mean llm/solved |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of perRecipe) {
        lines.push(`| ${s.recipe} | ${s.solved}/${s.total} | ${(s.passRate * 100).toFixed(1)}% | ${s.llmCalls} | ${s.tacticCalls} | ${s.meanLlmCallsPerSolved === null ? '—' : s.meanLlmCallsPerSolved.toFixed(1)} |`);
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

async function main() {
    const { BackendRepl } = await import('../lean/backendRepl.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

    const recipesArg = process.argv.find(a => a.startsWith('--recipes='));
    const setArg = process.argv.find(a => a.startsWith('--set='));
    const problemsArg = process.argv.find(a => a.startsWith('--problems='));
    const nArg = process.argv.find(a => a.startsWith('--N='));
    const budgetArg = process.argv.find(a => a.startsWith('--max-llm-calls='));
    const outArg = process.argv.find(a => a.startsWith('--out='));

    const set = setArg ? setArg.split('=')[1] : 'core';
    const problemsSource = set === 'mathlib' ? MATHLIB_PROBLEMS : SMOKE_PROBLEMS;
    if (set !== 'core' && set !== 'mathlib') {
        console.error('unknown problem set; known sets: core, mathlib');
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

    const pool = new BackendRepl({
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 2,
        // Mathlib imports take 5-35s cold; the core set is near-instant.
        timeoutMs: set === 'mathlib' ? 180_000 : 60_000,
        // Mathlib imports accumulate in the repl until it OOMs; give each problem a fresh process.
        workerPerProblem: set === 'mathlib'
    });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    try {
        const report = await runAblation({ backend: pool, llm, problems, recipes, N, maxLlmCalls, outDir });
        console.log(`\nAblation complete: ${recipes.length} recipes x ${problems.length} problems -> ${outDir}`);
        console.log(renderMarkdown(report));
    } finally {
        await pool.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/ablation.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
