// Universal-arrow stopping rule (architecture.md §4).
export function isGoalSolved(result) {
    return result && result.status === 'ok' && (!result.newGoals || result.newGoals.length === 0);
}

export function isLemmaProved(egraph, statementHash, pinnedHash) {
    return egraph.isRootSolved() && statementHash === pinnedHash;
}
