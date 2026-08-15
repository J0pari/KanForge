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

    // --- transposition / merge telemetry (architecture.md §2.2) -----------------------------
    // tactic_applied carries carriedOver (transposition merges: subgoals that landed on an
    // already-open class) and created (genuinely new classes) — the structure's own counts,
    // emitted by the loop. The egraph future emits the same fields, so these metrics are
    // structure-agnostic.
    const applyEvents = events.filter(e => (e.type ?? '').toLowerCase() === 'tactic_applied');
    const carriesTotal = applyEvents.reduce((s, e) => s + (Number.isFinite(e.carriedOver) ? e.carriedOver : 0), 0);
    const createsTotal = applyEvents.reduce((s, e) => s + (Number.isFinite(e.created) ? e.created : 0), 0);
    const transpositionHitRate = (carriesTotal + createsTotal) > 0 ? carriesTotal / (carriesTotal + createsTotal) : null;
    const duplicateStatesAvoided = carriesTotal > 0 ? carriesTotal : null;

    // --- search quality from the new instrumentation ----------------------------------------
    const deadEnds = count(events, 'goal_dead_end');
    const deadEndRate = selected > 0 ? deadEnds / selected : null;
    const depthValues = events
        .filter(e => (e.type ?? '').toLowerCase() === 'goal_selected' && Number.isFinite(e.depth))
        .map(e => e.depth);
    const meanDepth = depthValues.length ? depthValues.reduce((s, d) => s + d, 0) / depthValues.length : null;
    const ladderResults = count(events, 'ladder_result');
    const ladderClosed = events.filter(e => (e.type ?? '').toLowerCase() === 'ladder_result' && e.solved === true).length;
    const memoryReplays = events.filter(e => (e.type ?? '').toLowerCase() === 'tactic_applied' && e.via === 'goal-memory').length;
    const memoryVetoes = events.filter(e => (e.type ?? '').toLowerCase() === 'tactic_predicted_failure' && typeof e.reason === 'string' && e.reason.startsWith('failed-before')).length;
    const unknownVetoes = events.filter(e => (e.type ?? '').toLowerCase() === 'tactic_predicted_failure' && typeof e.reason === 'string' && e.reason.startsWith('unknown-identifier')).length;
    const kernelUnknownIdentifiers = count(events, 'kernel_unknown_identifier');

    // --- compression quality (architecture.md §0.5, research_notes §5) ---------------------
    // proofDescriptionLength: the final proof scripts' lengths under the canonical layout.
    const verifiedEvents = events.filter(e => (e.type ?? '').toUpperCase() === 'LEMMA_VERIFIED');
    const proofLengths = verifiedEvents
        .map(e => String(e.proofScript ?? '').replace(/\s+/g, ' ').trim().length)
        .filter(n => n > 0);
    const proofDescriptionLength = proofLengths.length
        ? { total: proofLengths.reduce((s, n) => s + n, 0), mean: proofLengths.reduce((s, n) => s + n, 0) / proofLengths.length, perLemma: proofLengths }
        : null;
    // libraryRelativeDescriptionLength: the residual description once the verified library is
    // taken as given (MDL: L(data | model)). A reused lemma contributes ZERO residual — its
    // content is already a dictionary entry, paid for when it was first proved; a fresh proof
    // contributes its full length.
    const reuseLemmas = new Set(events.filter(e => (e.type ?? '').toUpperCase() === 'STORE_REUSE').map(e => e.lemmaId).filter(Boolean));
    const residualLengths = verifiedEvents
        .map(e => {
            const len = String(e.proofScript ?? '').replace(/\s+/g, ' ').trim().length;
            if (!len) return null;
            return { len: reuseLemmas.has(e.lemmaId) ? 0 : len, reused: reuseLemmas.has(e.lemmaId) };
        })
        .filter(Boolean);
    const libraryRelativeDescriptionLength = residualLengths.length
        ? { total: residualLengths.reduce((s, r) => s + r.len, 0), mean: residualLengths.reduce((s, r) => s + r.len, 0) / residualLengths.length, reusedCount: residualLengths.filter(r => r.reused).length }
        : null;
    const reuseCount = reuseLemmas.size;

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
        duplicateStatesAvoided,

        // --- search quality ---
        firstSuccessRank,
        branchingFactor: applied > 0 ? subgoals / applied : null,
        meanDepth,
        deadEndRate,
        transpositionHitRate,

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

        // --- compression quality (architecture.md §0.5, §6.1; event-derived, no fabrication) ---
        proofDescriptionLength,
        libraryRelativeDescriptionLength,
        reuseCount,

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
            repairRounds: repaired,
            ladderResults,
            ladderClosed,
            memoryReplays,
            memoryVetoes,
            unknownVetoes,
            kernelUnknownIdentifiers
        }
    };
}
