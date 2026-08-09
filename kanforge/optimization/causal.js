// Causal analysis over the traced event stream (architecture.md §6).
//
// Consumes the events emitted by agent/loop.js (id/t/parent/lemmaId/...). The parent chain is
// the per-lemma causal DAG; array order (emit order) is the causal order within a lemma.
//
// API (architecture.md §6):
//   getTransitionMatrix()  — action→action Markov probabilities
//   getFailurePredictors() — action sequences reliably preceding FAIL (negative rules)
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
export function compilePredictors(predictors) {
    const patterns = (predictors ?? []).map(p => p.pattern ?? []);
    return {
        count: patterns.length,
        rejects(head, history = []) {
            const h = String(head ?? '');
            for (const pattern of patterns) {
                if (pattern.length === 0) continue;
                if (h !== pattern[pattern.length - 1]) continue;
                const prefix = pattern.slice(0, -1);
                if (prefix.length === 0) return true;
                const tail = history.slice(-prefix.length);
                if (tail.length === prefix.length && tail.every((x, i) => x === prefix[i])) return true;
            }
            return false;
        }
    };
}
