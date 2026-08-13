// Learning-stack integrations (architecture.md §6.2): preference-pair persistence, temporal
// held-out predictor mining, per-run GRPO records, and the three-level reward channel.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrainingDataset } from '../growth/dataset.js';
import { swissRank, parseJudgeVerdict } from '../search/swiss.js';
import { eventsFromDatasetSamples, compilePredictorsFromDataset, lemmaTrajectory } from '../optimization/causal.js';
import { trajectoriesFromEvents, groupAdvantages } from '../optimization/grpo.js';

test('dataset persists preference pairs with deterministic split', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-pref-'));
    const ds = new TrainingDataset({ dir });
    ds.addPreference({ goalShape: 'a + b = b + a', tacticA: 'rw [add_comm]', tacticB: 'omega', winner: 'a' });
    ds.addPreference({ goalShape: 'a + b = b + a', tacticA: 'rw [add_comm]', tacticB: 'omega', winner: 'b' });

    const reloaded = new TrainingDataset({ dir });
    assert.strictEqual(reloaded.preferences.length, 2);
    assert.strictEqual(reloaded.preferences[0].winner, 'a');
    assert.strictEqual(reloaded.preferences[0].tacticA, 'rw [add_comm]');
    // same triple → same split, deterministically
    assert.strictEqual(reloaded.preferences[0].split, reloaded.preferences[1].split);
    assert.ok(fs.existsSync(path.join(dir, 'preferences.jsonl')));
});

test('swissRank reports every judged pair through onOutcome', async () => {
    const judge = async (a, b) => (a === 'x' ? 'a' : 'b');
    const seen = [];
    await swissRank(['x', 'y', 'z'], judge, { onOutcome: o => seen.push(o) });
    // full round-robin of 3 candidates = 3 pairs
    assert.strictEqual(seen.length, 3);
    for (const o of seen) {
        assert.ok(typeof o.tacticA === 'string' && typeof o.tacticB === 'string');
        assert.ok(['a', 'b', 'equal'].includes(o.result));
    }
});

test('dataset sample trajectories mine into temporal held-out predictors', () => {
    const samples = [
        // rw→omega failing in 3 of 4 occurrences: confidence 0.75 — above minConfidence,
        // below the 0.95 overfit ceiling
        { id: 's1', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] },
        { id: 's2', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] },
        { id: 's3', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] },
        { id: 's4', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: false }] }
    ];
    const events = eventsFromDatasetSamples(samples);
    assert.strictEqual(events.length, 8);
    assert.strictEqual(events.filter(e => e.type === 'tactic_failed').length, 3);

    const compiled = compilePredictorsFromDataset(samples, { minSupport: 2 });
    assert.ok(compiled.count >= 1, 'rw→omega failing window compiled');
    assert.ok(compiled.rejects('omega', ['rw']), 'known-failing window rejected');
});

test('predictors with sub-gate support are inert, never reject', () => {
    const samples = [
        { id: 's1', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] }
    ];
    const compiled = compilePredictorsFromDataset(samples, { minSupport: 2 });
    assert.strictEqual(compiled.count, 0, 'single support below gate → inert');
    assert.strictEqual(compiled.rejects('omega', ['rw']), false);
});

test('predictors at the overfit confidence ceiling are inert', () => {
    // 100% failure confidence on rw→omega — exactly the overfit case the ceiling guards
    const samples = [
        { id: 's1', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] },
        { id: 's2', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] },
        { id: 's3', trajectory: [{ tactic: 'rw', failed: false }, { tactic: 'omega', failed: true }] }
    ];
    const compiled = compilePredictorsFromDataset(samples, { minSupport: 2 });
    assert.strictEqual(compiled.count, 0, 'confidence 1.0 > 0.95 ceiling → inert');
});

test('lemmaTrajectory extracts per-lemma tactic outcomes in emit order', () => {
    const events = [
        { type: 'tactic_applied', lemmaId: 'L', tactic: 'intro h' },
        { type: 'tactic_failed', lemmaId: 'L', tactic: 'omega' },
        { type: 'tactic_applied', lemmaId: 'L', tactic: 'exact h' }
    ];
    const t = lemmaTrajectory(events, 'L');
    assert.deepStrictEqual(t, [
        { tactic: 'intro', failed: false },
        { tactic: 'omega', failed: true },
        { tactic: 'exact', failed: false }
    ]);
});

test('GRPO group advantages are computed over the run, not per lemma', () => {
    const events = [
        { type: 'tactic_proposed', lemmaId: 'A', tactic: 'rfl' },
        { type: 'goal_solved', lemmaId: 'A' },
        { type: 'tactic_proposed', lemmaId: 'B', tactic: 'omega' },
        { type: 'tactic_failed', lemmaId: 'B' }
    ];
    const trajs = trajectoriesFromEvents(events);
    assert.strictEqual(trajs.length, 2);
    const withAdv = groupAdvantages(trajs);
    const solved = withAdv.find(t => t.lemmaId === 'A');
    const failed = withAdv.find(t => t.lemmaId === 'B');
    assert.ok(solved.advantage > 0);
    assert.ok(failed.advantage < 0);
});

test('progress samples record state, tactic, and outcome', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-prog-'));
    const ds = new TrainingDataset({ dir });
    const sample = ds.addSample({ lemma: 'theorem t', goalType: 'p = 2' }, 'rw [hk]', 'progress');
    assert.strictEqual(sample.outcome, 'progress');
    assert.strictEqual(sample.state.goalType, 'p = 2');
    assert.strictEqual(sample.tactic, 'rw [hk]');
    assert.strictEqual(ds.samples.length, 1);
});
