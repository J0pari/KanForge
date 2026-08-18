// Mission-shaped problem set for the ablation harness: real corpus targets run as single-cell
// loop attempts. The root theorem carries its imports — the loop's extractGoals opens a leased
// session with them, exactly like a blueprint root. Cells measure pass rate + cost per recipe
// and component mask on the REAL mission, not a harness problem.
// Source: corpus/index/corpus.json — the Erdős-10 variant statement (the solved "infinitely
// many even integers not a prime plus two powers of 2" formalization from
// google-deepmind/formal-conjectures, file ErdosProblems/10.lean, `erdos_10.variants.two_pows`).
export const MISSION_PROBLEMS = [
    {
        id: 'erdos10-variant-two-pows',
        tier: 'mission',
        statement: [
            'import Mathlib.Algebra.Group.Even',
            'import Mathlib.Data.Nat.Prime.Defs',
            'import Mathlib.Data.Set.Finite.Basic',
            '',
            'theorem not_sum_prime_two_powers_of_two_infinite : Set.Infinite { n : Nat | Even n ∧ ∀ p a b : Nat, Nat.Prime p → n ≠ p + 2 ^ a + 2 ^ b } := by sorry'
        ].join('\n')
    }
];
