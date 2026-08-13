// ProofSession (architecture.md §4 role split): owns the backend proof-state lifecycle — one
// leased session per lemma attempt. The repl pool's leased worker lives from extractGoals to
// endLemma; the loop holds this thin wrapper instead of touching the backend's session API
// directly.
export class ProofSession {
    constructor(backend) {
        if (!backend || typeof backend.extractGoals !== 'function') {
            throw new Error('ProofSession requires a backend with extractGoals');
        }
        this.backend = backend;
    }

    async open(statement) {
        return this.backend.extractGoals(statement);
    }

    close(lemmaId) {
        this.backend.endLemma?.(lemmaId);
    }
}
