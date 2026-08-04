// Verified attempts to training samples dataset (architecture.md §1, build_order.md §6.4).
//
// PARTIAL: in-memory array only — samples are lost on exit. Real behavior (build_order.md §6.4)
// is a growing on-disk dataset with held-out split + contamination check; tracked under the
// "Replace stubs" plan in README.md.
export class TrainingDataset {
    constructor() {
        this.samples = [];
    }

    addSample(state, tactic, outcome) {
        this.samples.push({ state, tactic, outcome, timestamp: Date.now() });
    }

    exportJson() {
        return JSON.stringify(this.samples, null, 2);
    }
}
