// Semantic text formatters (architecture.md §1, §8).
export function formatProofSummary(node) {
    return `Lemma: ${node.id}\nState: ${node.state}\nDeps: ${Array.from(node.deps ?? []).join(', ')}`;
}
