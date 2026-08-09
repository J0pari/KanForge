// Critic role (architecture.md §7.3, build_order.md §7.3): reviews a candidate proof before it
// is accepted into the development. Deterministic core — statement-match (the proof's statement
// hash must equal the pinned statement) and readability heuristics (no sorry/admit/axiom, sane
// length, real tactic content) — plus an optional LLM judgment pass. The critic never edits;
// it returns findings and a verdict.

import { hashStatement } from '../../lean/pin.js';

// Deterministic review. statement is the pinned statement, proofScript the proposed proof
// (the full source the kernel verified). Returns { verdict, findings }.
export function reviewProof({ statement, proofScript, pinnedHash = null } = {}) {
    const findings = [];
    const script = String(proofScript ?? '');
    const stmt = String(statement ?? '');

    // Statement-match: the proof's theorem statement must be exactly the pinned statement.
    if (!stmt) {
        findings.push({ severity: 'critical', code: 'NO_STATEMENT', message: 'no statement to match against' });
    } else if (pinnedHash && hashStatement(stmt) !== pinnedHash) {
        findings.push({ severity: 'critical', code: 'STATEMENT_MISMATCH', message: 'statement hash differs from the pin' });
    }
    if (!script.includes(stmt.trim())) {
        findings.push({ severity: 'critical', code: 'PROOF_MISSING_STATEMENT', message: 'proof source does not contain the statement' });
    }

    // Readability / integrity heuristics.
    if (/sorry|admit\b|axiom\b/i.test(script.replace(/^\s*\/-[\s\S]*?-\//gm, ''))) {
        findings.push({ severity: 'critical', code: 'UNPROVEN_SORRY', message: 'proof contains sorry/admit/axiom' });
    }
    const lines = script.split('\n');
    if (lines.length < 1 || lines.length > 400) {
        findings.push({ severity: 'warn', code: 'LENGTH', message: `proof is ${lines.length} lines (sanity 1..400)` });
    }
    const tacticLines = lines.filter(l => /^\s*(intro|apply|exact|omega|simp|ring|norm_num|cases|induction|rw|repeat|all_goals|by|rfl|linarith|nlinarith|positivity|field_simp|constructor|obtain|refine|use|aesop|solve_by_elim|exact_mod_cast|have|let|calc|·|\.$)/.test(l));
    if (tacticLines.length === 0) {
        findings.push({ severity: 'warn', code: 'NO_TACTIC_CONTENT', message: 'no recognizable tactic lines in the proof' });
    }

    const critical = findings.filter(f => f.severity === 'critical');
    return { verdict: critical.length > 0 ? 'reject' : 'accept', findings, ok: critical.length === 0 };
}

// Optional LLM judgment pass: statement-match + a holistic review. Strict-parse verdict.
export function parseCriticVerdict(text) {
    const t = String(text ?? '').toUpperCase();
    if (/ACCEPT/.test(t)) return 'accept';
    if (/REJECT/.test(t)) return 'reject';
    return null;
}

export class Critic {
    constructor({ llm = null } = {}) {
        this.llm = llm; // optional; without it the critic is deterministic-only
    }

    async review({ statement, proofScript, pinnedHash = null }) {
        const base = reviewProof({ statement, proofScript, pinnedHash });
        if (!this.llm || base.verdict === 'reject') return base;

        try {
            const response = await this.llm.complete([
                {
                    role: 'system',
                    content: 'You are a Lean 4 proof critic. Review the proof for correctness risk and readability.\n' +
                        'Respond with exactly one line: ACCEPT or REJECT.'
                },
                {
                    role: 'user',
                    content: `Statement:\n${statement}\n\nProof:\n${proofScript}`
                }
            ]);
            const verdict = parseCriticVerdict(response.text);
            if (verdict) {
                base.llmVerdict = verdict;
                if (verdict === 'reject') {
                    base.verdict = 'reject';
                    base.ok = false;
                    base.findings.push({ severity: 'warn', code: 'LLM_REJECT', message: 'the critic LLM rejected the proof' });
                } else {
                    base.findings.push({ severity: 'info', code: 'LLM_ACCEPT', message: 'the critic LLM accepted the proof' });
                }
            }
        } catch {
            // deterministic verdict stands if the LLM pass fails
        }
        return base;
    }
}
