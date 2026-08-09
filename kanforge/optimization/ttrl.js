// Test-time RL (architecture.md §6, build_order.md §6.3). Within-run adaptation from accumulated
// verification outcomes: the policy learns which goal classes are hard (repeated failures) and
// escalates their tactic budget, and which goals are solved cheaply (no escalation needed).
// No weights are trained — the policy is a pure function of the run's own event stream, applied
// immediately to the live loop (test-time adaptation, not offline training).

function failuresOnClass(events, classId) {
    return events.filter(e =>
        (e.type === 'tactic_failed' || e.type === 'recipe_failed' || e.type === 'repair_failed')
        && String(e.goalClassId ?? '') === String(classId ?? '')
    ).length;
}

export function analyzeTTL(events = [], { baseBudget = 8, escalatePerFailure = 1, capBudget = 24 } = {}) {
    const perClass = new Map();
    for (const e of events) {
        if (e.type === 'goal_selected') {
            const id = String(e.goalClassId);
            if (!perClass.has(id)) perClass.set(id, { classId: id, failures: 0, solved: false });
        }
    }
    for (const [id, c] of perClass) {
        c.failures = failuresOnClass(events, id);
        c.solved = events.some(e => e.type === 'goal_solved' && String(e.goalClassId) === id);
    }

    const adapted = new Map();
    for (const [id, c] of perClass) {
        if (c.solved) {
            adapted.set(id, { classId: id, maxAttempts: baseBudget, reason: 'solved' });
            continue;
        }
        const maxAttempts = Math.min(capBudget, baseBudget + c.failures * escalatePerFailure);
        adapted.set(id, { classId: id, maxAttempts, reason: c.failures > 0 ? `escalated after ${c.failures} failures` : 'base budget' });
    }
    return adapted;
}

export class TestTimePolicy {
    constructor({ baseBudget = 8, escalatePerFailure = 1, capBudget = 24 } = {}) {
        this.baseBudget = baseBudget;
        this.escalatePerFailure = escalatePerFailure;
        this.capBudget = capBudget;
        this.adapted = null;
        this.lastObserved = 0;
    }

    observe(events) {
        this.adapted = analyzeTTL(events, { baseBudget: this.baseBudget, escalatePerFailure: this.escalatePerFailure, capBudget: this.capBudget });
        this.lastObserved = events.length;
    }

    stateFor(classId) {
        if (!this.adapted) return { classId: String(classId ?? ''), maxAttempts: this.baseBudget, reason: 'unobserved' };
        return this.adapted.get(String(classId ?? '')) ?? { classId: String(classId ?? ''), maxAttempts: this.baseBudget, reason: 'unseen' };
    }

    summary() {
        if (!this.adapted) return { adapted: 0, escalations: 0 };
        const escalations = [...this.adapted.values()].filter(s => s.reason.startsWith('escalated')).length;
        return { adapted: this.adapted.size, escalations };
    }
}
