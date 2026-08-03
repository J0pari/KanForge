// Best-first search over goal equivalence classes (architecture.md §5).
// A state is the e-graph frontier; expanding a class applies ONE tactic (via the backend)
// and merges the resulting subgoals into the graph. Classes are scored by shared e-graph
// stats: fewest visits first, then highest value — transposition merging means a class
// reached by two paths keeps one shared score.
//
// Backend note: repl tactic mode attacks the head goal of a proof state, so against the real
// kernel expansion should follow frontier order (the P1 loop's discipline); score-based
// reordering is exact for stateless backends and for the mock/fake backends used in tests.

import { buildTacticPrompt } from '../agent/prompts.js';

export class BestFirstSearch {
    constructor({ backend, llm, maxTacticsPerGoal = 8 } = {}) {
        if (!backend || !llm) throw new Error('BestFirstSearch requires a backend and an llm');
        this.backend = backend;
        this.llm = llm;
        this.maxTacticsPerGoal = maxTacticsPerGoal;
    }

    _score(goalClass) {
        return [goalClass.stats.visits, -goalClass.stats.value];
    }

    async _propose(goal, attempt) {
        const response = await this.llm.complete(buildTacticPrompt(goal, attempt, this.maxTacticsPerGoal));
        return response.text?.trim() || null;
    }

    // Expand one goal class: try tactics until one applies cleanly. Returns true on progress.
    async expand(egraph, classId) {
        const goal = egraph.currentGoal(classId);
        for (let attempt = 1; attempt <= this.maxTacticsPerGoal; attempt++) {
            const tactic = await this._propose(goal, attempt);
            if (!tactic) continue;
            const result = await this.backend.applyTactic(goal, tactic);
            if (result.status !== 'ok') continue;
            egraph.applyTactic(classId, tactic, result.newGoals);
            return true;
        }
        return false;
    }

    async search(egraph, { maxExpansions = 100 } = {}) {
        let expansions = 0;
        while (!egraph.isRootSolved() && expansions < maxExpansions) {
            const open = egraph.getOpenGoals();
            if (open.length === 0) break;
            open.sort((a, b) => {
                const sa = this._score(a), sb = this._score(b);
                return sa[0] - sb[0] || sa[1] - sb[1] || (a.id < b.id ? -1 : 1);
            });
            const target = open[0];
            const progressed = await this.expand(egraph, target.id);
            if (!progressed) egraph.markFailed(target.id);
            expansions++;
        }
        return { ok: egraph.isRootSolved(), expansions };
    }
}
