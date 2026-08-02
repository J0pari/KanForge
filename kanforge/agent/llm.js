// Provider-neutral LLM client (architecture.md §1: agent/llm.js).
//
// Configuration is read from the environment (or an explicit config object for tests).
// Secrets never live in the repository and are never hardcoded: the API key comes from
// KANFORGE_LLM_API_KEY or a git-ignored .env file. Swapping providers is an environment
// change, not a code change (fungible): every provider speaks one of two wire formats,
// OpenAI-compatible chat completions or the Anthropic messages API.
//
// No mocks or stubs: the client always talks to the real provider endpoint over the real
// fetch. Request construction (`buildRequest`) and retry scheduling (`retryDelayMs`) are
// exported as pure functions so their logic is unit-testable without a network; end-to-end
// behavior is covered by the live suite, gated on a real key.

export const LLM_PROVIDERS = Object.freeze([
    'gemini', 'openai', 'anthropic', 'ollama', 'vllm', 'copilot', 'openrouter'
]);

const DEFAULT_BASE_URL = Object.freeze({
    gemini:    'https://generativelanguage.googleapis.com/v1beta/openai',
    openai:    'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    ollama:    'http://localhost:11434/v1',
    vllm:      'http://localhost:8000/v1',
    copilot:   'https://api.githubcopilot.com',
    openrouter: 'https://openrouter.ai/api/v1'
});

const DEFAULT_MODEL = Object.freeze({
    gemini:    'gemini-2.5-flash',
    openai:    'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    ollama:    'qwen2.5-coder:7b',
    vllm:      'Qwen/Qwen2.5-Coder-7B-Instruct',
    copilot:   'gpt-4o-mini',
    openrouter: 'openai/gpt-oss-20b:free'
});

// Local providers speak OpenAI-compatible chat completions on localhost and need no secret.
export const LOCAL_PROVIDERS = Object.freeze(['ollama', 'vllm']);

export class LLMError extends Error {
    constructor(message, { status = 0, kind = 'http', retryAfter = 0, cause } = {}) {
        super(message);
        this.name = 'LLMError';
        this.status = status;
        this.kind = kind; // 'http' | 'timeout' | 'rate-limit' | 'network' | 'config'
        this.retryAfter = retryAfter;
        this.cause = cause;
    }
}

export function loadLLMConfig(env = process.env) {
    const provider = (env.KANFORGE_LLM_PROVIDER ?? 'ollama').toLowerCase();
    if (!LLM_PROVIDERS.includes(provider)) {
        throw new Error(`unknown KANFORGE_LLM_PROVIDER: ${provider} (expected one of ${LLM_PROVIDERS.join(', ')})`);
    }
    return {
        provider,
        model: env.KANFORGE_LLM_MODEL ?? DEFAULT_MODEL[provider],
        apiKey: env.KANFORGE_LLM_API_KEY ?? null,
        baseUrl: env.KANFORGE_LLM_BASE_URL ?? DEFAULT_BASE_URL[provider],
        timeoutMs: Number(env.KANFORGE_LLM_TIMEOUT_MS ?? 60_000),
        temperature: env.KANFORGE_LLM_TEMPERATURE !== undefined ? Number(env.KANFORGE_LLM_TEMPERATURE) : 0.2,
        retries: Number(env.KANFORGE_LLM_RETRIES ?? 2)
    };
}

// Pure request construction: returns { url, headers, body } for a config + messages + opts.
export function buildRequest(config, messages, opts = {}) {
    const { provider, baseUrl, apiKey, model, temperature } = config;
    const maxTokens = opts.maxTokens ?? 2048;
    if (provider === 'anthropic') {
        return {
            url: `${baseUrl}/messages`,
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: { model, messages, max_tokens: maxTokens, temperature }
        };
    }
    // OpenAI-compatible chat completions (gemini, openai, ollama, vllm, copilot, openrouter)
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return {
        url: `${baseUrl}/chat/completions`,
        headers,
        body: { model, messages, max_tokens: maxTokens, temperature }
    };
}

// Pure retry scheduling. Returns delay ms to wait before the next attempt, or null to give up.
export function retryDelayMs(err, attempt, maxAttempts) {
    if (attempt >= maxAttempts) return null;
    if (err.kind === 'timeout') return 250 * (attempt + 1);
    if (err.kind === 'rate-limit') return (err.retryAfter > 0 ? err.retryAfter : 1000) * (attempt + 1);
    if (err.status >= 500) return 500 * (attempt + 1);
    return null;
}

export class LLMClient {
    constructor(config = null) {
        this.config = config ?? loadLLMConfig();
        if (typeof this.config.provider !== 'string') {
            throw new Error('LLMClient requires a config with a provider');
        }
        this.fetch = globalThis.fetch;
        if (typeof this.fetch !== 'function') {
            throw new Error('No global fetch available in this runtime');
        }
    }

    get provider() {
        return this.config.provider;
    }

    get model() {
        return this.config.model;
    }

    requiresApiKey() {
        // local providers need no secret; everything remote does
        return !LOCAL_PROVIDERS.includes(this.config.provider);
    }

    async complete(messages, opts = {}) {
        if (this.requiresApiKey() && !this.config.apiKey) {
            throw new LLMError(`${this.config.provider} requires KANFORGE_LLM_API_KEY`, { kind: 'config' });
        }

        const attempts = Math.max(0, Number(this.config.retries ?? 2));
        let lastErr;
        for (let attempt = 0; attempt <= attempts; attempt++) {
            try {
                return await this._request(messages, opts);
            } catch (err) {
                lastErr = err;
                const delay = retryDelayMs(err, attempt, attempts);
                if (delay === null) throw err;
                await new Promise(res => setTimeout(res, delay));
            }
        }
        throw lastErr;
    }

    async _request(messages, opts) {
        const { url, headers, body } = buildRequest(this.config, messages, opts);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        let resp;
        try {
            resp = await this.fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (cause) {
            if (cause?.name === 'AbortError') {
                throw new LLMError(`LLM request timed out after ${this.config.timeoutMs}ms`, { kind: 'timeout', cause });
            }
            throw new LLMError(`LLM request failed: ${cause?.message ?? cause}`, { kind: 'network', cause });
        } finally {
            clearTimeout(timer);
        }

        const text = await resp.text();
        if (!resp.ok) {
            const kind = resp.status === 429 ? 'rate-limit' : 'http';
            const retryAfter = Number(resp.headers?.get?.('retry-after')) || 0;
            throw new LLMError(`LLM HTTP ${resp.status}: ${truncate(text, 300)}`, {
                status: resp.status, kind, retryAfter
            });
        }
        return this._parse(text, resp.status);
    }

    _parse(text, status) {
        return parseCompletion(text, status, this.config.provider, this.config.model);
    }
}

// Pure response parsing for the provider wire shapes.
export function parseCompletion(text, status, provider, model) {
    const data = JSON.parse(text);
    const usage = normalizeUsage(data.usage);
    const message = data.choices?.[0]?.message;
    const content = message?.content
        ?? message?.reasoning   // reasoning models (e.g. cohere north) can return null content
        ?? data.content?.filter?.(p => p.type === 'text').map(p => p.text).join('')
        ?? '';
    return {
        text: content,
        usage,
        provider,
        model: data.model ?? model,
        rawStatus: status
    };
}

export function createLLM(config = null) {
    return new LLMClient(config);
}

function normalizeUsage(usage = {}) {
    return {
        promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0
    };
}

function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n)}...` : s;
}
