// Curated premise corpus for the §5.2 premise-retrieval ablation (build_order.md §5.2).
//
// The repl cannot enumerate Mathlib theorems ("You can only use import commands when you do not
// specify the env field" — no theorem-listing command), so until a real corpus exists the
// ablation runs against a hand-curated set of Nat arithmetic identities. Every entry matches
// the PremiseRetriever contract: `{ name, type }`.
//
// Deliberately token-heavy: `Nat.mul_add`, `Nat.add_mul`, `Nat.mul_assoc` all share the
// variables a/b/c and the mul/add operator words, which is exactly the discrimination problem
// lexical BM25 has on structurally-similar lemmas (observed: BM25 ranks Nat.mul_add #4 for its
// own goal). The premise-LOCK channel, not the ranking, is what makes the "with" side
// information-carrying.

export const PREMS_MATHLIB_1 = [
    { name: 'Nat.mul_add', type: '(a b c : Nat) -> a * (b + c) = a * b + a * c' },
    { name: 'Nat.add_mul', type: '(a b c : Nat) -> (a + b) * c = a * c + b * c' },
    { name: 'Nat.mul_comm', type: '(a b : Nat) -> a * b = b * a' },
    { name: 'Nat.mul_assoc', type: '(a b c : Nat) -> (a * b) * c = a * (b * c)' },
    { name: 'Nat.add_comm', type: '(a b : Nat) -> a + b = b + a' },
    { name: 'Nat.add_assoc', type: '(a b c : Nat) -> (a + b) + c = a + (b + c)' },
    { name: 'Nat.zero_add', type: '(a : Nat) -> 0 + a = a' },
    { name: 'Nat.add_zero', type: '(a : Nat) -> a + 0 = a' },
    { name: 'Nat.mul_zero', type: '(a : Nat) -> a * 0 = 0' },
    { name: 'Nat.mul_one', type: '(a : Nat) -> a * 1 = a' },
    { name: 'Nat.succ_ne_zero', type: '(n : Nat) -> Nat.succ n != 0' },
    { name: 'Nat.succ_add', type: '(n m : Nat) -> Nat.succ n + m = Nat.succ (n + m)' },
    { name: 'Nat.mul_succ', type: '(n m : Nat) -> n * Nat.succ m = n * m + n' },
    { name: 'Nat.add_sub_cancel', type: '(a b : Nat) -> a + b - b = a' }
];

// Lock-enforcement control: same corpus WITHOUT Nat.mul_add. Premise-locked mode must FAIL on
// mul_add_distr here even though the model knows Nat.mul_add from training — proving the lock
// actually constrains the generator and is not cosmetic.
export const PREMS_MATHLIB_1_NO_MUL_ADD = PREMS_MATHLIB_1.filter(p => p.name !== 'Nat.mul_add');

export const PREMISE_CORPORA = {
    full: PREMS_MATHLIB_1,
    'no-mul-add': PREMS_MATHLIB_1_NO_MUL_ADD
};
