// KPI calculator (architecture.md §6.1, build_order.md §5.6).
// Pure function of the event stream — never calls the backend or LLM. Every emitted value is
// derivable from events, or null with a documented reason (the instrumented loop emits what it
// emits; a metric whose source events are absent is null, never fabricated).
//
// Catalog (architecture.md §6.1): search efficiency, search quality, planning quality, learning
// quality, economic quality. Planning-quality metrics need blueprint-level counts that the loop's
// tactic events do not carry; learning-quality metrics need predictor pre-filter outcomes; both
// are null here until the respective instrumentation exists (build_order.md §5.6 backlog).

function count(events, type) {
    // Accept both the loop's lowercase and the legacy uppercase event names.
    const upper = type.toUpperCase();
    return events.filter(e => (e.type ?? '').toUpperCase() === upper).length;
}

export function computeMetrics(events = []) {
    const verified = count(events, 'lemma_verified');
    const failed = count(events, 'lemma_failed');
    const proposed = count(events, 'tactic_proposed');
    const applied = count(events, 'tactic_applied');
    const failedTactics = count(events, 'tactic_failed');
    const subgoals = count(events, 'subgoal_created');
    const solved = count(events, 'goal_solved');
    const selected = count(events, 'goal_selected');
    const repaired = count(events, 'repair_attempted');
    const guardrailTrips = count(events, 'guardrail_trip');

    // Unique goal-class states explored = distinct goalClassId across selection/proposal events.
    const statesSeen = new Set();
    for (const e of events) {
        if (e.goalClassId != null) statesSeen.add(e.goalClassId);
    }

    // First-success rank: avg `attempt` of proposal-driven solves (via: 'proposal' carries the
    // attempt rank). Repair/swiss solves have no rank and are excluded rather than skewed.
    const solveRanks = events.filter(e => (e.type ?? '').toUpperCase() === 'GOAL_SOLVED' && Number.isInteger(e.attempt)).map(e => e.attempt);
    const firstSuccessRank = solveRanks.length
        ? solveRanks.reduce((s, r) => s + r, 0) / solveRanks.length
        : null;

    // LLM latency + token totals from proposal/repair events that carry them.
    const llmEvents = events.filter(e => ['tactic_proposed', 'repair_proposed'].includes((e.type ?? '').toLowerCase()) && Number.isFinite(e.llmMs));
    const llmMsTotal = llmEvents.reduce((s, e) => s + e.llmMs, 0);
    const promptTokensTotal = llmEvents.reduce((s, e) => s + (e.promptTokens ?? 0), 0);
    const completionTokensTotal = llmEvents.reduce((s, e) => s + (e.completionTokens ?? 0), 0);

    // Kernel checks = tactic_applied + tactic_failed (each applied/failed is one kernel round-trip).
    const kernelChecks = applied + failedTactics;

    const total = verified + failed;
    const successRate = total > 0 ? verified / total : 0;
    const tacticSuccessRate = (applied + failedTactics) > 0 ? applied / (applied + failedTactics) : 0;

    return {
        // --- baseline KPIs (always available) ---
        verifiedLemmas: verified,
        failedLemmas: failed,
        successRate,
        tacticsPerLemma: verified > 0 ? applied / verified : 0,
        tacticSuccessRate,
        guardrailTrips,

        // --- search efficiency ---
        kernelChecksPerSolved: verified > 0 ? kernelChecks / verified : null,
        llmCallsPerSolved: verified > 0 ? proposed / verified : null,
        uniqueStatesExplored: statesSeen.size,
        duplicateStatesAvoided: null, // needs e-graph carriedOver counts; not in the event stream

        // --- search quality ---
        firstSuccessRank,
        branchingFactor: applied > 0 ? subgoals / applied : null,
        meanDepth: null, // needs per-goal depth bookkeeping in the loop; not in the event stream
        deadEndRate: null, // needs "goal class abandoned without solution" events; not emitted
        transpositionHitRate: null, // needs e-graph carriedOver/new-class counts; not in the event stream

        // --- planning quality (blueprint-level; needs blueprint/refine surface) ---
        blueprintLemmasPerTheorem: null,
        resplitsPerTheorem: null,
        unusedHelperLemmas: null,
        dependencyDepth: null,

        // --- learning quality (needs predictor pre-filter outcomes) ---
        predictorPrecision: null,
        predictorRecall: null,
        falseRejectionRate: null,
        performanceBeforeAfterPredictor: null,
        heldOutImprovement: null,

        // --- economic quality ---
        secondsPerTheorem: null, // needs wall-clock on lemma_verified (loop emits ms per lemma; aggregate below)
        llmLatencyPerTheorem: verified > 0 ? (llmMsTotal / 1000) / verified : null,
        llmTokensPerTheorem: verified > 0 ? (promptTokensTotal + completionTokensTotal) / verified : null,
        kernelCallsPerSuccessfulProof: verified > 0 ? kernelChecks / verified : null,

        // --- raw cost aggregates (help the digest render the catalog) ---
        _raw: {
            llmCalls: proposed,
            tacticCalls: applied,
            kernelChecks,
            llmMsTotal,
            promptTokensTotal,
            completionTokensTotal,
            solvedGoals: solved,
            goalsSelected: selected,
            repairRounds: repaired
        }
    };
}
