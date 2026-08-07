// Plain sha256 hash chain (no HMAC secret) so statement pins are reproducible across
// machines/runs. Each contentHash incorporates the previous hash.

import crypto from 'node:crypto';

// Statement hash chain (architecture.md §7): every verified lemma appends
// sha256(prevHash || statementHash || proofHash || outcome) — tamper-evident, reproducible.
export function hashChainEntry(prevHash, statementHash, proofHash, outcome) {
    return crypto.createHash('sha256')
        .update(String(prevHash ?? ''))
        .update(String(statementHash ?? ''))
        .update(String(proofHash ?? ''))
        .update(String(outcome ?? ''))
        .digest('hex');
}

// Verify a chain of { prevHash, statementHash, proofHash, outcome, hash } entries end to end.
export function verifyHashChain(entries) {
    let prev = null;
    for (const e of entries ?? []) {
        if ((e.prevHash ?? null) !== prev) return { ok: false, reason: 'prevHash link broken' };
        const expected = hashChainEntry(e.prevHash, e.statementHash, e.proofHash, e.outcome);
        if (expected !== e.hash) return { ok: false, reason: 'entry hash mismatch' };
        prev = e.hash;
    }
    return { ok: true };
}
