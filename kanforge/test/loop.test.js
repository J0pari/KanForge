// Control-flow tests for the P1 minimal loop (agent/loop.js).
// These inject plain async check functions (as core.test.js does for the Scheduler) to verify
// ordering, hashing, retry budget, and stop-budget logic — they make no claim about a kernel.
// The end-to-end proof through the real repl binary + a real LLM is loop.live.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MinimalLoop, parseProof, composeProof, proposeProofMessages, buildLemmaId, proofLooksLikeTactic
} from '../agent/loop.js';

const verifiedBackend = {
    getInfos: () => ({}),
    check: async () => ({ status: 'verified', goals: [], error: undefined })
};

const failingBackend = {
    getInfos: () => ({}),
    check: async () => ({ status: 'error', goals: [], error: { message: 'tactic failed' } })
};

const stubLlm = {
    complete: async (messages, opts) => {
        assert.ok(opts?.maxTokens > 0);
        return { text: 'omega' };
    }
};

function captureEvents(loop) {
    const events = [];
    loop.onEvent = e => events.push(e);
    return events;
}

test('parseProof: strips fences, leading by, and echoed statements', () => {
    assert.equal(parseProof('omega'), 'omega');
    assert.equal(parseProof('by omega'), 'omega');
    assert.equal(parseProof('```lean\nby omega\n```'), 'omega');
    assert.equal(parseProof('example (a b : Nat) : a + b = b + a := by omega'), 'omega');
    assert.equal(parseProof('  exact trivial\n'), 'exact trivial');
    assert.equal(parseProof('Here is the proof:\n\n```lean4\nrw [Nat.add_comm]\n```'), 'rw [Nat.add_comm]');
    assert.equal(parseProof('prose first\n```\nomega\n```\nmore prose\n```lean\nsimp\n```'), 'simp', 'last fenced block wins');
});

test('composeProof: fills the trailing sorry; rejects non-stubs', () => {
    const stmt = 'example (a b : Nat) : a + b = b + a := by sorry';
    assert.equal(composeProof(stmt, 'by omega'), 'example (a b : Nat) : a + b = b + a := by omega');
    assert.throws(() => composeProof('example : True := by trivial', 'rfl'), /not a sorry stub/);
});

test('proposeProofMessages: carries prior failure feedback into the retry prompt', () => {
    const messages = proposeProofMessages('example : True := by sorry', [
        { proof: 'rfl', error: 'type mismatch' }
    ]);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[1].content.includes('example : True := by sorry'));
    assert.ok(messages[1].content.includes('type mismatch'));
});

test('proposeProofMessages: renders optional per-lemma context into the prompt', () => {
    const withContext = proposeProofMessages('example : True := by sorry', [], 'Prove by induction on n; the step closes with omega.');
    assert.ok(withContext[1].content.includes('Context:'));
    assert.ok(withContext[1].content.includes('Prove by induction on n'));
    const without = proposeProofMessages('example : True := by sorry');
    assert.ok(!without[1].content.includes('Context:'), 'no context block when none provided');
});

test('addLemma: node ids are statement hashes; re-adding dedupes', () => {
    const loop = new MinimalLoop({ backend: verifiedBackend, llm: stubLlm });
    const a = loop.addLemma('example : True := by sorry');
    const b = loop.addLemma('example : True := by sorry');
    assert.equal(a, b);
    assert.equal(a.length, 64, 'node id must be a sha256 hex hash');
    assert.equal(loop.graph.nodes.size, 1);
});

test('oldest-sorry priority: lemmas dispatch in insertion order', async () => {
    const loop = new MinimalLoop({ backend: verifiedBackend, llm: stubLlm, concurrency: 1, attemptsPerLemma: 1 });
    const events = captureEvents(loop);
    const oldest = loop.addLemma('example : True := by sorry');
    const middle = loop.addLemma('example : 1 = 1 := by sorry');
    const newest = loop.addLemma('example : 2 = 2 := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, true);
    const order = events.filter(e => e.type === 'lemma_goal').map(e => e.nodeId);
    assert.deepEqual(order, [oldest, middle, newest]);
});

test('stop budget: after N failed lemmas the run halts and remaining nodes never dispatch', async () => {
    const loop = new MinimalLoop({
        backend: failingBackend,
        llm: stubLlm,
        concurrency: 1,
        attemptsPerLemma: 1,
        stopAfterFailures: 2
    });
    const events = captureEvents(loop);
    const bad1 = loop.addLemma('example : False := by sorry');
    const bad2 = loop.addLemma('example : 0 = 1 := by sorry');
    const never = loop.addLemma('example : True := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, false);
    assert.equal(out.stopped, true, 'run must report the early stop');
    assert.equal(out.failures.size, 2);
    assert.ok(out.failures.has(bad1) && out.failures.has(bad2));
    assert.ok(!out.failures.has(never), 'third lemma must not have been attempted');
    assert.equal(loop.verifyCalls, 4, 'two failing lemmas, two proof forms each');
    assert.ok(!events.some(e => e.type === 'lemma_goal' && e.nodeId === never));
});

test('attempts budget: a lemma exhausts attemptsPerLemma then fails loudly', async () => {
    const loop = new MinimalLoop({
        backend: failingBackend,
        llm: stubLlm,
        concurrency: 1,
        attemptsPerLemma: 3,
        stopAfterFailures: 1
    });
    const events = captureEvents(loop);
    const id = loop.addLemma('example : False := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, false);
    assert.equal(loop.llmCalls, 3);
    assert.equal(loop.verifyCalls, 6, 'three failing attempts, two proof forms each');
    const failed = events.find(e => e.type === 'lemma_failed');
    assert.ok(failed, 'a lemma_failed event must be emitted');
    assert.equal(failed.attempts, 3);
    assert.ok(failed.lastError.includes('tactic failed'));
});

test('proofLooksLikeTactic: shapes the verify-form ordering so the common case costs one check', () => {
    assert.equal(proofLooksLikeTactic('omega'), true);
    assert.equal(proofLooksLikeTactic('simp [hf]'), true);
    assert.equal(proofLooksLikeTactic('intro h; omega'), true, 'compound scripts are tactics');
    assert.equal(proofLooksLikeTactic('exact Nat.le_of_lt h'), true);
    assert.equal(proofLooksLikeTactic('Nat.add_comm a b'), false, 'bare terms verify as := <term>');
    assert.equal(proofLooksLikeTactic('rfl'), false);
    assert.equal(proofLooksLikeTactic(''), true);
});

test('term-first ordering: a bare proof term verifies via the := <term> form in ONE check', async () => {
    const termOnlyBackend = {
        getInfos: () => ({}),
        check: async src => ({
            status: src.includes(':= by ') ? 'error' : 'verified',
            goals: [],
            error: src.includes(':= by ') ? { message: 'unknown tactic' } : undefined
        })
    };
    const termLlm = { complete: async () => ({ text: 'Nat.add_comm a b' }) };
    const loop = new MinimalLoop({ backend: termOnlyBackend, llm: termLlm, concurrency: 1, attemptsPerLemma: 1 });
    const events = captureEvents(loop);
    loop.addLemma('example (a b : Nat) : a + b = b + a := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, true);
    assert.equal(loop.verifyCalls, 1, 'a bare term must verify on the term form alone');
    const verified = events.find(e => e.type === 'lemma_verified');
    assert.equal(verified.form, 'term');
});

test('term fallback: a proof term verifies via the := <term> form when by <term> is invalid', async () => {
    // Control-flow only: the "kernel" here accepts the term form and rejects the tactic form.
    const termOnlyBackend = {
        getInfos: () => ({}),
        check: async src => ({
            status: src.includes(':= by ') ? 'error' : 'verified',
            goals: [],
            error: src.includes(':= by ') ? { message: 'unknown tactic' } : undefined
        })
    };
    const loop = new MinimalLoop({ backend: termOnlyBackend, llm: stubLlm, concurrency: 1, attemptsPerLemma: 1 });
    const events = captureEvents(loop);
    loop.addLemma('example : True := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, true, 'term form must be accepted when the tactic form is invalid');
    assert.equal(loop.verifyCalls, 2, 'tactic form fails, then term form succeeds');
    const attempts = events.filter(e => e.type === 'lemma_attempt');
    assert.deepEqual(attempts.map(a => a.form), ['tactic', 'term']);
    const verified = events.find(e => e.type === 'lemma_verified');
    assert.equal(verified.form, 'term');
});

test('verified lemma: result recorded on the node, outcome ok, traced event emitted', async () => {
    const loop = new MinimalLoop({ backend: verifiedBackend, llm: stubLlm, concurrency: 1, attemptsPerLemma: 2 });
    const events = captureEvents(loop);
    const id = loop.addLemma('example : True := by sorry');

    const out = await loop.proveAll();
    assert.equal(out.ok, true);
    assert.equal(loop.verifyCalls, 1, 'first attempt should verify');
    const verified = events.find(e => e.type === 'lemma_verified');
    assert.ok(verified, 'a lemma_verified event must be emitted');
    assert.equal(verified.proof, 'omega');
    assert.equal(loop.graph.nodes.get(id).value.proof, 'omega', 'node value must carry the verified proof');
    assert.equal(loop.graph.nodes.get(id).cached, true);
});

test('scheduler kill-on-hang: a lemma aborted mid-flight still emits a terminal lemma_failed event', async () => {
    // Regression: the scheduler's per-lemma timeout used to reject without cancelling the
    // in-flight check, so an aborted lemma never emitted a terminal event and silently
    // vanished from the run's accounting (s.total < 20 in the smoke gate).
    const hangingLlm = {
        complete: async (messages, opts = {}) => new Promise((resolve, reject) => {
            if (opts.signal?.aborted) return reject(Object.assign(new Error('aborted'), { kind: 'abort' }));
            opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'abort' })), { once: true });
        })
    };
    const loop = new MinimalLoop({
        backend: verifiedBackend,
        llm: hangingLlm,
        concurrency: 1,
        attemptsPerLemma: 8,
        timeoutMs: 80 // backstop fires quickly in the test
    });
    const events = captureEvents(loop);
    const id = loop.addLemma('example : True := by sorry');
    const t0 = Date.now();
    const out = await loop.proveAll();
    const dt = Date.now() - t0;

    assert.equal(out.ok, false);
    assert.ok(out.failures.has(id), 'the aborted lemma must be recorded as failed');
    assert.ok(dt < 5000, `an aborted lemma must settle promptly, took ${dt}ms`);
    const failed = events.find(e => e.type === 'lemma_failed');
    assert.ok(failed, 'an aborted lemma MUST emit a terminal lemma_failed event, never vanish');
    assert.ok(/timed out|aborted/i.test(failed.lastError), `got: ${failed.lastError}`);
    assert.equal(failed.attempts, 1, 'the aborted attempt is counted');
});

test('scheduler maxFailures: generic core stop budget', async () => {
    const { PullGraph } = await import('../core/pullgraph.js');
    const { Scheduler } = await import('../core/scheduler.js');
    const g = new PullGraph();
    const dispatched = [];
    g.register('x', () => 1);
    g.register('y', () => 1);
    g.register('z', () => 1);
    const s = new Scheduler(g, {
        concurrency: 1,
        maxFailures: 1,
        check: async id => {
            dispatched.push(id);
            if (id === 'x') throw new Error('boom');
            return 'ok';
        }
    });
    s.enqueue(['x', 'y', 'z']);
    const out = await s.run();
    assert.equal(out.stopped, true);
    assert.deepEqual(dispatched, ['x'], 'only the first failing node is dispatched');
    assert.equal(out.failures.size, 1);
    assert.ok(!out.failures.has('y') && !out.failures.has('z'));
});
