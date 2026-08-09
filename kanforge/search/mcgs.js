// UCB-guided graph search over the goal e-graph (architecture.md §5, build_order.md §5.6).
// NOT textbook MCTS: there is no cheap rollout phase — the "simulation" is an expensive LLM +
// kernel call — so the loop is selection / expansion / backprop only, and the UCB value is a
// heuristic whose statistical meaning is validated empirically (does it beat best-first/BFS at
// normalized LLM+kernel cost on held-out families?), not assumed.
// Transposition merging is built into the e-graph: alpha-equivalent goals share one class with
// shared stats, so every backprop updates one value estimate per equivalence class and walks ALL
// parents. Selection descends from the root by UCB over class stats; expansion applies ONE tactic
// via the backend.

import { buildTacticPrompt } from '../agent/prompts.js';
import { sanitizeTacticText } from '../agent/llm.js';
import { tacticHead } from '../optimization/causal.js';

export class MCGS {
    constructor({ backend, llm, exploration = Math.SQRT2, maxTacticsPerGoal = 4, repulsion = false, predictors = null } = {}) {
        if (!backend || !llm) throw new Error('MCGS requires a backend and an llm');
        this.backend = backend;
        this.llm = llm;
        this.exploration = exploration;
        this.maxTacticsPerGoal = maxTacticsPerGoal;
        this.repulsion = repulsion;
        this.predictors = predictors; // compiled matcher (§5.3): reject known-failing windows pre-verification
        this.skipped = 0;
    }

    _ucb(goalClass, parentVisits) {
        const { visits, value } = goalClass.stats;
        if (visits === 0) return Infinity;
        return value / visits + this.exploration * Math.sqrt(Math.log(Math.max(parentVisits, 2)) / visits);
    }

    _select(egraph) {
        // Descend from the root to the best open frontier class by UCB.
        const open = egraph.getOpenGoals();
        if (open.length === 0) return null;
        const totalVisits = open.reduce((s, c) => s + c.stats.visits, 0);
        let best = open[0];
        let bestScore = -Infinity;
        for (const c of open) {
            const score = this._ucb(c, totalVisits);
            if (score > bestScore || (score === bestScore && c.id < best.id)) {
                best = c;
                bestScore = score;
            }
        }
        return best;
    }

    async _expand(egraph, goalClass) {
        const goal = egraph.currentGoal(goalClass.id);
        const attempted = this.repulsion ? new Set() : null;
        const history = [];
        for (let attempt = 1; attempt <= this.maxTacticsPerGoal; attempt++) {
            const response = await this.llm.complete(buildTacticPrompt(goal, attempt, this.maxTacticsPerGoal));
            const tactic = sanitizeTacticText(response.text);
            if (!tactic) continue;
            if (attempted && attempted.has(tactic)) continue; // repulsion: no duplicate re-checks
            attempted?.add(tactic);
            if (this.predictors?.rejects(tacticHead(tactic), history)) {
                this.skipped++;
                continue; // §5.3: do not spend kernel budget on a known-failing window
            }
            history.push(tacticHead(tactic));
            const result = await this.backend.applyTactic(goal, tactic);
            if (result.status !== 'ok') continue;
            egraph.applyTactic(goalClass.id, tactic, result.newGoals);
            return result.newGoals.length === 0 ? 1 : 0.5; // solved vs. progress
        }
        return 0;
    }

    _backprop(egraph, goalClass, reward) {
        // Update the class and every ancestor (transpositions share the update).
        const seen = new Set();
        const stack = [goalClass];
        while (stack.length) {
            const c = stack.pop();
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            c.stats.value += reward;
            for (const parentId of c.parents) {
                const parent = egraph.classes.get(parentId);
                if (parent) stack.push(parent);
            }
        }
    }

    async search(egraph, { rollouts = 50 } = {}) {
        let used = 0;
        while (!egraph.isRootSolved() && used < rollouts) {
            const selected = this._select(egraph);
            if (!selected) break;
            const reward = await this._expand(egraph, selected);
            if (reward === 0) egraph.markFailed(selected.id);
            this._backprop(egraph, selected, reward);
            used++;
        }
        return { ok: egraph.isRootSolved(), rollouts: used };
    }
}
