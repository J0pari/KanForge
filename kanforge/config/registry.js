// Component registry (architecture.md §5.8): the single source of truth for every toggleable,
// slidable, or selectable component of the live loop. One catalog serves three consumers:
//   - the GUI: each entry is a toggle / slider / dropdown widget with range and current value
//   - the ablation graph: toggles are the factorial components whose main effects are measured
//   - the live path: effectiveDefaults() is the recommended configuration (defaults until
//     ablation measures otherwise — ablation writes recommendations to runs/defaults.json)
// A component's `recommended` is null until evidence sets it; `default` is the safe initial.
// Components absent from this registry are not configurable by any consumer.
import fs from 'node:fs';
import path from 'node:path';

export const COMPONENTS = {
    recipe: { kind: 'dropdown', options: ['loop', 'bestofn', 'swiss', 'swiss+repulsion', 'bfs', 'mcgs'], default: 'loop', recommended: null, label: 'Search strategy' },
    maxTacticsPerGoal: { kind: 'slider', min: 1, max: 32, step: 1, default: 8, recommended: null, label: 'Tactic proposals per goal' },
    maxGoalsPerLemma: { kind: 'slider', min: 1, max: 500, step: 1, default: 100, recommended: null, label: 'Goal budget per lemma' },
    maxLlmCalls: { kind: 'slider', min: 0, max: 2000, step: 10, default: 0, recommended: null, label: 'LLM-call budget per lemma (0 = unlimited)' },
    repulsion: { kind: 'toggle', default: false, recommended: null, label: 'Diversity repulsion' },
    premises: { kind: 'toggle', default: false, recommended: null, label: 'Premise retrieval' },
    premiseLocked: { kind: 'toggle', default: false, recommended: null, label: 'Premise lock (commit guardrail)' },
    premiseTopK: { kind: 'slider', min: 1, max: 20, step: 1, default: 5, recommended: null, label: 'Premises retrieved' },
    tacticMenu: { kind: 'toggle', default: false, recommended: null, label: 'Tactic capability menu' },
    predictors: { kind: 'toggle', default: true, recommended: null, label: 'Failure-predictor pre-filter' },
    exemplars: { kind: 'toggle', default: false, recommended: null, label: 'Proven-lemma exemplars' },
    ttrl: { kind: 'toggle', default: false, recommended: null, label: 'Test-time budget escalation' },
    monitor: { kind: 'toggle', default: false, recommended: null, label: 'Degeneracy monitors' },
    repair: { kind: 'toggle', default: true, recommended: null, label: 'Error-driven repair' },
    searchStructure: { kind: 'dropdown', options: ['transposition', 'egraph'], default: 'transposition', recommended: null, label: 'Goal-state search structure' },
    safeLadder: { kind: 'toggle', default: true, recommended: null, label: 'Deterministic kernel-closer ladder' },
    campaignMemory: { kind: 'toggle', default: true, recommended: null, label: 'Campaign goal-shape memory (replay + veto)' },
    rankedReuse: { kind: 'toggle', default: true, recommended: null, label: 'Ranked store-reuse fallback (BM25 candidates beyond exact conclusion match)' },
    reuseRankLimit: { kind: 'slider', min: 1, max: 8, step: 1, default: 3, recommended: null, label: 'Ranked reuse candidates per goal' },
    reuseRankedChecks: { kind: 'slider', min: 1, max: 8, step: 1, default: 4, recommended: null, label: 'Ranked reuse fresh-check cap per attempt' },
    reuseTransfer: { kind: 'toggle', default: true, recommended: null, label: 'Session proof-pattern transfer (exact/apply/rw + trajectory replay over retrieved lemmas)' },
    maxTransferOps: { kind: 'slider', min: 1, max: 12, step: 1, default: 4, recommended: null, label: 'Transfer tactic applications per attempt' },
    checkTimeoutMs: { kind: 'slider', min: 60000, max: 600000, step: 30000, default: 240000, recommended: null, label: 'Kernel check timeout (ms)' },
    compressionMetrics: { kind: 'toggle', default: true, recommended: null, label: 'Compression-quality metrics' },
    // --- DAG-growth / retry dynamics (the re-split budget and stall-retry policies) ---
    reSplitBaseBudget: { kind: 'slider', min: 1, max: 8, step: 1, default: 3, recommended: null, label: 'Base re-splits per stub before parking' },
    reSplitProveBonus: { kind: 'slider', min: 0, max: 4, step: 1, default: 1, recommended: null, label: 'Extra re-splits per proved child (subtree productivity bonus)' },
    stallRetryFraction: { kind: 'slider', min: 0.1, max: 1, step: 0.1, default: 0.5, recommended: null, label: 'Fraction of ready-stalled lemmas retried per pass (descendant-ranked)' },
    dependencyIdleThreshold: { kind: 'slider', min: 1, max: 10, step: 1, default: 3, recommended: null, label: 'Idle iterations before dependency-idle stop' },
    retryTacticBudget: { kind: 'slider', min: 1, max: 16, step: 1, default: 4, recommended: null, label: 'Tactic proposals per stalled-retry attempt' },
    // --- Pool / kernel / reuse internals (injected at the backend and reuse seams) ---
    coldCheckRecycleThreshold: { kind: 'slider', min: 1, max: 20, step: 1, default: 3, recommended: null, label: 'Warm-worker env builds before recycle' },
    warmupTimeoutMs: { kind: 'slider', min: 60000, max: 600000, step: 30000, default: 180000, recommended: null, label: 'Repl worker warmup timeout (ms)' },
    rewarmDebounceMs: { kind: 'slider', min: 500, max: 10000, step: 500, default: 1500, recommended: null, label: 'Background re-warm debounce (ms)' },
    spawnRetryDelayMs: { kind: 'slider', min: 1000, max: 60000, step: 1000, default: 15000, recommended: null, label: 'Worker spawn retry delay (ms)' },
    harvestCandidateLimit: { kind: 'slider', min: 0, max: 20, step: 1, default: 5, recommended: null, label: 'Premise harvest #check candidates per proof' },
    predictorExploration: { kind: 'slider', min: 0, max: 0.2, step: 0.01, default: 0.02, recommended: null, label: 'Predictor counterfactual re-test rate' },
    reuseMaxInline: { kind: 'slider', min: 1, max: 100, step: 1, default: 24, recommended: null, label: 'Max inlined declarations per reuse source' },
    falsify: { kind: 'toggle', default: true, recommended: null, label: 'Falsification gate (bounded counterexample search on candidate lemmas)' },
    falsifyMaxInstances: { kind: 'slider', min: 2, max: 12, step: 1, default: 6, recommended: null, label: 'Counterexample instances per candidate probe' }
};

// Runtime overrides (CLI --override=name=value): the uniform injection channel for the
// ablation harness and the live path alike — a run can act on ANY registry component without
// hand-editing defaults.json. Overrides are process-local, validated against the component
// schema (kind/min/max/options), and win over recommended/default.
const _overrides = new Map();

export function applyOverrides(spec) {
    let applied = 0;
    for (const part of String(spec ?? '').split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        const c = COMPONENTS[name];
        if (!c) throw new Error(`unknown registry component: ${name}`);
        if (c.kind === 'toggle') {
            if (raw !== 'true' && raw !== 'false') throw new Error(`toggle ${name} expects true/false`);
            _overrides.set(name, raw === 'true');
            applied++;
        } else if (c.kind === 'slider') {
            const v = Number(raw);
            if (!Number.isFinite(v) || v < c.min || v > c.max) throw new Error(`slider ${name} out of range [${c.min}, ${c.max}]: ${raw}`);
            _overrides.set(name, v);
            applied++;
        } else if (c.kind === 'dropdown') {
            if (!(c.options ?? []).includes(raw)) throw new Error(`dropdown ${name} expects one of ${(c.options ?? []).join(', ')}`);
            _overrides.set(name, raw);
            applied++;
        }
    }
    return applied;
}

export function componentNames() {
    return Object.keys(COMPONENTS);
}

// The runtime override wins; then the recommended value when measured; then the safe default.
export function effectiveValue(name) {
    const c = COMPONENTS[name];
    if (!c) throw new Error(`unknown component: ${name}`);
    if (_overrides.has(name)) return _overrides.get(name);
    return c.recommended ?? c.default;
}

export function effectiveDefaults() {
    return Object.fromEntries(componentNames().map(name => [name, effectiveValue(name)]));
}

// Persisted recommendations (runs/defaults.json): { "<component>": <value>, ... } with a
// measuredAt timestamp and provenance. Written by the ablation graph; read by the live path
// and the GUI. Never hand-edited — it is the ablation's output surface.
export function saveRecommendedDefaults(file, recommendations, { provenance = null } = {}) {
    const payload = { measuredAt: new Date().toISOString(), provenance, recommendations };
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
}

export function loadRecommendedDefaults(file) {
    try {
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed.recommendations !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

// Apply persisted recommendations onto the registry (recommended = measured).
export function applyRecommendations(payload) {
    if (!payload) return 0;
    let applied = 0;
    for (const [name, value] of Object.entries(payload.recommendations ?? {})) {
        const c = COMPONENTS[name];
        if (!c) continue;
        if (c.kind === 'toggle' && typeof value === 'boolean') { c.recommended = value; applied++; }
        if (c.kind === 'dropdown' && (c.options ?? []).includes(value)) { c.recommended = value; applied++; }
        if (c.kind === 'slider' && typeof value === 'number' && value >= c.min && value <= c.max) { c.recommended = value; applied++; }
    }
    return applied;
}
