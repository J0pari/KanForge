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

test('Compute reward from event type', () => {
    assert.strictEqual(computeReward('GOAL_SOLVED'), REWARDS.GOAL_SOLVED);
    assert.strictEqual(computeReward('GUARDRAIL_TRIP'), REWARDS.GUARDRAIL_TRIP);
    assert.strictEqual(computeReward('UNKNOWN'), 0.0);
});
