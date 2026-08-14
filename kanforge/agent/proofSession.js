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

    // Open the session, retrying ONCE on transient repl states: a parse error or an empty
    // goal list for a statement that is in fact well-formed (observed live: the same stub
    // parses fine on the retry and later proves) is a fresh-session issue, not a statement
    // defect — one retry converts it instead of burning a whole round.
    async open(statement) {
        try {
            const goals = await this.backend.extractGoals(statement);
            if (!goals || goals.length === 0) throw new Error('extractGoals returned no goals');
            return goals;
        } catch (err) {
            if (!/parse error|unexpected token|returned no goals/i.test(err?.message ?? '')) throw err;
            return this.backend.extractGoals(statement);
        }
    }

    close(lemmaId) {
        this.backend.endLemma?.(lemmaId);
    }
}
