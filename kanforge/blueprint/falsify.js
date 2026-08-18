// Falsification gate: before any tactic search touches a candidate lemma, the pipeline asks
// whether the candidate is even TRUE. A bridging lemma that is false (a hallucinated
// construction, an over-universal claim) is the most expensive class of failure the system
// can make — proof search cannot detect it, only counterexamples can.
//
// The mechanism is kernel-grounded, never trust-based:
//   1. The LLM is asked for concrete falsifying INSTANCES (small assignments), not judgments —
//      its role is candidate generation only.
//   2. Each instance is a Lean decidable example (`example : <negated instance> := by decide`
//      or the equivalent conjunction); the kernel verifies each.
//   3. A single verified counterexample instance marks the candidate FALSIFIED — the skeleton
//      drops it and retries the decomposition with the counterexample as evidence.
//
// Gate scope: only statements that CAN have a computable counterexample get probed —
// universally quantified claims over Nat (≠, =, <, mod, Even/Odd/Prime predicates). Pure
// existential or definitional stubs skip the gate.

// Statements worth probing: a universal quantifier over Nat whose body is a decidable-looking
// arithmetic predicate. Conservative: skip if no ∀ over Nat at all.
export function isFalsifiableStatement(statement) {
    const text = String(statement ?? '');
    const decl = text.split('\n').filter(l => !/^\s*import\s+\S/.test(l)).join(' ');
    const hasUniversal = /∀[^)]*:\s*(Nat|ℕ)/.test(decl) || /\(.*?:\s*(Nat|ℕ)\s*\)/.test(decl);
    if (!hasUniversal) return false;
    return /≠|≠|%\s*=|Even|Odd|Prime|2 \^| \* | \+ | - /.test(decl);
}

export function buildFalsificationPrompt(statement) {
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 proof engineer performing BOUNDED COUNTEREXAMPLE SEARCH. Given a universal claim, produce up to 6 CONCRETE small-value assignments that could falsify it, each as a Lean example that `decide` can check. Rules:\n' +
                '- Use the SMALLEST plausible values first (0, 1, 2, 3, 4).\n' +
                '- Each instance must be a decidable proposition over concrete numbers: `example : <concrete negated or equality claim> := by decide`.\n' +
                '- The instance must make the original claim FALSE if it typechecks (e.g., for `∀ k, f k ≠ g k`, an instance `example : f 0 = g 0 := by decide`).\n' +
                '- Conjunctions like `Nat.Prime 2 ∧ (4 : Nat) = 2 + 2 ^ 0 + 2 ^ 0` are decidable — prefer them when primality matters.\n' +
                '- Return ONLY the example lines, one per line, no prose, no markdown fences.'
        },
        {
            role: 'user',
            content: `Find concrete counterexample instances (if any) for this claim:\n\n${statement}\n\nReturn the example lines.`
        }
    ];
}

// Extract decidable example snippets from an LLM response.
export function parseFalsificationInstances(text, { maxInstances = 6 } = {}) {
    const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
        const m = line.match(/^example\s*:([\s\S]+?):=\s*by\s*decide\s*$/);
        if (!m) continue;
        const claim = m[1].trim();
        if (!claim || /sorry|admit/.test(claim)) continue;
        out.push(claim);
        if (out.length >= maxInstances) break;
    }
    return out;
}

// Falsify a candidate statement: LLM proposes concrete instances; the kernel verifies each.
// Returns { falsified, counterexample, checked } — falsified only on kernel evidence.
export async function falsifyCandidate(statement, { llm, backend, maxInstances = 6 } = {}) {
    if (!isFalsifiableStatement(statement)) {
        return { falsified: false, counterexample: null, checked: 0, skipped: 'not-falsifiable-shape' };
    }
    let response;
    try {
        response = await llm.complete(buildFalsificationPrompt(statement));
    } catch (err) {
        return { falsified: false, counterexample: null, checked: 0, error: `llm: ${err?.message ?? err}` };
    }
    const instances = parseFalsificationInstances(response?.text, { maxInstances });
    if (!instances.length) {
        return { falsified: false, counterexample: null, checked: 0 };
    }
    const imports = String(statement).split(/\r?\n/).filter(l => /^\s*import\s+\S/.test(l)).join('\n');
    let checked = 0;
    for (const claim of instances) {
        const src = `${imports}${imports ? '\n\n' : ''}example : ${claim} := by decide`;
        checked++;
        try {
            const r = await backend.check(src, { useWarmEnv: false });
            if (r.status === 'verified') {
                return { falsified: true, counterexample: claim, checked };
            }
        } catch {
            // a check that errors (not rejects) carries no evidence either way
        }
    }
    return { falsified: false, counterexample: null, checked };
}
