// Skeleton generator (architecture.md §1, build_order.md §4.1).
import { hashStatement } from '../lean/pin.js';

export class SkeletonGenerator {
    constructor(llm) {
        this.llm = llm;
    }

    async generate(theoremStatement) {
        return {
            theorem: theoremStatement,
            lemmas: [
                { id: hashStatement('lemma_1'), statement: 'lemma lemma_1 : True := by sorry', deps: [] }
            ]
        };
    }
}
