// Verified attempts to training samples dataset (architecture.md §1, build_order.md §6.4).
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
