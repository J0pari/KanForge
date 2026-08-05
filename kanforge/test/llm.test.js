// LLM transport pure functions (agent/llm.js) — node:test form.
// Covers the prompt-shape normalization every search strategy relies on: the strategies pass
// arrays, `{ user }` shorthands (bestofn), or bare strings (RepulsionSampler) to llm.complete(),
// and the real CLI client must accept all three without crashing. Also covers event-stream
// parsing and retry scheduling.

import test from 'node:test';
import assert from 'node:assert';
import {
    normalizeMessages,
    messagesToPrompt,
    sanitizeTacticText,
    parseOpenCodeOutput,
    buildRequest,
    retryDelayMs
} from '../agent/llm.js';

test('normalizeMessages: accepts array, { user }, and bare string forms', () => {
    const array = [{ role: 'system', content: 's' }, { role: 'user', content: 'g' }];
    assert.deepStrictEqual(normalizeMessages(array), array);
    assert.deepStrictEqual(normalizeMessages('Goal: a = a'), [{ role: 'user', content: 'Goal: a = a' }]);
    assert.deepStrictEqual(normalizeMessages({ user: 'Goal: a = a' }), [{ role: 'user', content: 'Goal: a = a' }]);
});

test('normalizeMessages: empty/unknown shapes degrade to an empty array, never throw', () => {
    assert.deepStrictEqual(normalizeMessages(null), []);
    assert.deepStrictEqual(normalizeMessages(undefined), []);
    assert.deepStrictEqual(normalizeMessages({},), []);
    assert.deepStrictEqual(normalizeMessages(42), []);
});

test('messagesToPrompt: all three shapes serialize to the same user prompt', () => {
    const expected = 'Task:\nGoal: a = a';
    assert.strictEqual(messagesToPrompt('Goal: a = a'), expected);
    assert.strictEqual(messagesToPrompt({ user: 'Goal: a = a' }), expected);
    assert.strictEqual(messagesToPrompt([{ role: 'user', content: 'Goal: a = a' }]), expected);
});

test('messagesToPrompt: system/assistant roles get distinct labels', () => {
    const out = messagesToPrompt([
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'prev' },
        { role: 'user', content: 'next' }
    ]);
    assert.ok(out.includes('System instructions:\nsys'));
    assert.ok(out.includes('Assistant (history):\nprev'));
    assert.ok(out.includes('Task:\nnext'));
});

test('sanitizeTacticText: strips markdown fences, backticks, and trailing prose', () => {
    assert.strictEqual(sanitizeTacticText('`ring`'), 'ring');
    assert.strictEqual(sanitizeTacticText('```lean\nring\n```'), 'ring');
    assert.strictEqual(sanitizeTacticText('`omega` (proves linear arithmetic)'), 'omega');
    assert.strictEqual(sanitizeTacticText('  simp [h]  '), 'simp [h]');
    assert.strictEqual(sanitizeTacticText(null), '');
    assert.strictEqual(sanitizeTacticText(''), '');
});

test('parseOpenCodeOutput: concatenates text parts and reads the terminal token counts', () => {
    const stdout = [
        JSON.stringify({ type: 'text', part: { text: 'ring' } }),
        JSON.stringify({ type: 'text', part: { text: '' } }),
        JSON.stringify({ type: 'step_finish', part: { tokens: { input: 12, output: 3 } } })
    ].join('\n');
    assert.deepStrictEqual(parseOpenCodeOutput(stdout), { text: 'ring', usage: { promptTokens: 12, completionTokens: 3 } });
});

test('parseOpenCodeOutput: a non-JSON line breaks the contract loudly', () => {
    assert.throws(() => parseOpenCodeOutput('not json'), /contract violated/);
});

test('buildRequest: serializes messages through messagesToPrompt', () => {
    const req = buildRequest({ model: 'big-pickle' }, { user: 'Goal: a = a' }, { maxTokens: 32 });
    assert.deepStrictEqual(req, { cli: true, model: 'big-pickle', prompt: 'Task:\nGoal: a = a', maxTokens: 32 });
});

test('retryDelayMs: only timeouts are retried; aborts and hard failures are not', () => {
    assert.strictEqual(retryDelayMs({ kind: 'timeout' }, 0, 2), 250);
    assert.strictEqual(retryDelayMs({ kind: 'timeout' }, 1, 2), 500);
    assert.strictEqual(retryDelayMs({ kind: 'timeout' }, 2, 2), null);
    assert.strictEqual(retryDelayMs({ kind: 'abort' }, 0, 2), null);
    assert.strictEqual(retryDelayMs({ kind: 'http' }, 0, 2), null);
    assert.strictEqual(retryDelayMs({ kind: 'network' }, 0, 2), null);
});
