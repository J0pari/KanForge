# KanForge — Build Order

Milestones, deliverables, and acceptance criteria. Each phase depends on the previous. Phases 1–3
produce a working vertical slice; phases 4–7 add the "sharpened" (RL) agentic loop. Everything is
designed so that each phase ships and is *measurable* before the next starts.

> Canonical layout and module/file names: `architecture.md` §1. Event vocabulary: `architecture.md`
> §4. Reward defaults: `architecture.md` §6. Guardrail spec: `architecture.md` §2.5. Evidence for
> "why": `research_notes_2026.md`. This document adds only sequencing and acceptance.
>
> Numeric acceptance targets are **provisional** — set before the relevant system exists. The
> acceptance *criterion* (the measured comparison) is fixed; the threshold is a first guess to be
> re-set from the first runs.

---

## Build, test, and integration ordering (de-risk first)

The build retires risk in the order it can sink the project, and phases are gated by *measured
results*, not by code volume. The product scope is unchanged — this is ordering, not descoping.

1. **The loop must prove real lemmas before the machinery grows** (P0–P1 gate). Nothing past P1
   is justified until the minimal loop — PullGraph + scheduler + `backendRepl.applyTactic` + one LLM
   adapter — has proved a lemma via tactic-level search (LLM proposes one tactic per call, backend applies it, subgoals are searched recursively) and emitted a traced event. Every later
   phase assumes this is already robust, so its machinery always has something to learn from.
2. **Reliability before breadth** (P3–P5). The last-20% reliability work — repair, premise
   retrieval, autoformalization — is scheduled *after* the core loop and measured, because that
   is what makes the loop robust, not because it is glamorous.
3. **RL only after the deterministic loop saturates** (P6 gate). If pass@1 on the smoke set is
   near zero, the fix is loop reliability, not more machinery. P6 does not start until repair +
   search show diminishing returns.
4. **Scaffolding is deferred by default.** Anything not load-bearing for the current phase ships
   as a stub or is skipped. A stripped-down mode (`--minimal-loop`) runs the loop with console
   logging only; telemetry, query, digest, and RL layers are optional decorations until the loop
   works.

### Stage gates

| Review risk | Gate (phase) | Metric (decides) | Fail-forward |
|---|---|---|---|
| Loop never works | P0.3 + P1 | first-lemma time-to-verify (goal intake → all goals solved via tactic search); ≥ 1/20 miniF2F fully proved | fix loop reliability; do not add RL/query/digest |
| Backend brittle at scale | P0.3 resilience suite | worker restarts = hangs = JSON parse-failures = 0 in CI runs | harden the pool before raising concurrency |
| Nothing to learn from | P3 / P5 on the smoke set | repair sample-complexity; search budget use | extend the loop, not the RL stack |
| Pass@1 stalls RL | P6 start gate | pass@1 trajectory reported before P6 work begins | reorder: reliability work before RL |
| Guardrail paralysis | P4 (stub permission) | guardrail trips per attempt; permission-scope violations = 0 | tune the permission model; hard invariants never relax |

---

## Phase 0 — Foundations: toolchain + the pure core
**Est. 1–2 weeks.** No AI yet.

### 0.1 Toolchain
- Install `elan` + pinned `lean`/`mathlib4` toolchain; `lake` project with `lakefile.lean`.
- Stand up the Lean backend options (`lean/backend.js` + the two real impls, per
  `architecture.md` §3):
  - `leanprover-community/repl` built for the pinned toolchain (preferred, JSON-lines);
  - `lean` CLI for batch.
  - `lean4web` is *deferred* — it ships only once a real instance is exercised end-to-end
    (no fabricated adapters).
- **Deliverable:** `lean/backend.js` adapter interface + the implemented backends passing a
  round-trip test against the real kernel: `applyTactic(goal, "rfl")` returns zero subgoals (REPL) and
  `check("example : 1 + 1 = 2 := by rfl")` returns verified (CLI).

### 0.2 Build the core
- Implement `Lazy`, `LazyTemplate`, `LazyMapper`, `Pipeline`, `ConfigContext`, `LazyStream`, `lazify`,
  `fix`, `PullPromise`, `PullCache`, `PullGraph`, `StateSerializer`, `Hasher` in `core/` with
  unit tests (file mapping: `architecture.md` §1).
- Add `core/patch.js` (typed patch envelope, `architecture.md` §2.7) and `core/scheduler.js`
  (dependency-ordered dispatch, `architecture.md` §2.6) with unit tests.
- **Deliverable:** `core/` with tests; `PullGraph.serialize/deserialize` round-trips a nontrivial
  DAG; `invalidate()` transitively clears dependents; scheduler verifies the locality property
  (only descendants re-verify).

### 0.3 Smoke REPL client + scheduler
- `lean/backendRepl.js` spools JSON-lines; `lean/pin.js` provides `check()` + `extractGoals()` +
  statement hashing; `core/scheduler.js` dispatches statements to the pool dependency-ordered
  (Wave2 §7–8): 7-state lifecycle, priority tuple, no cyclic dispatch, bounded concurrency,
  timeout/kill-on-hang.
- **Acceptance:** a script checks `n` statements concurrently, returns
  `{status, goals, error}` for each, and reports per-check duration. Scheduler: no cyclic
  dispatch, deterministic ordering, failed dep blocks dependents without dispatch. CI runs on the
  pinned toolchain.
- **Resilience suite (same gate, `test/backend.repl.live.test.js`):** all failure modes are
  exercised against the **real** `repl` binary — kill a warm worker mid-check → the pool
  replaces it and the batch completes; a hung worker is killed on timeout and the batch recovers;
  normal runs report `restarts = hangs = parseErrors = 0`. (Pool contract: `architecture.md` §3.1.
  No mock/fake/stub: the suite skips, never fakes, when the binary is unavailable.)

---

## Phase 1 — Tactic-level search loop + telemetry
**Est. 2 weeks.**

### 1.1 Telemetry bus
- Implement `optimization/bus.js` (central event bus), `store.js` (bounded event store, causal
  parent links), `metrics.js` (KPI calculator), `patterns.js` (degeneracy monitors),
  `exporter.js` (telemetry export), `core/hasher.js` (hash chains), and the invariant wiring in
  `core/guardrails.js` (names per `architecture.md` §1).
- Add the proof event vocabulary (`architecture.md` §4).
- **Deliverable:** every REPL call and LLM call is a traced causal event with `parent`.

### 1.2 LLM adapter + tactic-level search
- `agent/llm.js`: OpenAI/Anthropic-compatible + local (vLLM/Ollama) clients; streaming optional.
- `agent/loop.js`: tactic-level search — for each lemma, the loop picks an unsolved goal, asks the LLM for ONE tactic, applies it via `backend.applyTactic`, gets subgoals, repeats. A proof is a tree of tactic applications. Each LLM call is bounded (10-30s), each kernel check is bounded (1-3s). No timeout possible by design.
- `search/bestofn.js`: for a single goal, sample N tactic proposals, apply each, take first that succeeds. Pre-filter
  stage before verification (Wave2 cost-model idea, CPU-side): drop known-failing patterns (causal
  predictors), premise-lock violations, and near-duplicate patches.
- **Acceptance (provisional):** on a 20-problem miniF2F smoke set with a frontier model,
   ≥ 1 problem fully proved (all goal equivalence classes in e-graph solved); `optimization/metrics.js` reports success rate, tokens/tactic,
  tactics/lemma. Re-set the threshold from the first run.
- **Search efficiency KPI:** kernel checks eliminated by the pre-filter (Wave2 §15),
  logged per run.

### 1.3 Query API (vertical slice)
- Implement `query/server.js` (signed, rate-limited) + `/proof/*` endpoints returning events,
  transition matrix (even if sparse), health (endpoints per `architecture.md` §8).
- **Acceptance:** `node kanforge/query/server.js health` and `/proof/events` work over TCP + GUI.

---

## Phase 2 — Proof-state machine + checkpointing
**Est. 1–2 weeks.**

### 2.1 Lemmas as graph nodes
- Wire `PullGraph` to the two-level structure: Level 1 nodes = lemmas (with `statementHash`, `proof`, `deps`, cache); Level 2 nodes = goal equivalence classes within each lemma's e-graph (with `normalizedGoalType`, `normalizedContext`, `tactics`, `stats`, `parents`).
- Error boundaries per node: fallback policy `retry→repair→skip (never weaken)`.
- **Deliverable:** proof of a theorem with 3+ lemmas produces a serializable forest; re-running
  hits the cache (cache-hit stats via `optimization/metrics.js`).

### 2.2 Resumability
- `PullGraph.serialize()` to `kanforge/runs/<runId>/state.json` after every verified lemma
  (each lemma is a resumable transaction).
- **Acceptance:** kill the process mid-search, restart with `--resume <runId>`, verify that
  cached lemmas are not re-proved and dependents continue.

### 2.3 Git growth
- `growth/commit.js` commits each verified lemma to a scratch repo with the
  statement hash in the commit message.
- **Acceptance:** after a run, `git log` shows one commit per verified lemma; `core/hasher.js`
  audit reproduces the run's event hash chain.

---

## Phase 3 — Repair loop (APOLLO-style)
**Est. 1–2 weeks.**

### 3.1 Error-driven repair
- `agent/repair.js`: on `VERIFY_FAIL`, classify error (syntax vs type vs missing-lemma), isolate
  the failing sub-goal, produce a structured repair prompt; low top-K (8) retries; recompose and
  re-verify up to a budget. Error telemetry is structured per Wave2 §11 —
  `{ location, constraint, expected, actual, dependencies }` — mapping to the failed graph
  neighborhood; verified regions stay immutable across repair rounds.
- **Acceptance (provisional):** sample complexity on the miniF2F smoke set drops ≥ 5× vs Phase 1
  best-of-N at equal accuracy (report both via `optimization/metrics.js`). The ≥ 5× figure is a first
  guess; the measured comparison is the fixed criterion.

### 3.2 Sub-proposition error feedback
- For conjunction/disjunction-heavy goals, align error text to the sub-proposition that failed
  (per the 2025 FOL literature).
- **Acceptance:** repair success on the smoke set reported; failure cases logged to
  `optimization/store.js` for Phase 6 analysis.

---

## Phase 4 — Blueprint (sketch/refine modality)
**Est. 2 weeks.**

### 4.1 Skeleton generator
- `blueprint/skeleton.js`: LLM proposes lemma decomposition; each lemma emitted as a typechecked
  `sorry` stub so the *statement* is kernel-valid; DAG acyclicity + dependency coverage audited;
  emit `blueprint.json` + `blueprint.md`.
- **Acceptance:** a multi-lemma development (10+ lemmas) yields an acyclic blueprint whose stubs
  all typecheck under Lean (statement hash pinned per stub).

### 4.2 Refine loop
- `blueprint/refine.js`: repeatedly pick the lowest unproved stub → Phase 3 agent loop → fill or
  re-split (re-split adds child stubs, never edits existing statements).
- Drift detection: `blueprint/drift.js` periodically re-hashes stub statements.
- **Acceptance:** the 10+ lemma development is fully proved bottom-up with no `sorry`; blueprint
  is invariant across the run (statement set unchanged).

### 4.3 Digestion (first cut)
- Implement `digest/writeup.js`: parse statements/writeups → render proof
  writeups with KaTeX + per-lemma cards + assumption account + dependency graph.
- **Acceptance:** each completed development produces readable `*.md` / `*.html` / `*.pdf`.

---

## Phase 5 — Search intelligence
**Est. 2 weeks.**

### 5.1 BFS + MCGS with transposition merging
- `search/bfs.js`, `search/mcgs.js`: best-first over goal equivalence classes; transposition merging is built into the e-graph structure — alpha-equivalent or definitionally-equal goals are already merged into equivalence classes with shared statistics (value/visit counts). The e-graph is the search structure itself (`architecture.md` §2.2, §10), so every search variant inherits the merge, not just MCGS.
- **Acceptance (provisional):** MCGS ≥ best-of-N at equal budget on the smoke set; merge rate
  reported. Compare, then decide.
- **Status:** the comparison apparatus ships in `bench/ablation.js` (recipes: `bestofn`, `swiss`,
  `swiss+repulsion`, `bfs`, `bfs+repulsion`, `mcgs`, `mcgs+repulsion`; shared LLM-call budget;
  per-recipe + per-problem cost/pass tables written to `bench/ablation/`). The P0.1 Mathlib repl
  build is **done** (`lean-project`, v4.33.0-rc1): the backend spawns it with the toolchain `bin`
  on `PATH` and a `LEAN_PATH` reconstructed from `KANFORGE_LEAN_PROJECT`, and the live suite
  proves `import Mathlib.Data.Real.Basic` + `#check Real` typechecks. A **Mathlib problem set**
  ships in `bench/mathlibSmoke.js` (`--set=mathlib`; 12 problems exercising ring, linarith,
  norm_num, decide, positivity, field_simp, tauto over Real/Int/`Nat.Prime`, each verified
  solvable by its family tactic through the real kernel). Two harness fixes made Mathlib runs
  viable: the drivers now release every proof session (`endLemma`), and `workerPerProblem` gives
  each problem a fresh repl process — the repl keeps every environment snapshot forever and a
  reused worker dies with `INTERNAL PANIC: out of memory` after ~9 heavy imports. The measured
  comparison (`--set=mathlib`) can now run; prefer `--problems=<subset>` to bound wall time
  (each statement imports its modules, 5-35s per problem per recipe).
- **Measured (§5.1 gate: MET).** First full Mathlib run: 5 problems × 7 recipes, N=8,
  budget 400 (report in `bench/ablation/ablation_1785973978734/`). Every recipe solves 4/5;
  **MCGS ≥ best-of-N at equal budget** — same accuracy with 6 LLM calls vs best-of-N's 15, and
  the search recipes (bfs/mcgs) beat the ranking recipes (swiss: 105 calls) outright. Repulsion
  only multiplies cost here. The single miss, `tauto_elim`, fails for EVERY recipe — a
  **proposal-distribution gap**: the model never proposes `tauto`, so no search budget helps
  (fails fast under bfs/mcgs, burns the judge budget under swiss).

### 5.2 Repulsion + premise retrieval
- `search/repulsion.js` (Goedel-style diversity penalty) and `search/premises.js`
  (LeanDojo-style relevance scoring over mathlib, "premise-locked" search).
- **Acceptance:** ablations logged (with/without each) on the smoke set.
- **Status:** both ship. `repulsion.js` provides `computeRepulsionPenalty` + `RepulsionSampler`
  (refuses duplicate re-proposals, steers with a "do not repeat" prompt note); `MCGS`/
  `BestFirstSearch` accept a `repulsion` flag that skips duplicate kernel re-checks. Premise
  retrieval is the lexical BM25 baseline wired into `TacticLoop`. The with/without ablation logs
  are produced by `bench/ablation.js` (§5.1 status): a `--premises=on|off` axis wraps the llm in
  `PremiseAugmentingLLM` (retrieve top-k from a curated corpus, inject "Premises (theorems you
  may use)"; `--premise-locked=on` restricts the generator to them; `--corpus=full|no-mul-add`
  is the lock-enforcement control). The P0.1 Mathlib repl build that was the gate is **done**;
  the real smoke-set numbers are the current open item.
- **Tactic-menu axis (coverage-before-RL).** The §5.1 run's `tauto_elim` gap proved the model's
  proposal distribution can be blind to imported tactics the solver needs. Fix: an import-verified
  capability layer at the `llm.complete` seam — `search/tacticMenu.js` builds a goal-shape-keyed,
  hypercompressed menu (head-connective detector + `MODULE_TACTICS` import map, non-circular: never
  consults a problem's `family`) injected into proposal prompts only. This is **not** an RL fix:
  RL cannot reinforce a tactic it never samples (sparse exploration), so coverage mechanisms are a
  *prerequisite* for P6, not a P6-side effect.
- **Measured.** `--menu=on` on the same 5-problem set (report in `bench/ablation/ablation_menu_on/`):
  `tauto_elim` flips FAILED→SOLVED on the first call under both best-of-N and MCGS, and the whole
  set goes 4/5→5/5 at LOWER cost (best-of-N 15→10 calls, MCGS 6→5). Coverage widens recall; for
  arg-less closers that is the whole fix.

### 5.3 Failure-aware search biasing
- Use `optimization/causal.js` `getFailurePredictors()` to penalize action sequences known to
  precede FAIL.
- **Acceptance:** predictor list is non-empty and search budget spent on non-predictor branches
  increases.

### 5.4 Multi-step goal-directed ablation tier
- The core (§5.1) and mathlib sets are each closable by ONE headline tactic, so they cannot
  separate a greedy single-tactic ranker from a multi-step searcher — exactly the divide the
  P6 gate (§6) must measure. Fix: a multi-step tier where every problem needs a 2–4 tactic
  `chain` and admits **no trivial closer**.
- **Tier definition** (`bench/stepSmoke.js`, `STEP_PROBLEMS`, 10 problems over the core repl):
  - **T4 logic decomposition** (families `rcases`/`intro`/`constructor`): `or_elim`, `or_comm`,
    `and_intro_chain`, `imp_trans`, `modus_tollens`.
  - **T5 rewrite + hypothesis composition** (family `rw`): `distrib_twice`, `square_expand`,
    `mul_comm_rw`, `func_compose`, `eq_trans_chain`.
  - Each problem carries a golden `chain`; `validateSmokeSet` rejects malformed chains.
- **Full-paces harness** (`bench/verifyStepSet.js`): every stub must typecheck, the golden chain
  must replay through the SAME `GoalEGraph`/`open[0]` frontier discipline as the ablation drivers
  (`replayChain`) AND re-verify once assembled via `assembleProofSource`, and each of the trivial
  closers `rfl`, `simp`, `omega`, `decide`, `assumption` must FAIL on the root goal. CLI:
  `node bench/verifyStepSet.js [--set=step] [--problems=id,...] [--out=dir]` → report.json/report.md.
- **Measured (real kernel, all 10 PASS):** `node bench/verifyStepSet.js` — every problem
  `stub=true chain=true asm=true neg=true` (report in `bench/ablation/verifyStep_1786002349245/`).
  Chain shape lessons: `rw` rewrites only the FIRST matching occurrence (repeat `rw [Nat.mul_add]`
  twice) and auto-closes definitionally via `rfl` (a trailing `rfl` fails with "No goals to be
  solved"); `(a+b)*(c+d)` reassociation is NOT definitional under left-assoc `+`, so the final
  `omega` is required, not cosmetic; `simp` closes `(p → q → r) → (p ∧ q → r)`, which is why the
  tier rejects trivial closers *empirically*, not by assumption.
- **Open item:** the tier ablation (bestofn vs MCGS × `--menu=on|off` × `--premises=on|off`) on
  `--set=step`; this is the pass@1/cost table the P6 gate (§6) is judged on.

---

## Phase 6 — RL optimization
**Est. 4 weeks.**

> **P6 start gate:** P6 does not begin until the deterministic loop (P3–P5) is the measured
> bottleneck. Report pass@1, repair sample-complexity, and search budget use on the smoke set
> before starting; if pass@1 is near zero, the next iteration is loop reliability, not RL.

### 6.1 Reward function + GRPO
- `optimization/reward.js`: initial defaults per `architecture.md` §6 (tune, don't trust).
- `optimization/grpo.js`: GRPO over trajectories sampled by the search layer, with Lean
  verification as the outcome oracle.
- **Deliverable:** training harness (single GPU fine-tune on Goedel-Prover-7B or
  DeepSeek-Prover-V2-7B style base); W&B/Prometheus metric export via `optimization/exporter.js`.

### 6.2 Guardrails (anti-reward-hacking)
- Enforce the invariant spec in `core/guardrails.js` (per `architecture.md` §2.5): pinned
  statement hash unchanged (no weakening); no `axiom`/`admit`/`unsafe` leakage; tactic-strength
  caps; `checkHermetic` over runs. `optimization/patterns.js` monitors degenerate loops.
- **Acceptance:** *hacking probes* pass — when prompted to "prove" a weakened/trivial variant, the
  system refuses (guardrail trip logged, no reward).

### 6.3 Test-time RL
- `optimization/ttrl.js`: on hard goals, allow the policy to adapt within the run from accumulated
  verification outcomes (AlphaProof-style).
- **Acceptance (provisional):** pass@1 improves on hard targets with adaptation vs frozen policy;
  sample efficiency reported.

### 6.4 Data flywheel
- `growth/dataset.js`: every verified attempt → training sample (state, tactic, outcome);
  self-generated problem corpus from the target list; held-out split maintained.
- **Acceptance:** dataset grows monotonically; contamination check (overlap with benchmark splits)
  reported per release.

---

## Phase 7 — Open-target missions + digestion at scale
**Est. 4+ weeks, ongoing.**

### 7.1 Curated corpus + autoformalization
- Start with 20 Erdős problems / OEIS conjectures whose statements are *formalizable* and
  auditable. `agent/roles/autoformalizer.js` (ALA-style: generalist orchestrator + Lean-tuned
  model).
- **Acceptance (provisional):** ≥ 50% of curated statements formalize; each formalization is
  human-reviewed and statement-pinned before search begins.

### 7.2 Multi-agent ensemble
- Implement `growth/multibody.js` (one-owner-per-region lemma edits, processing lanes) + the
  single-agent-workspace lock in `core/guardrails.js`; run parallel prover
  agents over the corpus with single-owner lemma edits (AxiomProver-style: autoformalizer /
  conjecturer / prover / critic under `agent/roles/`).
- **Acceptance:** 2+ agents run concurrently on disjoint targets without file conflicts; critic
  reviews candidate proofs (statement-match + readability).

### 7.3 Full digestion + audit
- Auto-generate per-target writeups with assumption accounts; assemble a research summary doc.
  `core/hasher.js` audit + git history = reproducibility pack.
- **Acceptance:** for every claimed result: Lean source, blueprint JSON, writeup, audit hash, and
  git commits all consistent and queryable via `/integrity/verify`.

### 7.4 Ongoing RL loop
- Fold every mission run back into 6.4; refresh reward/guardrails from `optimization/patterns.js`
  findings. Long-horizon runs use resumable transactions throughout (Phase 2 machinery).

---

## Milestone map (dependency graph)

```
P0 (toolchain + core) ─▶ P1 (loop + telemetry) ─▶ P2 (state machine + resume)
   │                          │                         │
   │                          ▼                         ▼
   │                     P3 (repair) ─────────▶ P4 (blueprint) ─▶ P5 (search)
   │                                                        │
   │                                                        ▼
   └──────────────────────────────────────────────────▶ P6 (RL) ─▶ P7 (missions)
```

---

## Suggested staffing/skills per phase
- **P0–P2:** one engineer strong in JS/Node + one with Lean4/lake/mathlib experience.
- **P3–P5:** same + familiarity with neural theorem proving literature (APOLLO, BFS-Prover,
  MCGS, Goedel repulsion).
- **P6:** add an ML engineer (RLHF/GRPO experience) + a mathematician for benchmark curation.
- **P7:** add a domain mathematician to review formalizations and writeups.

---

## Definition of done (whole project)
1. A target theorem entered in natural language yields: audited formal statement → blueprint DAG →
   verified Lean proof (no `sorry`) → readable writeup → commit + audit hash.
2. The optimization loop demonstrably improves pass@1 on held-out targets with the same model
   (measured, not asserted).
3. Reward-hacking probes consistently fail (guardrails hold).
4. Every result is reproducible: pinned toolchain + full event trace + hashes.

## Evaluation dimensions (Wave2 §15)
Independent of per-phase acceptance, the project is measured along four axes — the argument is
that this is an *incremental verification system*, so the KPIs are verification-system KPIs:
- **Verification throughput** — verified patches per compiler invocation.
- **Compilation efficiency** — incremental rebuild time vs full recompilation (locality
  property; scales with affected depth, not project size).
- **Search efficiency** — compiler invocations eliminated by the pre-filter / dedup stages.
- **Correctness preservation** — rate of interface violations and specification drift (guardrail
  trips per lemma).
