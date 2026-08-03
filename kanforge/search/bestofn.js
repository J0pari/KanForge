// Best-of-N search baseline (architecture.md §5).
export async function bestOfN(goal, backend, llm, N = 8) {
    for (let i = 0; i < N; i++) {
        const response = await llm.complete({ user: `Goal: ${goal.type}\nPropose tactic:` });
        const tactic = response.text?.trim();
        if (!tactic) continue;
        const result = await backend.applyTactic(goal, tactic);
        if (result.status === 'ok') {
            return { ok: true, tactic, result };
        }
    }
    return { ok: false };
}
