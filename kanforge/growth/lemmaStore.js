// Content-addressed lemma store (architecture.md §1).
//
// PARTIAL: in-memory Map only — nothing is persisted or reloaded. Real behavior (build_order.md
// §2.3 / §6.4) needs on-disk persistence keyed by statement hash; tracked under the
// "Replace stubs" plan in README.md.
export class LemmaStore {
    constructor() {
        this.store = new Map();
    }

    put(hash, lemmaData) {
        this.store.set(hash, lemmaData);
    }

    get(hash) {
        return this.store.get(hash);
    }
}
