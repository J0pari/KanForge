// Mandatory benchmark provenance (architecture.md §5.7). Every serious benchmark result —
// ablation report, ablation graph, mission digest, per-pass telemetry — must carry a provenance
// block with these keys. The audit (`bench/reportAudit.js`) treats a missing/empty key as a
// violation: a result without provenance is not a benchmark result.
//
// Values that are genuinely unknowable are recorded as `unknown:<reason>` strings — present and
// non-null, so the audit distinguishes "not recorded" (missing key) from "known unknown"
// (recorded as unknown:<reason>). A benchmark whose toolchain field says `unknown:...` is honest
// but NOT reproducible; treat it as a red flag, not a pass.
//
// Field meanings:
//   llmProvider     — provider identifier (e.g. `opencode`)
//   model           — model identifier (e.g. `deepseek/deepseek-v4-flash`)
//   runtimeVersion  — provider/runtime version; node version when the provider reports none
//   leanToolchain   — leanprover/lean4:vX.Y.Z
//   mathlibRev      — mathlib4 git rev from the lean project's lake-manifest.json
//   replRev         — repl git rev from the same manifest (the backend binary's source revision)
//   kanforgeCommit  — git rev-parse HEAD of this repository
//   components      — the effective component registry settings the run used
//   budget          — { maxTacticsPerGoal, maxGoalsPerLemma, maxLlmCalls, maxRounds, concurrency }
//   seed            — 'none' when no seeded randomness exists; the seed value otherwise
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MANDATORY_PROVENANCE_KEYS = Object.freeze([
    'llmProvider',
    'model',
    'runtimeVersion',
    'leanToolchain',
    'mathlibRev',
    'replRev',
    'kanforgeCommit',
    'components',
    'budget',
    'seed'
]);

// git rev-parse HEAD from any directory inside (or at) the checkout; null outside one.
export function gitHead(dir = process.cwd()) {
    try {
        const out = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000
        });
        const head = String(out).trim();
        return head || null;
    } catch {
        return null;
    }
}

// { mathlib, repl } revisions from a lean project's lake-manifest.json.
export function lakeDeps(leanProject = null) {
    if (!leanProject) return { mathlib: null, repl: null };
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(leanProject, 'lake-manifest.json'), 'utf8'));
        const packages = manifest.packages ?? [];
        const rev = name => packages.find(p => p?.name === name)?.rev ?? null;
        return { mathlib: rev('mathlib'), repl: rev('repl') };
    } catch {
        return { mathlib: null, repl: null };
    }
}

// Assemble the mandatory provenance block. All required keys are always present.
export function assembleProvenance({
    provider = null,
    model = null,
    providerVersion = null,
    toolchain = null,
    leanProject = null,
    packageRoot = process.cwd(),
    components = {},
    budget = {},
    seed = null
} = {}) {
    const deps = lakeDeps(leanProject);
    return {
        llmProvider: provider ?? 'unknown:no-provider-configured',
        model: model ?? 'unknown:no-model-configured',
        runtimeVersion: providerVersion ?? `unknown:provider-version-not-reported (node ${process.versions.node})`,
        leanToolchain: toolchain ?? 'unknown:no-toolchain-configured',
        mathlibRev: deps.mathlib ?? 'unknown:no-lake-manifest-or-no-mathlib-entry',
        replRev: deps.repl ?? 'unknown:no-lake-manifest-or-no-repl-entry',
        kanforgeCommit: gitHead(packageRoot) ?? 'unknown:not-a-git-checkout',
        components: { ...components },
        budget: { ...budget },
        seed: seed ?? 'none'
    };
}

// The audit's gate: which mandatory keys are missing/empty. ['entire block'] when null.
export function missingProvenanceKeys(block) {
    if (!block || typeof block !== 'object') return ['entire block'];
    return MANDATORY_PROVENANCE_KEYS.filter(k => block[k] == null || block[k] === '');
}
