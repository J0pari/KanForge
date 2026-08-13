// Kernel-grounded def-eq oracle tests (lean/defEqOracle.js, build_order.md §5.12): the oracle
// is the ONLY channel for non-congruence unions, so its contract is pinned here — it checks
// definitional equality via `rfl` under the goal's canonical binder telescope, memoizes per
// pair, and treats backend failures as rejection (never as confirmation).
import test from 'node:test';
import assert from 'node:assert';
import { createDefEqOracle } from '../lean/defEqOracle.js';

test('oracle builds the rfl check with the canonical binder telescope and reports verified', async () => {
    const seen = [];
    const backend = {
        check: async (src) => {
            seen.push(src);
            return { status: 'verified' };
        }
    };
    const oracle = createDefEqOracle(backend);
    const ok = await oracle.confirm('x + 0', 'x', [{ name: 'x', type: 'Nat' }]);
    assert.strictEqual(ok, true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0], 'example (x : Nat) : (x + 0) = (x) := by rfl');
});

test('backend rejection and thrown errors are both rejection — never confirmation', async () => {
    const rejecting = createDefEqOracle({ check: async () => ({ status: 'error', error: { message: 'type mismatch' } }) });
    assert.strictEqual(await rejecting.confirm('a + b', 'b + a', []), false);
    const throwing = createDefEqOracle({ check: async () => { throw new Error('worker died'); } });
    assert.strictEqual(await throwing.confirm('a + b', 'b + a', []), false);
});

test('results are memoized per pair (one backend check per distinct pair)', async () => {
    let checks = 0;
    const oracle = createDefEqOracle({ check: async () => { checks++; return { status: 'verified' }; } });
    await oracle.confirm('p', 'q', []);
    await oracle.confirm('p', 'q', []);
    await oracle.confirm('q', 'p', []);
    assert.strictEqual(checks, 2); // (p,q) once; (q,p) is a distinct ordered pair
    assert.strictEqual(oracle.checks(), 2);
});

test('identical texts are confirmed without a backend call', async () => {
    let checks = 0;
    const oracle = createDefEqOracle({ check: async () => { checks++; return { status: 'verified' }; } });
    assert.strictEqual(await oracle.confirm('x', 'x', []), true);
    assert.strictEqual(checks, 0);
});

test('empty texts are rejected', async () => {
    const oracle = createDefEqOracle({ check: async () => ({ status: 'verified' }) });
    assert.strictEqual(await oracle.confirm('', 'x', []), false);
    assert.strictEqual(await oracle.confirm(null, 'x', []), false);
});
