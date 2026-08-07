// Multi-step goal-directed tier for the §5.4 ablation (build_order.md §5.4). Where the core set
// (smoke.js) and mathlib set (mathlibSmoke.js) are closable by ONE headline tactic, every problem
// here needs a 2-4 tactic CHAIN and has no trivial closer: `rfl`, `simp`, `omega`, `decide` and
// `assumption` all FAIL on the root goal (verified against the real kernel by
// bench/verifyStepSet.js). This is the "next difficulty step up" the P6 start gate demands: it
// sharpens the deterministic loop toward real multi-step lemma proofs before any RL, and it is
// exactly the regime where search (bfs/mcgs) can out-cost ranking (bestofn/swiss) because a
// greedy single-tactic model can no longer brute-force a one-liner.
//
// Each problem's `chain` is the golden path (the verifier replays it through the SAME
// egraph/open[0] discipline as the ablation drivers, then assembles the proof source and
// re-verifies it in the kernel). Runs over the core repl (no Mathlib imports needed — `rcases`,
// `constructor`, `rw`, `omega`, `Or.inl/inr` are all core Lean).
//
// Tiers: T4 logic decomposition (intro/rcases/exact/constructor chains), T5 rewrite chains +
// hypothesis composition. Families: rcases / intro / constructor / rw (headline tactic).

export const STEP_PROBLEMS = [
    // --- Tier 4: logic decomposition ---
    {
        id: 'or_elim', tier: 4, family: 'rcases',
        context: 'Disjunction elimination from a hypothesis: rcases h into the two cases, then exact each implication.',
        statement: 'example (p q r : Prop) (h : p ∨ q) (hp : p → r) (hq : q → r) : r := by sorry',
        chain: ['rcases h with hp0 | hq0', 'exact hp hp0', 'exact hq hq0']
    },
    {
        id: 'or_comm', tier: 4, family: 'rcases',
        context: 'Intro the implication, case-split the disjunction, then reorient with the constructors: inr for hp, inl for hq.',
        statement: 'example (p q : Prop) : p ∨ q → q ∨ p := by sorry',
        chain: ['intro h', 'rcases h with hp | hq', 'exact Or.inr hp', 'exact Or.inl hq']
    },
    {
        id: 'and_intro_chain', tier: 4, family: 'constructor',
        context: 'Conjunction of implications: split the goal with constructor, then exact h hp and exact h2 hp.',
        statement: 'example (p q r : Prop) (h : p → q) (h2 : p → r) (hp : p) : q ∧ r := by sorry',
        chain: ['constructor', 'exact h hp', 'exact h2 hp']
    },
    {
        id: 'imp_trans', tier: 4, family: 'intro',
        context: 'Transitivity of implication: intro the three hypotheses, then compose hpq and hqr.',
        statement: 'example (p q r : Prop) : (p → q) → (q → r) → p → r := by sorry',
        chain: ['intro hpq', 'intro hqr', 'intro hp', 'exact hqr (hpq hp)']
    },
    {
        id: 'modus_tollens', tier: 4, family: 'intro',
        context: 'Modus tollens: intro the implication, the negated conclusion, and the hypothesis, then derive False from the clash.',
        statement: 'example (p q : Prop) : (p → q) → ¬q → ¬p := by sorry',
        chain: ['intro h', 'intro hnq', 'intro hp', 'exact hnq (h hp)']
    },

    // --- Tier 5: rewrite chains + hypothesis composition ---
    {
        id: 'distrib_twice', tier: 5, family: 'rw',
        context: 'Distribution over two sums: rw Nat.add_mul, two rw Nat.mul_add steps (Lean 4 rw rewrites one occurrence at a time), then omega to reassociate addition. omega alone fails (nonlinear); simp does not distribute.',
        statement: 'example (a b c d : Nat) : (a + b) * (c + d) = a * c + a * d + b * c + b * d := by sorry',
        chain: ['rw [Nat.add_mul]', 'rw [Nat.mul_add]', 'rw [Nat.mul_add]', 'omega']
    },
    {
        id: 'square_expand', tier: 5, family: 'rw',
        context: 'Square expansion over Nat without ring: rw Nat.add_mul, two rw Nat.mul_add steps, then omega. The exact Nat/Int analogue of ring_square with no tactic import.',
        statement: 'example (a b : Nat) : (a + b) * (a + b) = a * a + a * b + b * a + b * b := by sorry',
        chain: ['rw [Nat.add_mul]', 'rw [Nat.mul_add]', 'rw [Nat.mul_add]', 'omega']
    },
    {
        id: 'mul_comm_rw', tier: 5, family: 'rw',
        context: 'Use the commuted product hypothesis: rewrite the goal with Nat.mul_comm, then close by exact h.',
        statement: 'example (a b c : Nat) (h : a * b = c) : b * a = c := by sorry',
        chain: ['rw [Nat.mul_comm]', 'exact h']
    },
    {
        id: 'func_compose', tier: 5, family: 'rw',
        context: 'Rewrite through two function hypotheses: rw hf then rw hg. Lean 4 rw automatically closes definitionally-equal goals via rfl. omega cannot (function applications are atoms).',
        statement: 'example (f g : Nat → Nat) (hf : ∀ x, f x = x + 1) (hg : ∀ x, g x = x) (n : Nat) : f (g n) = n + 1 := by sorry',
        chain: ['rw [hf]', 'rw [hg]']
    },
    {
        id: 'eq_trans_chain', tier: 5, family: 'rw',
        context: 'Transitivity via two rewrite hypotheses: rw hfg then rw hgh, closing definitionally via rfl.',
        statement: 'example (f g h : Nat → Nat) (hfg : ∀ x, f x = g x) (hgh : ∀ x, g x = h x) (n : Nat) : f n = h n := by sorry',
        chain: ['rw [hfg]', 'rw [hgh]']
    }
];

export const STEP_FAMILIES = ['rcases', 'intro', 'constructor', 'rw'];
