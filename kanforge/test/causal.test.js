import test from 'node:test';
import assert from 'node:assert';
import { CausalAnalyzer, compilePredictors, tacticHead } from '../optimization/causal.js';
import { bestOfN } from '../search/bestofn.js';

// Causal streams modeled on agent/loop.js emissions: id/parent chaining per lemma, tactic
// fields on proposal/apply/fail events, ms on lemma outcomes.

let seq = 0;
const lastByLemma = new Map();
function evt(type, { lemmaId = 'L1', tactic = null, parent = true, ms = null, error = null } = {}) {
    const prev = lastByLemma.get(lemmaId) ?? null;
    const e = {
        id: `evt_${++seq}`,
        t: Date.now(),
        type,
        lemmaId,
        ...(tactic != null ? { tactic } : {}),
        ...(parent && prev ? { parent: prev } : {}),
        ...(ms != null ? { ms } : {}),
        ...(error != null ? { error } : {})
    };
    lastByLemma.set(lemmaId, e.id);
    return e;
}

function fresh() {
    seq = 0;
    lastByLemma.clear();
    return [];
}

test('tacticHead normalizes first token', () => {
    assert.strictEqual(tacticHead('rw [Nat.mul_add]'), 'rw');
    assert.strictEqual(tacticHead('  simp '), 'simp');
    assert.strictEqual(tacticHead('rcases h with ⟨a, ha⟩ | hb'), 'rcases');
    assert.strictEqual(tacticHead(''), '');
});

test('transition matrix is action->action Markov probabilities', () => {
    const events = fresh();
    // Only OUTCOME events count as actions (proposals are filtered out by causal.js): the
    // stream is applied(rw), applied(simp), applied(rw), applied(omega).
    events.push(evt('tactic_proposed', { tactic: 'rw [h]' }));
    events.push(evt('tactic_applied', { tactic: 'rw [h]' }));
    events.push(evt('tactic_proposed', { tactic: 'simp' }));
    events.push(evt('tactic_applied', { tactic: 'simp' }));
    events.push(evt('tactic_proposed', { tactic: 'rw [h]' }));
    events.push(evt('tactic_applied', { tactic: 'rw [h]' }));
    events.push(evt('tactic_proposed', { tactic: 'omega' }));
    events.push(evt('tactic_applied', { tactic: 'omega' }));

    const analyzer = new CausalAnalyzer(events);
    const { actions, matrix } = analyzer.getTransitionMatrix();
    assert.ok(actions.includes('rw'));
    assert.strictEqual(matrix.rw.simp, 0.5); // rw->simp once, rw->omega once
    assert.strictEqual(matrix.rw.omega, 0.5);
    assert.strictEqual(matrix.simp.rw, 1.0);
    assert.ok(actions.includes('omega'));
});

test('failure predictors flag sequences preceding FAIL with confidence', () => {
    const events = fresh();
    // Three lemmas where the window [intro, simp] ends in FAIL twice and succeeds once ->
    // support 3, confidence 2/3. Lemma A also repeats the failing `simp` (a within-goal retry).
    const pushLemma = (id, actions) => {
        for (const [i, a] of actions.entries()) {
            const [type, tactic] = a;
            events.push(evt(type, { lemmaId: id, tactic, parent: i > 0 }));
        }
    };
    pushLemma('A', [
        ['tactic_applied', 'intro h'],
        ['tactic_failed', 'simp'],
        ['tactic_failed', 'simp']
    ]);
    pushLemma('B', [
        ['tactic_applied', 'intro h'],
        ['tactic_failed', 'simp']
    ]);
    pushLemma('C', [
        ['tactic_applied', 'intro h'],
        ['tactic_applied', 'simp']
    ]);

    const analyzer = new CausalAnalyzer(events);
    const preds = analyzer.getFailurePredictors({ minSupport: 2 });
    assert.ok(preds.length > 0, 'predictor list must be non-empty');

    // [intro, simp] appears 3x (A, B, C), ends in FAIL 2x -> confidence 2/3, support 3.
    const pair = preds.find(p => p.pattern.join(' ') === 'intro simp');
    assert.ok(pair, 'expected the [intro, simp] window to be a predictor');
    assert.strictEqual(pair.support, 3);
    assert.strictEqual(pair.fails, 2);
    assert.ok(Math.abs(pair.confidence - 2 / 3) < 1e-9);

    // Single-element pattern [simp] must also surface (2 fails / 3 occurrences).
    const single = preds.find(p => p.pattern.length === 1 && p.pattern[0] === 'simp');
    assert.ok(single);
});

test('compilePredictors rejects the final element of a known-failing window', () => {
    const matcher = compilePredictors([
        { pattern: ['intro', 'simp'], confidence: 0.9, support: 3 }
    ]);
    assert.strictEqual(matcher.count, 1);
    // head "simp" after history ending in "intro" -> reject.
    assert.strictEqual(matcher.rejects('simp', ['intro']), true);
    // not enough history -> allow.
    assert.strictEqual(matcher.rejects('simp', []), false);
    // different head -> allow.
    assert.strictEqual(matcher.rejects('omega', ['intro']), false);
    // single-element predictor rejects anywhere (gated: support/confidence present).
    const single = compilePredictors([{ pattern: ['tauto'], confidence: 0.8, support: 5 }]);
    assert.strictEqual(single.rejects('tauto', []), true);
    assert.strictEqual(single.rejects('omega', []), false);
});

test('predictor safety gate: low support or overfit confidence is INERT (never rejects)', () => {
    // support < 2 → inert.
    const lowSupport = compilePredictors([{ pattern: ['ring'], confidence: 0.5, support: 1 }]);
    assert.strictEqual(lowSupport.count, 0);
    assert.strictEqual(lowSupport.inert, 1);
    assert.strictEqual(lowSupport.rejects('ring', []), false);
    // confidence > 0.95 (the overfit case the §5.3 measured run produced) → inert.
    const overfit = compilePredictors([{ pattern: ['ring_nf'], confidence: 1.0, support: 3 }]);
    assert.strictEqual(overfit.count, 0);
    assert.strictEqual(overfit.inert, 1);
    assert.strictEqual(overfit.rejects('ring_nf', []), false);
    // gated pattern (support ≥ 2, confidence ≤ 0.95) rejects.
    const gated = compilePredictors([{ pattern: ['intro', 'simp'], confidence: 0.9, support: 3 }]);
    assert.strictEqual(gated.count, 1);
    assert.strictEqual(gated.rejects('simp', ['intro']), true);
});

test('bottlenecks rank time sinks by event type and lemma', () => {
    const events = fresh();
    events.push(evt('lemma_failed', { ms: 500 }));
    events.push(evt('lemma_failed', { ms: 900 }));
    events.push(evt('lemma_verified', { lemmaId: 'L2', ms: 200 }));

    const analyzer = new CausalAnalyzer(events);
    const b = analyzer.getBottlenecks();
    assert.strictEqual(b.totalMs, 1600);
    assert.strictEqual(b.byEventType[0].type, 'lemma_failed');
    assert.strictEqual(b.byEventType[0].ms, 1400);
    assert.ok(b.byLemma.some(x => x.lemmaId === 'L2' && x.ms === 200));
});

test('anomalies surface guardrail trips and failure clusters', () => {
    const events = fresh();
    events.push(evt('guardrail_trip', { violation: { type: 'PIN_DRIFT' } }));
    events.push(evt('guardrail_trip', { violation: { type: 'PIN_DRIFT' } }));
    for (let i = 0; i < 3; i++) {
        events.push(evt('tactic_failed', { tactic: 'simp' }));
    }

    const analyzer = new CausalAnalyzer(events);
    const anomalies = analyzer.getAnomalies();
    const trip = anomalies.find(a => a.kind === 'guardrail_trip');
    assert.ok(trip, 'guardrail trip must be reported');
    assert.strictEqual(trip.count, 2);
    const cluster = anomalies.find(a => a.kind === 'failure_cluster');
    assert.ok(cluster);
    assert.strictEqual(cluster.head, 'simp');
});

test('critical path returns the deepest per-lemma causal chain', () => {
    const events = fresh();
    // L1: three linked events. L2: two linked events.
    events.push(evt('goal_selected', { lemmaId: 'L1', parent: false }));
    events.push(evt('tactic_proposed', { lemmaId: 'L1', tactic: 'intro', parent: true }));
    events.push(evt('tactic_applied', { lemmaId: 'L1', tactic: 'intro', parent: true }));
    events.push(evt('goal_selected', { lemmaId: 'L2', parent: false }));
    events.push(evt('tactic_proposed', { lemmaId: 'L2', tactic: 'rfl', parent: true }));

    const analyzer = new CausalAnalyzer(events);
    const cp = analyzer.getCriticalPath();
    assert.strictEqual(cp.lemmaId, 'L1');
    assert.strictEqual(cp.length, 3);
});

// §5.3 acceptance, search side: a compiled predictor must move budget OFF the known-failing
// branch — the kernel is never consulted for a tactic that completes a failing window.
test('bestOfN spends no kernel budget on a known-failing window', async () => {
    const goal = { type: 'P → Q', context: [] };
    const backend = {
        applyCalls: [],
        async applyTactic(g, tactic) {
            this.applyCalls.push(tactic);
            return { status: 'error', newGoals: [], error: { message: `rejected: ${tactic}` } };
        }
    };
    // The window [intro, simp] is a predictor: a `simp` proposed right after an applied `intro`
    // is rejected before applyTactic. The llm cycles intro→simp, so every `simp` after the first
    // `intro` is filtered without touching the kernel.
    const predictors = compilePredictors([{ pattern: ['intro', 'simp'], confidence: 0.9, support: 3 }]);
    const llm = {
        calls: 0,
        async complete() {
            return { text: this.calls++ % 2 === 0 ? 'intro' : 'simp' };
        }
    };
    const outcome = await bestOfN(goal, backend, llm, 4, predictors);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.skipped, 2); // the two `simp` proposals after an `intro`
    assert.deepStrictEqual(backend.applyCalls, ['intro', 'intro']); // only non-predictor windows

    // Control: without the predictor, every proposal reaches the kernel.
    const backend2 = {
        applyCalls: [],
        async applyTactic(g, tactic) {
            this.applyCalls.push(tactic);
            return { status: 'error', newGoals: [], error: { message: `rejected: ${tactic}` } };
        }
    };
    const llm2 = {
        calls: 0,
        async complete() {
            return { text: this.calls++ % 2 === 0 ? 'intro' : 'simp' };
        }
    };
    await bestOfN(goal, backend2, llm2, 4, null);
    assert.strictEqual(backend2.applyCalls.length, 4);
});
