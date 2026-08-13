// Compression-quality metrics tests (architecture.md §0.5/§6.1, research_notes §5): the §0.5
// quantities are pure functions of the event stream — computed when the events carry the data,
// null with a documented reason otherwise, never fabricated. The amortized-cost point rides
// every run's outcome; the curve across runs is a digest-level aggregate, not a per-run fake.
import test from 'node:test';
import assert from 'node:assert';
import { computeMetrics } from '../optimization/metrics.js';
import { TacticLoop } from '../agent/loop.js';
import { MockBackend, MockLLM } from './architectural.test.js';

test('proofDescriptionLength is derived from lemma_verified proof scripts', () => {
    const events = [
        { type: 'lemma_verified', lemmaId: 'a', proofScript: 'by\n  intro h\n  omega' },
        { type: 'lemma_verified', lemmaId: 'b', proofScript: 'by\n  rfl' }
    ];
    const m = computeMetrics(events);
    assert.ok(m.proofDescriptionLength);
    assert.strictEqual(m.proofDescriptionLength.perLemma.length, 2);
    assert.ok(m.proofDescriptionLength.total > 0);
    assert.ok(m.proofDescriptionLength.mean > 0);
});

test('libraryRelativeDescriptionLength counts dictionary reuse as residual-only', () => {
    const events = [
        { type: 'lemma_verified', lemmaId: 'a', proofScript: 'by exact nat_add_comm' },
        { type: 'store_reuse', lemmaId: 'a', lemma: 'nat_add_comm' },
        { type: 'lemma_verified', lemmaId: 'b', proofScript: 'by\n  intro h\n  omega' }
    ];
    const m = computeMetrics(events);
    assert.strictEqual(m.reuseCount, 1);
    assert.ok(m.libraryRelativeDescriptionLength);
    assert.strictEqual(m.libraryRelativeDescriptionLength.reusedCount, 1);
    // The reused lemma's residual (short exact-reference) must be shorter than its sibling's.
    assert.ok(m.libraryRelativeDescriptionLength.total < m.proofDescriptionLength.total);
});

test('compression metrics are null (not fabricated) when no verified events exist', () => {
    const m = computeMetrics([{ type: 'tactic_failed', tactic: 'rfl' }]);
    assert.strictEqual(m.proofDescriptionLength, null);
    assert.strictEqual(m.libraryRelativeDescriptionLength, null);
    assert.strictEqual(m.reuseCount, 0);
});

test('outcome.metrics carries the amortized-cost point; the toggle gates the compression block', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['intro h', 'omega']);
    const loop = new TacticLoop({ backend, llm, maxTacticsPerGoal: 2 });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.strictEqual(outcome.ok, true);
    assert.ok(outcome.metrics.amortizedCostPoint, 'one point per run');
    assert.strictEqual(outcome.metrics.amortizedCostPoint.verifiedLemmas, 1);
    assert.ok(outcome.metrics.proofDescriptionLength !== null, 'compression block on by default');

    const backend2 = new MockBackend();
    const llm2 = new MockLLM(['intro h', 'omega']);
    const off = new TacticLoop({ backend: backend2, llm: llm2, maxTacticsPerGoal: 2, compressionMetrics: false });
    off.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcomeOff = await off.proveAll();
    assert.strictEqual(outcomeOff.ok, true);
    assert.strictEqual(outcomeOff.metrics.proofDescriptionLength, null);
    assert.strictEqual(outcomeOff.metrics.libraryRelativeDescriptionLength, null);
    assert.strictEqual(outcomeOff.metrics.reuseCount, null);
    assert.ok(outcomeOff.metrics.amortizedCostPoint, 'the curve point rides regardless of the toggle');
});
