// Mathlib smoke set for the P0.1+ gate (build_order.md §5.1/§5.2). The `import Mathlib` full
// corpus costs minutes per repl process, so every problem imports the specific Mathlib modules
// it needs (verified against v4.33.0-rc1). Mathlib-only tactics — ring, linarith, norm_num,
// positivity, field_simp, tauto — are exercised here; the core-only set lives in `smoke.js`
// (`--set=core`). Every problem is a well-typed `:= by sorry` stub provable by its `family`
// tactic. Tiers escalate: T1 ring over Nat/Int, T2 linarith, T3 norm_num/decide, T4 Real, T5
// harder.

export const MATHLIB_PROBLEMS = [
    // --- Tier 1: ring over Nat / Int ---
    {
        id: 'ring_distrib', tier: 1, family: 'ring',
        context: 'Polynomial identity over Nat. `ring` closes it in one step.',
        statement: 'import Mathlib.Tactic.Ring\n\nexample (a b c : Nat) : (a + b) * c = a * c + b * c := by sorry'
    },
    {
        id: 'ring_square', tier: 1, family: 'ring',
        context: 'Square expansion over Int. `ring` closes it in one step.',
        statement: 'import Mathlib.Tactic.Ring\n\nexample (a b : Int) : (a + b) * (a + b) = a * a + 2 * a * b + b * b := by sorry'
    },

    // --- Tier 2: linarith over Int ---
    {
        id: 'linarith_eq', tier: 2, family: 'linarith',
        context: 'Linear arithmetic with bounds: x ≤ y + 1 and y ≤ x - 1 force x = y + 1. `linarith` closes it.',
        statement: 'import Mathlib.Tactic.Linarith\n\nexample (x y : Int) (h1 : x ≤ y + 1) (h2 : y ≤ x - 1) : x = y + 1 := by sorry'
    },
    {
        id: 'linarith_mono', tier: 2, family: 'linarith',
        context: 'Multiplication by a positive constant preserves strict inequality over Int. `linarith` closes it.',
        statement: 'import Mathlib.Tactic.Linarith\n\nexample (a b : Int) (h : a < b) : 2 * a < 2 * b := by sorry'
    },

    // --- Tier 3: norm_num / decide ---
    {
        id: 'norm_num_real', tier: 3, family: 'norm_num',
        context: 'Concrete rational arithmetic over the reals. `norm_num` computes both sides.',
        statement: 'import Mathlib.Data.Real.Basic\n\nimport Mathlib.Tactic.NormNum\n\nexample : (3:Real) / 2 + (1:Real) / 2 = 2 := by sorry'
    },
    {
        id: 'prime_decide', tier: 3, family: 'decide',
        context: 'Prime check: `decide` evaluates the (decidable) predicate `Nat.Prime 3`.',
        statement: 'import Mathlib.Data.Nat.Prime.Basic\n\nexample : Nat.Prime 3 := by sorry'
    },

    // --- Tier 4: Real arithmetic ---
    {
        id: 'real_sq_ring', tier: 4, family: 'ring',
        context: 'Square expansion over the reals. `ring` closes it.',
        statement: 'import Mathlib.Data.Real.Basic\n\nimport Mathlib.Tactic.Ring\n\nexample (a b : Real) : (a + b)^2 = a^2 + 2 * a * b + b^2 := by sorry'
    },
    {
        id: 'pos_sq_plus_one', tier: 4, family: 'positivity',
        context: 'A square plus one is strictly positive over the reals. `positivity` closes it.',
        statement: 'import Mathlib.Data.Real.Basic\n\nimport Mathlib.Tactic.Positivity\n\nexample (x : Real) : 0 < x ^ 2 + 1 := by sorry'
    },
    {
        id: 'real_mul_zero', tier: 4, family: 'simp',
        context: 'Zero absorption over the reals. `simp` closes it.',
        statement: 'import Mathlib.Data.Real.Basic\n\nexample (x : Real) : x * 0 = 0 := by sorry'
    },
    {
        id: 'real_div_self', tier: 4, family: 'field_simp',
        context: 'Field identity over the reals under a nonzero hypothesis. `field_simp` closes it.',
        statement: 'import Mathlib.Data.Real.Basic\n\nimport Mathlib.Tactic.FieldSimp\n\nexample (a : Real) (ha : a ≠ 0) : a / a = 1 := by sorry'
    },

    // --- Tier 5: harder ---
    {
        id: 'mul_add_distr', tier: 5, family: 'rw',
        context: 'Distribution over Nat requires a lemma: `simp`/`omega`/`ring` do NOT close it, only `exact Nat.mul_add a b c` or `rw [Nat.mul_add]`. Premise-retrieval ablation (§5.2) must surface `Nat.mul_add`.',
        statement: 'import Mathlib.Data.Nat.Basic\n\nexample (a b c : Nat) : a * (b + c) = a * b + a * c := by sorry'
    },
    {
        id: 'tauto_elim', tier: 5, family: 'tauto',
        context: 'Propositional tautology (disjunction elimination). `tauto` closes it.',
        statement: 'import Mathlib.Tactic.Tauto\n\nexample (p q r : Prop) : (p ∨ q) → (p → r) → (q → r) → r := by sorry'
    },
    {
        id: 'prime_two_lt', tier: 5, family: 'decide',
        context: 'Conjunction of an inequality and a prime check. `decide` closes it.',
        statement: 'import Mathlib.Data.Nat.Prime.Basic\n\nexample : 2 < 3 ∧ Nat.Prime 3 := by sorry'
    }
];
