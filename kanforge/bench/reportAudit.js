// Report self-audit (build_order.md §5.3/§5.4 auditability).
//
// Every post-run JSON artifact (ablation report, trainer report) carries an `audit` block that
// RECOMPUTES its own aggregates from the raw rows and flags any inconsistency. The point: a
// subtle logical bug (a lemma with no terminal event, a per-recipe total that does not equal the
// sum of its rows, a predictor whose reported support does not match the event stream) must not
// survive human scrutiny of the artifact alone.
//
// Each audit is a list of checks; every check records { ok, observed } and any mismatch is also
// pushed to `violations` with enough context to locate the row. `allOk` is the conjunction.

import { CausalAnalyzer } from '../optimization/causal.js';
import { wilsonInterval } from './ablation.js';

// ---------------------------------------------------------------------------
// Ablation report (bench/ablation.js → report.json)

export function auditAblationReport(report) {
    const checks = [];
    const violations = [];
    const ok = (name, passed, observed) => {
        checks.push({ check: name, ok: passed, observed });
        return passed;
    };
    const bad = (name, context) => violations.push({ check: name, ...context });

    const rows = report.detail ?? [];
    const perRecipe = report.perRecipe ?? [];
    const perProblem = report.perProblem ?? [];
    const recipes = report.config?.recipes ?? [];
    const maxLlmCalls = report.config?.maxLlmCalls ?? null;

    // Row coverage: every (recipe, problem) cell exactly once.
    const cellCount = recipes.length * perProblem.length;
    const seen = new Set();
    let duplicates = 0;
    for (const r of rows) {
        const key = `${r.recipe}\u0001${r.id}`;
        if (seen.has(key)) { duplicates++; bad('row_uniqueness', { key }); }
        seen.add(key);
    }
    const missing = recipes.length * perProblem.length - seen.size;
    if (missing > 0) bad('row_coverage', { expected: cellCount, actual: seen.size, missing });
    ok('row_coverage', duplicates === 0 && missing === 0, { expected: cellCount, actual: seen.size, duplicates, missing });

    // Per-recipe aggregates recompute from rows.
    for (const s of perRecipe) {
        const recipeRows = rows.filter(r => r.recipe === s.recipe);
        const recomputed = {
            solved: recipeRows.filter(r => r.solved).length,
            llmCalls: recipeRows.reduce((n, r) => n + (r.llmCalls ?? 0), 0),
            tacticCalls: recipeRows.reduce((n, r) => n + (r.tacticCalls ?? 0), 0),
            skipped: recipeRows.reduce((n, r) => n + (r.skipped ?? 0), 0),
            wallMs: recipeRows.reduce((n, r) => n + (r.ms ?? 0), 0),
            solvedLlmCalls: recipeRows.filter(r => r.solved).reduce((n, r) => n + (r.llmCalls ?? 0), 0)
        };
        for (const field of ['solved', 'llmCalls', 'tacticCalls', 'skipped', 'wallMs', 'solvedLlmCalls']) {
            if (s[field] !== recomputed[field]) {
                bad('per_recipe_recompute', { recipe: s.recipe, field, reported: s[field], recomputed: recomputed[field] });
            }
        }
        const expectedRate = recipeRows.length ? recomputed.solved / recipeRows.length : 0;
        if (Math.abs(s.passRate - expectedRate) > 1e-9) {
            bad('per_recipe_recompute', { recipe: s.recipe, field: 'passRate', reported: s.passRate, recomputed: expectedRate });
        }
        if (s.solved) {
            const expectedMean = recomputed.solvedLlmCalls / recomputed.solved;
            if (Math.abs(s.meanLlmCallsPerSolved - expectedMean) > 1e-9) {
                bad('per_recipe_recompute', { recipe: s.recipe, field: 'meanLlmCallsPerSolved', reported: s.meanLlmCallsPerSolved, recomputed: expectedMean });
            }
        } else if (s.meanLlmCallsPerSolved !== null) {
            bad('per_recipe_recompute', { recipe: s.recipe, field: 'meanLlmCallsPerSolved', reported: s.meanLlmCallsPerSolved, recomputed: null });
        }
        // solved + failed cannot exceed total.
        const failed = recipeRows.filter(r => !r.solved).length;
        if (recomputed.solved + failed !== recipeRows.length) {
            bad('outcome_exhaustiveness', { recipe: s.recipe, solved: recomputed.solved, failed, total: recipeRows.length });
        }
    }
    ok('per_recipe_recompute', !violations.some(v => v.check === 'per_recipe_recompute'), {});

    // CI recompute: passRateCI must equal wilsonInterval(solved, total) (or be null for < 2 rows).
    for (const s of perRecipe) {
        const recipeRows = rows.filter(r => r.recipe === s.recipe);
        const solved = recipeRows.filter(r => r.solved).length;
        const expected = wilsonInterval(solved, recipeRows.length);
        const reported = s.passRateCI ?? null;
        const same = expected === null && reported === null
            ? true
            : expected !== null && reported !== null &&
              Math.abs(expected[0] - reported[0]) < 1e-9 && Math.abs(expected[1] - reported[1]) < 1e-9;
        if (!same) {
            bad('pass_rate_ci_recompute', { recipe: s.recipe, reported, recomputed: expected });
        }
    }
    ok('pass_rate_ci_recompute', !violations.some(v => v.check === 'pass_rate_ci_recompute'), {});

    // Provenance: a benchmark run must carry the §5.7 provenance block with non-null keys.
    const prov = report.config?.provenance ?? null;
    const provMissing = prov ? ['toolchain', 'leanProject', 'model', 'provider', 'corpus'].filter(k => prov[k] == null) : ['entire block'];
    if (provMissing.length) bad('provenance_present', { missing: provMissing });
    ok('provenance_present', provMissing.length === 0, { missing: provMissing });

    // Solved rows carry no error; failed rows carry one. A "solved" row whose error is set, or
    // a row with neither solved nor error, means the outcome enum is inconsistent.
    for (const r of rows) {
        const hasError = r.error != null && r.error !== '';
        if (r.solved && hasError) bad('outcome_consistency', { recipe: r.recipe, id: r.id, note: 'solved row carries an error' });
        if (!r.solved && !hasError) bad('outcome_consistency', { recipe: r.recipe, id: r.id, note: 'unsolved row carries no error' });
        if (maxLlmCalls != null && (r.llmCalls ?? 0) > maxLlmCalls) {
            bad('budget_respected', { recipe: r.recipe, id: r.id, llmCalls: r.llmCalls, maxLlmCalls });
        }
        if ((r.skipped ?? 0) > (r.llmCalls ?? 0)) {
            bad('skip_bound', { recipe: r.recipe, id: r.id, skipped: r.skipped, llmCalls: r.llmCalls });
        }
    }
    ok('outcome_consistency', !violations.some(v => v.check === 'outcome_consistency'), {});
    ok('budget_respected', !violations.some(v => v.check === 'budget_respected'), {});
    ok('skip_bound', !violations.some(v => v.check === 'skip_bound'), {});

    // Per-problem solvedBy recomputes from rows.
    for (const p of perProblem) {
        const solvedBy = rows.filter(r => r.id === p.id && r.solved).map(r => r.recipe).sort();
        const reported = [...(p.solvedBy ?? [])].sort();
        if (JSON.stringify(solvedBy) !== JSON.stringify(reported)) {
            bad('per_problem_recompute', { id: p.id, reported, recomputed: solvedBy });
        }
    }
    ok('per_problem_recompute', !violations.some(v => v.check === 'per_problem_recompute'), {});

    // Pairwise deltas recompute from per-recipe pass rates.
    for (const d of report.pairwise ?? []) {
        const base = perRecipe.find(s => s.recipe === d.base);
        const target = perRecipe.find(s => s.recipe === d.recipe);
        if (!base || !target) { bad('pairwise_recompute', { note: `missing base/target for ${d.base}->${d.recipe}` }); continue; }
        if (Math.abs(d.passDelta - (target.passRate - base.passRate)) > 1e-9) {
            bad('pairwise_recompute', { base: d.base, recipe: d.recipe, reported: d.passDelta, recomputed: target.passRate - base.passRate });
        }
    }
    ok('pairwise_recompute', !violations.some(v => v.check === 'pairwise_recompute'), {});

    return {
        schema: 'ablation-report/audit.v1',
        checkCount: checks.length,
        passed: checks.filter(c => c.ok).length,
        checks,
        violations,
        allOk: violations.length === 0
    };
}

// ---------------------------------------------------------------------------
// Trainer report (bench/trainPredictors.js → predictors_<set>.json)

// A trainer report must satisfy: every problem lemma has EXACTLY ONE terminal event
// (lemma_verified XOR lemma_failed); the config solved/failed counters equal the terminal
// counts in the event stream; each predictor's support/fails recompute from the events; the
// transition matrix rows sum to 1. This is the class of inconsistency that previously
// produced "solved=1 failed=5 events=48" with four lemmas silently lacking a terminal.
export function auditTrainerReport(report, { events = [], problems = [], lemmaIds = null, analyzer = null } = {}) {
    const checks = [];
    const violations = [];
    const ok = (name, passed, observed) => {
        checks.push({ check: name, ok: passed, observed });
        return passed;
    };
    const bad = (name, context) => violations.push({ check: name, ...context });

    const terminalTypes = ['lemma_verified', 'lemma_failed'];
    const terminalsByLemma = new Map();
    for (const e of events) {
        if (!terminalTypes.includes(e.type)) continue;
        const lid = e.lemmaId;
        if (!lid) { bad('terminal_has_lemma_id', { id: e.id, type: e.type }); continue; }
        if (!terminalsByLemma.has(lid)) terminalsByLemma.set(lid, []);
        terminalsByLemma.get(lid).push(e.type);
    }

    // Every problem lemma must have exactly one terminal. lemmaIds maps problem.id ->
    // hashStatement(statement) as captured by addLemma, so the audit does not re-derive hashes.
    const problemLemmas = problems.map(p => ({ id: p.id, lemmaId: lemmaIds?.get(p.id) ?? null }));
    const missingTerminal = [];
    const doubleTerminal = [];
    const unmapable = [];
    for (const p of problemLemmas) {
        if (!p.lemmaId) { unmapable.push(p.id); continue; }
        const terms = terminalsByLemma.get(p.lemmaId) ?? [];
        if (terms.length === 0) missingTerminal.push(p.id);
        if (terms.length > 1) doubleTerminal.push({ id: p.id, types: terms });
    }
    if (unmapable.length) bad('terminal_lemma_id_map', { unmapable });
    if (missingTerminal.length) bad('terminal_coverage', { missing: missingTerminal });
    if (doubleTerminal.length) bad('terminal_exclusivity', { double: doubleTerminal });
    ok('terminal_lemma_id_map', unmapable.length === 0, { unmapable });
    ok('terminal_coverage', missingTerminal.length === 0, { problems: problemLemmas.length, withTerminal: problemLemmas.length - missingTerminal.length, missing: missingTerminal });
    ok('terminal_exclusivity', doubleTerminal.length === 0, { double: doubleTerminal });
    if (missingTerminal.length) bad('terminal_coverage', { missing: missingTerminal });
    if (doubleTerminal.length) bad('terminal_exclusivity', { double: doubleTerminal });
    ok('terminal_coverage', missingTerminal.length === 0, { problems: problemLemmas.length, withTerminal: problemLemmas.length - missingTerminal.length, missing: missingTerminal });
    ok('terminal_exclusivity', doubleTerminal.length === 0, { double: doubleTerminal });

    // Config solved/failed must equal the terminal counts in the stream. The stream counts must
    // be computed over PROBLEM lemmas only (not any stray lemmaId in the store).
    const streamSolved = new Set();
    const streamFailed = new Set();
    let problemTerminalCount = 0;
    const cfg = report.config ?? {};
    for (const p of problemLemmas) {
        const terms = terminalsByLemma.get(p.lemmaId ?? '') ?? [];
        if (terms.includes('lemma_verified')) streamSolved.add(p.lemmaId);
        if (terms.includes('lemma_failed')) streamFailed.add(p.lemmaId);
        if (terms.length) problemTerminalCount++;
    }
    if (cfg.solved !== streamSolved.size) bad('config_counters', { field: 'solved', reported: cfg.solved, recomputed: streamSolved.size });
    if (cfg.failed !== streamFailed.size) bad('config_counters', { field: 'failed', reported: cfg.failed, recomputed: streamFailed.size });
    if (problemLemmas.length && problemTerminalCount !== problemLemmas.length) {
        bad('config_counters', { note: 'terminal count != problem count', solved: streamSolved.size, failed: streamFailed.size, problems: problemLemmas.length });
    }
    ok('config_counters', !violations.some(v => v.check === 'config_counters'), { solved: streamSolved.size, failed: streamFailed.size });

    // Predictor support/fails must recompute from the events under the SAME window/minSupport.
    const realAnalyzer = analyzer ?? new CausalAnalyzer(events);
    if (Array.isArray(report.predictors) && report.predictors.length) {
        const recomputed = realAnalyzer.getFailurePredictors({
            window: cfg.window ?? 3,
            minSupport: cfg.minSupport ?? 1,
            minConfidence: 0
        });
        const byKey = new Map(recomputed.map(p => [p.pattern.join('\u0001'), p]));
        for (const p of report.predictors) {
            const k = p.pattern.join('\u0001');
            const rc = byKey.get(k);
            if (!rc) { bad('predictor_recompute', { pattern: p.pattern, note: 'pattern absent from event stream' }); continue; }
            if (rc.support !== p.support) bad('predictor_recompute', { pattern: p.pattern, field: 'support', reported: p.support, recomputed: rc.support });
            if (rc.fails !== p.fails) bad('predictor_recompute', { pattern: p.pattern, field: 'fails', reported: p.fails, recomputed: rc.fails });
            const expectedConf = rc.support ? rc.fails / rc.support : 0;
            if (Math.abs(expectedConf - p.confidence) > 1e-9) bad('predictor_recompute', { pattern: p.pattern, field: 'confidence', reported: p.confidence, recomputed: expectedConf });
        }
        // And no reported predictor may have drifted above the configured confidence floor.
        for (const p of report.predictors) {
            if (p.confidence < (cfg.minConfidence ?? 0) - 1e-9) bad('predictor_floor', { pattern: p.pattern, confidence: p.confidence, minConfidence: cfg.minConfidence });
        }
    }
    ok('predictor_recompute', !violations.some(v => v.check === 'predictor_recompute'), {});
    ok('predictor_floor', !violations.some(v => v.check === 'predictor_floor'), {});

    // Transition matrix rows must sum to ~1.
    const matrix = report.transitionMatrix ?? {};
    const badRows = [];
    for (const [from, row] of Object.entries(matrix)) {
        const sum = Object.values(row).reduce((s, v) => s + Number(v), 0);
        if (Math.abs(sum - 1) > 1e-9) badRows.push({ from, sum });
    }
    if (badRows.length) bad('transition_matrix_sums', { rows: badRows });
    ok('transition_matrix_sums', badRows.length === 0, { rows: badRows });

    // Parent chains must resolve (no dangling causal parent).
    const ids = new Set(events.map(e => e.id));
    const dangling = [];
    for (const e of events) {
        if (e.parent != null && !ids.has(e.parent)) dangling.push({ id: e.id, parent: e.parent });
    }
    if (dangling.length) bad('causal_parents', { dangling });
    ok('causal_parents', dangling.length === 0, { dangling: dangling.length });

    return {
        schema: 'trainer-report/audit.v1',
        checkCount: checks.length,
        passed: checks.filter(c => c.ok).length,
        checks,
        violations,
        allOk: violations.length === 0
    };
}
