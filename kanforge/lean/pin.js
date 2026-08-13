// Statement pinning (architecture.md §3 + §3.1 pin drift).
// A statement pin is the toolchain + mathlib context plus a hash of the canonical normalized
// form. Hash comparison is only valid under the SAME normVersion: a Lean/mathlib update can
// change the meaning of a term without changing the toolchain, so a pin mismatch under a
// different norm/toolchain reports DRIFT (operator re-pins deliberately); a hash mismatch under
// the same norm reports WEAKENED (statement text mutated).
//
// The canonical form is WHITESPACE-COLLAPSED text (trim + collapse runs of whitespace), NOT a
// `#print`-normalized term. This is a deliberate simplification: it is stable across machines,
// needs no kernel round-trip, and detects statement-text mutation. It does NOT canonicalize
// alpha-renaming or definitional unfolding; statements that differ only by such semantics share
// a namespace of "same hash, possibly different meaning" and rely on the toolchain pin + kernel
// re-verification, not on the hash, for correctness.

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
//
// Context comparison is TRI-STATE, not truthy: a field known at pin time and unknown now (or
// vice versa) is uncertainty, and uncertainty reports DRIFT. Treating "known before, unknown
// now" as equal would let a proof built against a pinned mathlib be accepted under an
// unrecorded one — exactly the case the drift check exists to catch.
export function checkPin(pin, current) {
    if (!pin || !current) {
        return { ok: false, drift: true, reason: 'missing pin' };
    }
    const known = v => v != null && v !== '';
    const fieldChanged = (a, b) => {
        const ka = known(a);
        const kb = known(b);
        if (ka !== kb) return true; // known-before/unknown-now = context uncertainty
        if (!ka) return false;     // unknown before and now = nothing to compare
        return a !== b;
    };
    const contextChanged =
        (pin.normVersion ?? NORM_VERSION) !== (current.normVersion ?? NORM_VERSION) ||
        pin.toolchain !== current.toolchain ||
        fieldChanged(pin.mathlibHash, current.mathlibHash) ||
        fieldChanged(pin.leanVersion, current.leanVersion);
    if (contextChanged) {
        return { ok: false, drift: true, reason: 'norm/toolchain context changed or missing' };
    }
    if (pin.statementHash !== current.statementHash) {
        return { ok: false, drift: false, reason: 'statement hash mismatch' };
    }
    return { ok: true, drift: false };
}
