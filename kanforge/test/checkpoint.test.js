// RunCheckpoint: save/load round-trip, resume from partial run, hash chain integrity.
// Wire into BlueprintRefiner: resume skips proved lemmas.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunCheckpoint, serializeEventStore, deserializeEventStore, CHECKPOINT_FILENAME } from '../core/checkpoint.js';
import { EventStore } from '../optimization/store.js';
import { BlueprintRefiner } from '../blueprint/refine.js';
import { hashStatement } from '../lean/pin.js';
import { hashChainEntry } from '../core/hasher.js';

test('serializeEventStore + deserializeEventStore round-trip', () => {
    const s = new EventStore();
    s.append({ type: 'a', id: 1, parent: null });
    s.append({ type: 'b', id: 2, parent: 1 });
    const events = serializeEventStore(s);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'a');
    const s2 = new EventStore();
    deserializeEventStore(s2, events);
    assert.strictEqual(s2.events.length, 2);
    assert.strictEqual(s2.events[1].parent, 1);
});

test('RunCheckpoint save/load round-trip with hash chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-ckpt-'));
    const ckpt = new RunCheckpoint(dir);
    ckpt.save({
        lemmas: [{ id: 'a', statement: 'theorem t : True := by trivial', deps: [], proof: 'trivial' }],
        rounds: [{ id: 'a', ok: true, resplit: false, added: 0, error: null }],
        hashChain: [{ prevHash: null, statementHash: 's', proofHash: 'p', hash: 'h', outcome: 'verified' }]
    });
    const loaded = ckpt.load();
    assert.ok(loaded);
    assert.strictEqual(loaded.lemmas[0].id, 'a');
    assert.strictEqual(loaded.lemmas[0].proof, 'trivial');
    assert.strictEqual(loaded.rounds.length, 1);
    assert.strictEqual(loaded.hashChain.length, 1);
    assert.strictEqual(loaded.hashChain[0].hash, 'h');
});

test('RunCheckpoint.applyResume marks proved lemmas and restores hash chain', () => {
    const store = new EventStore();
    const checkpoint = {
        lemmas: [{ id: 'x', statement: 'S', proof: 'p', deps: [] }, { id: 'y', statement: 'T', deps: ['x'] }],
        rounds: [{ id: 'x', ok: true }],
        hashChain: [{ prevHash: null, hash: 'abc', outcome: 'verified' }],
        events: [{ type: 'x' }, { type: 'y' }]
    };
    const { proved, hashChain, eventCount } = RunCheckpoint.applyResume(checkpoint, { eventStore: store });
    assert.ok(proved.has('x'));
    assert.strictEqual(proved.get('x').proof, 'p');
    assert.strictEqual(hashChain.length, 1);
    assert.strictEqual(hashChain[0].hash, 'abc');
    assert.strictEqual(eventCount, 2);
    assert.strictEqual(store.events.length, 2);
});

test('RunCheckpoint.verifyHashChain on valid chain', () => {
    const hash = hashChainEntry(null, 's', 'p', 'verified');
    assert.ok(typeof hash === 'string' && hash.length === 64);
    assert.strictEqual(RunCheckpoint.verifyHashChain([{ prevHash: null, statementHash: 's', proofHash: 'p', outcome: 'verified', hash }]).ok, true);
    assert.strictEqual(RunCheckpoint.verifyHashChain([]).ok, true);
    assert.strictEqual(RunCheckpoint.verifyHashChain(null).ok, true);
});

test('resume skips already-proved lemmas in BlueprintRefiner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-resume-'));
    const ckpt = new RunCheckpoint(dir);
    const THM = 'theorem thm : P := by sorry';
    const H = 'theorem helper : P := by sorry';
    const idThm = hashStatement(THM), idH = hashStatement(H);

    // Write a checkpoint with helper already proved
    ckpt.save({
        lemmas: [
            { id: idH, statement: H, deps: [], proof: 'rfl' },
            { id: idThm, statement: THM, deps: [idH] }
        ],
        rounds: [{ id: idH, ok: true, resplit: false, added: 0, error: null }],
        hashChain: []
    });

    class MockBackend {
        async extractGoals(s) { return [{ type: 'P', context: [], sessionKey: 'k' }]; }
        async applyTactic(g, t) { return g.type === 'P' && t === 'rfl' ? { status: 'ok', newGoals: [] } : { status: 'error', newGoals: [], error: { message: 'stuck' } }; }
        async verifyProof() { return { status: 'verified' }; }
        async check() { return { status: 'verified' }; }
        endLemma() {}
        pin() { return { toolchain: 'mock', normVersion: 1 }; }
    }
    class MockLLM {
        async complete() { return { text: 'rfl' }; }
    }

    const refiner = new BlueprintRefiner({
        llm: new MockLLM(),
        backend: new MockBackend(),
        loopOptions: { maxTacticsPerGoal: 1 },
        checkpoint: ckpt
    });

    const bp = {
        theorem: THM,
        lemmas: [
            { id: idH, statement: H, deps: [], pinnedHash: idH },
            { id: idThm, statement: THM, deps: [idH], pinnedHash: idThm }
        ]
    };
    const res = await refiner.refine(bp);

    // helper was already proved in checkpoint → skipped, thm now proved (dep satisfied)
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.proved.length, 2);
    assert.strictEqual(res.rounds.length, 2); // 1 from checkpoint resume + 1 new
    assert.strictEqual(res.rounds[1].id, idThm);

    // checkpoint was updated after the run
    const reloaded = ckpt.load();
    assert.strictEqual(reloaded.lemmas.filter(l => l.proof).length, 2);
    assert.strictEqual(reloaded.rounds.length, 2);
});
