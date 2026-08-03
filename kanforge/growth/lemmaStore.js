// Content-addressed lemma store (architecture.md §1).
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
