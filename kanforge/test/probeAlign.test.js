import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPartialExamples } from '../agent/roles/probeAlign.js';

const IN_SYM = String.fromCharCode(0x2208);
const NOT_IN_SYM = String.fromCharCode(0x2209);

test('alignPartialExamples: typed ascription, untyped literal, and unicode Nat', () => {
    const exs = [
        `example : (4 : Nat) ${IN_SYM} S := by simp`,
        `example : 1 ${NOT_IN_SYM} S := by simp`,
        `example : (3 : \u2115) ${NOT_IN_SYM} S := by simp`
    ];
    const out = alignPartialExamples(exs, []);
    assert.deepEqual(out.map(r => r.instance), [
        'the number 4 is an element of the set',
        'the number 1 is not an element of the set',
        'the number 3 is not an element of the set'
    ]);
});

test('alignPartialExamples: unmatched example gets a null label (never invented)', () => {
    const out = alignPartialExamples(['example : True := by trivial'], []);
    assert.strictEqual(out[0].instance, null);
});
