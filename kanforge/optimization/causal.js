// Causal TELEMETRY / trace analysis over the traced event stream (architecture.md §6).
//
// Consumes the events emitted by agent/loop.js (id/t/parent/lemmaId/...). The parent chain is
// the per-lemma causal ORDER; array order (emit order) is the causal order within a lemma. This
// module computes SEQUENCE STATISTICS over that ordered stream — it is trace infrastructure, NOT
// causal inference. A pattern `A → B → FAIL` correlates with failure; it does not establish that
// A or B caused it (confounders: goal shape, family, hypotheses, imports, premises, depth, LLM
// sampling, toolchain). Intervention-based causal questions are future work (build_order.md §5.6).
//
// API (architecture.md §6):
//   getTransitionMatrix()  — action→action Markov probabilities (sequence statistics, not causes)
//   getFailurePredictors() — action windows correlated with FAIL (negative rules)
//   getBottlenecks()       — time sinks (event types / lemmas)
//   getAnomalies()         — pathological runs (guardrail trips, repair loops)
//   getCriticalPath()      — longest dependent chain in a development
//
// §5.3 search biasing: getFailurePredictors() returns patterns that compilePredictors() turns
// into a reject-matcher the search layer consults BEFORE kernel verification, so budget is not
// spent on branches known to fail.

// Normalized tactic head: the first token, punctuation stripped. "rw [Nat.mul_add]" -> "rw".
export function tacticHead(tactic) {
    const token = String(tactic ?? '').trim().split(/\s+/)[0] ?? '';
    return token.replace(/[()[\]{},;.]/g, '');
}

// Outcome events only — the loop emits a `tactic_proposed` AND a `tactic_applied`/`tactic_failed`
// for the same tactic, so counting proposals too would double every action. The kernel outcome
// (applied/failed) is the action; the proposal is just the LLM call that led to it.
const ACTION_TYPES = new Set([
    'tactic_applied', 'tactic_failed',
    'repair_applied', 'repair_failed'
]);

// Per-lemma action stream: outcome events that carry a tactic, in emit order, each marked
// failed when its event type is a FAIL. Swiss emits tactic_applied for the winner, so every
// applied action is represented even when the proposal was a tournament pick.
function actionStreams(events) {
    const byLemma = new Map();
    for (const e of events) {
        const lemmaId = e.lemmaId ?? e.nodeId ?? null;
        if (lemmaId == null) continue;
        if (e.tactic == null) continue;
        if (!ACTION_TYPES.has(e.type)) continue;
        if (!byLemma.has(lemmaId)) byLemma.set(lemmaId, []);
        byLemma.get(lemmaId).push({
            head: tacticHead(e.tactic),
            type: e.type,
            failed: e.type === 'tactic_failed' || e.type === 'repair_failed'
        });
    }
    return [...byLemma.entries()];
}

// Index events by id for parent-chain walks.
function byId(events) {
    const index = new Map();
    for (const e of events) index.set(e.id, e);
    return index;
}

export class CausalAnalyzer {
    constructor(events = []) {
        this.events = events;
    }

    // Markov action→action probabilities over tactic heads, per-lemma contiguous streams.
    // Returns { actions, counts, matrix } where matrix[from][to] = P(to | from) (0 if never).
    getTransitionMatrix() {
        const counts = new Map();
        for (const [, stream] of actionStreams(this.events)) {
            for (let i = 0; i + 1 < stream.length; i++) {
                const from = stream[i].head;
                const to = stream[i + 1].head;
                if (!counts.has(from)) counts.set(from, new Map());
                const row = counts.get(from);
                row.set(to, (row.get(to) ?? 0) + 1);
            }
        }
        const actions = new Set();
        for (const [from, row] of counts) {
            actions.add(from);
            for (const to of row.keys()) actions.add(to);
        }
        const matrix = {};
        for (const [from, row] of counts) {
            const total = [...row.values()].reduce((s, n) => s + n, 0) || 1;
            matrix[from] = {};
            for (const [to, n] of row) matrix[from][to] = n / total;
        }
        return { actions: [...actions].sort(), counts, matrix };
    }

    // Negative rules: contiguous head-windows whose FINAL action is a FAIL. A pattern of length
    // L counts as a support on every occurrence of that exact L-window anywhere in a lemma
    // stream; confidence = (occurrences ending in FAIL) / (all occurrences).
    getFailurePredictors({ window = 3, minSupport = 1, minConfidence = 0.5 } = {}) {
        const fails = new Map(); // patternKey -> { pattern, fails }
        const supports = new Map(); // patternKey -> count
        const key = p => p.join('\u0001');

        for (const [, stream] of actionStreams(this.events)) {
            const heads = stream.map(a => a.head);
            for (let L = 1; L <= Math.min(window, heads.length); L++) {
                for (let i = L - 1; i < heads.length; i++) {
                    const pattern = heads.slice(i - L + 1, i + 1);
                    const k = key(pattern);
                    supports.set(k, (supports.get(k) ?? 0) + 1);
                    if (stream[i].failed) {
                        if (!fails.has(k)) fails.set(k, { pattern, fails: 0 });
                        fails.get(k).fails += 1;
                    }
                }
            }
        }

        const out = [];
        for (const [k, f] of fails) {
            const support = supports.get(k) ?? 0;
            if (support < minSupport) continue;
            const confidence = f.fails / support;
            if (confidence < minConfidence) continue;
            out.push({ pattern: f.pattern, support, fails: f.fails, confidence });
        }
        out.sort((a, b) => b.confidence - a.confidence || b.support - a.support);
        return out;
    }

    // Time sinks: total ms by event type and by lemma (events that carry ms — lemma_failed,
    // lemma_verified — and per-tactic estimates when the type has ms).
    getBottlenecks() {
        const byEventType = new Map();
        const byLemma = new Map();
        let totalMs = 0;
        for (const e of this.events) {
            const ms = Number(e.ms);
            if (!Number.isFinite(ms) || ms <= 0) continue;
            totalMs += ms;
            byEventType.set(e.type, (byEventType.get(e.type) ?? 0) + ms);
            const lemmaId = e.lemmaId ?? e.nodeId ?? 'global';
            byLemma.set(lemmaId, (byLemma.get(lemmaId) ?? 0) + ms);
        }
        const topEventTypes = [...byEventType.entries()]
            .map(([type, ms]) => ({ type, ms }))
            .sort((a, b) => b.ms - a.ms);
        const topLemmas = [...byLemma.entries()]
            .map(([lemmaId, ms]) => ({ lemmaId, ms }))
            .sort((a, b) => b.ms - a.ms);
        return { totalMs, byEventType: topEventTypes, byLemma: topLemmas };
    }

    // Pathological runs: guardrail trips, repair cycles that never succeed, llm error streaks.
    getAnomalies() {
        const anomalies = [];
        const guardrails = this.events.filter(e => e.type === 'guardrail_trip');
        if (guardrails.length > 0) {
            const byType = {};
            for (const g of guardrails) {
                const t = g.violation?.type ?? 'UNKNOWN';
                byType[t] = (byType[t] ?? 0) + 1;
            }
            anomalies.push({ kind: 'guardrail_trip', count: guardrails.length, byType });
        }

        // A repair loop is a (lemma, goalClass) where FAIL actions repeat with no success in
        // between — same failure head re-attempted against the same goal class.
        const loopCounts = new Map();
        for (const [, stream] of actionStreams(this.events)) {
            let current = null;
            for (const a of stream) {
                if (a.failed) {
                    const k = a.head;
                    loopCounts.set(k, (loopCounts.get(k) ?? 0) + 1);
                    current = k;
                }
            }
        }
        for (const [head, count] of loopCounts) {
            if (count >= 3) {
                anomalies.push({ kind: 'failure_cluster', head, count, detail: `${count} FAIL actions for tactic head "${head}"` });
            }
        }

        const llmErrors = this.events.filter(e => e.type === 'llm_error').length;
        if (llmErrors >= 3) {
            anomalies.push({ kind: 'llm_error_streak', count: llmErrors });
        }
        return anomalies;
    }

    // Longest dependent chain in a development: the deepest per-lemma causal chain (parent
    // links) by event count, tie-broken by summed ms. Walks the FULL parent chain from the
    // lemma's last event to its root, so chains spanning the emit window resolve completely.
    getCriticalPath() {
        const index = byId(this.events);
        const byLemma = new Map();
        for (const e of this.events) {
            const lemmaId = e.lemmaId ?? e.nodeId ?? 'global';
            if (!byLemma.has(lemmaId)) byLemma.set(lemmaId, []);
            byLemma.get(lemmaId).push(e);
        }
        let best = { lemmaId: null, length: 0, ms: 0, events: [] };
        for (const [lemmaId, evs] of byLemma) {
            const walked = [];
            let cursor = evs[evs.length - 1];
            while (cursor) {
                walked.unshift(cursor);
                cursor = cursor.parent ? index.get(cursor.parent) : null;
            }
            const ms = walked.reduce((s, e) => s + (Number(e.ms) || 0), 0);
            if (walked.length > best.length || (walked.length === best.length && ms > best.ms)) {
                best = { lemmaId, length: walked.length, ms, events: walked.map(e => e.type) };
            }
        }
        return best;
    }
}

// Compile predictors into a reject-matcher for the search layer.
//   rejects(head, history) — true when `head` (as the final element of a pattern) completes a
//   known-failing window against `history` (the recent tactic heads in this branch).
//
// SAFETY GATE (architecture.md §6, build_order.md §5.3): a pattern may suppress an action ONLY
// when it meets minimum support AND bounded confidence — otherwise it is INERT (never rejects).
// Rejection has a feedback loop (observed failure → reject → future success impossible), so a
// pattern with tiny support or near-1.0 confidence (the overfit case) must not gate the kernel.
// Defaults: minSupport 2 (never configurable below 2 for the reject path), confidence ceiling
// 0.95. Held-out evidence is the miner's responsibility, and the two mining paths differ in it:
// the live loop mines from the GLOBAL dataset at run start (only prior runs'/cycles' samples —
// temporal held-out by construction), while the ablation harness mines and applies within one
// run. A pattern mined and applied on the same stream is a hypothesis, not a validated gate —
// that is the overfitting risk this floor/ceiling guards against; the live path's temporal
// separation is what upgrades hypotheses toward gates.
export function compilePredictors(predictors, { minSupport = 2, maxConfidence = 0.95, source = null, minedAt = null } = {}) {
    const active = [];
    let inert = 0;
    for (const p of predictors ?? []) {
        const support = p.support ?? 0;
        const confidence = p.confidence ?? 0;
        if (support < minSupport) { inert++; continue; }
        if (confidence > maxConfidence) { inert++; continue; }
        active.push(p.pattern ?? []);
    }
    return {
        count: active.length,
        inert, // patterns that failed the safety gate (reported, never used for rejection)
        // Version/provenance metadata (§6): where and when the patterns were mined. The live
        // path mines per run start from prior-run samples only (temporal held-out) — the
        // timestamp is how downstream audits distinguish a fresh prior from a stale one.
        minedAt: minedAt ?? new Date().toISOString(),
        source: source ?? 'unknown',
        rejects(head, history = []) {
            const h = String(head ?? '');
            for (const pattern of active) {
                if (pattern.length === 0) continue;
                if (h !== pattern[pattern.length - 1]) continue;
                const prefix = pattern.slice(0, -1);
                if (prefix.length === 0) return true;
                const tail = (history ?? []).slice(-prefix.length);
                if (tail.length === prefix.length && tail.every((x, i) => x === prefix[i])) return true;
            }
            return false;
        },
        // Inference-only hint surface (§6.2): patterns whose prefix matches the tail of the
        // recent history — the final head is what to AVOID proposing next. Rejection saves
        // kernel budget; the warning steers the LLM so the proposal is never made.
        warnings(history = []) {
            const h = (history ?? []).map(tacticHead);
            const out = [];
            for (const pattern of active) {
                if (pattern.length < 2) continue;
                const prefix = pattern.slice(0, -1);
                if (h.length < prefix.length) continue;
                const tail = h.slice(-prefix.length);
                if (tail.every((x, i) => x === prefix[i])) out.push(pattern);
            }
            return out;
        }
    };
}

// The per-lemma tactic trajectory, in emit order: [{ tactic, failed }]. The same filter
// actionStreams applies — kernel-checked outcome events only. Used by the dataset's failed
// samples so prior runs' failures are mineable (temporal held-out predictor mining, §6.2).
export function lemmaTrajectory(events, lemmaId) {
    const stream = actionStreams(events).find(([id]) => id === lemmaId);
    if (!stream) return [];
    return stream[1].map(a => ({ tactic: a.head, failed: a.failed }));
}

// Temporal held-out predictor mining (§6.2): build a synthetic event stream from the GLOBAL
// dataset's samples — every sample was appended by a PRIOR run or prior cycle, so patterns
// mined here can never be contaminated by the current cycle's outcomes — and compile the
// failure predictors through the same floor/ceiling gate as the live stream.
export function eventsFromDatasetSamples(samples = []) {
    const events = [];
    let id = 0;
    for (const s of samples) {
        for (const step of s.trajectory ?? []) {
            if (!step?.tactic) continue;
            events.push({
                id: `ds${id++}`,
                type: step.failed ? 'tactic_failed' : 'tactic_applied',
                tactic: step.tactic,
                lemmaId: s.id ?? `sample${id}`
            });
        }
    }
    return events;
}

export function compilePredictorsFromDataset(samples = [], { window = 3, minSupport = 2, minConfidence = 0.5, maxConfidence = 0.95 } = {}) {
    const analyzer = new CausalAnalyzer(eventsFromDatasetSamples(samples));
    const mined = analyzer.getFailurePredictors({ window, minSupport, minConfidence });
    return compilePredictors(mined, { minSupport, maxConfidence, source: 'dataset' });
}
