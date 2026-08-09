import test from 'node:test';
import assert from 'node:assert';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';
import { computeMetrics } from '../optimization/metrics.js';
import { computeReward, REWARDS } from '../optimization/reward.js';

test('EventBus emit and subscribe', () => {
    const bus = new EventBus();
    let received = null;
    bus.subscribe(e => { received = e; });
    bus.emit({ type: 'TEST_EVENT', data: 42 });
    assert.strictEqual(received.type, 'TEST_EVENT');
    assert.strictEqual(received.data, 42);
    assert.ok(received.id);
    assert.ok(received.t);
});

test('EventStore query and causal chain', () => {
    const store = new EventStore();
    const e1 = { id: 'evt_1', type: 'START' };
    const e2 = { id: 'evt_2', type: 'PROGRESS', parent: 'evt_1' };
    store.append(e1);
    store.append(e2);

    const chain = store.getCausalChain('evt_2');
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].id, 'evt_1');
    assert.strictEqual(chain[1].id, 'evt_2');
});

test('Compute metrics from events', () => {
    const events = [
        { type: 'LEMMA_VERIFIED' },
        { type: 'TACTIC_PROPOSED' },
        { type: 'TACTIC_APPLIED' }
    ];
    const metrics = computeMetrics(events);
    assert.strictEqual(metrics.verifiedLemmas, 1);
    assert.strictEqual(metrics.successRate, 1.0);
});

test('metrics catalog: search-efficiency + quality values from an instrumented stream', () => {
    const events = [
        { type: 'lemma_verified' },
        { type: 'tactic_proposed', goalClassId: 'g1', attempt: 1, llmMs: 100, promptTokens: 10, completionTokens: 5 },
        { type: 'tactic_applied', goalClassId: 'g1' },
        { type: 'subgoal_created' },
        { type: 'goal_solved', goalClassId: 'g1', attempt: 1, via: 'proposal' },
        { type: 'tactic_failed', goalClassId: 'g2', attempt: 2 }
    ];
    const m = computeMetrics(events);
    // baseline
    assert.strictEqual(m.verifiedLemmas, 1);
    // search efficiency
    assert.strictEqual(m.kernelChecksPerSolved, 2);      // applied + failed = 2 / 1 solved
    assert.strictEqual(m.llmCallsPerSolved, 1);
    assert.strictEqual(m.uniqueStatesExplored, 2);        // g1, g2
    // search quality
    assert.strictEqual(m.firstSuccessRank, 1);
    assert.strictEqual(m.branchingFactor, 1);             // 1 subgoal / 1 applied
    // economic
    assert.strictEqual(m.llmLatencyPerTheorem, 0.1);      // 100ms / 1 theorem
    assert.strictEqual(m.llmTokensPerTheorem, 15);        // (10+5)/1
    // documented-null fields (not fabricated)
    assert.strictEqual(m.duplicateStatesAvoided, null);
    assert.strictEqual(m.meanDepth, null);
    assert.strictEqual(m.transpositionHitRate, null);
    assert.strictEqual(m.blueprintLemmasPerTheorem, null);
    assert.strictEqual(m.predictorPrecision, null);
});

test('metrics catalog: firstSuccessRank excludes repair/swiss solves (no attempt rank)', () => {
    const events = [
        { type: 'lemma_verified' },
        { type: 'goal_solved', goalClassId: 'g1', via: 'repair' }, // no attempt
        { type: 'goal_solved', goalClassId: 'g2', attempt: 3, via: 'proposal' }
    ];
    const m = computeMetrics(events);
    assert.strictEqual(m.firstSuccessRank, 3);
});

test('metrics catalog: zero-solve runs emit null cost-per-solved, never NaN', () => {
    const m = computeMetrics([{ type: 'lemma_failed' }, { type: 'tactic_failed' }]);
    assert.strictEqual(m.kernelChecksPerSolved, null);
    assert.strictEqual(m.llmCallsPerSolved, null);
    assert.strictEqual(m.successRate, 0);
});

test('Compute reward from event type', () => {
    assert.strictEqual(computeReward('GOAL_SOLVED'), REWARDS.GOAL_SOLVED);
    assert.strictEqual(computeReward('GUARDRAIL_TRIP'), REWARDS.GUARDRAIL_TRIP);
    assert.strictEqual(computeReward('UNKNOWN'), 0.0);
});
