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
    checkTimeoutMs: { kind: 'slider', min: 60000, max: 600000, step: 30000, default: 240000, recommended: null, label: 'Kernel check timeout (ms)' },
    compressionMetrics: { kind: 'toggle', default: true, recommended: null, label: 'Compression-quality metrics' }
};

export function componentNames() {
    return Object.keys(COMPONENTS);
}

// The recommended value wins when measured; the safe default otherwise.
export function effectiveValue(name) {
    const c = COMPONENTS[name];
    if (!c) throw new Error(`unknown component: ${name}`);
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
