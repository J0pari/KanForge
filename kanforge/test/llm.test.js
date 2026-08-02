import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMError, loadLLMConfig, createLLM, LLM_PROVIDERS, buildRequest, retryDelayMs, messagesToPrompt, parseOpenCodeOutput } from '../agent/llm.js';
import { ENV } from './loadEnv.js';

const MESSAGES = [{ role: 'user', content: 'prove: 2+2=4' }];

test('loadLLMConfig defaults to opencode, keyless, with no secret/baseUrl fields at all', () => {
    const cfg = loadLLMConfig({});
    assert.equal(cfg.provider, 'opencode');
    assert.equal(cfg.model, 'big-pickle');
    assert.ok(!('apiKey' in cfg), 'an opencode-only layer must not carry a secret field');
    assert.ok(!('baseUrl' in cfg), 'the CLI transport has no HTTP base URL');
    assert.deepEqual(LLM_PROVIDERS, ['opencode'], 'opencode is the sole provider');
    assert.ok(!LLM_PROVIDERS.includes('mock'), 'no mock provider may exist');
});

test('loadLLMConfig reads env overrides', () => {
    const cfg = loadLLMConfig({
        KANFORGE_LLM_PROVIDER: 'opencode',
        KANFORGE_LLM_MODEL: 'opencode/big-pickle',
        KANFORGE_LLM_TIMEOUT_MS: '90000',
        KANFORGE_LLM_RETRIES: '4',
        KANFORGE_LLM_OPENCODE_BIN: 'C:\\opencode.exe'
    });
    assert.equal(cfg.provider, 'opencode');
    assert.equal(cfg.model, 'opencode/big-pickle');
    assert.equal(cfg.timeoutMs, 90000);
    assert.equal(cfg.retries, 4);
    assert.equal(cfg.opencodeBin, 'C:\\opencode.exe');
});

test('loadLLMConfig rejects every provider other than opencode, including former ollama/openrouter', () => {
    assert.throws(() => loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'openrouter' }), /unknown KANFORGE_LLM_PROVIDER.*openrouter/);
    assert.throws(() => loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'ollama' }), /unknown KANFORGE_LLM_PROVIDER/);
    assert.throws(() => loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini' }), /unknown KANFORGE_LLM_PROVIDER/);
    assert.throws(() => loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'not-a-provider' }), /unknown KANFORGE_LLM_PROVIDER/);
});

test('retryDelayMs: only transient timeouts are retried; hard CLI failures are surfaced', () => {
    assert.equal(retryDelayMs(new LLMError('t', { kind: 'timeout' }), 0, 2), 250);
    assert.equal(retryDelayMs(new LLMError('t', { kind: 'timeout' }), 2, 2), null, 'no retries left');
    assert.equal(retryDelayMs(new LLMError('e', { kind: 'http' }), 0, 2), null, 'CLI non-zero exits are not retried');
    assert.equal(retryDelayMs(new LLMError('s', { kind: 'network' }), 0, 2), null, 'spawn failures are not retried');
    assert.equal(retryDelayMs(new LLMError('a', { kind: 'abort' }), 0, 2), null, 'caller-driven aborts are never retried');
});

test('complete with an already-aborted signal rejects as abort without spawning the CLI', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createLLM(loadLLMConfig({}));
    await assert.rejects(
        client.complete([{ role: 'user', content: 'x' }], { signal: controller.signal }),
        err => err.kind === 'abort'
    );
});

test('messagesToPrompt: system instructions + task serialize into one prompt', () => {
    const prompt = messagesToPrompt([
        { role: 'system', content: 'Use omega first.' },
        { role: 'user', content: 'prove 2+2=4' }
    ]);
    assert.match(prompt, /System instructions:\nUse omega first\./);
    assert.match(prompt, /Task:\nprove 2\+2=4/);
    assert.ok(prompt.indexOf('System instructions') < prompt.indexOf('Task:'));
});

test('parseOpenCodeOutput: collects text parts and usage, ignores unknown event types', () => {
    const out = parseOpenCodeOutput([
        JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'exact ' } }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'Nat.add_comm' } }),
        JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 7, output: 3, reasoning: 0 } } })
    ].join('\n'));
    assert.equal(out.text, 'exact Nat.add_comm');
    assert.deepEqual(out.usage, { promptTokens: 7, completionTokens: 3 });
    assert.deepEqual(parseOpenCodeOutput('').usage, { promptTokens: 0, completionTokens: 0 });
});

test('parseOpenCodeOutput: a non-JSON line breaks the CLI contract and is surfaced, never dropped', () => {
    assert.throws(
        () => parseOpenCodeOutput('not-json at all\n' + JSON.stringify({ type: 'text', part: { type: 'text', text: 'x' } })),
        /contract violated.*not-json at all/
    );
});

test('buildRequest: opencode routes to the CLI transport with the serialized prompt', () => {
    const cfg = loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'opencode' });
    const req = buildRequest(cfg, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'goal' }
    ], { maxTokens: 128 });
    assert.equal(req.cli, true);
    assert.equal(req.model, 'big-pickle');
    assert.equal(req.maxTokens, 128);
    assert.match(req.prompt, /System instructions:\nsys/);
});

test('live: opencode round-trip through the real CLI (no key required)', {
    skip: ENV.KANFORGE_LLM_PROVIDER !== 'opencode' && 'set KANFORGE_LLM_PROVIDER=opencode to run this gate'
}, async () => {
    const client = createLLM({ ...loadLLMConfig(ENV), timeoutMs: 120_000 });
    const out = await client.complete(
        [{ role: 'user', content: 'Reply with exactly one word: ok' }],
        { maxTokens: 32 }
    );
    assert.equal(out.provider, 'opencode');
    assert.ok(out.model.startsWith('opencode/'));
    assert.ok(out.text.trim().length > 0, 'expected a non-empty completion');
    assert.ok(out.usage.completionTokens >= 0);
});
