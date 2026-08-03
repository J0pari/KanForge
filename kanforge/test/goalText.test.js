// Goal-text parser tests (lean/goalText.js) — fixtures are the exact strings observed from
// the real repl binary (rev 1d23837) during protocol probing.

import test from 'node:test';
import assert from 'node:assert';
import { parseGoalText, formatBinders, splitGoalBlocks } from '../lean/goalText.js';

test('parses telescope + target (trans_lt open goal)', () => {
    const g = parseGoalText('a b c : Nat\nh : a < b\nh2 : b < c\n⊢ a < c');
    assert.strictEqual(g.type, 'a < c');
    assert.deepStrictEqual(g.context, [
        { name: 'a', type: 'Nat' },
        { name: 'b', type: 'Nat' },
        { name: 'c', type: 'Nat' },
        { name: 'h', type: 'a < b' },
        { name: 'h2', type: 'b < c' }
    ]);
    assert.strictEqual(g.caseName, null);
});

test('parses hypothesis telescope (and_comm)', () => {
    const g = parseGoalText('p q : Prop\nh : p ∧ q\n⊢ q ∧ p');
    assert.strictEqual(g.type, 'q ∧ p');
    assert.deepStrictEqual(g.context.at(-1), { name: 'h', type: 'p ∧ q' });
});

test('parses case-tagged induction goals with inaccessible names', () => {
    const zero = parseGoalText('case zero\n⊢ 0 + 0 = 0');
    assert.strictEqual(zero.caseName, 'zero');
    assert.strictEqual(zero.type, '0 + 0 = 0');
    assert.deepStrictEqual(zero.context, []);

    const succ = parseGoalText('case succ\nn✝ : Nat\na✝ : n✝ + 0 = n✝\n⊢ n✝ + 1 + 0 = n✝ + 1');
    assert.strictEqual(succ.caseName, 'succ');
    assert.strictEqual(succ.type, 'n✝ + 1 + 0 = n✝ + 1');
    assert.deepStrictEqual(succ.context, [
        { name: 'n✝', type: 'Nat' },
        { name: 'a✝', type: 'n✝ + 0 = n✝' }
    ]);
});

test('round-trips binders for statement reconstruction', () => {
    const g = parseGoalText('a b c : Nat\nh : a < b\nh2 : b < c\n⊢ a < c');
    assert.strictEqual(formatBinders(g.context), '(a : Nat) (b : Nat) (c : Nat) (h : a < b) (h2 : b < c)');
});

test('splits multi-goal unsolved blocks on case tags', () => {
    const blocks = splitGoalBlocks('case zero\n⊢ 0 + 0 = 0\ncase succ\nn✝ : Nat\n⊢ n✝ + 1 + 0 = n✝ + 1');
    assert.strictEqual(blocks.length, 2);
    assert.ok(blocks[0].includes('0 + 0 = 0'));
    assert.ok(blocks[1].includes('n✝ + 1 + 0'));
});

test('tolerates empty/garbage input', () => {
    assert.deepStrictEqual(parseGoalText(''), { type: '', context: [], caseName: null });
    assert.deepStrictEqual(parseGoalText(null), { type: '', context: [], caseName: null });
});
