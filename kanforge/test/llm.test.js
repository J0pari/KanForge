import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMClient, LLMError, loadLLMConfig, createLLM, LLM_PROVIDERS } from '../agent/llm.js';

const MESSAGES = [{ role: 'user', content: 'prove: 2+2=4' }];

function fakeResponse(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        async text() {
            return JSON.stringify(body);
        }
    };
}

function openaiBody(text = 'ok', usage = { prompt_tokens: 5, completion_tokens: 3 }) {
    return {
        choices: [{ message: { content: text } }],
        usage,
        model: 'test-model'
    };
}

function anthropicBody(text = 'ok', usage = { input_tokens: 5, output_tokens: 3 }) {
    return {
        content: [{ type: 'text', text }],
        usage,
        model: 'test-model'
    };
}

test('loadLLMConfig defaults to local ollama with no secret', () => {
    const cfg = loadLLMConfig({});
    assert.equal(cfg.provider, 'ollama');
    assert.equal(cfg.apiKey, null);
    assert.equal(cfg.requiresApiKey ?? false, false);
    assert.ok(cfg.baseUrl.includes('11434'));
    assert.ok(LLM_PROVIDERS.includes('gemini'));
    assert.ok(LLM_PROVIDERS.includes('mock'));
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

test('remote providers require a key; local providers do not', async () => {
    const gemini = createLLM({ ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini' }) });
    assert.equal(gemini.requiresApiKey(), true);
    await assert.rejects(() => gemini.complete(MESSAGES), (err) => err.kind === 'config');

    const ollama = createLLM({ ...loadLLMConfig({}), fetchImpl: async () => fakeResponse(200, openaiBody()) });
    assert.equal(ollama.requiresApiKey(), false);
    const out = await ollama.complete(MESSAGES);
    assert.equal(out.text, 'ok');
});

test('openai-compatible wire: URL, bearer header, body, parsing', async () => {
    let captured;
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'gemini', KANFORGE_LLM_API_KEY: 'env-key' }),
        fetchImpl: async (url, init) => {
            captured = { url, init };
            return fakeResponse(200, openaiBody('the proof', { prompt_tokens: 10, completion_tokens: 4 }));
        }
    });
    const out = await client.complete(MESSAGES, { maxTokens: 512 });
    assert.ok(captured.url.endsWith('/chat/completions'));
    assert.equal(captured.init.headers.authorization, 'Bearer env-key');
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body.messages, MESSAGES);
    assert.equal(body.max_tokens, 512);
    assert.equal(out.text, 'the proof');
    assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 4 });
});

test('copilot provider uses OpenAI-compatible wire with key', async () => {
    let captured;
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'copilot', KANFORGE_LLM_API_KEY: 'ck' }),
        fetchImpl: async (url, init) => {
            captured = { url, init };
            return fakeResponse(200, openaiBody());
        }
    });
    await client.complete(MESSAGES);
    assert.ok(captured.url.includes('api.githubcopilot.com'));
    assert.equal(captured.init.headers.authorization, 'Bearer ck');
});

test('anthropic adapter: native messages wire + token normalization', async () => {
    let captured;
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'anthropic', KANFORGE_LLM_API_KEY: 'sk-ant' }),
        fetchImpl: async (url, init) => {
            captured = { url, init };
            return fakeResponse(200, anthropicBody('done', { input_tokens: 7, output_tokens: 2 }));
        }
    });
    const out = await client.complete(MESSAGES);
    assert.ok(captured.url.endsWith('/messages'));
    assert.equal(captured.init.headers['x-api-key'], 'sk-ant');
    assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.max_tokens, 2048);
    assert.equal(out.text, 'done');
    assert.deepEqual(out.usage, { promptTokens: 7, completionTokens: 2 });
});

test('request timeout surfaces as LLMError kind timeout', async () => {
    const client = createLLM({
        ...loadLLMConfig({}),
        timeoutMs: 20,
        fetchImpl: (url, init) => new Promise((res, rej) => {
            init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    });
    await assert.rejects(() => client.complete(MESSAGES), (err) => err.kind === 'timeout');
});

test('429 rate limit retries with retry-after then succeeds', async () => {
    const calls = [];
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'openai', KANFORGE_LLM_API_KEY: 'k', KANFORGE_LLM_RETRIES: '2' }),
        fetchImpl: async () => {
            calls.push(calls.length);
            if (calls.length === 1) {
                return fakeResponse(429, { error: { message: 'quota' } }, { 'retry-after': '0' });
            }
            return fakeResponse(200, openaiBody());
        }
    });
    const out = await client.complete(MESSAGES);
    assert.equal(out.text, 'ok');
    assert.equal(calls.length, 2);
});

test('5xx retries then gives up with the last error', async () => {
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'openai', KANFORGE_LLM_API_KEY: 'k', KANFORGE_LLM_RETRIES: '1' }),
        fetchImpl: async () => fakeResponse(503, { error: 'down' })
    });
    await assert.rejects(
        () => client.complete(MESSAGES),
        (err) => err instanceof LLMError && err.status === 503 && err.kind === 'http'
    );
});

test('network failure surfaces as LLMError kind network', async () => {
    const client = createLLM({
        ...loadLLMConfig({}),
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });
    await assert.rejects(() => client.complete(MESSAGES), (err) => err.kind === 'network');
});

test('mock provider returns configured reply without any network', async () => {
    const client = createLLM({
        ...loadLLMConfig({ KANFORGE_LLM_PROVIDER: 'mock' }),
        mockReply: (messages) => `canned response for ${messages.at(-1).content}`
    });
    const out = await client.complete(MESSAGES);
    assert.equal(out.text, 'canned response for prove: 2+2=4');
    assert.equal(out.provider, 'mock');
});

test('no secret is ever a default', () => {
    const cfg = loadLLMConfig({});
    assert.equal(cfg.apiKey, null);
    for (const provider of LLM_PROVIDERS) {
        const c = loadLLMConfig({ KANFORGE_LLM_PROVIDER: provider });
        assert.equal(c.apiKey, null, `${provider} must never default a key`);
    }
});
