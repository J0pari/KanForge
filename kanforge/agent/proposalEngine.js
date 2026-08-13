// ProposalEngine (architecture.md §4.1): the single LLM seam of the live loop.
//
// Every LLM call the loop makes — per-goal proposals, repair proposals, lemma-level repair,
// and every delegated recipe's calls (bestofn, swiss proposals + pairwise judges, bfs, mcgs,
// repulsion sampling) — goes through the wrapped `llm` this engine exposes. That gives the
// project exactly ONE owner for:
//   - LLM-call accounting (write-through: the counter increments on every complete(), so
//     no path can under- or over-count; cost-normalized ablation reads this counter);
//   - the maxLlmCalls budget wall (once exhausted, further complete() calls return an empty
//     response — recipes see "no proposal" and stop, so the budget is a hard wall, not a
//     suggestion);
//   - failure-kind classification (abstention vs provider failure vs timeout vs budget),
//     so a dead transport is never mistaken for a silent model.
//
// The predictor exploration rate belongs here too (§6): with probability `predictorExploration`
// a predicted-failure tactic is applied anyway, producing counterfactual evidence that keeps
// the predictor from self-confirming forever. Every exploration is emitted as an event so the
// false-rejection accounting has the counterfactual on record.
import { sanitizeTacticText } from './llm.js';

export class ProposalEngine {
    constructor({ llm, maxLlmCalls = null, predictorExploration = 0.02, onEvent = null } = {}) {
        if (!llm) throw new Error('ProposalEngine requires an llm client');
        this.maxLlmCalls = maxLlmCalls;
        this.predictorExploration = predictorExploration;
        this.onEvent = onEvent; // (event) => void — exploration/prediction records
        this.llmCalls = 0;
        this.budgetExhausted = false;
        const raw = llm;
        // Budget-walled, counting client. Recipes receive THIS object and nothing else.
        this.llm = {
            complete: async (prompt) => {
                if (this.budgetExhausted) {
                    return { text: null, usage: { promptTokens: 0, completionTokens: 0 }, budget: true };
                }
                if (this.maxLlmCalls != null && this.llmCalls >= this.maxLlmCalls) {
                    this.budgetExhausted = true;
                    this.onEvent?.({ type: 'budget_wall_engaged', budget: this.maxLlmCalls, llmCalls: this.llmCalls });
                    return { text: null, usage: { promptTokens: 0, completionTokens: 0 }, budget: true };
                }
                this.llmCalls++;
                return raw.complete(prompt);
            }
        };
    }

    // One proposal: prompt in, structured record out. errorKind:
    //   null                — a tactic was produced
    //   'abstention'        — the model produced no usable tactic (sanitizer returned empty)
    //   'budget-exhausted'  — the wall engaged; no call was made
    //   'provider-failure'  — the transport/CLI threw (dead provider must not look like a
    //                         silent model — §4 failure kinds)
    async propose(prompt) {
        const t0 = Date.now();
        try {
            const response = await this.llm.complete(prompt);
            const llmMs = Date.now() - t0;
            const usage = response.usage ?? null;
            if (response.budget) {
                return { tactic: null, error: `LLM-call budget exhausted (${this.maxLlmCalls})`, errorKind: 'budget-exhausted', llmMs, promptTokens: null, completionTokens: null };
            }
            const tactic = sanitizeTacticText(response.text) || null;
            if (!tactic) {
                return { tactic: null, error: 'model returned no tactic', errorKind: 'abstention', llmMs, promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null };
            }
            return { tactic, llmMs, promptTokens: usage?.promptTokens ?? null, completionTokens: usage?.completionTokens ?? null };
        } catch (err) {
            return { tactic: null, error: err?.message ?? String(err), errorKind: 'provider-failure', llmMs: Date.now() - t0, promptTokens: null, completionTokens: null };
        }
    }

    // Should a predicted-failure tactic be tried anyway? Counterfactual evidence (§6):
    // rejection is only honest if it is occasionally re-tested against the kernel.
    shouldExplore(rejectedTactic) {
        if (this.predictorExploration <= 0) return false;
        const explore = Math.random() < this.predictorExploration;
        if (explore) {
            this.onEvent?.({ type: 'predictor_explored', tactic: rejectedTactic });
        }
        return explore;
    }
}
