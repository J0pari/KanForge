// Systems integration & coordination tests (TacticLoop + EventBus + Guardrails + Session).

import test from 'node:test';
import assert from 'node:assert';
import { TacticLoop } from '../agent/loop.js';
import { MockBackend, MockLLM } from './architectural.test.js';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';
import { hashChainEntry, verifyHashChain } from '../core/hasher.js';
import { hashStatement } from '../lean/pin.js';

test('TacticLoop emits events to EventBus/Store with causal parent chaining', async () => {
    const bus = new EventBus();
    const store = new EventStore();
    bus.subscribe(e => store.append(e));

    const backend = new MockBackend();
    const llm = new MockLLM(['intro h', 'omega']);
    const loop = new TacticLoop({ backend, llm, bus, store, maxTacticsPerGoal: 2 });

    const lemmaId = loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, true);

    // Verify events stored
    const events = store.events;
    assert.ok(events.length > 5);

    // Filter events for this lemma
    const lemmaEvents = events.filter(e => e.lemmaId === lemmaId);
    assert.ok(lemmaEvents.length >= 4);

    // Verify causal parent chain: each lemma event's parent is the id of the previous event for that lemma
    for (let i = 1; i < lemmaEvents.length; i++) {
        assert.strictEqual(lemmaEvents[i].parent, lemmaEvents[i - 1].id);
    }
});

test('TacticLoop trips guardrail and emits statement_weakened when statement pin is tampered', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['omega']);
    const loop = new TacticLoop({ backend, llm, maxTacticsPerGoal: 1 });

    const lemmaId = loop.addLemma('example : 1 = 1 := by sorry');

    // Tamper pin to simulate a statement weakening attack
    loop.pins.set(lemmaId, { statementHash: 'bad_tampered_hash', normVersion: 1 });

    const outcome = await loop.proveAll();

    // Verification should fail at commit due to guardrail rejection
    assert.strictEqual(outcome.ok, false);

    const storeEvents = loop.store.events;
    const weakenedEvt = storeEvents.find(e => e.type === 'statement_weakened');
    const tripEvt = storeEvents.find(e => e.type === 'guardrail_trip');

    assert.ok(weakenedEvt);
    assert.ok(tripEvt);
    assert.strictEqual(weakenedEvt.lemmaId, lemmaId);
});

test('TacticLoop closes proof session in backend in finally block', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['omega']);
    const loop = new TacticLoop({ backend, llm, maxTacticsPerGoal: 1 });

    const lemmaId = loop.addLemma('example : 1 = 1 := by sorry');
    await loop.proveAll();

    // backend.endLemma should have been called with lemmaId
    assert.deepStrictEqual(backend.ended, [lemmaId]);
});

test('TacticLoop emits lemma_failed when the backend throws (exception, not a guardrail fail)', async () => {
    // Regression: a thrown backend error (repl worker busy, session timeout, worker exit)
    // used to propagate out of _proveLemma without a lemma_failed terminal, so the causal
    // store and the predictor miner lost the failure. The catch must emit it once.
    const throwing = Object.create(new MockBackend());
    throwing.extractGoals = async () => { throw new Error('repl worker busy'); };

    const llm = new MockLLM(['omega']);
    const loop = new TacticLoop({ backend: throwing, llm, maxTacticsPerGoal: 1 });
    const lemmaId = loop.addLemma('example : 1 = 1 := by sorry');
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, false);
    const failures = [...outcome.failures.keys()];
    assert.ok(failures.includes(lemmaId), 'scheduler must record the lemma as failed');

    const failed = loop.store.events.filter(e => e.type === 'lemma_failed' && e.lemmaId === lemmaId);
    assert.strictEqual(failed.length, 1, 'exactly one lemma_failed terminal for the exception');
});

test('TacticLoop appends a statement hash chain entry per verified lemma and it verifies', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['intro h', 'omega']);
    const loop = new TacticLoop({ backend, llm, maxTacticsPerGoal: 2 });

    const statement = 'example (P Q : Prop) : P → Q := by sorry';
    const lemmaId = loop.addLemma(statement);
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.hashChainOk, true);

    // one entry per verified lemma, chained on prevHash, integrity-checkable end to end
    assert.strictEqual(loop.hashChain.length, 1);
    const entry = loop.hashChain[0];
    assert.strictEqual(entry.prevHash, null);
    assert.strictEqual(entry.statementHash, hashStatement(statement));
    assert.strictEqual(entry.outcome, 'verified');
    assert.strictEqual(entry.hash, hashChainEntry(null, entry.statementHash, entry.proofHash, 'verified'));
    assert.deepStrictEqual(verifyHashChain(loop.hashChain), { ok: true });
});

test('TacticLoop hash chain stays intact across multiple verified lemmas', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['intro h', 'omega']);
    // sequential dispatch so the cycling mock LLM serves one lemma's tactics at a time
    const loop = new TacticLoop({ backend, llm, concurrency: 1, maxTacticsPerGoal: 2 });

    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    loop.addLemma('example (P Q : Prop) : Q → P := by sorry');
    const outcome = await loop.proveAll();

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(loop.hashChain.length, 2);
    assert.strictEqual(loop.hashChain[1].prevHash, loop.hashChain[0].hash);
    assert.deepStrictEqual(verifyHashChain(loop.hashChain), { ok: true });
});

test('TacticLoop runs the e-graph behind the contract (searchStructure: egraph)', async () => {
    const backend = new MockBackend();
    const llm = new MockLLM(['intro h', 'omega']);
    const loop = new TacticLoop({ backend, llm, maxTacticsPerGoal: 2, searchStructure: 'egraph' });

    const lemmaId = loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();

    // The same search flow must solve through the e-graph (mock oracle confirms nothing, so
    // unions are congruence-only here — the real def-eq oracle is exercised by defEqOracle tests
    // and the live suite).
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(loop.hashChain.length, 1);
    assert.ok(loop.store.events.some(e => e.type === 'lemma_verified' && e.lemmaId === lemmaId));
});
