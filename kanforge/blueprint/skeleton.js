// Skeleton generator (architecture.md §1, build_order.md §4.1).
//
// STUB: NOT IMPLEMENTED. `generate()` never calls `this.llm` and returns one hardcoded
// placeholder stub regardless of input. Real behavior (build_order.md §4.1) is an LLM-proposed
// lemma decomposition emitted as kernel-typechecked `sorry` stubs; tracked under the
// "Replace stubs" plan in README.md.
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
