// Reward function parameterization and defaults (architecture.md §6).
export const REWARDS = Object.freeze({
    GOAL_SOLVED: 1.0,
    COMPLEXITY_REDUCTION: 0.5,
    DEPTH_DECREASE: 0.1,
    LEMMA_REUSE: 0.05,
    REPAIR_ROUND: -0.1,
    WASTED_TACTIC: -0.5,
    GUARDRAIL_TRIP: -1.0
});

export function computeReward(eventType, details = {}) {
    switch (eventType) {
        case 'GOAL_SOLVED':
        case 'goal_solved': return REWARDS.GOAL_SOLVED;
        case 'COMPLEXITY_REDUCTION': return REWARDS.COMPLEXITY_REDUCTION;
        case 'REPAIR_PROPOSED': return REWARDS.REPAIR_ROUND;
        case 'TACTIC_FAILED':
        case 'tactic_failed': return REWARDS.WASTED_TACTIC;
        case 'GUARDRAIL_TRIP': return REWARDS.GUARDRAIL_TRIP;
        default: return 0.0;
    }
}
