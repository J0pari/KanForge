// Guardrails invariant spec tests (core/guardrails.js).

import test from 'node:test';
import assert from 'node:assert';
import { Guardrails, HARD_INVARIANTS } from '../core/guardrails.js';
import { PullGraph } from '../core/pullgraph.js';
import { hashStatement, makePin } from '../lean/pin.js';
import { hashChainEntry } from '../core/hasher.js';

test('checkAll verifies clean graph passes all invariants', () => {
    const graph = new PullGraph();
    const stmt = 'example : 1 = 1 := by sorry';
    const id = hashStatement(stmt);
    graph.register(id, () => stmt);
    const node = graph.nodes.get(id);
    node.cached = true;
    node.value = { statement: stmt, proofScript: 'by rfl', verifiedAt: new Date().toISOString() };

    const pins = new Map([[id, makePin(stmt)]]);
    const res = Guardrails.checkAll(graph, { pins });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.violations.length, 0);
});

test('checkAll catches STATEMENT_WEAKENED when statement text is mutated', () => {
    const graph = new PullGraph();
    const original = 'example (n : Nat) : n = n := by sorry';
    const mutated = 'example (n : Nat) : n = 0 := by sorry';
    const id = hashStatement(original);

    // Register node with mutated statement text
    graph.register(id, () => mutated);
    const node = graph.nodes.get(id);
    node.cached = true;
    node.value = { statement: mutated, proofScript: 'by rfl', verifiedAt: new Date().toISOString() };

    const pins = new Map([[id, makePin(original)]]);
    const res = Guardrails.checkAll(graph, { pins });

    assert.strictEqual(res.ok, false);
    const v = res.violations.find(x => x.type === 'STATEMENT_WEAKENED');
    assert.ok(v);
    assert.strictEqual(v.nodeId, id);
});

test('checkAll catches LEAKAGE (axiom/admit/unsafe/sorry) unless permission active', () => {
    const graph = new PullGraph();
    const stmt = 'example : True := by sorry';
    const id = hashStatement(stmt);
    graph.register(id, () => stmt);
    const node = graph.nodes.get(id);
    node.cached = true;
    node.value = { statement: stmt, proofScript: 'by sorry', verifiedAt: new Date().toISOString() };

    // Without permission -> LEAKAGE violation
    const res1 = Guardrails.checkAll(graph, { pins: new Map([[id, makePin(stmt)]]) });
    assert.strictEqual(res1.ok, false);
    assert.ok(res1.violations.some(x => x.type === 'LEAKAGE' && x.token === 'sorry'));

    // With active 'sorry-stub' permission -> passes
    const res2 = Guardrails.checkAll(graph, {
        pins: new Map([[id, makePin(stmt)]]),
        permissions: [{ kind: 'sorry-stub', expiresAt: Date.now() + 60000 }]
    });
    assert.strictEqual(res2.ok, true);
});

test('assertLemmaCommit enforces HARD invariants ignoring permissions', () => {
    const stmt = 'example : True := by sorry';
    const pin = makePin(stmt);

    // Hard gate rejects 'sorry' in proofScript even if callers have a permission
    const commit = Guardrails.assertLemmaCommit({
        pin,
        statement: stmt,
        proofScript: 'by sorry',
        verification: { status: 'verified' }
    });
    assert.strictEqual(commit.ok, false);
    assert.ok(commit.violations.some(x => x.type === 'LEAKAGE'));
});

test('checkInvalidationLocality checks invalidation touches only descendants', () => {
    const graph = new PullGraph();
    graph.register('A', () => 'A');
    graph.register('B', () => 'B');
    graph.register('C', () => 'C');
    graph.dependsOn('B', 'A'); // B depends on A
    graph.dependsOn('C', 'B'); // C depends on B

    // Invalidate A -> B, C are descendants
    const ok = Guardrails.checkInvalidationLocality(graph, ['A'], ['B', 'C']);
    assert.strictEqual(ok.ok, true);

    // Invalidate A -> claiming 'D' is invalidated is unrelated
    const fail = Guardrails.checkInvalidationLocality(graph, ['A'], ['D']);
    assert.strictEqual(fail.ok, false);
    assert.deepStrictEqual(fail.unrelated, ['D']);
});

test('checkAll verifies hash chain integrity', () => {
    const e1Hash = hashChainEntry(null, 'h1', 'p1', 'ok');
    const e2Hash = hashChainEntry(e1Hash, 'h2', 'p2', 'ok');
    const validChain = [
        { prevHash: null, statementHash: 'h1', proofHash: 'p1', outcome: 'ok', hash: e1Hash },
        { prevHash: e1Hash, statementHash: 'h2', proofHash: 'p2', outcome: 'ok', hash: e2Hash }
    ];

    const graph = new PullGraph();
    const res = Guardrails.checkAll(graph, { hashChain: validChain });
    assert.strictEqual(res.ok, true);
});
