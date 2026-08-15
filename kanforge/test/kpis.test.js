// optimization/kpis.js — verification-throughput KPIs recomputed from the event stream.
import test from 'node:test';
import assert from 'node:assert';
import { computePassKpis } from '../optimization/kpis.js';

function ev(type, extra = {}) {
    return { id: `${type}_${Math.random()}`, type, ...extra };
}

test('KPIs normalize per verified theorem and handle zero-verified passes', () => {
    const events = [
        ev('tactic_proposed'), ev('tactic_proposed'),
        ev('tactic_applied'), ev('tactic_failed'),
        ev('goal_selected'), ev('goal_selected'), ev('goal_selected'),
        ev('store_reuse'),
        ev('lemma_verified', { ms: 10000 }),
        ev('lemma_failed', { ms: 5000 })
    ];
    const { passKpis } = computePassKpis({ events, rounds: [{ ok: true }], backendInfos: { warmChecks: 40, coldChecks: 10, restarts: 2, hangs: 0, timeouts: 1, parseErrors: 0 } });
    assert.strictEqual(passKpis.verified, 1);
    assert.strictEqual(passKpis.llmCallsPerVerified, 2);
    assert.strictEqual(passKpis.kernelOpsPerVerified, 2);
    assert.strictEqual(passKpis.goalExpansionsPerVerified, 3);
    assert.strictEqual(passKpis.searchWallSecondsPerVerified, 15);
    assert.strictEqual(passKpis.replRestartsPerVerified, 2);
    assert.strictEqual(passKpis.reuseHitRate, 0.5);
    assert.strictEqual(passKpis.warmColdCheckRatio, 4);
    assert.deepStrictEqual(passKpis.pool, { warmChecks: 40, coldChecks: 10, restarts: 2, hangs: 0, timeouts: 1, parseErrors: 0 });
});

test('zero-verified pass reports null per-theorem rates, not NaN', () => {
    const { passKpis } = computePassKpis({ events: [ev('lemma_failed', { ms: 1000 })], rounds: [{ ok: false }], backendInfos: null });
    assert.strictEqual(passKpis.verified, 0);
    assert.strictEqual(passKpis.llmCallsPerVerified, null);
    assert.strictEqual(passKpis.searchWallSecondsPerVerified, null);
    assert.strictEqual(passKpis.warmColdCheckRatio, null);
    assert.strictEqual(passKpis.pool.warmChecks, null);
});
