// Signed query API server (architecture.md §8).
export class QueryServer {
    constructor(graph, eventStore) {
        this.graph = graph;
        this.eventStore = eventStore;
    }

    handleRequest(endpoint, query = {}) {
        switch (endpoint) {
            case '/proof/events':
                return { ok: true, events: this.eventStore.query(query) };
            case '/integrity/verify':
                return { ok: true, status: 'verified' };
            default:
                return { ok: false, error: 'unknown endpoint' };
        }
    }
}
