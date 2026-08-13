// Best-first search over goal equivalence classes (architecture.md §5).
// A state is the transposition-graph frontier; expanding a class applies ONE tactic (via the backend)
// and merges the resulting subgoals into the graph. Classes are scored by shared
// stats: fewest visits first, then highest value — transposition merging means a class
// reached by two paths keeps one shared score.
//
// Backend note: repl tactic mode attacks the head goal of a proof state, so against the real
// kernel expansion should follow frontier order (the P1 loop's discipline); score-based
// reordering is exact for stateless backends and for the mock/fake backends used in tests.

import { buildTacticPrompt } from '../agent/prompts.js';
import { sanitizeTacticText } from '../agent/llm.js';
import { tacticHead } from '../optimization/causal.js';
import { computeRepulsionPenalty } from './repulsion.js';

export class BestFirstSearch {
    constructor({ backend, llm, maxTacticsPerGoal = 8, repulsion = false, predictors = null } = {}) {
        if (!backend || !llm) throw new Error('BestFirstSearch requires a backend and an llm');
        this.backend = backend;
        this.llm = llm;
        this.maxTacticsPerGoal = maxTacticsPerGoal;
        this.repulsion = repulsion;
        this.predictors = predictors; // compiled matcher (§5.3)
        this.skipped = 0;
        this._penalties = new Map(); // classId → accumulated diversity penalty
    }

    _score(goalClass) {
        const penalty = this._penalties.get(goalClass.id) ?? 0;
        // Fewest visits first, then highest value; a class the LLM repeats tactics on carries
        // a penalty that deprioritizes it.
        return [goalClass.stats.visits, -(goalClass.stats.value - penalty)];
    }

    async _propose(goal, attempt) {
        const response = await this.llm.complete(buildTacticPrompt(goal, attempt, this.maxTacticsPerGoal));
        return sanitizeTacticText(response.text) || null;
    }

    // Expand one goal class: try tactics until one applies cleanly. Returns true on progress.
    async expand(graph, classId) {
        const goal = graph.currentGoal(classId);
        const attempted = this.repulsion ? new Set() : null;
        const history = [];
        let penalty = 0;
        for (let attempt = 1; attempt <= this.maxTacticsPerGoal; attempt++) {
            const tactic = await this._propose(goal, attempt);
            if (!tactic) continue;
            if (attempted && attempted.has(tactic)) {
                penalty += computeRepulsionPenalty(tactic, [...attempted]);
                continue; // repulsion: no duplicate re-checks
            }
            attempted?.add(tactic);
            if (this.predictors?.rejects(tacticHead(tactic), history)) {
                this.skipped++;
                continue; // §5.3: no kernel budget on a known-failing window
            }
            history.push(tacticHead(tactic));
            const result = await this.backend.applyTactic(goal, tactic);
            if (result.status !== 'ok') continue;
            graph.applyTactic(classId, tactic, result.newGoals);
            if (penalty > 0) this._penalties.set(classId, (this._penalties.get(classId) ?? 0) + penalty);
            return true;
        }
        return false;
    }

    async search(graph, { maxExpansions = 100 } = {}) {
        let expansions = 0;
        while (!graph.isRootSolved() && expansions < maxExpansions) {
            const open = graph.getOpenGoals();
            if (open.length === 0) break;
            open.sort((a, b) => {
                const sa = this._score(a), sb = this._score(b);
                return sa[0] - sb[0] || sa[1] - sb[1] || (a.id < b.id ? -1 : 1);
            });
            const target = open[0];
            const progressed = await this.expand(graph, target.id);
            if (!progressed) graph.markFailed(target.id);
            expansions++;
        }
        return { ok: graph.isRootSolved(), expansions };
    }
}
