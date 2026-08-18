// blueprint/falsify.js — the falsification gate: bounded counterexample search on candidate
// lemmas, kernel-evidence only (the erdos10 bridging lemma `two_pow_two_pow_ne_sum` is false
// at k=0; this gate exists so that class never costs 400+ proof-search rounds again).
import test from 'node:test';
import assert from 'node:assert';
import {
    isFalsifiableStatement,
    buildFalsificationPrompt,
    parseFalsificationInstances,
    falsifyCandidate
} from '../blueprint/falsify.js';
import { SkeletonGenerator } from '../blueprint/skeleton.js';
import { hashStatement } from '../lean/pin.js';

const FALSE_LEMMA = 'theorem two_pow_two_pow_ne_sum : ∀ k p a b : Nat, Nat.Prime p → 2 ^ (2 ^ (k + 1)) ≠ p + 2 ^ a + 2 ^ b := by sorry';
const TRUE_LEMMA = 'theorem add_comm_probe (a b : Nat) : a + b = b + a := by sorry';
const NON_UNIVERSAL = 'theorem exists_probe : ∃ n : Nat, n + 1 = 2 := by sorry';

test('isFalsifiableStatement gates on universal Nat claims with arithmetic content', () => {
    assert.strictEqual(isFalsifiableStatement(FALSE_LEMMA), true);
    assert.strictEqual(isFalsifiableStatement(TRUE_LEMMA), true);
    assert.strictEqual(isFalsifiableStatement(NON_UNIVERSAL), false);
    assert.strictEqual(isFalsifiableStatement(''), false);
});

test('parseFalsificationInstances extracts only decidable example lines', () => {
    const text = 'Here are the instances:\nexample : Nat.Prime 2 ∧ (4 : Nat) = 2 + 2 ^ 0 + 2 ^ 0 := by decide\nexample : (2 : Nat) + 1 = 2 := by decide\nexample : True := by sorry\nrandom prose';
    const out = parseFalsificationInstances(text);
    assert.deepStrictEqual(out, [
        'Nat.Prime 2 ∧ (4 : Nat) = 2 + 2 ^ 0 + 2 ^ 0',
        '(2 : Nat) + 1 = 2'
    ]);
});

test('falsifyCandidate marks a false claim only on kernel-verified evidence', async () => {
    const llm = {
        async complete() {
            return { text: 'example : Nat.Prime 2 ∧ (2 ^ (2 ^ (0 + 1)) : Nat) = 2 + 2 ^ 0 + 2 ^ 0 := by decide\nexample : Nat.Prime 3 ∧ (2 ^ (2 ^ (0 + 1)) : Nat) = 3 + 2 ^ 0 := by decide' };
        }
    };
    const backend = {
        // The kernel verifies exactly the true counterexample instance.
        async check(src) {
            if (src.includes('= 2 + 2 ^ 0 + 2 ^ 0')) return { status: 'verified' };
            return { status: 'error', error: { message: 'not decidable-true' } };
        }
    };
    const r = await falsifyCandidate(FALSE_LEMMA, { llm, backend });
    assert.strictEqual(r.falsified, true);
    assert.strictEqual(r.counterexample, 'Nat.Prime 2 ∧ (2 ^ (2 ^ (0 + 1)) : Nat) = 2 + 2 ^ 0 + 2 ^ 0');
    assert.strictEqual(r.checked, 1);
});

test('falsifyCandidate reports unfalsified when no instance verifies', async () => {
    const llm = { async complete() { return { text: 'example : (0 : Nat) + 0 = 1 := by decide' }; } };
    const backend = { async check() { return { status: 'error', error: { message: 'false' } }; } };
    const r = await falsifyCandidate(TRUE_LEMMA, { llm, backend });
    assert.strictEqual(r.falsified, false);
});

test('skeleton retries the decomposition when a candidate is kernel-falsified', async () => {
    let calls = 0;
    const FALSE_CHILD = 'theorem bad_bridge : ∀ k : Nat, 2 ^ k ≠ 2 ^ k := by sorry';
    const GOOD_CHILD = 'theorem good_bridge (n : Nat) : n + 0 = n := by sorry';
    const llm = {
        async complete(messages) {
            const user = (messages.find(m => m.role === 'user') ?? { content: '' }).content ?? '';
            if (user.includes('Decompose this theorem into')) {
                calls++;
                if (calls === 1) {
                    return { text: JSON.stringify({ lemmas: [{ name: 'bad_bridge', statement: FALSE_CHILD, deps: [] }], rootDeps: ['bad_bridge'] }) };
                }
                assert.ok(user.includes('FALSIFIED'), 'retry prompt must carry the falsification evidence');
                return { text: JSON.stringify({ lemmas: [{ name: 'good_bridge', statement: GOOD_CHILD, deps: [] }], rootDeps: ['good_bridge'] }) };
            }
            return { text: 'example : (0 : Nat) = 0 ^ 0 := by decide' };
        }
    };
    const backend = {
        async check(src) {
            // The falsification probe verifies the counterexample instance for bad_bridge.
            if (src.includes('example') && src.includes('0 ^ 0')) return { status: 'verified' };
            // Skeleton typechecks: every stub passes.
            return { status: 'verified', goals: [] };
        },
        pin() { return { toolchain: 'mock', normVersion: 1 }; }
    };
    const skeleton = new SkeletonGenerator({ llm, backend });
    const result = await skeleton.generate('theorem thm : P := by sorry', {
        falsify: { enabled: (stmt) => stmt.includes('bad_bridge') ? falsifyCandidate(stmt, { llm, backend }) : { falsified: false } }
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.blueprint.lemmas.some(l => l.statement.includes('good_bridge')), 'retry must carry the good child');
    assert.ok(!result.blueprint.lemmas.some(l => l.statement.includes('bad_bridge')), 'the falsified child must be dropped');
    assert.strictEqual(calls, 2);
});
