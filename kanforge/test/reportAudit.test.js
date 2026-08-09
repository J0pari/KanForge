import test from 'node:test';
import assert from 'node:assert';
import { auditAblationReport, auditTrainerReport } from '../bench/reportAudit.js';
import { CausalAnalyzer } from '../optimization/causal.js';

test('ablation audit passes on a self-consistent report', () => {
    const rows = [
        { recipe: 'bestofn', id: 'a', tier: 1, solved: true, error: null, llmCalls: 5, tacticCalls: 3, skipped: 1, ms: 100 },
        { recipe: 'bestofn', id: 'b', tier: 1, solved: false, error: 'budget exhausted', llmCalls: 8, tacticCalls: 2, skipped: 0, ms: 200 },
        { recipe: 'mcgs', id: 'a', tier: 1, solved: false, error: 'budget exhausted', llmCalls: 6, tacticCalls: 4, skipped: 2, ms: 150 },
        { recipe: 'mcgs', id: 'b', tier: 1, solved: true, error: null, llmCalls: 4, tacticCalls: 2, skipped: 0, ms: 90 }
    ];
    const report = {
        generatedAt: 't',
        config: { recipes: ['bestofn', 'mcgs'], N: 4, maxLlmCalls: 60, problemCount: 2 },
        perRecipe: [
            { recipe: 'bestofn', solved: 1, total: 2, passRate: 0.5, llmCalls: 13, tacticCalls: 5, skipped: 1, wallMs: 300, solvedLlmCalls: 5, meanLlmCallsPerSolved: 5, problems: [] },
            { recipe: 'mcgs', solved: 1, total: 2, passRate: 0.5, llmCalls: 10, tacticCalls: 6, skipped: 2, wallMs: 240, solvedLlmCalls: 4, meanLlmCallsPerSolved: 4, problems: [] }
        ],
        perProblem: [
            { id: 'a', tier: 1, solvedBy: ['bestofn'] },
            { id: 'b', tier: 1, solvedBy: ['mcgs'] }
        ],
        detail: rows,
        pairwise: [
            { base: 'bestofn', recipe: 'mcgs', passDelta: 0, meanLlmCalls: 4 }
        ]
    };
    const audit = auditAblationReport(report);
    assert.strictEqual(audit.allOk, true, JSON.stringify(audit.violations));
    assert.ok(audit.checks.length > 5);
});

test('ablation audit flags a fabricated per-recipe total', () => {
    const rows = [
        { recipe: 'bestofn', id: 'a', tier: 1, solved: true, error: null, llmCalls: 5, tacticCalls: 3, skipped: 0, ms: 100 },
        { recipe: 'bestofn', id: 'b', tier: 1, solved: false, error: 'budget exhausted', llmCalls: 8, tacticCalls: 2, skipped: 0, ms: 200 }
    ];
    const report = {
        generatedAt: 't',
        config: { recipes: ['bestofn'], N: 4, maxLlmCalls: 60, problemCount: 2 },
        perRecipe: [
            // llmCalls does NOT equal 5 + 8 = 13
            { recipe: 'bestofn', solved: 1, total: 2, passRate: 0.5, llmCalls: 99, tacticCalls: 5, skipped: 0, wallMs: 300, solvedLlmCalls: 5, meanLlmCallsPerSolved: 5, problems: [] }
        ],
        perProblem: [
            { id: 'a', tier: 1, solvedBy: ['bestofn'] },
            { id: 'b', tier: 1, solvedBy: ['bestofn'] }
        ],
        detail: rows,
        pairwise: []
    };
    const audit = auditAblationReport(report);
    assert.strictEqual(audit.allOk, false);
    assert.ok(audit.violations.some(v => v.check === 'per_recipe_recompute' && v.field === 'llmCalls'));
});

test('ablation audit flags a row that claims solved but carries an error', () => {
    const rows = [
        { recipe: 'bestofn', id: 'a', tier: 1, solved: true, error: 'solved but error set', llmCalls: 5, tacticCalls: 3, skipped: 0, ms: 100 }
    ];
    const report = {
        generatedAt: 't',
        config: { recipes: ['bestofn'], N: 4, maxLlmCalls: 60, problemCount: 1 },
        perRecipe: [
            { recipe: 'bestofn', solved: 1, total: 1, passRate: 1, llmCalls: 5, tacticCalls: 3, skipped: 0, wallMs: 100, solvedLlmCalls: 5, meanLlmCallsPerSolved: 5, problems: [] }
        ],
        perProblem: [{ id: 'a', tier: 1, solvedBy: ['bestofn'] }],
        detail: rows,
        pairwise: []
    };
    const audit = auditAblationReport(report);
    assert.strictEqual(audit.allOk, false);
    assert.ok(audit.violations.some(v => v.check === 'outcome_consistency'));
});

test('ablation audit flags a row that blew its budget', () => {
    const rows = [
        { recipe: 'bestofn', id: 'a', tier: 1, solved: false, error: 'budget exhausted', llmCalls: 61, tacticCalls: 3, skipped: 0, ms: 100 }
    ];
    const report = {
        generatedAt: 't',
        config: { recipes: ['bestofn'], N: 4, maxLlmCalls: 60, problemCount: 1 },
        perRecipe: [
            { recipe: 'bestofn', solved: 0, total: 1, passRate: 0, llmCalls: 61, tacticCalls: 3, skipped: 0, wallMs: 100, solvedLlmCalls: 0, meanLlmCallsPerSolved: null, problems: [] }
        ],
        perProblem: [{ id: 'a', tier: 1, solvedBy: [] }],
        detail: rows,
        pairwise: []
    };
    const audit = auditAblationReport(report);
    assert.strictEqual(audit.allOk, false);
    assert.ok(audit.violations.some(v => v.check === 'budget_respected'));
});

// Trainer report audit: the exact regression class that produced "solved=1 failed=5 events=48"
// (lemmas dispatched with no terminal event). A report whose config says 2 solved + 1 failed but
// whose stream has a lemma with NO terminal must fail the audit.
test('trainer audit passes when every lemma has exactly one terminal', () => {
    const events = [
        { id: 'e1', type: 'lemma_goal', lemmaId: 'L1', statement: 'S1' },
        { id: 'e2', type: 'lemma_verified', lemmaId: 'L1', statement: 'S1' },
        { id: 'e3', type: 'lemma_goal', lemmaId: 'L2', statement: 'S2' },
        { id: 'e4', type: 'lemma_failed', lemmaId: 'L2', statement: 'S2', error: 'boom' },
        { id: 'e5', type: 'lemma_goal', lemmaId: 'L3', statement: 'S3' },
        { id: 'e6', type: 'lemma_failed', lemmaId: 'L3', statement: 'S3', error: 'boom' }
    ];
    const report = {
        config: { window: 3, minSupport: 2, minConfidence: 0.5, problemCount: 3, solved: 1, failed: 2 },
        predictors: [],
        transitionMatrix: {}
    };
    const problems = [
        { id: 'a', statement: 'S1' }, { id: 'b', statement: 'S2' }, { id: 'c', statement: 'S3' }
    ];
    const lemmaIds = new Map([['a', 'L1'], ['b', 'L2'], ['c', 'L3']]);
    const audit = auditTrainerReport(report, { events, problems, lemmaIds });
    assert.strictEqual(audit.allOk, true, JSON.stringify(audit.violations));
});

test('trainer audit flags a lemma with NO terminal (the orphaned-job regression)', () => {
    const events = [
        { id: 'e1', type: 'lemma_goal', lemmaId: 'L1', statement: 'S1' },
        { id: 'e2', type: 'lemma_verified', lemmaId: 'L1', statement: 'S1' },
        { id: 'e3', type: 'lemma_goal', lemmaId: 'L2', statement: 'S2' }, // no terminal
        { id: 'e4', type: 'lemma_goal', lemmaId: 'L3', statement: 'S3' },
        { id: 'e5', type: 'lemma_failed', lemmaId: 'L3', statement: 'S3', error: 'boom' }
    ];
    const report = {
        config: { window: 3, minSupport: 2, minConfidence: 0.5, problemCount: 3, solved: 1, failed: 1 },
        predictors: [],
        transitionMatrix: {}
    };
    const problems = [
        { id: 'a', statement: 'S1' }, { id: 'b', statement: 'S2' }, { id: 'c', statement: 'S3' }
    ];
    const lemmaIds = new Map([['a', 'L1'], ['b', 'L2'], ['c', 'L3']]);
    const audit = auditTrainerReport(report, { events, problems, lemmaIds });
    assert.strictEqual(audit.allOk, false);
    const cov = audit.violations.find(v => v.check === 'terminal_coverage');
    assert.ok(cov, 'terminal_coverage violation must be reported');
    assert.deepStrictEqual(cov.missing, ['b']);
});

test('trainer audit flags a config solved counter that disagrees with the stream', () => {
    const events = [
        { id: 'e1', type: 'lemma_goal', lemmaId: 'L1', statement: 'S1' },
        { id: 'e2', type: 'lemma_verified', lemmaId: 'L1', statement: 'S1' }
    ];
    const report = {
        config: { window: 3, minSupport: 2, minConfidence: 0.5, problemCount: 1, solved: 99, failed: 0 },
        predictors: [],
        transitionMatrix: {}
    };
    const problems = [{ id: 'a', statement: 'S1' }];
    const lemmaIds = new Map([['a', 'L1']]);
    const audit = auditTrainerReport(report, { events, problems, lemmaIds });
    assert.strictEqual(audit.allOk, false);
    assert.ok(audit.violations.some(v => v.check === 'config_counters'));
});

test('trainer audit recomputes predictor support/fails from the event stream', () => {
    const events = [
        { id: 'e1', type: 'lemma_goal', lemmaId: 'L1', statement: 'S1' },
        { id: 'e2', type: 'tactic_failed', lemmaId: 'L1', tactic: 'simp' },
        { id: 'e3', type: 'lemma_failed', lemmaId: 'L1', statement: 'S1', error: 'boom' },
        { id: 'e4', type: 'lemma_goal', lemmaId: 'L2', statement: 'S2' },
        { id: 'e5', type: 'tactic_failed', lemmaId: 'L2', tactic: 'simp' },
        { id: 'e6', type: 'lemma_failed', lemmaId: 'L2', statement: 'S2', error: 'boom' }
    ];
    const analyzer = new CausalAnalyzer(events);
    const predictors = analyzer.getFailurePredictors({ window: 1, minSupport: 2, minConfidence: 0.5 });
    const report = {
        config: { window: 1, minSupport: 2, minConfidence: 0.5, problemCount: 2, solved: 0, failed: 2 },
        predictors,
        transitionMatrix: analyzer.getTransitionMatrix().matrix
    };
    const problems = [{ id: 'a', statement: 'S1' }, { id: 'b', statement: 'S2' }];
    const lemmaIds = new Map([['a', 'L1'], ['b', 'L2']]);
    const audit = auditTrainerReport(report, { events, problems, lemmaIds, analyzer });
    assert.strictEqual(audit.allOk, true, JSON.stringify(audit.violations));

    // Now corrupt one support value and confirm the audit catches it.
    report.predictors[0].support = report.predictors[0].support + 1;
    const audit2 = auditTrainerReport(report, { events, problems, lemmaIds, analyzer });
    assert.strictEqual(audit2.allOk, false);
    assert.ok(audit2.violations.some(v => v.check === 'predictor_recompute' && v.field === 'support'));
});

test('trainer audit flags dangling causal parents', () => {
    const events = [
        { id: 'e1', type: 'lemma_goal', lemmaId: 'L1', statement: 'S1' },
        { id: 'e2', type: 'tactic_applied', lemmaId: 'L1', tactic: 'intro', parent: 'e_missing' },
        { id: 'e3', type: 'lemma_failed', lemmaId: 'L1', statement: 'S1', error: 'boom' }
    ];
    const report = {
        config: { window: 3, minSupport: 2, minConfidence: 0.5, problemCount: 1, solved: 0, failed: 1 },
        predictors: [],
        transitionMatrix: {}
    };
    const problems = [{ id: 'a', statement: 'S1' }];
    const lemmaIds = new Map([['a', 'L1']]);
    const audit = auditTrainerReport(report, { events, problems, lemmaIds });
    assert.strictEqual(audit.allOk, false);
    assert.ok(audit.violations.some(v => v.check === 'causal_parents'));
});
