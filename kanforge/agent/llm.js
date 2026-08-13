// Sole LLM client (architecture.md §1: agent/llm.js).
//
// KanForge delegates ALL model interaction to opencode: the client runs the opencode CLI as a
// subprocess (`opencode run --format json -m opencode/<model> "<prompt>"`) and reads the
// JSON-lines event stream. big-pickle is served on the opencode free tier, so no secret is ever
// needed; the model is fungible at the opencode layer (set KANFORGE_LLM_MODEL to any model ref
// opencode can serve).
//
// Isolation: every call runs in a per-user scratch project dir (`--dir <tmp>/kanforge-opencode`),
// so kanforge sessions never collide with the desktop app's. (OPENCODE_DATA is NOT honored by the
// CLI — verified empirically — so the scratch dir is the isolation boundary.)
//
// No mocks or stubs: the client always drives the real CLI. Request construction (buildRequest),
// prompt serialization (messagesToPrompt), event parsing (parseOpenCodeOutput), and retry
// scheduling (retryDelayMs) are exported as pure functions so their logic is unit-testable;
// end-to-end behavior is covered by the live suite gated on the opencode CLI being installed.
//
// Strictness: there are no fallback paths. A missing CLI, a non-JSON stdout, a non-zero exit,
// or a timeout all surface as loud, actionable errors. The only retried condition is a timeout
// (transient); a hard CLI failure is never silently swallowed.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LLM_PROVIDERS = Object.freeze(['opencode']);

const DEFAULT_MODEL = 'big-pickle';

export class LLMError extends Error {
    constructor(message, { status = 0, kind = 'http', cause } = {}) {
        super(message);
        this.name = 'LLMError';
        this.status = status;
        this.kind = kind; // 'http' (CLI non-zero exit) | 'timeout' | 'network' (spawn failure)
        this.cause = cause;
    }
}

export function loadLLMConfig(env = process.env) {
    const provider = (env.KANFORGE_LLM_PROVIDER ?? 'opencode').toLowerCase();
    if (provider !== 'opencode') {
        throw new Error(`unknown KANFORGE_LLM_PROVIDER: ${provider} (expected one of ${LLM_PROVIDERS.join(', ')})`);
    }
    return {
        provider: 'opencode',
        model: env.KANFORGE_LLM_MODEL ?? DEFAULT_MODEL,
        timeoutMs: Number(env.KANFORGE_LLM_TIMEOUT_MS ?? 60_000),
        retries: Number(env.KANFORGE_LLM_RETRIES ?? 2),
        opencodeBin: env.KANFORGE_LLM_OPENCODE_BIN ?? null
    };
}

// Pure request construction for the CLI transport.
export function buildRequest(config, messages, opts = {}) {
    return {
        cli: true,
        model: config.model,
        prompt: messagesToPrompt(messages),
        maxTokens: opts.maxTokens ?? 2048
    };
}

// Pure retry scheduling. Only a timeout is transient enough to retry; a hard CLI failure
// (non-zero exit, spawn error) is a real condition that must be surfaced, not retried, and a
// caller-driven abort is never retried either.
export function retryDelayMs(err, attempt, maxAttempts) {
    if (attempt >= maxAttempts) return null;
    if (err.kind === 'abort') return null;
    if (err.kind === 'timeout') return 250 * (attempt + 1);
    return null;
}

export class LLMClient {
    constructor(config = null) {
        this.config = config ?? loadLLMConfig();
        if (typeof this.config.provider !== 'string') {
            throw new Error('LLMClient requires a config with a provider');
        }
    }

    get provider() {
        return this.config.provider;
    }

    get model() {
        return this.config.model;
    }

    async complete(messages, opts = {}) {
        const attempts = Math.max(0, Number(this.config.retries ?? 2));
        const { signal } = opts;
        let lastErr;
        for (let attempt = 0; attempt <= attempts; attempt++) {
            try {
                return await this._cliRequest(buildRequest(this.config, messages, opts), opts);
            } catch (err) {
                lastErr = err;
                const delay = retryDelayMs(err, attempt, attempts);
                if (delay === null) throw err;
                if (signal?.aborted) throw err; // caller gave up: never sleep-and-retry past an abort
                await new Promise((resolve, reject) => {
                    const onAbort = () => { clearTimeout(timer); reject(err); };
                    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
            }
        }
        throw lastErr;
    }

    async _cliRequest(req, opts = {}) {
        const scratch = join(tmpdir(), 'kanforge-opencode');
        mkdirSync(scratch, { recursive: true });
        const modelRef = req.model.includes('/') ? req.model : `opencode/${req.model}`;
        const args = ['run', '-m', modelRef, '--format', 'json', '--pure', '--dir', scratch, req.prompt];
        let out;
        try {
            out = await runOpenCodeProcess(this.config, args, opts.signal);
        } catch (cause) {
            if (cause.kind === 'timeout') {
                throw new LLMError(`opencode CLI timed out after ${this.config.timeoutMs}ms`, { kind: 'timeout', cause });
            }
            if (cause.kind === 'spawn') {
                throw new LLMError(`opencode CLI failed to start: ${cause.message}`, { kind: 'network', cause });
            }
            if (cause.kind === 'abort') {
                throw new LLMError('opencode CLI aborted', { kind: 'abort', cause });
            }
            throw new LLMError(
                `opencode CLI exited ${cause.code ?? cause.signal}: ${truncate(cause.stderr || cause.message, 300)}`,
                { kind: 'http', cause }
            );
        }
        const { text, usage } = parseOpenCodeOutput(out.stdout);
        return { text, usage, provider: this.config.provider, model: modelRef, rawStatus: 200 };
    }
}

// Pure: normalize the prompt shapes this codebase passes to llm.complete() into a messages
// array. Callers use an array of { role, content }, a `{ user: string }` shorthand (search/
// bestofn.js), or a bare prompt string (RepulsionSampler via ablation.js) — the real CLI client
// must accept all three, not just the array form.
export function normalizeMessages(messages) {
    if (Array.isArray(messages)) return messages;
    if (typeof messages === 'string') return [{ role: 'user', content: messages }];
    if (messages && typeof messages === 'object' && typeof messages.user === 'string') {
        return [{ role: 'user', content: messages.user }];
    }
    return [];
}

// Pure: extract a usable tactic from a raw LLM response. The opencode model free-form answers
// with markdown fences, backticks, and explanatory prose around the tactic; the kernel needs the
// bare tactic. This is the single response contract for the live loop AND the search recipes —
// the same sanitization every proposal path applies (architecture.md §4.1). Extraction order:
// (1) the first markdown fence block wins (prose around it is dropped), (2) else edge fences are
// stripped, (3) a leading backtick quote is cut at its closing backtick ('`ring` (a tautology)'
// -> 'ring'), a trailing backtick is dropped. Multi-line content without fences passes through
// untouched — the repair path consumes whole scripts verbatim.
export function sanitizeTacticText(text) {
    let t = String(text ?? '').trim();
    const fence = t.match(/```\s*(?:lean4?|lean\s*4)?\s*[\r\n]*([\s\S]*?)```/i);
    if (fence) {
        t = fence[1].trim();
    } else {
        t = t.replace(/^```(?:lean)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    if (t.startsWith('`')) {
        const close = t.indexOf('`', 1);
        if (close !== -1) t = t.slice(1, close);
    } else if (t.endsWith('`')) {
        t = t.slice(0, -1);
    }
    return t.trim();
}

// Pure: serialize a chat messages array into a single prompt for the opencode CLI (agent mode
// takes one prompt, not role-tagged turns). The kanforge system prompt becomes inline
// instructions, so the model still sees the full grounding.
export function messagesToPrompt(messages) {
    return normalizeMessages(messages).map((m) => {
        const label = m.role === 'system' ? 'System instructions'
            : m.role === 'assistant' ? 'Assistant (history)'
            : 'Task';
        return `${label}:\n${String(m.content ?? '')}`;
    }).join('\n\n---\n\n');
}

// Pure: parse the `opencode run --format json` event stream into { text, usage }.
// `text` parts are assistant output; the terminal step_finish carries token counts.
// The contract is JSON-lines on stdout; a non-JSON line means the CLI contract broke
// (e.g. wrong mode, a crash banner) and must be surfaced, never silently dropped.
export function parseOpenCodeOutput(stdout) {
    let text = '';
    let usage = { promptTokens: 0, completionTokens: 0 };
    for (const raw of String(stdout).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let ev;
        try {
            ev = JSON.parse(line);
        } catch {
            throw new Error(`opencode --format json contract violated: expected JSON-lines stdout, got: ${truncate(line, 120)}`);
        }
        if (ev.type === 'text' && typeof ev.part?.text === 'string') {
            text += ev.part.text;
        } else if (ev.type === 'step_finish' && ev.part?.tokens) {
            usage = normalizeUsage({
                prompt_tokens: ev.part.tokens.input,
                completion_tokens: ev.part.tokens.output
            });
        }
    }
    return { text, usage };
}

let _openCodeInvocation = null;
// The opencode provider's contract: the CLI must exist at a known location. No silent
// guessing or degradation — a missing binary throws a loud, actionable error so the
// environment gets fixed instead of the caller quietly running on a wrong/inferred binary.
export function resolveOpenCodeInvocation(config = {}) {
    if (_openCodeInvocation) return _openCodeInvocation;
    if (config.opencodeBin) {
        if (!existsSync(config.opencodeBin)) {
            throw new Error(`KANFORGE_LLM_OPENCODE_BIN points to a missing file: ${config.opencodeBin}`);
        }
        _openCodeInvocation = { command: config.opencodeBin };
        return _openCodeInvocation;
    }
    let prefix = null;
    let resolveError = null;
    try {
        if (process.platform === 'win32') {
            // `npm prefix -g` needs the cmd wrapper on Windows (npm is a .cmd script).
            const comSpec = process.env.ComSpec ?? 'cmd.exe';
            prefix = execFileSync(comSpec, ['/d', '/s', '/c', 'npm prefix -g'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
        } else {
            // On Unix `npm` is a real binary on PATH; spawn it directly (no cmd.exe).
            prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 15_000 }).trim();
        }
    } catch (err) {
        resolveError = err?.message ?? String(err);
    }
    const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const exe = prefix ? join(prefix, 'node_modules', 'opencode-ai', 'bin', exeName) : null;
    if (exe && existsSync(exe)) {
        _openCodeInvocation = { command: exe };
        return _openCodeInvocation;
    }
    const tried = exe ?? `npm prefix -g failed (${resolveError})`;
    throw new Error(
        `opencode CLI not found. Tried: ${tried}. ` +
        'Install it (npm install -g opencode-ai) or set KANFORGE_LLM_OPENCODE_BIN to the opencode binary path.'
    );
}

function runOpenCodeProcess(config, args, signal) {
    if (signal?.aborted) return Promise.reject({ kind: 'abort', message: 'aborted before spawn' });
    let command;
    try {
        command = resolveOpenCodeInvocation(config).command;
    } catch (cause) {
        return Promise.reject({ kind: 'spawn', message: cause.message, stderr: '' });
    }
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const killTree = () => {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            } else {
                child.kill('SIGTERM');
            }
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            killTree();
            reject({ kind: 'timeout', stderr });
        }, config.timeoutMs);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            killTree();
            reject({ kind: 'abort', message: 'aborted', stderr });
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            if (err.code === 'ENOENT') reject({ kind: 'spawn', message: err.message, stderr });
            else reject({ kind: 'exit', code: err.code ?? 1, message: err.message, stderr });
        });
        child.on('close', (code, sig) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            if (code === 0) resolve({ stdout, stderr });
            else reject({ kind: 'exit', code, signal: sig, message: `exited with code ${code}`, stderr });
        });
    });
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
