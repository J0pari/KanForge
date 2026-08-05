// TrainingDataset (build_order.md §6.4) — monotonic growth, held-out split, contamination check.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrainingDataset } from '../growth/dataset.js';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-dataset-'));
}

test('samples persist across instances (monotonic growth)', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        ds.addSample({ type: 'a < c', context: [] }, 'omega', 'verified');
        ds.addSample({ type: 'a < c', context: [] }, 'linarith', 'failed');

        const reloaded = new TrainingDataset({ dir });
        assert.strictEqual(reloaded.samples.length, 2);
        assert.strictEqual(reloaded.samples[0].tactic, 'omega');
        assert.strictEqual(reloaded.samples[1].outcome, 'failed');
        assert.ok(reloaded.samples.every(s => s.id && s.timestamp && (s.split === 'train' || s.split === 'held-out')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('train and held-out splits partition all samples', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        for (let i = 0; i < 50; i++) {
            ds.addSample({ type: `goal ${i}`, context: [] }, 'rfl', 'verified');
        }
        const train = ds.trainSplit();
        const held = ds.heldOutSplit();
        assert.strictEqual(train.length + held.length, 50);
        const overlap = train.filter(t => held.includes(t));
        assert.strictEqual(overlap.length, 0);
        assert.ok(held.length > 0, 'expected a non-empty held-out split');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('split assignment is deterministic per state', () => {
    const dir = tmpDir();
    try {
        const a = new TrainingDataset({ dir });
        const b = new TrainingDataset({ dir: path.join(dir, 'other') });
        const state = { type: 'Q', context: [{ name: 'h', type: 'P' }] };
        a.addSample(state, 'exact h', 'verified');
        b.addSample(state, 'exact h', 'verified');
        assert.strictEqual(a.samples[0].split, b.samples[0].split);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('contaminationCheck reports benchmark overlap and stays clean otherwise', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        ds.recordProblem('theorem mini : 1 + 1 = 2 := by sorry', { source: 'target-list' });
        ds.recordProblem('theorem own : a + b = b + a := by sorry', { source: 'target-list' });

        const clean = ds.contaminationCheck({ miniF2F: ['theorem other : 2 + 2 = 4 := by sorry'] });
        assert.strictEqual(clean.clean, true);
        assert.deepStrictEqual(clean.overlaps, []);

        const dirty = ds.contaminationCheck({ miniF2F: ['theorem mini : 1 + 1 = 2 := by sorry'] });
        assert.strictEqual(dirty.clean, false);
        assert.strictEqual(dirty.overlaps.length, 1);
        assert.strictEqual(dirty.overlaps[0].set, 'miniF2F');
        assert.ok(dirty.overlaps[0].statement.includes('1 + 1 = 2'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('problems persist across instances', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        ds.recordProblem('theorem t : True := by sorry', { source: 'target-list' });
        const reloaded = new TrainingDataset({ dir });
        assert.strictEqual(reloaded.problems.length, 1);
        assert.strictEqual(reloaded.problems[0].statementHash, ds.problems[0].statementHash);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('exportJson contains samples and problems', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        ds.addSample({ type: 'P', context: [] }, 'assumption', 'verified');
        ds.recordProblem('theorem t : P → P := by sorry', { source: 'target' });
        const parsed = JSON.parse(ds.exportJson());
        assert.strictEqual(parsed.samples.length, 1);
        assert.strictEqual(parsed.problems.length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('corrupt JSONL line is recorded, not fatal', () => {
    const dir = tmpDir();
    try {
        const ds = new TrainingDataset({ dir });
        ds.addSample({ type: 'P', context: [] }, 'assumption', 'verified');
        fs.appendFileSync(path.join(dir, 'samples.jsonl'), '{ not json\n');
        const reloaded = new TrainingDataset({ dir });
        assert.strictEqual(reloaded.samples.length, 1);
        assert.strictEqual(reloaded.getCorrupt().length, 1);
        assert.strictEqual(reloaded.getCorrupt()[0].file, 'samples.jsonl');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
