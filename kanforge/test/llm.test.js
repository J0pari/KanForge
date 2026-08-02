import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMError, loadLLMConfig, createLLM, LLM_PROVIDERS, LOCAL_PROVIDERS, buildRequest, retryDelayMs, parseCompletion } from '../agent/llm.js';
import { ENV } from './loadEnv.js';

const MESSAGES = [{ role: 'user', content: 'prove: 2+2=4' }];

const LIVE_PROVIDER = ENV.KANFORGE_LLM_PROVIDER ?? 'openrouter';
const HAS_KEY = Boolean(ENV.KANFORGE_LLM_API_KEY);

test('loadLLMConfig defaults to local ollama with no secret', () => {
    const cfg = loadLLMConfig({});
    assert.equal(cfg.provider, 'ollama');
    assert.equal(cfg.apiKey, null);
    assert.equal(cfg.requiresApiKey ?? false, false);
    assert.ok(cfg.baseUrl.includes('11434'));
    assert.ok(LLM_PROVIDERS.includes('gemini'));
    assert.ok(!LLM_PROVIDERS.includes('mock'), 'no mock provider may exist');
});

test('loadLLMConfig reads env overrides', () => {
    const cfg = loadLLMConfig({
        KANFORGE_LLM_PROVIDER: 'gemini',
        KANFORGE_LLM_MODEL: 'gemini-2.0-flash-lite',
        KANFORGE_LLM_API_KEY: 'env-key',
        KANFORGE_LLM_BASE_URL: 'https://custom.example/v1'
    });
    assert.equal(cfg.provider, 'gemini');
    assert.equal(cfg.model, 'gemini-2.0-flash-lite');
    assert.equal(cfg.apiKey, 'env-key');
    assert.equal(cfg.baseUrl, 'https://custom.example/v1');
});

test('loadLLMConfig rejects unknown providers', () => {
    assert.throws(() => loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'not-a-provider' }), /unknown KANFORGE_LLM_PROVIDER/);
});

test('requiresApiKey: remote providers need a key, local providers do not', () => {
    assert.equal(createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini' }) }).requiresApiKey(), true);
    assert.equal(createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'openrouter' }) }).requiresApiKey(), true);
    assert.equal(createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'anthropic' }) }).requiresApiKey(), true);
    assert.equal(createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'ollama' }) }).requiresApiKey(), false);
    assert.equal(createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'vllm' }) }).requiresApiKey(), false);
    assert.deepEqual(LOCAL_PROVIDERS, ['ollama', 'vllm']);
});

test('missing key on a remote provider fails fast with kind config', async () => {
    const gemini = createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini' }) });
    await assert.rejects(() => gemini.complete(MESSAGES), (err) => err.kind === 'config');
});

test('buildRequest: OpenAI-compatible wire (gemini) — url, bearer header, body', () => {
    const cfg = loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini', KANFORGE_LLM_API_KEY: 'env-key' });
    const { url, headers, body } = buildRequest(cfg, MESSAGES, { maxTokens: 512 });
    assert.ok(url.endsWith('/chat/completions'));
    assert.equal(headers.authorization, 'Bearer env-key');
    assert.deepEqual(body.messages, MESSAGES);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.model, cfg.model);
});

test('buildRequest: openrouter uses OpenAI-compatible wire with the pinned default model', () => {
    const cfg = loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'openrouter', KANFORGE_LLM_API_KEY: 'or-key' });
    const { url, headers, body } = buildRequest(cfg, MESSAGES);
    assert.ok(url.includes('openrouter.ai/api/v1/chat/completions'));
    assert.equal(headers.authorization, 'Bearer or-key');
    assert.equal(body.model, 'openai/gpt-oss-20b:free');
});

test('buildRequest: anthropic native wire — x-api-key, version, /messages, max_tokens default', () => {
    const cfg = loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'anthropic', KANFORGE_LLM_API_KEY: 'sk-ant' });
    const { url, headers, body } = buildRequest(cfg, MESSAGES);
    assert.ok(url.endsWith('/messages'));
    assert.equal(headers['x-api-key'], 'sk-ant');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(body.max_tokens, 2048);
});

test('buildRequest: custom baseUrl override is honored', () => {
    const cfg = loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'vllm', KANFORGE_LLM_BASE_URL: 'http://localhost:8000/v1' });
    const { url, headers } = buildRequest(cfg, MESSAGES);
    assert.ok(url.includes('localhost:8000'));
    assert.equal(headers.authorization, undefined, 'no key on local providers');
});

test('retryDelayMs: pure retry scheduling', () => {
    assert.equal(retryDelayMs(new LLMError('t', { kind: 'timeout' }), 0, 2), 250);
    assert.equal(retryDelayMs(new LLMError('r', { kind: 'rate-limit', retryAfter: 3 }), 0, 2), 3);
    assert.equal(retryDelayMs(new LLMError('r', { kind: 'rate-limit' }), 1, 2), 2000);
    assert.equal(retryDelayMs(new LLMError('s', { status: 503 }), 0, 2), 500);
    assert.equal(retryDelayMs(new LLMError('4', { status: 400 }), 0, 2), null, '4xx is not retried');
    assert.equal(retryDelayMs(new LLMError('t', { kind: 'timeout' }), 2, 2), null, 'no retries left');
});

test('parseCompletion: content, reasoning fallback, and usage normalization', () => {
    const withContent = parseCompletion(JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
        model: 'm'
    }), 200, 'openrouter', 'fallback');
    assert.equal(withContent.text, 'done');
    assert.deepEqual(withContent.usage, { promptTokens: 7, completionTokens: 2 });
    assert.equal(withContent.model, 'm');

    // Reasoning models can return null content at max_tokens cut-off; fall back to reasoning.
    const withReasoning = parseCompletion(JSON.stringify({
        choices: [{ message: { content: null, reasoning: 'draft proof steps...' } }],
        usage: { prompt_tokens: 5, completion_tokens: 90 },
        model: 'cohere/north-mini-code:free'
    }), 200, 'openrouter', 'fallback');
    assert.equal(withReasoning.text, 'draft proof steps...');
    assert.equal(withReasoning.model, 'cohere/north-mini-code:free');
});

test('no secret is ever a default', () => {
    const cfg = loadLLMConfig({});
    assert.equal(cfg.apiKey, null);
    for (const provider of LLM_PROVIDERS) {
        const c = loadLLMConfig({ KANFORGE_LLM_PROVIDER: provider });
        assert.equal(c.apiKey, null, `${provider} must never default a key`);
    }
});

test(
    'live: real provider round-trip with the configured key',
    { skip: !HAS_KEY && 'KANFORGE_LLM_API_KEY not set (add to kanforge/.env)' },
    async () => {
        const client = createLLM({ ...loadLLMConfig(ENV), timeoutMs: 90_000 });
        assert.equal(client.requiresApiKey(), true);
        const out = await client.complete(
            [{ role: 'user', content: 'Reply with exactly one word: ok' }],
            { maxTokens: 32 }
        );
        assert.ok(typeof out.text === 'string' && out.text.length > 0, 'expected a non-empty completion');
        assert.equal(out.provider, LIVE_PROVIDER);
        assert.ok(out.usage.promptTokens >= 0);
        assert.ok(out.usage.completionTokens >= 0);
    }
);
