// Deterministic kernel-closer ladder (registry component `safeLadder`): a bounded sequence of
// standard closers applied to a goal BEFORE any LLM proposal. Every rung is kernel-verified
// (backend.applyTactic) — the ladder cannot hallucinate, and a failure costs one quick check.
// The campaign pathology it eliminates: trivial arithmetic goals (2 ^ 1 = 2, x * 1 = x,
// a < a + b with positivity in context) burning the LLM budget on invented lemma names
// (`twopow_one`, `nat_mul_one_id`, …) that then fail whole-source verification.
//
// Order: cheapest/least-destructive first. `rfl` closes definitional identities; `norm_num`
// closes numeral arithmetic; `simp` rewrites with a bounded simpset; `ring` closes semiring
// identities; `omega`/`linarith` close linear arithmetic (with context hypotheses); `tauto`
// closes propositional logic. `positivity` proves positivity side-goals (a common subgoal of
// `apply pow_lt_pow_right`-shaped proofs).
export const SAFE_LADDER_TACTICS = Object.freeze([
    'rfl',
    'norm_num',
    'simp',
    'ring',
    'omega',
    'linarith',
    'tauto',
    'positivity'
]);

// Try the ladder against one goal. Applies rungs in order, stopping at the first kernel
// success. Returns { ok, tactic, result, attempts } — `result` is the backend applyTactic
// outcome for the winning rung (newGoals included). Never throws: a backend error on a rung
// is a failed rung, recorded as { kind } on the lastError for telemetry.
export async function runSafeLadder(goal, backend, { tactics = SAFE_LADDER_TACTICS, onRung = null } = {}) {
    let lastError = null;
    let attempts = 0;
    for (const tactic of tactics) {
        attempts++;
        let result;
        try {
            result = await backend.applyTactic(goal, tactic);
        } catch (err) {
            lastError = { tactic, kind: 'backend-error', message: err?.message ?? String(err) };
            onRung?.({ tactic, status: 'error', error: lastError });
            continue;
        }
        if (result.status === 'ok') {
            onRung?.({ tactic, status: 'ok', newGoals: result.newGoals?.length ?? 0 });
            return { ok: true, tactic, result, attempts, lastError };
        }
        lastError = { tactic, kind: 'kernel', message: result.error?.message ?? 'tactic failed' };
        onRung?.({ tactic, status: 'error', error: lastError });
    }
    return { ok: false, tactic: null, result: null, attempts, lastError };
}
