// Toggleable search recipes in the live loop (architecture.md §5 integration contract,
// build_order.md §5.1). Every strategy — loop / bestofn / swiss / swiss+repulsion / bfs / mcgs —
// runs through TacticLoop and must reach the same commit gate (pin, guardrails, hash chain).

import test from 'node:test';
import assert from 'node:assert';
import { TacticLoop, LOOP_SEARCH_RECIPES } from '../agent/loop.js';
import { MockBackend, MockLLM } from './architectural.test.js';

function runLemma(opts, tactics) {
    const backend = new MockBackend();
    const loop = new TacticLoop({ backend, llm: new MockLLM(tactics), maxTacticsPerGoal: 2, maxGoalsPerLemma: 10, onEvent: () => {}, ...opts });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    return loop.proveAll().then(outcome => ({ outcome, loop, backend }));
}

test('LOOP_SEARCH_RECIPES names the full toggleable set', () => {
    assert.deepStrictEqual(LOOP_SEARCH_RECIPES, ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'mcgs']);
});

test('invalid searchRecipe falls back to the default loop', () => {
    const loop = new TacticLoop({ backend: new MockBackend(), llm: new MockLLM(['intro h', 'omega']), searchRecipe: 'not-a-recipe', onEvent: () => {} });
    assert.strictEqual(loop.searchRecipe, 'loop');
});

test('useSwiss: true maps to the swiss recipe for backward compatibility', () => {
    const loop = new TacticLoop({ backend: new MockBackend(), llm: new MockLLM(['intro h', 'omega']), useSwiss: true, onEvent: () => {} });
    assert.strictEqual(loop.searchRecipe, 'swiss');
});

test('recipe loop: default inline single-tactic path still solves', async () => {
    const { outcome } = await runLemma({}, ['intro h', 'omega']);
    assert.strictEqual(outcome.ok, true);
});

test('recipe bestofn: delegates per-goal proposal to bestOfN', async () => {
    const { outcome, loop } = await runLemma({ searchRecipe: 'bestofn', swissN: 2 }, ['intro h', 'omega']);
    assert.strictEqual(outcome.ok, true);
    const events = loop.store.events;
    assert.ok(events.some(e => e.type === 'tactic_applied' && e.via === 'bestofn'), 'tactic_applied via bestofn');
    assert.strictEqual(events.filter(e => e.type === 'goal_solved').length, 1);
});

test('recipe swiss: swiss tournament wins per goal, then commit gate', async () => {
    const { outcome, loop } = await runLemma({ searchRecipe: 'swiss', swissN: 2 }, ['intro h', 'omega', 'A', 'intro h', 'omega', 'B']);
    assert.strictEqual(outcome.ok, true);
    const events = loop.store.events;
    assert.ok(events.some(e => e.type === 'swiss_tournament_start'), 'tournament started');
    assert.ok(events.some(e => e.type === 'swiss_tournament_complete'), 'tournament completed');
    assert.strictEqual(events.filter(e => e.type === 'goal_solved').length, 1);
    // cost is counted honestly through the counting proxy, not the old swissN approximation
    assert.strictEqual(loop.llmCalls, 6);
});

test('recipe swiss+repulsion: repulsion sampler seeds failed tactics across the lemma', async () => {
    const { outcome, loop } = await runLemma({ searchRecipe: 'swiss+repulsion', swissN: 2 }, ['intro h', 'omega', 'A', 'intro h', 'omega', 'B']);
    assert.strictEqual(outcome.ok, true);
    const events = loop.store.events;
    assert.ok(events.some(e => e.type === 'swiss_tournament_complete' && e.repulsion === true), 'repulsion tournament completed');
    assert.strictEqual(loop.llmCalls, 6);
});

test('recipe bfs: whole-graph best-first delegation reaches the commit gate', async () => {
    const { outcome, loop, backend } = await runLemma({ searchRecipe: 'bfs' }, ['intro h', 'omega']);
    assert.strictEqual(outcome.ok, true);
    const events = loop.store.events;
    assert.ok(events.some(e => e.type === 'search_start' && e.recipe === 'bfs'), 'search_start emitted');
    const complete = events.find(e => e.type === 'search_complete');
    assert.ok(complete && complete.solved === true, 'search_complete with solved=true');
    // the loop still runs the full commit gate: kernel verify + hash chain
    assert.strictEqual(backend.verifyCalls.length, 1);
    assert.strictEqual(loop.hashChain.length, 1);
    assert.ok(loop.llmCalls >= 2, 'delegated llm cost counted');
});

test('recipe mcgs: UCB graph search delegation reaches the commit gate', async () => {
    const { outcome, loop, backend } = await runLemma({ searchRecipe: 'mcgs' }, ['intro h', 'omega']);
    assert.strictEqual(outcome.ok, true);
    const events = loop.store.events;
    assert.ok(events.some(e => e.type === 'search_start' && e.recipe === 'mcgs'), 'search_start emitted');
    const complete = events.find(e => e.type === 'search_complete');
    assert.ok(complete && complete.solved === true, 'search_complete with solved=true');
    assert.strictEqual(backend.verifyCalls.length, 1);
    assert.strictEqual(loop.hashChain.length, 1);
});

test('recipe that exhausts budget fails cleanly through lemma_failed', async () => {
    // A backend that never accepts a tactic: the whole-graph recipe must emit search_complete
    // with solved=false and then a single lemma_failed terminal.
    const backend = new MockBackend();
    backend.applyTactic = async () => ({ status: 'error', newGoals: [], error: { message: 'always fails' } });
    const loop = new TacticLoop({ backend, llm: new MockLLM(['intro h', 'omega']), searchRecipe: 'bfs', maxGoalsPerLemma: 3, onEvent: () => {} });
    const lemmaId = loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.strictEqual(outcome.ok, false);
    const failures = [...outcome.failures.keys()];
    assert.ok(failures.includes(lemmaId), 'scheduler records the lemma as failed');
    const failed = loop.store.events.filter(e => e.type === 'lemma_failed' && e.lemmaId === lemmaId);
    assert.strictEqual(failed.length, 1, 'exactly one lemma_failed terminal');
});
