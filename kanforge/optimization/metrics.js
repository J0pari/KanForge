// KPI calculator and performance metrics (architecture.md).
export function computeMetrics(events) {
    const verified = events.filter(e => e.type === 'LEMMA_VERIFIED' || e.type === 'lemma_verified').length;
    const failed = events.filter(e => e.type === 'LEMMA_FAILED' || e.type === 'lemma_failed').length;
    const tacticProposed = events.filter(e => e.type === 'TACTIC_PROPOSED' || e.type === 'tactic_proposed').length;
    const tacticApplied = events.filter(e => e.type === 'TACTIC_APPLIED' || e.type === 'tactic_applied').length;

    return {
        verifiedLemmas: verified,
        failedLemmas: failed,
        successRate: (verified + failed) > 0 ? verified / (verified + failed) : 0,
        tacticsPerLemma: verified > 0 ? tacticApplied / verified : 0,
        tacticSuccessRate: tacticProposed > 0 ? tacticApplied / tacticProposed : 0
    };
}
