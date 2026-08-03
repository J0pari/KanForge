// Complex proof targets requiring multi-step decomposition
export const COMPLEX_PROBLEMS = [
    {
        id: 'pow_add',
        tier: 4,
        family: 'induction',
        statement: 'example (a m n : Nat) : a ^ (m + n) = a ^ m * a ^ n := by sorry',
        context: 'Prove by induction on n. Base: a^(m+0) = a^m * a^0 = a^m * 1. Step: a^(m+n+1) = a^(m+n) * a = (a^m * a^n) * a = a^m * (a^n * a) = a^m * a^(n+1).'
    },
    {
        id: 'mul_comm',
        tier: 4,
        family: 'induction',
        statement: 'example (m n : Nat) : m * n = n * m := by sorry',
        context: 'Prove by induction on n. Base: m * 0 = 0 = 0 * m. Step: m * (n+1) = m * n + m = n * m + m = (n+1) * m. Requires helper lemma: m * (n+1) = m * n + m.'
    },
    {
        id: 'add_assoc',
        tier: 3,
        family: 'induction',
        statement: 'example (a b c : Nat) : (a + b) + c = a + (b + c) := by sorry',
        context: 'Prove by induction on c. Base: (a+b)+0 = a+b = a+(b+0). Step: (a+b)+(c+1) = ((a+b)+c)+1 = (a+(b+c))+1 = a+((b+c)+1) = a+(b+(c+1)).'
    }
];
