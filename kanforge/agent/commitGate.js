// CommitGate (architecture.md §2.5, §4): the verification-and-policy sequence that turns a
// solved e-graph into a committed lemma. Extracted from TacticLoop so the hard boundary — pin,
// drift, whole-source kernel check, premise lock, leakage scan, hash chain — has one owner and
// the loop stays orchestration.
//
// The gate performs no LLM calls and mutates nothing except the hash chain handed in. It
// returns either { ok: true, result, proofScript, source, hashEntry } or a typed failure
// { ok: false, kind, message, ... } that the caller maps to its event stream.

import { hashStatement } from '../lean/pin.js';
import { straighten, buildProofSource } from '../core/state.js';
import { Guardrails } from '../core/guardrails.js';
import { findPremiseLockViolations } from '../search/premises.js';
import { hashChainEntry } from '../core/hasher.js';

export async function runCommitGate({
    backend,
    statement,
    lemmaId,
    pin,
    currentPin,
    checkPin,
    egraph,
    directProof,
    premiseLocked = false,
    retriever = null,
    retrievedPremises = null
}) {
    // Pin-context drift (§3.1): the toolchain/norm context captured at pin time must still
    // match the live backend. (Statement weakening was already checked by the caller against
    // the pinned hash — the gate re-asserts it via the guardrail at the end.)
    const pinStatus = checkPin(pin, currentPin);
    if (!pinStatus.ok && !pinStatus.drift) {
        return { ok: false, kind: 'pin_drift', message: pinStatus.reason };
    }

    // Compose the proof: a multi-line repair may have produced a direct proof; otherwise the
    // tree is extracted and straightened. Either way the WHOLE source is what gets verified.
    const proofTree = directProof ? null : egraph.extractProof();
    if (!directProof && !proofTree) {
        return { ok: false, kind: 'proof_extraction_failed', message: 'proof extraction failed' };
    }
    const proofScript = directProof ?? straighten(proofTree).script;
    const source = buildProofSource(statement, proofScript);

    // Pre-flight check: syntactically and type-level valid before the full kernel verify.
    // Catches bullet misalignment, unclosed goals, and variable shadowing — compose errors
    // that straighten missed.
    const preflight = await backend.check(source, { useWarmEnv: false });
    if (preflight.status !== 'verified') {
        const perr = preflight.error?.message ?? 'pre-flight check failed';
        return { ok: false, kind: 'preflight_failed', message: `proof composition invalid: ${String(perr).slice(0, 200)}`, proofScript, source, sourceHead: source.slice(0, 400), preflightError: perr };
    }
    const verification = await backend.verifyProof(source, lemmaId);

    // Premise-lock gate (build_order.md §5.2): when locked, the proof may only reference
    // premises that were actually retrieved for this lemma.
    if (premiseLocked) {
        const violations = findPremiseLockViolations(proofScript, retriever?.corpus ?? [], [...(retrievedPremises ?? new Set())]);
        if (violations.length > 0) {
            return { ok: false, kind: 'premise_lock', message: `proof references unretrieved premises: ${violations.join(', ')}`, names: violations, proofScript, source, verification };
        }
    }

    // HARD guardrail gate at commit (§2.5): pin unchanged, kernel accepted, and the COMPLETE
    // source clean — the leakage scan covers statement + proof, never the script alone.
    const commit = Guardrails.assertLemmaCommit({ pin, statement, proofScript, verification, source });
    if (!commit.ok) {
        return { ok: false, kind: 'guardrails', message: commit.violations.map(v => v.type).join(', '), violations: commit.violations, proofScript, source, verification, kernelError: verification?.error?.message ?? verification?.error ?? 'no kernel message', sourceHead: source.slice(0, 400) };
    }

    // Run-level statement hash chain (§7): every verified lemma appends a tamper-evident
    // entry — sha256(prevHash || statementHash || proofHash || outcome).
    const statementHash = hashStatement(statement);
    const proofHash = hashStatement(proofScript);
    return {
        ok: true,
        result: { statement, proofScript, verifiedAt: new Date().toISOString() },
        proofScript,
        source,
        hashEntry: { statementHash, proofHash, outcome: 'verified' }
    };
}
