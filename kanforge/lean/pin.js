// Statement pinning (architecture.md §3 + §3.1 pin drift).
// A statement pin is the toolchain + mathlib context plus a hash of the canonical
// `#print`-normalized form. Hash comparison is only valid under the SAME normVersion:
// a Lean/mathlib update can change the printed form without changing meaning, so a pin
// mismatch under a different norm/toolchain reports DRIFT (operator re-pins deliberately);
// a hash mismatch under the same norm reports WEAKENED (statement text mutated).

import crypto from 'node:crypto';

export const NORM_VERSION = 1;

export function normalizeStatement(statement) {
    // Canonical form: trim, then collapse all runs of whitespace (incl. newlines) to one
    // space, so cosmetic formatting does not flip hashes.
    return String(statement).trim().replace(/[ \t\r\n]+/g, ' ');
}

export function hashStatement(statement) {
    return crypto.createHash('sha256').update(normalizeStatement(statement)).digest('hex');
}

export function makePin(statement, { toolchain, mathlibHash = null, leanVersion = null, normVersion = NORM_VERSION } = {}) {
    return {
        toolchain: toolchain ?? null,
        mathlibHash,
        leanVersion,
        normVersion,
        statementHash: hashStatement(statement)
    };
}

// current = { toolchain, mathlibHash, leanVersion, normVersion, statementHash }
// Returns { ok, drift, reason }.
//   drift: true  -> norm/toolchain/mathlib context changed (DRIFT; re-pin deliberately)
//   drift: false -> same context, statement hash differs (WEAKENED; statement mutated)
export function checkPin(pin, current) {
    if (!pin || !current) {
        return { ok: false, drift: true, reason: 'missing pin' };
    }
    const contextChanged =
        (pin.normVersion ?? NORM_VERSION) !== (current.normVersion ?? NORM_VERSION) ||
        pin.toolchain !== current.toolchain ||
        (pin.mathlibHash && current.mathlibHash && pin.mathlibHash !== current.mathlibHash) ||
        (pin.leanVersion && current.leanVersion && pin.leanVersion !== current.leanVersion);
    if (contextChanged) {
        return { ok: false, drift: true, reason: 'norm/toolchain context changed' };
    }
    if (pin.statementHash !== current.statementHash) {
        return { ok: false, drift: false, reason: 'statement hash mismatch' };
    }
    return { ok: true, drift: false };
}
