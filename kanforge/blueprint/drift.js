// Drift detection (architecture.md §1, build_order.md §4.2).
import { hashStatement } from '../lean/pin.js';

export function checkDrift(stubs) {
    const drifts = [];
    for (const stub of stubs) {
        const currentHash = hashStatement(stub.statement);
        if (stub.pinnedHash && currentHash !== stub.pinnedHash) {
            drifts.push({ id: stub.id, expected: stub.pinnedHash, actual: currentHash });
        }
    }
    return { ok: drifts.length === 0, drifts };
}
