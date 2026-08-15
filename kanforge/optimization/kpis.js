// Verification-throughput KPIs (architecture.md §5.7): the per-pass cost accounting that makes
// "is this technique genuinely better or merely more expensive" answerable from the artifact
// alone. Computed from the run's own event stream + backend health counters — no new probes,
// every number recomputes from telemetry the loop already emits. Written per pass to
// `runs/<problem>/kpis.ndjson` and embedded in the pass telemetry (passes.ndjson).
//
// KPI definitions (per verified theorem):
//   llmCalls            — tactic/repair proposal LLM calls
//   kernelOps           — tactic applications (accepted + rejected)
//   searchWallSeconds   — wall-clock of lemma attempts (verified + failed spans)
//   replRestarts        — backend worker restarts
//   goalExpansions      — goal_selected events (search expansions)
//   reuseHits           — store reuse accepted (exact + goal-shape) per verified
// plus the pool's warm/cold check ratio (kernel-import waste indicator).

export function computePassKpis({ events = [], rounds = [], backendInfos = null } = {}) {
    const count = type => events.filter(e => e.type === type).length;
    const proposed = count('tactic_proposed') + count('repair_proposed');
    const kernelOps = count('tactic_applied') + count('tactic_failed');
    const goalExpansions = count('goal_selected');
    const reuseHits = count('store_reuse');
    const verified = count('lemma_verified');
    const failed = count('lemma_failed');

    const attemptMs = events
        .filter(e => (e.type === 'lemma_verified' || e.type === 'lemma_failed') && typeof e.ms === 'number')
        .reduce((s, e) => s + e.ms, 0);

    const per = n => (verified > 0 ? +(n / verified).toFixed(2) : null);
    const warm = backendInfos?.warmChecks ?? null;
    const cold = backendInfos?.coldChecks ?? null;
    const totalChecks = (warm ?? 0) + (cold ?? 0);

    return {
        passKpis: {
            verified,
            failed,
            roundsRun: rounds.length,
            llmCallsPerVerified: per(proposed),
            kernelOpsPerVerified: per(kernelOps),
            searchWallSecondsPerVerified: per(attemptMs / 1000),
            replRestartsPerVerified: backendInfos ? per(backendInfos.restarts ?? 0) : null,
            goalExpansionsPerVerified: per(goalExpansions),
            reuseHitRate: verified + failed > 0 ? +(reuseHits / (verified + failed)).toFixed(3) : null,
            reuseHitsPerVerified: per(reuseHits),
            warmColdCheckRatio: totalChecks > 0 && cold > 0 ? +(warm / cold).toFixed(2) : null,
            pool: {
                warmChecks: warm,
                coldChecks: cold,
                restarts: backendInfos?.restarts ?? null,
                hangs: backendInfos?.hangs ?? null,
                timeouts: backendInfos?.timeouts ?? null,
                parseErrors: backendInfos?.parseErrors ?? null
            }
        }
    };
}
