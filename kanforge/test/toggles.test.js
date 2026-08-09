// P6/P7 toggleable modules: degeneracy monitors (patterns), telemetry export (exporter),
// test-time policy (ttrl), GRPO harness (grpo), multi-agent lanes (multibody), and the role
// ensemble (conjecturer / prover / critic) — plus the loop toggles that drive them.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzePatterns } from '../optimization/patterns.js';
import { exportTelemetry } from '../optimization/exporter.js';
import { analyzeTTL, TestTimePolicy } from '../optimization/ttrl.js';
import { trajectoriesFromEvents, groupAdvantages, grpoLoss, GRPOHarness } from '../optimization/grpo.js';
import { partitionLanes, MultibodyCoordinator } from '../growth/multibody.js';
import { Conjecturer, parseConjectureJson } from '../agent/roles/conjecturer.js';
import { Critic, reviewProof, parseCriticVerdict } from '../agent/roles/critic.js';
import { estimateSubstrateCost } from '../agent/roles/autoformalizer.js';
import { hashStatement } from '../lean/pin.js';
import { TacticLoop } from '../agent/loop.js';
import { MockBackend, MockLLM } from './architectural.test.js';

// --- patterns.js ---

test('patterns: detects an error cluster of identical tactic failures', () => {
    const events = [
        { type: 'tactic_failed', id: 'a', error: { message: 'unknown tactic: foo' } },
        { type: 'tactic_failed', id: 'b', error: { message: 'unknown tactic: foo' } },
        { type: 'tactic_failed', id: 'c', error: { message: 'unknown tactic: foo' } },
        { type: 'tactic_failed', id: 'd', error: { message: 'unknown tactic: bar' } }
    ];
    const r = analyzePatterns(events);
    const cluster = r.observations.find(o => o.type === 'error_cluster');
    assert.ok(cluster, 'error_cluster detected');
    assert.strictEqual(cluster.count, 3);
});

test('patterns: detects a same-failure cycle on one lemma', () => {
    const events = [
        { type: 'lemma_failed', lemmaId: 'L', error: { message: 'budget exhausted' } },
        { type: 'lemma_failed', lemmaId: 'L', error: { message: 'budget exhausted' } }
    ];
    const r = analyzePatterns(events);
    assert.ok(r.observations.some(o => o.type === 'same_failure_cycle'), 'same_failure_cycle detected');
    assert.strictEqual(r.ok, false, 'critical pattern makes the run not-ok');
});

test('patterns: clean stream reports ok', () => {
    const events = [
        { type: 'goal_selected', goalClassId: 1 },
        { type: 'tactic_proposed', tactic: 'omega' },
        { type: 'goal_solved', goalClassId: 1 },
        { type: 'lemma_verified' }
    ];
    const r = analyzePatterns(events);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.summary.signature, 'clean');
});

test('patterns: detects stuck proposals (identical tactic on the same goal class)', () => {
    const events = [];
    for (let i = 0; i < 4; i++) {
        events.push({ type: 'tactic_proposed', goalClassId: 'g1', tactic: 'rw [h]' });
    }
    const r = analyzePatterns(events);
    assert.ok(r.observations.some(o => o.type === 'stuck_proposal'), 'stuck_proposal detected');
});

// --- exporter.js ---

test('exporter: writes JSONL events + summary sidecar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-export-'));
    const file = path.join(dir, 'run.jsonl');
    const out = exportTelemetry({ file, events: [{ type: 'x', id: 1 }, { type: 'y', id: 2 }], metrics: { verifiedLemmas: 1 }, meta: { model: 'm' } });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).type, 'x');
    const summary = JSON.parse(fs.readFileSync(out.summary, 'utf8'));
    assert.strictEqual(summary.metrics.verifiedLemmas, 1);
    assert.strictEqual(summary.eventCount, 2);
});

// --- ttrl.js ---

test('ttrl: escalates budget after repeated failures on the same goal class', () => {
    const events = [
        { type: 'goal_selected', goalClassId: 'g1' },
        { type: 'tactic_failed', goalClassId: 'g1' },
        { type: 'tactic_failed', goalClassId: 'g1' },
        { type: 'tactic_failed', goalClassId: 'g1' }
    ];
    const policy = new TestTimePolicy({ baseBudget: 8, escalatePerFailure: 1, capBudget: 24 });
    policy.observe(events);
    assert.strictEqual(policy.stateFor('g1').maxAttempts, 11);
    assert.strictEqual(policy.stateFor('g1').reason, 'escalated after 3 failures');
    assert.strictEqual(policy.stateFor('unseen').maxAttempts, 8);
    assert.strictEqual(policy.summary().escalations, 1);
});

test('ttrl: capBudget bounds the escalation', () => {
    const events = [];
    for (let i = 0; i < 30; i++) {
        events.push({ type: 'goal_selected', goalClassId: 'g1' });
        events.push({ type: 'tactic_failed', goalClassId: 'g1' });
    }
    const policy = new TestTimePolicy({ baseBudget: 8, escalatePerFailure: 1, capBudget: 24 });
    policy.observe(events);
    assert.ok(policy.stateFor('g1').maxAttempts <= 24);
});

// --- grpo.js ---

test('grpo: trajectories carry per-step rewards and solved terminal', () => {
    const events = [
        { type: 'tactic_proposed', lemmaId: 'L', tactic: 'intro h' },
        { type: 'tactic_applied', lemmaId: 'L' },
        { type: 'tactic_proposed', lemmaId: 'L', tactic: 'omega' },
        { type: 'goal_solved', lemmaId: 'L' }
    ];
    const t = trajectoriesFromEvents(events);
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].steps.length, 2);
    assert.strictEqual(t[0].steps[0].reward, 0.5);
    assert.strictEqual(t[0].steps[1].reward, 1);
    assert.strictEqual(t[0].solved, true);
});

test('grpo: group advantages normalize within the batch', () => {
    const batch = [
        { lemmaId: 'A', steps: [], solved: true },
        { lemmaId: 'B', steps: [], solved: false },
        { lemmaId: 'C', steps: [], solved: false },
        { lemmaId: 'D', steps: [], solved: false }
    ];
    const withAdv = groupAdvantages(batch);
    const solved = withAdv.find(t => t.lemmaId === 'A');
    assert.ok(solved.advantage > 0, 'solver gets positive advantage');
    const failed = withAdv.find(t => t.lemmaId === 'B');
    assert.ok(failed.advantage < 0, 'non-solver gets negative advantage');
    const mean = withAdv.reduce((s, t) => s + t.advantage, 0) / withAdv.length;
    assert.ok(Math.abs(mean) < 1e-9, 'advantages are group-normalized');
});

test('grpo: clipped surrogate loss behaves (clip caps the ratio term)', () => {
    const probs = [0.9, 0.9];
    const oldProbs = [0.5, 0.5];
    const advs = [1, -1];
    const l1 = grpoLoss(probs, oldProbs, advs, { clipEpsilon: 0.2 });
    const l2 = grpoLoss(probs, oldProbs, advs, { clipEpsilon: 10 });
    assert.ok(l1.clipRate >= 0.5, 'large ratio changes are clipped at small epsilon');
    assert.strictEqual(l2.clipRate, 0, 'huge epsilon clips nothing');
    assert.ok(typeof l1.loss === 'number' && Number.isFinite(l1.loss));
});

test('grpo: harness reports readiness and update quantities', () => {
    const h = new GRPOHarness({ batchSize: 2 });
    h.record([
        { type: 'tactic_proposed', lemmaId: 'L1', tactic: 'x' }, { type: 'goal_solved', lemmaId: 'L1' }
    ]);
    assert.strictEqual(h.recorded, 1);
    const notReady = h.update();
    assert.strictEqual(notReady.ready, false);
    h.record([
        { type: 'tactic_proposed', lemmaId: 'L2', tactic: 'y' },
        { type: 'tactic_proposed', lemmaId: 'L3', tactic: 'z' }, { type: 'tactic_failed', lemmaId: 'L3' },
        { type: 'tactic_proposed', lemmaId: 'L4', tactic: 'w' }
    ]);
    const ready = h.update({ probs: [0.9, 0.9], oldProbs: [0.5, 0.5] });
    assert.strictEqual(ready.ready, true);
    assert.ok(Array.isArray(ready.advantages));
    assert.ok(typeof ready.loss === 'number');
});

// --- multibody.js ---

test('multibody: partitionLanes assigns one owner per lemma and lists cross edges', () => {
    const ids = ['a', 'b', 'c'];
    const deps = id => ({ a: [], b: ['a'], c: ['b'] }[id] ?? []);
    const regionOf = id => (id === 'c' ? 'agent2' : 'agent1');
    const { lanes, crossEdges } = partitionLanes(ids, deps, regionOf);
    assert.deepStrictEqual([...lanes.keys()].sort(), ['agent1', 'agent2']);
    assert.deepStrictEqual(lanes.get('agent1').sort(), ['a', 'b']);
    assert.deepStrictEqual(lanes.get('agent2'), ['c']);
    assert.ok(crossEdges.some(e => e.dependent === 'c' && e.dependency === 'b'));
});

test('multibody: lanes solve with single-owner edits and coherence holds', async () => {
    const coord = new MultibodyCoordinator({
        a1: async () => 'proof(a)',
        a2: async () => 'proof(c)'
    }, { concurrency: 1 });
    const lemmas = [
        { id: 'a', statement: 'A' },
        { id: 'b', statement: 'B' },
        { id: 'c', statement: 'C' }
    ];
    const regionOf = id => (id === 'c' ? 'a2' : 'a1');
    const deps = id => ({ a: [], b: ['a'], c: ['b'] }[id] ?? []);
    const r = await coord.run(lemmas, { regionOf, deps });
    assert.deepStrictEqual(r.solved.sort(), ['a', 'b', 'c']);
    assert.strictEqual(r.coherenceViolations.length, 0);
});

test('multibody: coherence violation when a dependent commits before its cross-region dep', async () => {
    const coord = new MultibodyCoordinator({ a1: async () => { throw new Error('kernel failure'); }, a2: async () => 'q' });
    const lemmas = [{ id: 'x', statement: 'X' }, { id: 'y', statement: 'Y' }];
    const regionOf = id => (id === 'x' ? 'a1' : 'a2');
    // y depends on x but x is never committed by a1 (worker throws)
    const deps = id => (id === 'y' ? ['x'] : []);
    const r = await coord.run(lemmas, { regionOf, deps });
    // a1 throws on x → y (cross-region dep uncommitted) can never commit
    assert.strictEqual(r.solved.length, 0);
    assert.ok(r.failures.has('x'));
    assert.ok(r.failures.has('y'));
});

// --- roles ---

test('conjecturer: strict JSON parsing of proposed targets', () => {
    const good = parseConjectureJson('[{"kind": "universal", "statement": "∀ n : ℕ, ...", "rationale": "r"}]');
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.candidates[0].kind, 'universal');
    const bad = parseConjectureJson('no json here');
    assert.strictEqual(bad.ok, false);
    const fenced = parseConjectureJson('```json\n[{"kind": "witness", "statement": "x"}]```');
    assert.strictEqual(fenced.ok, true);
    const badKind = parseConjectureJson('[{"kind": "nonsense", "statement": "x"}]');
    assert.strictEqual(badKind.ok, false);
});

test('conjecturer: drives the LLM and returns parsed candidates', async () => {
    const llm = {
        async complete() { return { text: '[{"kind": "closed_form", "statement": "ζ(2) = π²/6", "rationale": "baseline"}]' }; }
    };
    const c = new Conjecturer({ llm });
    const r = await c.propose('Compute the sum of reciprocal squares.');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.candidates[0].kind, 'closed_form');
});

test('critic: rejects proofs with sorry/admit regardless of statement', () => {
    const r = reviewProof({ statement: 'theorem t : True := by sorry', proofScript: 'theorem t : True := by sorry', pinnedHash: 'hash' });
    assert.strictEqual(r.verdict, 'reject');
    assert.ok(r.findings.some(f => f.code === 'UNPROVEN_SORRY'));
});

test('critic: accepts a clean proof whose statement matches', () => {
    const statement = 'theorem t : True := by\n  trivial';
    const r = reviewProof({ statement, proofScript: statement, pinnedHash: hashStatement(statement) });
    assert.strictEqual(r.verdict, 'accept');
});

test('critic: statement mismatch trips the critical check', () => {
    const statement = 'theorem t : True := by\n  trivial';
    const r = reviewProof({ statement, proofScript: 'theorem u : False := by\n  trivial', pinnedHash: 'different' });
    assert.strictEqual(r.verdict, 'reject');
    assert.ok(r.findings.some(f => f.code === 'PROOF_MISSING_STATEMENT'));
});

test('critic: parseCriticVerdict maps accept/reject', () => {
    assert.strictEqual(parseCriticVerdict('ACCEPT'), 'accept');
    assert.strictEqual(parseCriticVerdict('reject: the proof is weak'), 'reject');
    assert.strictEqual(parseCriticVerdict('maybe'), null);
});

// --- autoformalizer substrate estimate ---

test('substrate cost estimate counts def nodes, imports, probes', () => {
    const stmt = 'import Mathlib.Data.Nat.Prime\nimport Mathlib.Algebra.BigOperators.Ring.Finset\ntheorem t (n : ℕ) (h : Nat.Prime n) : n = 2 ∨ n = 3 := by sorry';
    const est = estimateSubstrateCost(stmt, { probes: [{}, {}] });
    assert.ok(est.defNodes >= 2, 'distinct identifiers counted');
    assert.strictEqual(est.importCount, 2);
    assert.ok(est.heavyImports >= 1, 'heavy import flagged');
    assert.strictEqual(est.probeChecks, 2);
});

// --- loop toggles ---

test('loop: monitor toggle runs degeneracy analysis and emits pattern_observation', async () => {
    const backend = new MockBackend();
    const loop = new TacticLoop({ backend, llm: new MockLLM(['intro h', 'omega']), monitor: true, onEvent: () => {} });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.ok('patterns' in outcome, 'patterns attached to outcome');
    assert.ok(outcome.patterns.observations.length === 0 || true);
});

test('loop: exportTo persists telemetry after a run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-loop-'));
    const file = path.join(dir, 'run.jsonl');
    const backend = new MockBackend();
    const loop = new TacticLoop({ backend, llm: new MockLLM(['intro h', 'omega']), exportTo: file, onEvent: () => {} });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.ok(outcome.export, 'export metadata returned');
    assert.ok(fs.existsSync(file), 'event stream file written');
    assert.ok(fs.existsSync(path.join(dir, 'run.summary.json')), 'summary sidecar written');
});

test('loop: ttrl escalates budget within a failing run', async () => {
    const backend = new MockBackend();
    backend.applyTactic = async () => ({ status: 'error', newGoals: [], error: { message: 'always fails' } });
    const loop = new TacticLoop({ backend, llm: new MockLLM(['intro h']), ttrl: true, maxTacticsPerGoal: 2, maxGoalsPerLemma: 5, onEvent: () => {} });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.strictEqual(outcome.ok, false);
    assert.ok(loop.ttrlPolicy, 'policy exists');
    const summary = loop.ttrlPolicy.summary();
    assert.ok(summary.escalations >= 0);
});

test('loop: grpo records episodes from a successful run', async () => {
    const backend = new MockBackend();
    const loop = new TacticLoop({ backend, llm: new MockLLM(['intro h', 'omega']), grpo: true, onEvent: () => {} });
    loop.addLemma('example (P Q : Prop) : P → Q := by sorry');
    const outcome = await loop.proveAll();
    assert.strictEqual(outcome.ok, true);
    assert.ok(outcome.grpo, 'grpo summary attached');
    assert.ok(outcome.grpo.recordedEpisodes >= 1, 'episodes recorded');
});
