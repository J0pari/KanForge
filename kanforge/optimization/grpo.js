// GRPO update harness (architecture.md §6, build_order.md §6.3). Computes the policy-update
// quantities a GRPO trainer would apply, over episode batches recorded from the live loop:
//   - trajectoriesFromEvents: per-lemma tactic sequences with per-step outcome rewards
//   - groupAdvantages: group-relative (batch-normalized) advantage per trajectory
//   - grpoLoss: clipped surrogate objective + KL penalty (the exact update math)
// The harness RECORDS batches and COMPUTES update quantities; it does not fake a training run —
// applying a gradient step to the LLM policy is a P7.3/6.4 concern (offline trainer), and this
// module makes the numbers it would need inspectable.

export function trajectoriesFromEvents(events = []) {
    const byLemma = new Map();
    for (const e of events) {
        if (e.type !== 'tactic_proposed' && e.type !== 'tactic_applied' && e.type !== 'goal_solved' && e.type !== 'tactic_failed') continue;
        if (!byLemma.has(e.lemmaId)) byLemma.set(e.lemmaId, { lemmaId: e.lemmaId, steps: [], solved: false });
        const t = byLemma.get(e.lemmaId);
        if (e.type === 'tactic_proposed') {
            t.steps.push({ tactic: e.tactic, applied: false, reward: 0 });
        } else if (e.type === 'tactic_applied') {
            const last = t.steps[t.steps.length - 1];
            if (last && !last.applied) {
                last.applied = true;
                last.reward = 0.5; // progress (decomposition) — partial credit, not solved
            }
        } else if (e.type === 'goal_solved') {
            const last = t.steps[t.steps.length - 1];
            if (last) last.reward = 1;
            t.solved = true;
        } else if (e.type === 'tactic_failed') {
            const last = t.steps[t.steps.length - 1];
            if (last) last.reward = -0.5; // spent budget on a kernel-rejected tactic
        }
    }
    return [...byLemma.values()].filter(t => t.steps.length > 0);
}

// Group-relative advantage: (reward - groupMean) / (groupStd + eps), the GRPO normalization
// that removes the policy's absolute-scale bias within a batch.
export function groupAdvantages(trajectories = [], { eps = 1e-8 } = {}) {
    const rewards = trajectories.map(t => t.solved ? 1 : 0);
    const mean = rewards.reduce((s, r) => s + r, 0) / Math.max(1, rewards.length);
    const variance = rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rewards.length);
    const std = Math.sqrt(variance);
    return trajectories.map((t, i) => ({
        ...t,
        advantage: (rewards[i] - mean) / (std + eps)
    }));
}

// Clipped surrogate objective (PPO-family, the update GRPO uses) plus KL penalty vs the old
// policy: loss = -E[ min(r * A, clip(r, 1-eps, 1+eps) * A) - beta * KL ]. probs/oldProbs are
// step-level policy probabilities (log-probabilities are not emitted by the LLM client; the
// harness takes them as input so the update math is exact and testable).
export function grpoLoss(probs, oldProbs, advantages, { clipEpsilon = 0.2, beta = 0.01, eps = 1e-8 } = {}) {
    if (probs.length !== oldProbs.length || probs.length !== advantages.length) {
        throw new Error('grpoLoss requires equal-length probs/oldProbs/advantages arrays');
    }
    let loss = 0;
    let clipRate = 0;
    let kl = 0;
    for (let i = 0; i < probs.length; i++) {
        const ratio = (probs[i] + eps) / (oldProbs[i] + eps);
        const adv = advantages[i];
        const unclipped = ratio * adv;
        const clipped = Math.min(Math.max(ratio, 1 - clipEpsilon), 1 + clipEpsilon) * adv;
        loss += -Math.min(unclipped, clipped);
        if (Math.abs(ratio - 1) > clipEpsilon) clipRate++;
        kl += oldProbs[i] * Math.log((oldProbs[i] + eps) / (probs[i] + eps));
    }
    loss = loss / probs.length;
    kl = kl / probs.length;
    return { loss: loss + beta * kl, clipRate: clipRate / probs.length, kl };
}

// Records episode batches from a loop's event store and reports the update quantities a trainer
// would consume. Toggleable: `grpo: true` on the loop records batches into this harness.
export class GRPOHarness {
    constructor({ clipEpsilon = 0.2, beta = 0.01, batchSize = 16 } = {}) {
        this.clipEpsilon = clipEpsilon;
        this.beta = beta;
        this.batchSize = batchSize;
        this.batches = [];
        this.recorded = 0;
    }

    record(events = []) {
        const trajectories = trajectoriesFromEvents(events);
        for (const t of trajectories) this.batches.push(t);
        this.recorded += trajectories.length;
    }

    // Compute the update quantities for the oldest full batch, if one is ready.
    update({ probs, oldProbs } = {}) {
        if (this.batches.length < this.batchSize) return { ready: false, reason: `need ${this.batchSize - this.batches.length} more episodes` };
        const batch = this.batches.splice(0, this.batchSize);
        const withAdv = groupAdvantages(batch);
        const advantages = withAdv.map(t => t.advantage);
        const n = Math.min(probs?.length ?? advantages.length, oldProbs?.length ?? advantages.length, advantages.length);
        if (!probs || !oldProbs || n < advantages.length) {
            // The trainer supplies policy probabilities; without them we report the prepared
            // batch and its advantages, not a fabricated gradient.
            return { ready: true, batch: withAdv, advantages, loss: null, clipRate: null, reason: 'probs/oldProbs not supplied by trainer' };
        }
        return {
            ready: true,
            batch: withAdv,
            advantages,
            ...grpoLoss(probs.slice(0, n), oldProbs.slice(0, n), advantages.slice(0, n), { clipEpsilon: this.clipEpsilon, beta: this.beta })
        };
    }

    summary() {
        return { recordedEpisodes: this.recorded, queuedEpisodes: this.batches.length, batchSize: this.batchSize, ready: this.batches.length >= this.batchSize };
    }
}
