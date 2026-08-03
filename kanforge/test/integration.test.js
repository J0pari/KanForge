// Systems integration & coordination tests (TacticLoop + EventBus + Guardrails + Session).

import test from 'node:test';
import assert from 'node:assert';
import { TacticLoop } from '../agent/loop.js';
import { MockBackend, MockLLM } from './architectural.test.js';
import { EventBus } from '../optimization/bus.js';
import { EventStore } from '../optimization/store.js';

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
