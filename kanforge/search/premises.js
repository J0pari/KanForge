// Premise retrieval + premise-locked flag (architecture.md §5).
export class PremiseRetriever {
    constructor(corpus = []) {
        this.corpus = corpus;
    }

    retrieve(goal, topK = 5) {
        return this.corpus.slice(0, topK);
    }
}
