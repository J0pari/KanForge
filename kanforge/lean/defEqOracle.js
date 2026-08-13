// Kernel-grounded definitional-equality oracle (build_order.md §5.12): the ONLY channel by
// which the e-graph can union classes that pure congruence closure did not already identify.
// A candidate pair (lhsText, rhsText) is confirmed iff Lean accepts
//
//     example (v0 : T0) (v1 : T1) … : (lhs) = (rhs) := by rfl
//
// i.e. definitional equality under the goal's canonical binder telescope. This is the weakest
// sound equivalence — anything `rfl` accepts is guaranteed interchangeable — so an oracle-
// confirmed union can never corrupt search state. Results are memoized per pair (the egraph
// additionally records confirmed unions so serialized state never re-queries the kernel).
export function createDefEqOracle(backend, { warm = false } = {}) {
    if (!backend || typeof backend.check !== 'function') {
        throw new Error('createDefEqOracle requires a backend with check(statement, opts)');
    }
    const memo = new Map(); // "lhs::rhs" -> bool
    let checks = 0;
    return {
        checks: () => checks,
        async confirm(lhsText, rhsText, context = []) {
            const lhs = String(lhsText ?? '').trim();
            const rhs = String(rhsText ?? '').trim();
            if (!lhs || !rhs) return false;
            if (lhs === rhs) return true;
            const key = `${lhs}::${rhs}`;
            if (memo.has(key)) return memo.get(key);
            const binders = (context ?? [])
                .map(c => `(${c.name} : ${c.type})`)
                .join(' ');
            const src = `example ${binders ? `${binders} ` : ''}: (${lhs}) = (${rhs}) := by rfl`;
            checks++;
            try {
                const res = await backend.check(src, { useWarmEnv: warm });
                const ok = res?.status === 'verified';
                memo.set(key, ok);
                return ok;
            } catch {
                memo.set(key, false);
                return false;
            }
        }
    };
}
