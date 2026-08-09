# Erdős Problem #3 — verbatim source (https://www.erdosproblems.com/3)

- Site: erdosproblems.com, curated by T. F. Bloom; database: teorth/erdosproblems (Apache-2.0)
- Status: OPEN, prize $5000
- Tags: number theory, additive combinatorics, arithmetic progressions
- OEIS: A003002, A003003, A003004, A003005
- DeepMind formalization: https://github.com/google-deepmind/formal-conjectures/blob/main/FormalConjectures/ErdosProblems/3.lean
- Citation: T. F. Bloom, Erdős Problem #3, https://www.erdosproblems.com/3, accessed 2026-08-09

## Statement (verbatim LaTeX from /latex/3)

If $A\subseteq \mathbb{N}$ has $\sum_{n\in A}\frac{1}{n}=\infty$ then must $A$ contain arbitrarily
long arithmetic progressions?

## Discussion (verbatim)

This is essentially asking for good bounds on $r_k(N)$, the size of the largest subset of
$\{1,\ldots,N\}$ without a non-trivial $k$-term arithmetic progression. For example, a bound like
\[r_k(N) \ll_k \frac{N}{(\log N)(\log\log N)^2}\] would be sufficient. Even the case $k=3$ is
non-trivial, but was proved by Bloom and Sisask [BlSi20]. Much better bounds for $r_3(N)$ were
subsequently proved by Kelley and Meka [KeMe23]. Green and Tao [GrTa17] proved
$r_4(N)\ll N/(\log N)^{c}$ for some small constant $c>0$. Gowers [Go01] proved
\[r_k(N) \ll \frac{N}{(\log\log N)^{c_k}},\] where $c_k>0$ is a small constant depending on $k$.
The current best bounds for general $k$ are due to Leng, Sah, and Sawhney [LSS24], who show that
\[r_k(N) \ll \frac{N}{\exp((\log\log N)^{c_k})}\] for some constant $c_k>0$ depending on $k$.

Curiously, Erdős [Er83c] thought this conjecture was the 'only way to approach' the conjecture
that there are arbitrarily long arithmetic progressions of prime numbers, now a theorem due to
Green and Tao [GrTa08] (see [219]).

In [Er81] Erdős makes the stronger conjecture that
\[r_k(N) \ll_C\frac{N}{(\log N)^C}\] for every $C>0$ (now known for $k=3$ due to Kelley and Meka
[KeMe23]) - see [140].

See also [139] and [142].

This is discussed in problem A5 of Guy's collection [Gu04].

## References (verbatim)

- [BlSi20] Bloom, T.F. and Sisask, O., Breaking the logarithmic barrier in Roth's theorem on
  arithmetic progressions. arXiv:2007.03528 (2020).
- [Er81] Erdős, P., On the combinatorial problems which I would most like to see solved.
  Combinatorica (1981), 25-42.
- [Er83c] Erdős, Paul, Combinatorial problems in geometry. Math. Chronicle (1983), 35-54.
- [Go01] Gowers, W. T., A new proof of Szemerédi's theorem. Geom. Funct. Anal. (2001), 465-588.
- [GrTa08] Green, Ben and Tao, Terence, The primes contain arbitrarily long arithmetic
  progressions. Ann. of Math. (2) (2008), 481-547.
- [GrTa17] Green, Ben and Tao, Terence, New bounds for Szemerédi's theorem, III: a polylogarithmic
  bound for $r_4(N)$. Mathematika (2017), 944-1040.
- [Gu04] Guy, Richard K., Unsolved problems in number theory. (2004), xviii+437.
- [KeMe23] Kelley, Z. and Meka, R., Strong Bounds for 3-Progressions. arXiv:2302.05537 (2023).
- [LSS24] Leng, J., Sah, A. and Sawhney, M., Improved bounds for Szemerédi's theorem.
  arXiv:2402.17995 (2024).
