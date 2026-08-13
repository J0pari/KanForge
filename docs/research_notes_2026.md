# KanForge — Research Notes (state of the art, Aug 2026)

**Canonical source for**: the systems landscape, the working tricks, the design warnings, and the
source list. `blueprint.md` cites this as its evidence base; `build_order.md` and `architecture.md`
derive constraints from it. Module paths do not belong here (see `architecture.md`).

> Calibration note: most figures below come from a survey (cs.virginia.edu course page) and press
> material fetched during this session, recalled here. The *shape* of the field — which tricks
> work, which failure modes repeat — is stable and is what we design against. Individual numbers
> (scores, sizes, dates) move fast and must be re-verified against primary sources before any
> public claim. Where a number is load-bearing for a decision, it is marked below.

---

## 1. The systems landscape

| System | Origin | Headline result | Mechanism that matters |
|---|---|---|---|
| AlphaProof | DeepMind | Silver IMO 2024; Nature 651:607 (Nov 2025) | RL in Lean; ~300k state-tactic pairs; test-time RL |
| AlphaProof Nexus | DeepMind | 9/353 Erdős, 44/492 OEIS (May 2026) | LLM-in-charge agentic population search; **<3% on open problems** *(load-bearing)* |
| AxiomProver | Axiom Math | 12/12 Putnam 2025; 4 open conjectures; 42/42 IMO 2026 | multi-agent ensemble: autoformalizer / conjecturer / prover / critic |
| Seed-Prover / 1.5 | ByteDance | Gold IMO 2025; ~99.6% MiniF2F | lemma-style whole-proof generation; sketch + rubric RL |
| DeepSeek-Prover-V2 | DeepSeek | 88.9% MiniF2F-test; 49/658 PutnamBench | recursive subgoal decomposition; GRPO; sketch/solution consistency |
| Goedel-Prover-V2 | Princeton | open-source SOTA at ~80× smaller | repulsion sampling; premise-locked search; expert iteration + RL |
| Aristotle | Harmonic | Gold IMO 2025; 10/12 Putnam | MCGS over a hypertree of proof states |
| Kimina-Prover | Moonshot | 57.4% Putnam (Nov 2025) | large-scale RL; shipped a REST Lean verifier (Kimina Lean Server) |
| Gauss | Math Inc | strong PNT formalized in ~3 weeks | agentic autoformalization over a stalled human effort |
| FormaRL | Tsinghua | competitive open-source | GRPO with Lean compiler feedback |
| LeanMarathon | open | paper-level autoformalization, 258 lemmas, 0 `sorry` | durable, resumable harness; blueprint DAG; drift detection |
| APOLLO | open | 84.9% miniF2F at sub-8B scale | modular repair loop; sample complexity 25,600 → hundreds |
| ALA | open | 52% autoformalization on 400-thm benchmark | two-model orchestration (generalist + Lean-tuned) |
| Open Proof Corpus | Meta (open) | +17% over naive best-of-n (26%→43% vs 26%→36%) | Swiss-tournament best-of-n with pairwise LLM judgment, Bradley-Terry ranking *(load-bearing: `search/swiss.js` follows arXiv:2506.21621 §5.5)* |

**Infrastructure**: Lean REPL (`leanprover-community/repl`), Lean Copilot, LeanDojo/LeanDojo-v2
(premise retrieval, data extraction), `lean4web` (server-side Lean, Apache-2.0, TypeScript),
Kimina Lean Server (FastAPI verifier), mathlib4 (~100k declarations).

### Design implications
1. **Multi-agent separation is the proven path to *published* results** — AxiomProver's
   autoformalizer / conjecturer / prover / critic split produced the peer-reviewed wins. We adopt
   the roles, but only in Phase 7; the single-agent loop (P0–P6) is the same machinery without the
   orchestration.
2. **The reward loop is central.** Every frontier system trains the policy against kernel
   verification. This system's boundary is different: the policy is a hosted LLM with no
   trainable weights here, so the same loop exists in its record-not-train form — preference
   pairs, held-out failure predictors, and GRPO records that a trainer consumes
   (`architecture.md` §6.2). Telemetry, reward, and search biasing are first-class from P1, not
   a bolt-on; a gradient step is out of scope by decree.
3. **Open-problem hit rate is low even for DeepMind.** Targets the corpus as curated,
   formalizable, auditable, and throughput-batched; expect partial results, not miracles.
4. **Comparisons are made on a fixed corpus at equal cost.** OPC's tournament methodology and
   the frontier papers' ablations converge on the same discipline: pass rate alone is an
   anecdote; the measured quantity is pass@k *at normalized LLM + kernel cost*. This is the
   design behind the ablation harness's fixed corpora, shared budget, and per-recipe cost
   tables (`architecture.md` §5.7).

---

## 2. The ten tricks (design constraints, not prescriptions)

All tricks below apply at the **tactic level** (Level 2, `architecture.md` §2.2): the LLM proposes one tactic per call, the backend applies it to a goal and returns subgoals. A proof is a tree of tactic applications extracted from the transposition graph. The lemma DAG (Level 1) is the dependency structure; the goal transposition graph (Level 2) is where the intelligence lives.

1. **Verifier-as-reward RL** — AlphaProof, Seed-Prover, DeepSeek-V2, FormaRL, Kimina converge on
   GRPO/VAPO/expert-iteration with binary kernel verification + shaped progress. Applied at tactic level: each tactic application is a reward signal.
2. **Sketch → refine** — Seed-Prover (sketch model) and LeanMarathon (audited blueprint DAG):
   produce the lemma skeleton first, prove bottom-up.
3. **Repair loops beat raw sampling** — APOLLO: isolate the failing subgoal, retry at low
   top-K with a different tactic, recompose, re-verify. 10–100× sample savings claimed. Applied at tactic level: when a tactic fails on a goal, repair proposes an alternative tactic for the same goal.
4. **Graph search with state merging** — Aristotle MCGS, AlphaProof Nexus: merge
   transposition-equivalent goals (same context, def-eq) so they share an equivalence class and statistics. Applied at Level 2: the goal transposition graph structure (`architecture.md` §2.2) automatically merges equivalent goals, enabling efficient search.
5. **Diversity mechanisms** — Goedel repulsion; low top-K independent attempts; AlphaProof
   test-time RL on hard goals.
6. **Premise retrieval** — LeanDojo-style relevance scoring; "premise-locked" search removes
   spurious hypotheses.
7. **Autoformalization is the bottleneck** — ALA: two-model orchestration lifts 22% → 52%.
8. **Durable harnesses** — LeanMarathon: resumable transactions, parallel, checkpointed,
    target-fidelity invariants. *(Closest prior art to our PullGraph design.)*
9. **Assumption accounting** — Axiom's case studies: explicit-hypothesis discipline catches
   mis-stated or vacuous problems.
10. **Multi-agent ensemble with critic** — AxiomProver: separate roles; critic reviews before
    publication.

---

## 3. The ten warnings (each maps to a guardrail in `architecture.md` §2.5)

1. **The verification gap** — Lean verifies the *formalized* statement, not the natural-language
   claim. Mitigate: statement-hash pinning, assumption accounting, human review of
   formalizations.
2. **Reward hacking in RLVR** — proving trivial weakenings, exploiting `simp`/`omega`/`aesop`,
   leaking `axiom`/`unsafe`. The verification-horizon literature (METR, 2025–26) argues hacking
   is *inevitable* under sustained optimization against an imperfect objective — monitor and
   re-audit, don't assume it's patched.
3. **Benchmark saturation** — MiniF2F is effectively saturated (~99.6%). Measure on PutnamBench,
   ProverBench, ProofNet, Lean Workbook, uproof, and **held-out novel** targets.
4. **Low absolute hit rate on open problems** — AlphaProof Nexus: <3% on Erdős, <10% on OEIS.
   Plan around a curated corpus and batch throughput.
5. **Long-horizon brittleness** — multi-hour autonomous runs drift and die. Checkpoint
   everywhere; every lemma is a resumable unit.
6. **Sample/compute cost** — frontier regimes use TB-scale RAM and thousands of agents. Our design
   favors *low* sample complexity (repair loops, premise pruning, dedup, state merging).
7. **Data contamination** — competition corpora leak into pretraining. Maintain clean held-out
   splits.
8. **Strategy starvation** — fixed tactics fail on sensitive deductive chains. Keep tactic
   diversity + goal-level error feedback. When a tactic fails on a goal, the repair loop should propose fundamentally different tactics, not minor variations.
9. **Digestion is still human** — formal proofs are unreadable. Ship prose translations,
   blueprints, assumption accounts.
10. **Mathlib dependency drift** — pin toolchain + `lakefile.lean` per workspace; isolate builds.

---

## 4. Sources

- Survey of prover systems, cs.virginia.edu course page (covers Jan 2025–Jan 2026).
- AlphaProof / AlphaProof Nexus (DeepMind; Nature 651:607, May 2026).
- Seed-Prover & Seed-Prover/1.5 (ByteDance).
- DeepSeek-Prover-V2 (DeepSeek).
- Goedel-Prover-V2 (Princeton).
- Aristotle (Harmonic).
- Kimina-Prover (Moonshot; Kimina Lean Server).
- FormaRL (Tsinghua).
- LeanMarathon (open).
- APOLLO (open).
- ALA (open).
- AxiomProver (Axiom Math).
- Open Proof Corpus (Meta, open; arXiv:2506.21621 — Swiss-tournament best-of-n methodology).
- Repos: github.com/leanprover-community/repl, github.com/leanprover-community/lean4web,
  github.com/lean-dojo/LeanDojo, mathlib4.

### 4.1 Implementation lineage (provenance, not design)

The foundational primitives in `kanforge/core/` (`lazy`, `hasher`, `patch`) and the
telemetry/instrumentation modules (`optimization/*`, `digest/*`, `growth/*`) are re-implementations
of lazy build-system machinery under KanForge's domain (proofs, not documents); correctness is
enforced by the unit-test suite, not by trust in the source.

---

## 5. The compression lens (conceptual framing)

**Thesis.** The resource this system manages is *redundant reasoning*. Each architectural layer
compresses a different kind of redundancy, and the Lean kernel is what makes the compression
accountable: a compressed representation only counts when it re-expands into a kernel-verified
artifact. That is the operational form of "formal intelligence ≈ finding small representations
of large regularities that can be mechanically re-expanded into proofs" — not the slogan
"LLMs compress text".

**The four compression claims, mapped to mechanisms (all live):**

1. **Search compresses by state equivalence** — the goal-state transposition graph (`core/transpositionGraph.js`,
   `architecture.md` §2.2): different tactic histories that reach the same normalized state share
   one equivalence class and its statistics. This is quotienting — the question "which differences
   in the history of thought are irrelevant to the future" — and it is why the identity semantics
   are syntactic: merging states that are not provably interchangeable would corrupt the quotient.
2. **Knowledge compresses by reusable lemmas** — the blueprint DAG and the lemma store: a theorem
   family described through a few reusable lemmas has a much shorter description than the same
   proofs stated independently (the MDL intuition: `L(model) + L(data | model)`). The store is the
   dictionary; the kernel re-verification on every reuse is what keeps corrupted entries out of
   the dictionary.
3. **Context compresses by task-relevant retrieval** — premise retrieval, the tactic menu, and
   prompt synthesis discard the irrelevant bulk of the Lean environment and send only what the
   next decision needs (rate-distortion: bounded distortion, minimal retained information; the
   information-bottleneck objective `I(X;Z) − β·I(Z;Y)` with X = full formal state, Z = prompt,
   Y = the next transformation).
4. **Experience compresses into search priors** — failure predictors and the training dataset
   turn historical outcomes into rejection rules and preference pairs. A predictor is a
   compressed history of failures; its known failure mode is over-compression, which the
   exploration rate (`predictorExploration`, `architecture.md` §6) exists to relieve — a
   compressor aggressive enough to discard rare successes destroys the information needed to
   discover new regularities.

**Mathematical grounding (what supports the analogy, and what does not).** Shannon ties
prediction to coding (`E_P[−log Q] = H(P) + D_KL(P‖Q)`), so "a model is a compressor of its
distribution" is literal for next-token cross-entropy. Kolmogorov complexity gives the right
intuition (a large object with a tiny generating rule) but is uncomputable — practical systems
use its approximations. MDL is the most useful form for proofs (model + residual description
length). Proof complexity supplies the honest distinction: **proof length, search cost, and the
description length of the proof-generating strategy are three different quantities** — a short
proof found through enormous search is not "efficient reasoning". This system measures the cost
of discovering the compressed explanation (LLM calls, kernel calls, trajectories, reuse, skips),
not merely whether a proof exists.

**The measurement gap.** The mechanisms exist; the compression itself is not yet measured
directly. The staged quantities (`architecture.md` §6.1 backlog) are: proof description length
under a specified encoding, library-relative description length (the residual after reusable
lemmas are taken as dictionary entries), and the amortized-cost curve — cost to solve problem
`T_i` as a function of the verified lemma library accumulated from `T_1..T_{i−1}`. A
systematically falling curve is the claim "knowledge is being compressed into reusable
mathematics" made measurable. Until instrumented, these metrics are `null` with a documented
reason — never fabricated.
