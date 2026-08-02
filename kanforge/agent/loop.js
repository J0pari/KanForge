// P1 minimal loop (build_order.md P1 gate): PullGraph + scheduler + backendRepl + one LLM adapter.
// Node ids ARE statement hashes (pin.js), so re-adding the same lemma de-dupes to one graph node.
// For each lemma, the loop: emits a goal event -> asks the LLM for a proof body -> verifies the
// composed statement against the real kernel -> on error, feeds the message back and retries up to
// `attemptsPerLemma`; the scheduler stops once `stopAfterFailures` nodes have failed.
// No mocks: `backend` is a real Lean backend and `llm` a real LLMClient.

import { Scheduler } from '../core/scheduler.js';
import { PullGraph } from '../core/pullgraph.js';
import { hashStatement } from '../lean/pin.js';

const SYSTEM_PROMPT =
    'You prove Lean 4 theorems. The user gives a Lean 4 statement ending in `:= by sorry`. ' +
    'Reply with ONLY the proof body that fills the sorry (the tactics or term that follows `:=`). ' +
    'No code fences, no commentary, no leading `by`.';

// Pure: extract the proof body from LLM output. Tolerates fences, a leading `by`, and echoes of
// the whole statement; when the model wraps its answer in a fenced block (even amid prose), the
// LAST fenced block wins.
export function parseProof(text) {
    let s = String(text ?? '').trim();
    const blocks = [...s.matchAll(/```(?:lean4|lean)?\s*\n?([\s\S]*?)```/g)].map(m => m[1].trim());
    if (blocks.length) s = blocks[blocks.length - 1];
    if (s.includes(':=')) {
        s = s.slice(s.lastIndexOf(':=') + 2).trim();
    }
    s = s.replace(/^by\s+/, '').trim();
    return s;
}

// Pure: fill the trailing `:= by sorry` of a stub statement with a proof body.
export function composeProof(statement, proof) {
    const body = parseProof(proof);
    const stub = String(statement).trim();
    if (!/:= by sorry\s*$/.test(stub)) {
        throw new Error(`statement is not a sorry stub: ${stub}`);
    }
    return stub.replace(/:= by sorry\s*$/, `:= by ${body}`);
}

// Pure: the term variant — `:= <body>` instead of `:= by <body>`. Some models emit a proof
// *term* (e.g. `Nat.add_comm a b`), which is not valid after `by`; verify both forms.
export function composeProofTerm(statement, proof) {
    const body = parseProof(proof);
    const stub = String(statement).trim();
    if (!/:= by sorry\s*$/.test(stub)) {
        throw new Error(`statement is not a sorry stub: ${stub}`);
    }
    return stub.replace(/:= by sorry\s*$/, `:= ${body}`);
}

// Pure: build the chat messages for one (or a retry of) a lemma attempt.
export function proposeProofMessages(statement, feedback = []) {
    let user = `Statement:\n${statement}\n\nFill the trailing \`sorry\` with a proof.`;
    for (const fb of feedback) {
        user += `\n\nPrevious attempt \`${fb.proof}\` was rejected by Lean:\n${fb.error}\nTry again.`;
    }
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user }
    ];
}

export function buildLemmaId(statement) {
    return hashStatement(statement);
}

export class MinimalLoop {
    constructor({ backend, llm, concurrency = 2, attemptsPerLemma = 2, timeoutMs = 300_000, stopAfterFailures = 2, maxTokens = 512, onEvent = null } = {}) {
        if (!backend || !llm) {
            throw new Error('MinimalLoop requires a real backend and a real llm client');
        }
        this.backend = backend;
        this.llm = llm;
        this.concurrency = concurrency;
        this.attemptsPerLemma = attemptsPerLemma;
        this.timeoutMs = timeoutMs;
        this.stopAfterFailures = stopAfterFailures;
        this.maxTokens = maxTokens;
        this.onEvent = onEvent ?? (e => console.log(JSON.stringify(e)));

        this.graph = new PullGraph();
        this._age = new Map(); // nodeId -> insertion order (older = smaller = dispatched first)
        this._order = 0;
        this.llmCalls = 0;
        this.verifyCalls = 0;
        this._events = [];
        this.lastOutcome = null;
    }

    addLemma(statement, { deps = [] } = {}) {
        const id = buildLemmaId(statement);
        if (!this.graph.nodes.has(id)) {
            this._age.set(id, this._order++);
            this.graph.register(id, () => statement);
        }
        for (const dep of deps) {
            const depId = buildLemmaId(dep);
            if (!this.graph.nodes.has(depId)) {
                this._age.set(depId, this._order++);
                this.graph.register(depId, () => dep);
            }
            this.graph.dependsOn(id, depId);
        }
        return id;
    }

    // Oldest-sorry priority: the earliest-added lemma (lowest insertion index) dispatches first.
    priority(nodeId) {
        return this._age.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
    }

    _emit(event) {
        this._events.push(event);
        this.onEvent?.(event);
    }

    async _tryForms(nodeId, attempt, proof, statement) {
        // A proof body may be a tactic script (`:= by ...`) or a proof term (`:= ...`); try both.
        // One kernel check each; a verified response with no remaining goals wins.
        const forms = [
            { form: 'tactic', src: composeProof(statement, proof) },
            { form: 'term', src: composeProofTerm(statement, proof) }
        ];
        let last;
        for (const c of forms) {
            if (last && c.src === last.src) continue;
            this.verifyCalls++;
            const res = await this.backend.check(c.src);
            this._emit({ type: 'lemma_attempt', nodeId, attempt, proof, status: res.status, form: c.form });
            if (res.status === 'verified' && !res.goals.length) {
                return { ok: true, form: c.form };
            }
            last = { src: c.src, res };
        }
        return { ok: false, res: last?.res ?? { status: 'error', error: { message: 'no form accepted' } } };
    }

    async _proveStatement(nodeId, statement) {
        this._emit({ type: 'lemma_goal', nodeId, statement });
        const start = Date.now();
        const feedback = [];
        let lastError = 'no attempts made';

        for (let attempt = 1; attempt <= this.attemptsPerLemma; attempt++) {
            let proof = null;
            try {
                this.llmCalls++;
                const out = await this.llm.complete(proposeProofMessages(statement, feedback), { maxTokens: this.maxTokens });
                proof = parseProof(out.text);
            } catch (err) {
                lastError = `llm call failed: ${err?.message ?? err}`;
                this._emit({ type: 'lemma_llm_error', nodeId, attempt, error: lastError });
                feedback.push({ proof: '<llm-error>', error: lastError });
                continue;
            }

            const attemptResult = await this._tryForms(nodeId, attempt, proof, statement);
            if (attemptResult.ok) {
                const ms = Date.now() - start;
                this._emit({ type: 'lemma_verified', nodeId, statement, proof, attempts: attempt, ms, form: attemptResult.form });
                return { statement, proof, attempts: attempt, ms };
            }
            lastError = attemptResult.res?.error?.message ?? 'unproven goals remain';
            feedback.push({ proof, error: lastError });
        }

        const ms = Date.now() - start;
        this._emit({ type: 'lemma_failed', nodeId, statement, attempts: this.attemptsPerLemma, ms, lastError });
        throw new Error(`lemma ${nodeId} failed after ${this.attemptsPerLemma} attempts: ${lastError}`);
    }

    async proveAll() {
        const scheduler = new Scheduler(this.graph, {
            check: async id => this._proveStatement(id, this.graph.nodes.get(id).computation.value),
            concurrency: this.concurrency,
            timeoutMs: this.timeoutMs,
            priority: id => this.priority(id),
            maxFailures: this.stopAfterFailures ?? null,
            onProgress: info => this._emit({ type: `scheduler_${info.stage}`, ...info })
        });

        scheduler.enqueue([...this.graph.nodes.keys()]);
        const outcome = await scheduler.run();
        this.lastOutcome = outcome;
        this._emit({ type: 'loop_finished', ok: outcome.ok, stopped: outcome.stopped, failures: [...outcome.failures.keys()] });
        return outcome;
    }

    events() {
        return [...this._events];
    }

    getInfos() {
        return {
            lemmas: this.graph.nodes.size,
            llmCalls: this.llmCalls,
            verifyCalls: this.verifyCalls,
            events: this._events.length,
            backend: this.backend.getInfos?.() ?? null
        };
    }
}
