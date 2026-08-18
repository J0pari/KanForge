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

    // Failure taxonomy (mathematical vs search vs infrastructure): the distinction a naive
    // failure rate hides. lemma_failed error strings are classified mechanically — an infra
    // failure is never a mathematical judgment.
    const classify = (msg) => {
        const m = String(msg ?? '');
        if (/repl|worker|timeout|timed out|acquire|session|process|spawn|paging|memory|no repl/i.test(m)) return 'infrastructure';
        if (/unexpected token|parse error|extractGoals/i.test(m)) return 'infrastructure';
        if (/guardrails rejected|KERNEL_REJECTED|Unknown identifier|unknown constant/i.test(m)) return 'math';
        if (/budget|exhausted|not solved after search|could not extract/i.test(m)) return 'search';
        return 'search';
    };
    const failureTaxonomy = { math: 0, search: 0, infrastructure: 0 };
    for (const e of events) {
        if (e.type === 'lemma_failed') {
            failureTaxonomy[classify(e.error?.message ?? e.error)]++;
        }
    }

    return {
        passKpis: {
            verified,
            failed,
            failureTaxonomy,
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
