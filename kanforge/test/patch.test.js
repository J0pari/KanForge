// Patch algebra — typed mutation record (architecture.md §2.7, build_order.md §5.9).
// The patch is the typed form of the loop's core operation, projected from the LIVE event
// stream: patchFromEvent(e) maps a loop event to { node, op, replacement, scope, meta }.
import test from 'node:test';
import assert from 'node:assert';
import { Patch, PATCH_OPS, patchFromEvent, patchStreamFromEvents } from '../core/patch.js';

test('Patch validates its op at construction', () => {
    const p = new Patch({ node: 'g1', op: 'tactic', replacement: 'intro h' });
    assert.strictEqual(p.op, 'tactic');
    assert.strictEqual(p.node, 'g1');
    assert.strictEqual(p.replacement, 'intro h');
    assert.throws(() => new Patch({ node: 'g1', op: 'nonsense' }), /unknown patch op/);
    assert.deepStrictEqual(PATCH_OPS, ['tactic', 'lemma', 'rewrite', 'replace', 'reuse']);
});

test('patchFromEvent projects a tactic event with its meta', () => {
    const e = {
        type: 'tactic_proposed',
        goalClassId: 'g1',
        tactic: 'rw [Nat.mul_comm]',
        attempt: 2,
        llmMs: 150,
        promptTokens: 10,
        completionTokens: 5,
        via: 'proposal'
    };
    const p = patchFromEvent(e);
    assert.strictEqual(p.op, 'tactic');
    assert.strictEqual(p.node, 'g1');
    assert.strictEqual(p.replacement, 'rw [Nat.mul_comm]');
    assert.strictEqual(p.scope, 'goal');
    assert.deepStrictEqual(p.meta, { attempt: 2, llmMs: 150, promptTokens: 10, completionTokens: 5, via: 'proposal' });
});

test('patchFromEvent maps failure + lemma events; returns null for telemetry-only events', () => {
    assert.strictEqual(patchFromEvent({ type: 'tactic_failed', goalClassId: 'g1', tactic: 'ring', error: 'no' }).op, 'tactic');
    assert.strictEqual(patchFromEvent({ type: 'goal_solved', goalClassId: 'g1', tactic: 'rfl', via: 'proposal' }).op, 'tactic');
    assert.strictEqual(patchFromEvent({ type: 'lemma_verified', lemmaId: 'l1' }).op, 'lemma');
    assert.strictEqual(patchFromEvent({ type: 'goal_selected', goalClassId: 'g1' }), null); // telemetry only
    assert.strictEqual(patchFromEvent({ type: 'llm_error' }), null);
    assert.strictEqual(patchFromEvent(null), null);
});

test('patchStreamFromEvents builds the ordered transformation history', () => {
    const events = [
        { type: 'goal_selected', goalClassId: 'g1' },              // telemetry — skipped
        { type: 'tactic_proposed', goalClassId: 'g1', tactic: 'intro h', attempt: 1 },
        { type: 'tactic_applied', goalClassId: 'g1', tactic: 'intro h' },
        { type: 'subgoal_created' },
        { type: 'tactic_proposed', goalClassId: 'g2', tactic: 'rfl', attempt: 1 },
        { type: 'goal_solved', goalClassId: 'g2', tactic: 'rfl' },
        { type: 'lemma_verified', lemmaId: 'l1' }
    ];
    const stream = patchStreamFromEvents(events);
    assert.strictEqual(stream.length, 6); // 5 tactic-ish + terminal lemma_verified
    assert.strictEqual(stream[0].op, 'tactic');
    assert.strictEqual(stream[0].replacement, 'intro h');
    assert.strictEqual(stream[stream.length - 1].op, 'lemma');
});
