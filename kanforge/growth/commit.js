// Commit-per-lemma growth (architecture.md §1, build_order.md §2.3).
export function formatLemmaCommitMessage(lemmaId, statementHash) {
    return `feat(proof): prove lemma ${lemmaId} [stmt:${statementHash}]`;
}
