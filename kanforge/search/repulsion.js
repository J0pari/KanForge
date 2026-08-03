// Goedel-style diversity penalty (architecture.md §5).
export function computeRepulsionPenalty(tactic, activeTactics) {
    let penalty = 0.0;
    for (const t of activeTactics) {
        if (t === tactic) penalty += 0.5;
    }
    return penalty;
}
