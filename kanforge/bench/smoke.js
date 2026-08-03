// miniF2F-style smoke set for the P0–P1 gate (build_order.md §1.2, 20-problem provisional target).
// Runs over the REAL repl binary, whose environment is core Lean + Std (no Mathlib): omega over
// Nat/Int, simp, rw, rcases/cases, induction, constructor, native_decide are available; Mathlib
// tactics (ring, linarith, nlinarith, norm_num, field_simp, tauto) are NOT. Every problem is a
// well-typed `:= by sorry` stub whose statement genuinely needs a proof (never closed by rfl).
// Tiers escalate: T1 linear omega, T2 logic, T3 functions/induction, T4 harder / ceiling.

export const SMOKE_PROBLEMS = [
    // --- Tier 1: linear arithmetic (omega) ---
    { id: 'trans_lt', tier: 1, family: 'omega', statement: 'example (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry' },
    { id: 'add_double', tier: 1, family: 'omega', statement: 'example (n : Nat) : n + n = 2 * n := by sorry' },
    { id: 'add_mono', tier: 1, family: 'omega', statement: 'example (a b c : Nat) (h : a ≤ b) : a + c ≤ b + c := by sorry' },
    { id: 'nat_sub', tier: 1, family: 'omega', statement: 'example (m n : Nat) : m + n - n = m := by sorry' },
    { id: 'int_sub', tier: 1, family: 'omega', statement: 'example (x y : Int) : x - y = x + -y := by sorry' },
    { id: 'le_antisymm', tier: 1, family: 'omega', statement: 'example (a b : Nat) (h1 : a ≤ b) (h2 : b ≤ a) : a = b := by sorry' },
    { id: 'add_comm', tier: 1, family: 'omega', statement: 'example (m n : Nat) : m + n = n + m := by sorry' },

    // --- Tier 2: propositional logic ---
    { id: 'and_comm', tier: 2, family: 'rcases', statement: 'example (p q : Prop) (h : p ∧ q) : q ∧ p := by sorry' },
    { id: 'modus_ponens', tier: 2, family: 'exact', statement: 'example (p q r : Prop) (hp : p) (h : p → q) (h2 : q → r) : r := by sorry' },
    { id: 'em', tier: 2, family: 'by_cases', statement: 'example (p : Prop) : p ∨ ¬p := by sorry' },
    { id: 'contraposition', tier: 2, family: 'intro', statement: 'example (p q : Prop) : (p → q) → (¬q → ¬p) := by sorry' },

    // --- Tier 3: functions, congruence, induction ---
    { id: 'congr_fun', tier: 3, family: 'rw', statement: 'example (f g : Nat → Nat) (h : f = g) (x : Nat) : f x = g x := by sorry' },
    { id: 'func_iter', tier: 3, family: 'simp', statement: 'example (f : Nat → Nat) (hf : ∀ x, f x = x) : f (f 1) = 1 := by sorry' },
    { id: 'add_zero', tier: 3, family: 'induction', statement: 'example (n : Nat) : n + 0 = n := by sorry' },
    { id: 'pow_one', tier: 3, family: 'induction', statement: 'example (n : Nat) : 1 ^ n = 1 := by sorry' },
    { id: 'zero_or_pos', tier: 3, family: 'rcases', statement: 'example (x : Nat) : x = 0 ∨ x ≠ 0 := by sorry' },

    // --- Tier 4: harder / ceiling ---
    { id: 'mul_mono', tier: 4, family: 'omega', statement: 'example (a b : Nat) (h : a ≤ b) : a * 2 ≤ b * 2 := by sorry' },
    { id: 'le_of_lt', tier: 4, family: 'exact', statement: 'example (n m : Nat) (h : n < m) : n ≤ m := by sorry' },
    { id: 'add_cancel', tier: 4, family: 'omega', statement: 'example (a b c : Nat) (h : a + c ≤ b + c) : a ≤ b := by sorry' },
    {
        id: 'lt_pow_two', tier: 4, family: 'induction',
        tags: ['induction', 'arithmetic'],
        context: 'Prove by induction on n. Base n = 0: 0 < 2^0 reduces to 0 < 1 (omega). Step: assume n < 2^n; need n + 1 < 2^(n+1). Use `rw [pow_succ]` (or `pow_add`) to arithmetize 2^(n+1) = 2 * 2^n, then omega closes n + 1 < 2 * 2^n from the induction hypothesis.',
        statement: 'example (n : Nat) : n < 2 ^ n := by sorry'
    },

    // --- Tier 5: complex multi-step induction ---
    {
        id: 'pow_add', tier: 5, family: 'induction',
        tags: ['induction', 'arithmetic', 'multi-step'],
        context: 'Prove by induction on n. Base: a^(m+0) = a^m * a^0 = a^m * 1. Step: a^(m+n+1) = a^(m+n) * a = (a^m * a^n) * a = a^m * (a^n * a) = a^m * a^(n+1).',
        statement: 'example (a m n : Nat) : a ^ (m + n) = a ^ m * a ^ n := by sorry'
    },
    {
        id: 'mul_comm', tier: 5, family: 'induction',
        tags: ['induction', 'arithmetic', 'multi-step'],
        context: 'Prove by induction on n. Base: m * 0 = 0 = 0 * m. Step: m * (n+1) = m * n + m = n * m + m = (n+1) * m. Requires helper lemma: m * (n+1) = m * n + m.',
        statement: 'example (m n : Nat) : m * n = n * m := by sorry'
    },
    {
        id: 'add_assoc', tier: 5, family: 'induction',
        tags: ['induction', 'arithmetic'],
        context: 'Prove by induction on c. Base: (a+b)+0 = a+b = a+(b+0). Step: (a+b)+(c+1) = ((a+b)+c)+1 = (a+(b+c))+1 = a+((b+c)+1) = a+(b+(c+1)).',
        statement: 'example (a b c : Nat) : (a + b) + c = a + (b + c) := by sorry'
    }
];

// Heuristic: which tactic family does a produced proof lean on (for the per-family report).
// First tactic to appear in the proof text wins, so `rcases h with ⟨k, hk⟩; omega` classifies as
// rcases and `induction n with ...; omega` as induction, while a bare `omega` stays omega.
const TACTIC_ORDER = [
    'aesop', 'nlinarith', 'linarith', 'ring_nf', 'field_simp', 'positivity', 'norm_num', 'tauto',
    'by_contra', 'by_cases', 'native_decide', 'rcases', 'rintro', 'constructor', 'cases', 'induction',
    'have', 'simpa', 'simp', 'rw', 'refine', 'apply', 'exact', 'intro', 'contradiction', 'assumption',
    'decide', 'omega'
];

export function tacticFamily(proof) {
    const p = String(proof ?? '').trim();
    if (!p) return 'empty';
    let best = null;
    let bestIdx = Infinity;
    for (const t of TACTIC_ORDER) {
        const m = new RegExp(`\\b${t}\\b`).exec(p);
        if (m && m.index < bestIdx) {
            best = t;
            bestIdx = m.index;
        }
    }
    return best ?? 'other';
}

export function validateSmokeSet(problems = SMOKE_PROBLEMS) {
    for (const p of problems) {
        if (typeof p.id !== 'string' || !p.statement) throw new Error(`smoke problem ${JSON.stringify(p.id)} malformed`);
        if (!/:= by sorry\s*$/.test(p.statement.trim())) {
            throw new Error(`smoke problem ${p.id} must be a ':= by sorry' stub: ${p.statement}`);
        }
        if (![1, 2, 3, 4, 5].includes(p.tier)) throw new Error(`smoke problem ${p.id} has invalid tier`);
        if (p.context !== undefined && typeof p.context !== 'string') {
            throw new Error(`smoke problem ${p.id} context must be a string`);
        }
        if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some(t => typeof t !== 'string'))) {
            throw new Error(`smoke problem ${p.id} tags must be an array of strings`);
        }
    }
}
