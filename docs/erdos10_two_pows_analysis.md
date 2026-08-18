# erdos10-two-pows: proof mapping and architecture-shape analysis

Status: analysis only. No mission is running. This document records the mapping between the
known proof and the DAG the pipeline builds, the tactical/strategic defects the earlier run
exhibited, and which architecture mechanisms force the efficient route without the proof being
known to the system.

## 1. What the target actually is

Mission statement (the solved variant of Erdős #10, formal-conjectures
`ErdosProblems/10.lean`, `erdos_10.variants.two_pows`):

    Set.Infinite { n : Nat | Even n ∧ ¬ ∃ p a b : Nat, Nat.Prime p ∧ n = p + 2 ^ a + 2 ^ b }

The literature chain:

- Crocker, "On the sum of a prime and of two powers of two", Pacific J. Math. 36 (1971)
  103–107, Theorem I: infinitely many ODD positive integers are not representable as
  p + 2^a + 2^b (a, b > 0, p prime).
- The even statement follows by a parity reduction from the odd statement (the odd side is the
  substance; the even side is a derived set).
- Erdős #10 itself (an at-most-k-powers-of-2 basis question) is OPEN; the mission was never
  targeting it. The mission targets the solved variant.

## 2. The true proof mapped onto the DAG shape

The optimal derivation DAG has three layers:

    layer A (arithmetic substrate, library-reusable)
      - powers of 2 modulo small primes: 2^a mod q is periodic; {2^a + 2^b mod q} is a fixed
        finite residue set S_q per prime q.
      - size bound: n - 2^a - 2^b is strictly larger than the modulus it is congruent to 0
        modulo, hence composite (not prime) when the congruence holds.
    layer B (the obstruction construction — the hard middle)
      - a covering system: finitely many primes q_1..q_t and residue choices r such that every
        pair (a, b) is covered — i.e. for every a, b, 2^a + 2^b ≡ some fixed value mod some q_i
        under the residue restriction; so n ≡ r_i mod q_i forces n - 2^a - 2^b ≡ 0 mod q_i.
      - the family lemma: n(m) = r + m·M (M = product of the q_i) satisfies the obstruction
        for all m; the set is infinite.
    layer C (parity + subset glue)
      - the odd set (layer B) is infinite;
      - an explicit parity map embeds (a tail of) the odd set into the even set;
      - the even set is therefore infinite.

Key structural facts the earlier run's DAG got wrong:

- Its bridge lemma (`two_pow_two_pow_ne_sum`) asserted a FAMILY (2^(2^(k+1))) avoids the
  representation, which is false at k = 0 (4 = 2 + 2^0 + 2^0). A family-identity proof and a
  covering-obstruction proof are different proof SHAPES; the skeleton chose the wrong shape
  and nothing in the pipeline distinguished them.
- Its mod-3 work was a necessary congruence of the chosen family, treated as an obstruction.
  A necessary condition is not an obstruction; the covering system needs ALL residues
  covered, which a single modulus can never do.

## 3. Tactical and strategic defects of the earlier run

Strategic:

1. No falsification gate: the false bridge typechecked and received hundreds of proof-search
   rounds. (Fixed: blueprint/falsify.js gates every candidate lemma with kernel-verified
   counterexample search before any tactic attempt.)
2. No intake instance ledger: the mission entered with zero probes, so the first concrete
   counterexample (4) was never checked at intake. (Fixed: fail-closed probes gate in
   blueprint/run.js; blueprint/probes.js generates the ledger from the source's own test
   theorems.)
3. No critical-path visibility: global proved-count grew while the root-connected frontier was
   blocked, which made the run look healthy. (Fixed: the gap-annotated assembly reports the
   root-connected pertinence audit per pass, and the failure taxonomy separates math/search/
   infrastructure failures.)

Tactical:

4. Unbounded breadth under a false hypothesis: re-splits kept generating children of a false
   bridge. (Fixed: dynamic re-split budget, parked sterile subtrees, orphan pruning.)
5. Knowledge fragmentation: dozens of variants of the same arithmetic facts. (Fixed: store
   canonicalization — shortest-proof entry wins per normalized conclusion and at equal
   retrieval score.)
6. Library-interface hallucination (e.g. a nonexistent `pow_right_injective`). (Fixed:
   unknown-identifier harvest and veto, premise corpus with kernel-grounded names, and
   replay-first reuse of verified local lemmas over speculative identifiers.)
7. Infrastructure failures indistinguishable from mathematical failures. (Fixed: failure
   taxonomy in the per-pass KPIs.)

## 4. Which architecture shape forces the efficient route without knowing the proof

For each defect, the mechanism that would have redirected the run:

- Falsification gate: the false bridge dies at skeleton time with a kernel-verified
  counterexample; the decomposition retries with that evidence instead of proving a falsehood.
- Instance ledger: the family claim's first counterexample is a probe, checked before the DAG
  exists.
- Pertinence audit: a stalled bridge with a proved periphery reads as exactly that — the pass
  report shows root-connectivity, not a global count.
- Re-split budget: a sterile subtree stops growing; effort moves to other ready lemmas.
- Reuse/transfer over verified local lemmas: the arithmetic substrate of layer A accumulates
  ONCE and is reused, so the layer-B attempt starts from a canonical substrate rather than
  re-deriving variants.

One shape-guidance element is now part of the skeleton's generic prompt (not problem-specific):
decompositions should prefer (a) explicit maps from known-infinite sets, or (b) obstruction
constructions with an actual covering argument, over unvalidated family identities — the
skeleton system prompt lists these as the admissible infinitude proof patterns.

The one thing deliberately NOT done: the covering system itself is not encoded anywhere. The
skeleton must discover it, and the falsification gate is what distinguishes a working covering
system from another dead family. The architecture's job is to make wrong constructions cheap
and visible, not to know the right one.

## 5. Current mission state

- The `erdos10-variant-two-pows` run directory is archived (its DAG contains the false bridge;
  it is evidence, not an active mission).
- A correctly-labeled mission directory `erdos9-variant-infinite` exists (Crocker's odd-side
  theorem: infinitely many ODD integers not p + 2^a + 2^b), whose probes ledger is pending
  generation — the intake gate will refuse to run it until the probes exist and verify.
- Nothing is running.
