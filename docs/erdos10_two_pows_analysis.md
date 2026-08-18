# erdos10-two-pows: concrete DAG mapping — attempted vs correct

Status: analysis only. No mission is running. This document compares the exact composition
of the attempted DAG (the archived `erdos10-variant-two-pows` run) against the concrete lemma
structure of the known proof, and traces the denominator explosion to its mechanisms.

## 1. The known proof, precisely

Crocker, Pacific J. Math. 36 (1971) 103–107, Theorem I: infinitely many odd n are not of the
form p + 2^a + 2^b (p prime). The mechanism (stated in Pan, arXiv:0905.3809):

- **Fermat divisibility.** If b − a = 2^s · t with t odd, then
  2^a + 2^b = 2^a (1 + 2^{2^s t}), and 2^{2^s} + 1 divides 1 + 2^{2^s t} (x + 1 | x^t + 1 for t
  odd). So F_s := 2^{2^s} + 1 divides 2^a + 2^b.
- **The construction.** Choose n ≡ 0 (mod F_0 F_1 F_2 F_3 F_4) (using the prime Fermat numbers
  3, 5, 17, 257, 65537 — pairwise coprime) with n large, and odd. For a ≠ b: p = n − 2^a − 2^b
  ≡ 0 (mod F_s) for the s from b − a; since n is large, p = F_s is impossible (p must be
  divisible by F_s and exceed it, or — in the coprime-product form — p is divisible by every
  F_i, forcing p ≥ ∏ F_i, a contradiction with p = F_s); hence p is composite. For a = b:
  2^a + 2^b = 2^{a+1}, handled by a covering system over the single-power case.
- The residue class {n : n ≡ r (mod 2·∏F_s)} is infinite, so the set is infinite.

## 2. The correct DAG, as this pipeline would state it

Layer A — arithmetic substrate (each a plain Nat lemma, library-reusable):

    A1  x_add_one_dvd_x_pow_odd_add_one   : ∀ x t : Nat, Odd t → x + 1 ∣ x ^ t + 1
    A2  fermat_divides_pow_two_sum        : ∀ s a t : Nat, Odd t → F_s ∣ (2 ^ (2 ^ s * t) + 1)
    A3  two_pow_sum_congr_fermat          : ∀ a b s t : Nat, b = a + 2 ^ s * t → Odd t → F_s ∣ (2 ^ a + 2 ^ b)
    A4  fermat_pairwise_coprime           : ∀ s r : Nat, s ≠ r → Nat.Coprime (F_s) (F_r)
    A5  prime_dvd_fermat_product_bound    : (forces p ≥ ∏F_s when each F_i | p)
    A6  quotient_gt_one_composite         : ∀ q m : Nat, 1 < q → q ∣ m → 1 < m / q → ¬ Nat.Prime m
    A7  residue_class_infinite            : ∀ r M : Nat, Set.Infinite { n : Nat | n ≡ r [MOD M] }

Layer B — the construction (Crocker's theorem, the odd side):

    B1  fermat_class_avoids_two_pow_sum   : ∀ a b m : Nat, a ≠ b → ∃ s, F_s ∣ (m · P − 2 ^ a − 2 ^ b)
        (P = F_0·F_1·F_2·F_3·F_4; m · P is the family)
    B2  equal_powers_covered              : the a = b clause (single-power covering)
    B3  crocker_family_not_representable  : ∀ m ≥ 1, ¬ ∃ p a b, Nat.Prime p ∧ m·P = p + 2^a + 2^b
    B4  crocker_family_infinite           : Set.Infinite { n | ∃ m, n = m·P }
    B5  odd_integers_not_pp_infinite      : Set.Infinite { n : Nat | Odd n ∧ ¬∃ p a b, Nat.Prime p ∧ n = p + 2^a + 2^b }

Layer C — the even variant (mission statement):

    C1  even_variant (parallel congruence construction or parity reduction)

Total: about 12–14 lemmas, three layers, one residue-class construction.

## 3. The attempted DAG, measured

From the archived checkpoint (428 lemmas, 821 rounds):

**Global shape.**

- 428 lemmas; 199 proved; 422 children added across re-splits.
- **267 distinct normalized conclusions — 161 lemmas are duplicates of another lemma.**
  72 conclusions occur more than once; the tail: one conclusion appears in 23 lemmas, one in
  15, three in 6, two in 5. Roughly 38% of the entire DAG is the same handful of facts
  restated.

**Family composition (total / proved):**

    add/succ-cluster   126 /  54     — variants of x+0, succ, +1 facts
    mul-cluster         68 /  32     — variants of x*2, 2*x, x+x, distributivity
    mod-cluster         57 /  29     — the mod-3 red herring + residue facts
    order/pos-cluster   48 /  14     — 2^n < 2^(n+1) and positivity variants
    twopow_*            36 /  24
    pow_*               24 /   8
    two_pow_*           24 /  15
    critical-path        1 /   0     — exactly one lemma named on the root chain

**The critical path is 4 lemmas deep and entirely unproved:**

    two_pow_two_pow_ne_sum          (the FALSE bridge; deps=3)
      └─ two_pow_two_pow_mem_target (deps=2)
           └─ subset_two_pow_two_pow_target (deps=1)
                └─ not_sum_prime_two_powers_of_two_infinite (ROOT, deps=2)

plus `two_pow_two_pow_family_infinite` (deps=1) hanging beside it. The false bridge has a
transitive subtree of only 3 — the other ~420 lemmas are the arithmetic swamp feeding these
few lemmas' dependency lists.

**Denominator explosion — the churn table (resplit-rounds per lemma):**

    nat_add_zero_id        x17     (x + 0 = x — provable by rfl)
    x_plus_zero_eq_x       x9
    twopow_succ_eq_twice   x7
    four_mod_three_eq_one  x5
    nat_zero_add           x4
    twomod3_four           x4
    x_add_x_eq_two_mul     x4
    nat_mul_one_eq         x4
    nat_two_pow_one        x4
    self_add_zero_eq       x4
    twopow_pow_one         x4
    one_le_imp_pos_nat     x4

Every one of these is a trivial or one-step arithmetic fact. Each failed round on one of them
triggered a skeleton re-split, and each re-split emitted more near-duplicate children. The
top-churned lemma — `x + 0 = x` — was re-split 17 times. That single fact, its 9-times-churned
sibling, and their spawned children account for a large share of the 422 added children. The
denominator exploded because the system re-split TRIVIAL lemmas it should have closed with
`rfl`, under the environment-churn conditions, and because nothing capped the depth of
re-splitting a single sterile fact.

## 4. The precise dead-end taxonomy

1. **False bridge (fatal, strategic).** `two_pow_two_pow_ne_sum` is false at k=0. It typechecked,
   so the whole run organized around a false goal; its 4-lemma critical path absorbed every
   attempt while the periphery proved.
2. **Trivial-fact churn (dominant denominator driver).** 12 lemmas, all one-step facts,
   re-split ≥4 times each; `x + 0 = x` re-split 17 times. These are not hard math — they are
   environment-thrash victims re-split into more variants of themselves.
3. **Duplication swamp.** 161 duplicate lemmas across 72 conclusion clusters (worst: 23 and 15
   variants of one conclusion). The mod-3 cluster alone is 57 lemmas for what is, in the true
   proof, one Fermat-divisibility lemma of a different modulus entirely.
4. **Wrong-modulus red herring.** The mod-3 work (57 lemmas) was necessary-for-the-wrong-family,
   mistaken for an obstruction. The true proof's modulus structure is the Fermat numbers
   F_s = 2^{2^s}+1 — a residue-class construction the run never approached, because the
   skeleton's family-identity decomposition shape never suggested obstruction patterns.

## 5. What the run should have looked like, and what would have forced it

The correct run on the odd-side theorem is ~12–14 lemmas: A1–A7 (all provable by
`omega`/`norm_num`/`exact` plus one divisibility rewrite), B1–B5 (the construction), C1. The
attempted run produced 428.

The mechanisms now in place that would have forced the efficient route:

- **Falsification gate**: the false bridge dies at skeleton time (k=0 counterexample), so the
  decomposition never organizes around it. This is the single most consequential fix.
- **Re-split budget + parking**: a lemma re-split 3 times without progress is parked; the 17x
  churn on `x + 0 = x` cannot happen.
- **Canonicalization**: one canonical fact per normalized conclusion; the 161 duplicates stop
  accumulating (reuse serves the canonical entry).
- **Pertinence audit per pass**: the 4-lemma critical path vs. 420-lemma swamp reads as an
  explicit orphan/pertinence report instead of an abstract proved-count.
- **Failure taxonomy**: environment-thrash failures on trivial lemmas are labeled
  infrastructure, not math — the "hard arithmetic" reading that justified re-splitting
  `x + 0 = x` disappears.
- **Skeleton shape guidance** (added): the admissible Set.Infinite patterns include the
  obstruction/residue-class construction, which the true proof uses.

The one thing deliberately not encoded: the Fermat-number construction itself. The skeleton
must discover it; the gate's job is to kill wrong constructions cheaply — a false family dies
in one probe instead of 400 rounds.
