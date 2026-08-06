// Tactic-menu augmentation tests (build_order.md §5.2): import-verified availability, goal-shape
// detection, menu content for the curated problems, and the wrapper chain (menu innermost,
// premises outermost) at the llm.complete seam.

import test from 'node:test';
import assert from 'node:assert';
import { goalShape, tacticMenuFor, availableTactics, TacticMenuAugmentingLLM, MODULE_TACTICS } from '../search/tacticMenu.js';
import { PremiseRetriever, PremiseAugmentingLLM, parseProposalGoal } from '../search/premises.js';
import { MATHLIB_PROBLEMS } from '../bench/mathlibSmoke.js';
import { PREMS_MATHLIB_1 } from '../bench/premisesCorpus.js';

const problem = id => MATHLIB_PROBLEMS.find(p => p.id === id);
const TAUTO = problem('tauto_elim');
const MUL_ADD = problem('mul_add_distr');
const RING = problem('ring_distrib');
const REAL_MUL_ZERO = problem('real_mul_zero');

// --- goal-shape detection ---

test('goalShape classifies the curated mathlib goal shapes', () => {
    const tauto = goalShape('(p ∨ q) → (p → r) → (q → r) → r');
    assert.strictEqual(tauto.head, '→');
    assert.ok(tauto.tags.has('implication'));
    assert.ok(tauto.tags.has('disjunction'));
    assert.ok(tauto.propositional);

    const eq = goalShape('a * (b + c) = a * b + a * c');
    assert.strictEqual(eq.head, '=');
    assert.ok(eq.tags.has('arithmetic'));
    assert.ok(!eq.propositional);

    const ineq = goalShape('2 * a < 2 * b');
    assert.strictEqual(ineq.head, '<');

    const atom = goalShape('Nat.Prime 3');
    assert.strictEqual(atom.head, null);
    assert.ok(atom.propositional);

    const typeAsn = goalShape('(3:Real) / 2 + (1:Real) / 2 = 2');
    assert.strictEqual(typeAsn.head, '=', 'type ascription colon inside parens must not become the head');
});

test('availableTactics is core + import-provided only', () => {
    const t = availableTactics(TAUTO.statement);
    assert.ok(t.has('intro') && t.has('simp') && t.has('exact'), 'core always present');
    assert.ok(t.has('tauto'), 'Mathlib.Tactic.Tauto provides tauto');
    assert.ok(!t.has('ring'), 'Tauto module does not provide ring');

    const n = availableTactics(MUL_ADD.statement);
    assert.ok(n.has('omega'), 'Mathlib.Data.Nat.Basic verified to provide omega');
    assert.ok(!n.has('ring') && !n.has('tauto'), 'Nat.Basic provides neither');

    const r = availableTactics(RING.statement);
    assert.ok(r.has('ring'));

    const mz = availableTactics(REAL_MUL_ZERO.statement);
    assert.ok(!mz.has('ring') && !mz.has('norm_num'), 'Real.Basic transitives are not claimed');
});

// --- menu content ---

test('tauto_elim menu surfaces tauto as the closing move', () => {
    const menu = tacticMenuFor(TAUTO.statement, '(p ∨ q) → (p → r) → (q → r) → r');
    assert.ok(menu.includes('tauto'));
    assert.ok(menu.includes('Tactic menu (import-verified):'));
    assert.ok(menu.includes('closes outright'));
    assert.ok(!menu.includes('ring'));
});

test('mul_add_distr menu offers rw + omega but not ring (not imported)', () => {
    const menu = tacticMenuFor(MUL_ADD.statement, 'a * (b + c) = a * b + a * c');
    assert.ok(menu.includes('rw'), 'core rw card for equality goals');
    assert.ok(menu.includes('omega'), 'Nat.Basic provides omega');
    assert.ok(!menu.includes('ring'), 'ring is not import-verified here');
    assert.ok(!menu.includes('tauto'));
});

test('ring problem menu includes ring; field problem includes field_simp', () => {
    const ringMenu = tacticMenuFor(RING.statement, '(a + b) * c = a * c + b * c');
    assert.ok(ringMenu.includes('ring'));

    const field = problem('real_div_self');
    const fieldMenu = tacticMenuFor(field.statement, 'a / a = 1');
    assert.ok(fieldMenu.includes('field_simp'));
});

test('menu for an unknown import keeps core cards only (no unverified module tactics)', () => {
    const menu = tacticMenuFor('import Foo.Bar\n\nexample : True := by sorry', 'True');
    assert.ok(menu, 'core cards always produce a menu');
    assert.ok(menu.includes('simp') && menu.includes('exact'));
    assert.ok(!menu.includes('tauto') && !menu.includes('ring') && !menu.includes('omega'), 'no unverified module tactics');
});

// --- wrapper chain ---

class RecordingLLM {
    constructor() {
        this.calls = [];
    }
    async complete(prompt, opts = {}) {
        this.calls.push(prompt);
        return { text: 'simp' };
    }
}

const PROPOSAL_STRING = 'Goal: (p ∨ q) → (p → r) → (q → r) → r\nPropose tactic:';
const PROPOSAL_MSG = [
    { role: 'system', content: 'system' },
    { role: 'user', content: `Goal:\n  a * (b + c) = a * b + a * c\n\nPropose ONE tactic (attempt 1/8):` }
];
const JUDGE_PROMPT = 'Judge which of two tactic proposals for the same Lean goal is more promising.\n\nGoal:\n  a < c\n\nA: omega\nB: ring';

test('parseProposalGoal extracts from all prompt shapes and skips judges', () => {
    assert.strictEqual(parseProposalGoal({ user: PROPOSAL_STRING }), '(p ∨ q) → (p → r) → (q → r) → r');
    assert.strictEqual(parseProposalGoal([{ role: 'user', content: PROPOSAL_STRING }]), '(p ∨ q) → (p → r) → (q → r) → r');
    assert.strictEqual(parseProposalGoal(PROPOSAL_MSG), 'a * (b + c) = a * b + a * c');
    assert.strictEqual(parseProposalGoal(JUDGE_PROMPT), null);
});

test('TacticMenuAugmentingLLM injects the menu into proposal prompts, never judges', async () => {
    const raw = new RecordingLLM();
    const wrapped = new TacticMenuAugmentingLLM(raw, { statement: TAUTO.statement });

    await wrapped.complete({ user: PROPOSAL_STRING });
    await wrapped.complete(PROPOSAL_MSG);
    await wrapped.complete(JUDGE_PROMPT);

    assert.strictEqual(raw.calls.length, 3);

    const [u, msg, judge] = raw.calls;
    assert.ok(u.user.includes('Tactic menu (import-verified):'));
    assert.ok(u.user.includes('tauto'));
    assert.ok(u.user.includes('Propose tactic:'), 'propose instruction preserved');
    assert.ok(msg[1].content.includes('Tactic menu'));
    assert.ok(msg[1].content.includes('Propose ONE tactic'));
    assert.strictEqual(judge, JUDGE_PROMPT, 'judge prompt passes through untouched');
});

test('menu and premise wrappers compose: premises rebuild + menu appended', async () => {
    const raw = new RecordingLLM();
    const menu = new TacticMenuAugmentingLLM(raw, { statement: MUL_ADD.statement });
    const retriever = new PremiseRetriever(PREMS_MATHLIB_1);
    const premises = new PremiseAugmentingLLM(menu, retriever, { premiseLocked: true, premiseTopK: 5 });

    await premises.complete({ user: `Goal: a * (b + c) = a * b + a * c\nPropose tactic:` });

    const finalUser = raw.calls[0][1].content;
    assert.ok(finalUser.includes('Premises (theorems you may use):'), 'premise section present');
    assert.ok(finalUser.includes('Nat.mul_add'), 'retrieved premise injected');
    assert.ok(finalUser.includes('Tactic menu (import-verified):'), 'menu present after premise rebuild');
    assert.ok(finalUser.includes('Propose ONE tactic'), 'single propose instruction');
    assert.ok(raw.calls[0][0].content.includes('ONLY use the premises'), 'lock honored in the system message');
});

test('menu caching returns the same menu for the same goal', async () => {
    const raw = new RecordingLLM();
    const wrapped = new TacticMenuAugmentingLLM(raw, { statement: TAUTO.statement });
    await wrapped.complete({ user: PROPOSAL_STRING });
    await wrapped.complete({ user: PROPOSAL_STRING });
    assert.strictEqual(raw.calls[0].user, raw.calls[1].user);
    assert.strictEqual(wrapped.menus.size, 1);
});
