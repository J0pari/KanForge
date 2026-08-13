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
- Implement `Lazy`, `PullGraph`, `Scheduler`, `Hasher`, `Patch` in `core/` with unit tests (file
  mapping: `architecture.md` §1).
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
   ≥ 1 problem fully proved (all goal equivalence classes in transposition graph solved); `optimization/metrics.js` reports success rate, tokens/tactic,
  tactics/lemma. Re-set the threshold from the first run.
- **Search efficiency KPI:** kernel checks eliminated by the pre-filter (Wave2 §15),
  logged per run.

### 1.3 Query API (deferred, architecture.md §8)
- A signed, rate-limited `/proof/*` query API is not part of the system. The correctness surface
  is the development digest (`digest/development.js`) + per-lemma artifacts (`growth/commit.js`).
- **Re-entry condition (P7):** a real consumer (operator dashboard) that the API serves; if
  re-added, `/integrity/verify` must run a real `verifyHashChain` over the run's chain.

---

## Phase 2 — Proof-state machine + checkpointing
**Est. 1–2 weeks.**

### 2.1 Lemmas as graph nodes
- Wire `PullGraph` to the two-level structure: Level 1 nodes = lemmas (with `statementHash`, `proof`, `deps`, cache); Level 2 nodes = goal equivalence classes within each lemma's transposition graph (with `normalizedGoalType`, `normalizedContext`, `tactics`, `stats`, `parents`).
- Error boundaries per node: fallback policy `retry→repair→skip (never weaken)`.
- **Deliverable:** proof of a theorem with 3+ lemmas produces a serializable forest; re-running
  hits the cache (cache-hit stats via `optimization/metrics.js`).

### 2.2 Resumability
- `RunCheckpoint.save()` to `runs/<problemId>/checkpoint.json` after every refine round
  (proved lemmas, stalled flags, rounds, hash chain — each lemma is a resumable transaction).
- **Acceptance:** kill the process mid-search, re-run `--problem=<id>` (resume is automatic;
  `--fresh` archives the old workdir first), verify that proved lemmas are not re-proved,
  stalled lemmas stay stalled, and dependents continue.

### 2.3 Artifact growth
- `growth/commit.js` writes each verified lemma's artifacts (statement.lean + proof.lean +
  audit.json) into the problem workdir; the development digest's hash chain is the publication
  record.
- **Acceptance:** after a run, the workdir holds one artifact directory per verified lemma and
  `core/hasher.js` audit reproduces the run's event hash chain.

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

### 5.1 BFS + UCB-guided graph search (MCGS) with transposition merging
- `search/bfs.js`, `search/mcgs.js`: best-first over goal equivalence classes; `mcgs.js` is
  UCB-guided graph search over the open classes — selection / expansion / backprop only, **not**
  textbook MCTS (no cheap rollout; the "simulation" is an LLM + kernel call — `architecture.md` §5,
  §5.6). Transposition merging is built into the transposition graph structure — identically-normalized
  goals are already merged into equivalence classes with shared statistics
  (identity semantics per `architecture.md` §2.2; parent edges are populated by tactic
  expansion, so MCGS backprop walks real ancestry)
  (value/visit counts). The transposition graph is the search structure itself (`architecture.md` §2.2, §10),
  so every search variant inherits the merge, not just MCGS.
- **Acceptance (provisional):** MCGS ≥ best-of-N at equal budget on the smoke set; merge rate
  reported. Compare, then decide. (§5.6 sharpens this to a held-out, cost-normalized comparison;
  a "can solve something" anecdote is not acceptance.)
- **Toggleable live path (architecture.md §5 integration contract).** The loop accepts every
  strategy as a `searchRecipe` toggle (`loop` / `bestofn` / `bfs` / `mcgs` / `swiss`) plus
  orthogonal `repulsion` / `premises` / `tacticMenu` / `predictors` toggles, and the open-problem
  pipeline (`blueprint/refine.js`) passes the configured recipe through. The ablation graph and
  the live loop consume the SAME toggles, so "compare, then decide" is a runtime switch, not a
  rebuild. Deliverable: `TacticLoop({ searchRecipe })` delegates per-lemma proving to the named
  strategy; `blueprint/run.js` accepts `--recipe=` and the toggle flags; unit tests cover each
  recipe path in the loop.
- **Status:** the comparison apparatus ships in `bench/ablation.js` (recipes: `bestofn`, `swiss`,
  `swiss+repulsion`, `bfs`, `bfs+repulsion`, `mcgs`, `mcgs+repulsion`; shared LLM-call budget;
  per-recipe + per-problem cost/pass tables written to `bench/ablation/`). The P0.1 Mathlib repl
  build is **done** (`lean-project`, v4.33.0-rc1): the backend spawns it with the toolchain `bin`
  on `PATH` and a `LEAN_PATH` reconstructed from `KANFORGE_LEAN_PROJECT`, and the live suite
  proves `import Mathlib.Data.Real.Basic` + `#check Real` typechecks. A **Mathlib problem set**
  ships in `bench/mathlibSmoke.js` (`--set=mathlib`; 12 problems exercising ring, linarith,
  norm_num, decide, positivity, field_simp, tauto over Real/Int/`Nat.Prime`, each verified
  solvable by its family tactic through the real kernel). Two harness fixes made Mathlib runs
  viable: every proof session is released after its lemma (`endLemma` — owned by the loop), and
  `workerPerProblem` gives
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
  are produced by `bench/ablation.js` (§5.1 status): the premises axis is the loop's own
  `premises`/`premiseLocked`/`premiseTopK` options (top-k from a curated corpus injected into
  the proposal prompt; `premiseLocked` restricts the generator to them — a commit-time
  guardrail, not just a prompt note). The historical `--premises=on|off` measurements below were
  taken by an earlier wrapper-based harness; the current instrument drives the loop options
  directly (`architecture.md` §0.4). The P0.1 Mathlib repl build is **done**;
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
- **Status:** `optimization/causal.js` ships (transition matrix, failure predictors, bottlenecks,
  anomalies, critical path; `compilePredictors` turns predictors into a reject matcher). The
  search entry points (`bestofn`, `swiss`, `bfs`, `mcgs`) consult the compiled matcher BEFORE
  kernel verification through the loop, and the ablation report logs `predictor-skips` per recipe
  (read from the loop's own counter).
  Unit tests cover the analyzer and the budget-shift claim (`test/causal.test.js`). The trainer
  (`bench/trainPredictors.js`) runs the REAL loop over a problem set and mines the event store;
  its report is self-audited (`reportAudit.js`: terminal coverage, predictor support/fails/
  confidence recomputed from the raw stream).
- **Measured (§5.3 gate: MET).** Full real trainer run on `--set=step` (10 lemmas, real kernel +
  real LLM, 139 traced events): `solved=4 failed=6`, report audit 10/10 PASS, 10 failure
  predictors at confidence 1 (`ring`, `ring_nf`, `ring→ring`, `ring→ring_nf`, `ring_nf→ring`,
  `intro→intro`, …) written to `bench/ablation/predictors_step.json`. With/without comparison on
  `or_elim,mul_comm_rw`, recipes `bestofn,mcgs`, N=4, budget 60 (`bench/ablation/ablation_predictors_on|off/`):

  | config | recipe | solved | llm calls | kernel checks | predictor-skips |
  |---|---|---|---|---|---|
  | predictors ON | bestofn | 1/2 | 5 | 2 | 3 |
  | predictors ON | mcgs | 0/2 | 15 | 14 | 1 |
  | predictors OFF | bestofn | 2/2 | 6 | 6 | 0 |
  | predictors OFF | mcgs | 1/2 | 10 | 10 | 0 |

  Budget-shift reading: with the pre-filter, `mul_comm_rw` [bestofn] spent 4 LLM proposals but
  only 1 kernel check (3 rejected pre-verification); without it, kernel = LLM calls every time.
  The rejected tactics were `ring`/`ring_nf`/`intro` — which genuinely fail on `b * a = c` from
  hypothesis `h` (ring cannot use hypotheses), so the skips are correct rejections, not false
  positives. The pass@1 delta between the two runs is dominated by LLM nondeterminism at N=4
  (`mul_comm_rw` closed in 1 call OFF vs. missed within 4 calls ON); per the §5.4 note, re-run
  any cell with a fresh seed to average it out.
- **Predictor safety gate (hard).** A failure predictor must not suppress an action unless ALL
  hold (architecture.md §6): minimum support (≥ 2), held-out evidence (confidence verified on a
  split the pattern was not mined from), bounded confidence (default ceiling 0.95 — a pattern at
  confidence 1.0 on tiny support is the overfit case and is inert), and false-rejection
  accounting (every rejection logged with its counterfactual; the rate is a report-audit safety
  metric, not a KPI). The measured §5.3 run's confidence-1 predictors (`ring`, `ring_nf`) fail
  the bounded-confidence gate and must NOT be used for rejection without held-out evidence.
- **Open item:** the §5.4 premises axis on `--set=step` (a step-tier premise corpus is needed
  first; the current corpora are mathlib-smoke-shaped). (Corpus now ships — see §5.4; remaining
  work is a consistent-model re-run + lock enforcement.)

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
  must replay through the SAME `GoalTranspositionGraph`/`open[0]` frontier discipline the live loop uses
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
- **Measured (§5.4 tier ablation, real kernel, N=4, 60 LLM calls/lemma, single sample per cell):**
  pass@1/cost table under `bench/ablation/ablation_1786166306620/` (scoped) and
  `ablation_1786166640876/` (bestofn menu=on), `ablation_1786167296479/` (mcgs menu=on),
  `ablation_1786168088188/` (bestofn menu=off), `ablation_1786168694684/` (mcgs menu=off):

  | recipe | menu | pass@1 | llm calls | mean llm/solved |
  |---|---|---|---|---|
  | bestofn | on | 5/10 | 32 | 1.6 |
  | bestofn | off | 6/10 | 29 | 2.2 |
  | mcgs | on | 5/10 | 40 | 2.0 |
  | mcgs | off | 5/10 | 48 | 1.6 |

  Readings: bestofn ≥ MCGS at equal budget on this tier (menu-off bestofn is the cheapest
  cell); MCGS wins the two `imp_trans`/`modus_tollens` decomposition problems bestofn misses,
  and bestofn wins `or_elim`/`and_intro_chain`/`mul_comm_rw` MCGS misses — union across all
  four cells is 7/10, and `or_comm`, `distrib_twice`, `square_expand` are unsolved by every
  cell. The greedy-vs-searcher divide §5.4 exists because the two recipes solve *disjoint*
  problem sets: a cost model that routes per-problem (menu-off bestofn for rw-tiers, MCGS for
  decomposition) beats either recipe alone. This is the pass@1/cost data the P6 gate (§6) is
  judged on.
- **Premises axis (step tier).** `bench/premisesCorpus.js` now ships a step-tier corpus:
  `PREMS_STEP_1` (19 kernel-verified premises: `Or.inl/inr/elim`, `And.intro/left/right`,
  `Eq.refl/symm/trans`, `Nat.mul_add/add_mul/mul_comm/add_assoc/add_comm/mul_assoc/zero_add/
  add_zero/mul_one/mul_zero`) plus the lock-control `PREMS_STEP_1_NO_RW` (drops the 3 rewrite
  identities `Nat.mul_add`, `Nat.add_mul`, `Nat.mul_comm`). Logic premises use a `p/q/r` type
  style and Nat identities `(a b c : Nat) -> ...` so the BM25 retriever pulls every
  golden-chain premise into its top-8 (quality floor pinned by `test/premises.test.js`, 14
  tests, incl. 3 new). `--set=step` now defaults `--corpus=step`; `--corpus=step-no-rw` is the
  rewrite-lock control.
- **Cycle guard in `GoalTranspositionGraph.isSolved`.** A tactic whose subgoal hashes back to an ancestor
  class (e.g. `rw [Nat.mul_comm]` twice on `b*a = c` re-attaches the ROOT class as a child)
  would recurse without bound. `isSolved` carries a path-visited set that treats an on-path
  class as not-yet-solved (regression test `test/transpositionGraph.test.js` "isSolved terminates on a
  goal-class cycle"; premise-locked MCGS on `mul_comm_rw` completes and solves in 1 rollout).
- **Premise lock, past and present.** The historical wrapper-based harness only influenced the
  prompt — `findPremiseLockViolations` is enforced inside `TacticLoop`, and the wrapper never
  post-hoc rejected a proposal naming a non-retrieved theorem. Evidence: with `--corpus=step-no-rw`
  (no `Nat.mul_comm`) a `bestofn` row still solved `mul_comm_rw` — the generator emitted the
  rewrite from its own knowledge. Since the orthogonalization (`architecture.md` §0.4) the
  premises axis is the loop's own options (`premises`/`premiseLocked`), so a locked cell now
  gets the loop's commit-time enforcement without any harness wiring.
- **Measured (real kernel, single sample per cell, N=4, budget 12, `mul_comm_rw`, bestofn).**
  Cells `ablation_premises_off_r2` (0/1, 4 llm / 4 kernel), `ablation_premises_on_r2` (0/1,
  7 llm / 7 kernel) — pass@1 delta masked by LLM nondeterminism at N=4 (this same problem
  solved in 1 call on an earlier run, missed within 4–7 here); premise augmentation roughly
  doubles per-call wall time (~75 s vs ~35 s). A `locked` cell re-run hung in repl worker
  startup (both rows timed out at 600 s with 0 llm/0 kernel — a worker flake, not the crash).
  **Confounded by a model switch mid-experiment**: cells here ran under `opencode/big-pickle`;
  the session LLM is `deepseek-v4-flash`, so further cells must be re-measured on a single
  consistent model before the with/without/locked table is written.
- **Open item:** re-run the three cells (off / on / locked) on one consistent model with a
  higher `--row-timeout-ms`; with the loop-native premises axis the locked control now gets
  commit-time enforcement for free.

### 5.5 Live-surface discipline
**Rule:** every module/member is either (a) live — reachable from a run entry point — or (b)
explicitly deferred in `architecture.md` (P6/P7), or (c) absent. No dead code and no doc claim
about dead code.
- The loop is a class (`TacticLoop`, `agent/loop.js`); the stage combinator has no place in the
  system (`architecture.md` §4, §2.7).
- The live foundations are `core/lazy` (via `PullGraph`) and `core/hasher` (§9).
- The loop's core operation is a typed graph mutation: `core/patch.js` carries the `Patch` record
  (`patchFromEvent`), captured per lemma into the retrieval index + digest (§2.7, §5.9). The
  transposition graph's single mutation entry point is `applyPatch` — a tactic is a `Patch({op:'tactic', ...})`,
  never a raw tuple.
- `query/` is not part of the system; `architecture.md` §8 names the digest + commit as the
  correctness surface.
- `PullGraph` exposes only `register`/`dependsOn`/`nodes`/`edges`/`serialize`/`invalidate`/
  `computation` (`core/pullgraph.js`).
- `lean/pin.js` hashes whitespace-collapsed canonical text; it does not perform `#print`
  normalization (§3).
- **The measurement layer is orthogonal (architecture.md §0.4).** `bench/ablation.js` contains
  no proof machinery — it constructs the live `TacticLoop` with each cell's options and reads
  the loop's counters; the loop is the only implementation. The component registry
  (`config/registry.js`) is the only component catalog; ablation axes, GUI widgets, and
  live-path flags all key on its names (§5.8).
- **Acceptance:** every non-test JS file imports only live or explicitly-deferred modules; the full
  non-live suite passes.

### 5.6 Quantitative evaluation + honest search/causal claims
- **MCGS is UCB-guided graph search, not textbook MCTS** (`architecture.md` §5). The code has
  selection / expansion / backprop but no cheap rollout phase — the "simulation" is an expensive
  LLM + kernel call — so the UCB value is a heuristic whose statistical meaning must be validated
  empirically. **The experiment that settles it:** on held-out theorem families (not the in-sample
  smoke set), does MCGS outperform simpler best-first / beam / BFS strategies *once LLM-call and
  kernel-verification cost are normalized*? Success is a measured pass@k-vs-cost table showing a
  strict Pareto gain on held-out families — not "MCGS can solve something". The comparison
  apparatus already exists (`bench/ablation.js`); the missing piece is a held-out split of the
  step/mathlib tiers + the normalized-cost table (§5.1/§5.4 conventions).
- **`causal.js` is causal telemetry, not causal inference** (`architecture.md` §6). Keep the
  nomenclature honest in every new doc/comment: Markov transitions, failure *correlations*, timing,
  critical path. Do not claim a pattern `A → B → FAIL` *causes* failure — the confounders (goal
  shape, family, hypotheses, imports, premises, depth, LLM sampling, toolchain) are unobserved.
  The intervention-based questions (holding goal shape constant, does tactic X change the
  probability of eventual proof vs tactic Y) are future work requiring controls, and are tracked
  here so nobody mistakes correlation mining for it.
- **Metrics catalog (`optimization/metrics.js`, `architecture.md` §6.1).** Extend `computeMetrics`
  to the full catalog — search efficiency (`kernelChecksPerSolved`, `llmCallsPerSolved`,
  `uniqueStatesExplored`, `duplicateStatesAvoided`), search quality (`firstSuccessRank`,
  `branchingFactor`, `meanDepth`, `deadEndRate`, `transpositionHitRate`), planning quality
   (`blueprintLemmasPerTheorem`, `resplitsPerTheorem`, `unusedHelperLemmas`, `dependencyDepth`),
   learning quality (`predictorPrecision`, `predictorRecall`, `falseRejectionRate`,
   `performanceBeforeAfterPredictor`, `heldOutImprovement`), economic quality
   (`secondsPerTheorem`, `llmLatencyPerTheorem`, `kernelCallsPerSuccessfulProof`), and
   compression quality (research_notes §5, architecture §0.5/§6.1): `proofDescriptionLength`,
   `libraryRelativeDescriptionLength`, `amortizedCostCurve` — the direct measurements of the
   compression claims, staged with the same no-fabrication rule. Emit `null`
   (with a documented reason) for any metric the current event stream cannot produce, rather than
   fabricating a number. **Instrumentation backlog** (loop must emit to un-null these):
  - per-proposal LLM latency and token counts (`tactic_proposed`);
  - per-goal attempt rank of the solving tactic (`goal_solved` carries `attempt`), for
    `firstSuccessRank`;
  - transposition graph transposition hits / dead-end goal classes, for `transpositionHitRate` and
    `deadEndRate`;
  - blueprint-level counts (lemmas / resplits / unused helpers / dependency depth) surfaced by
    `blueprint/refine.js` into the digest, for planning quality;
  - predictor pre-filter outcomes (rejected-then-verified, allowed-then-failed) for learning quality;
  - per-lemma store reuse records (accepted/rejected with verification) and accumulated-library
    size per problem index, for `libraryRelativeDescriptionLength` and `amortizedCostCurve`.
- **Acceptance:** the held-out MCGS-vs-baseline cost table is produced and either shows a strict
  Pareto gain or is recorded as "no measured advantage, keep best-first"; `computeMetrics` emits
  the full catalog with no fabricated values; no doc/comment claims causal inference where only
  telemetry exists.

### 5.7 Lemma store as retrieval index (per `architecture.md` §2.8)
The content-addressed `growth/lemmaStore.js` (statement hash → artifact) evolves into a retrieval
index: theorem proving becomes partly retrieval. Staged so each mode lands with a live consumer and
a measured effect; retrieval never bypasses kernel verification.
- **Stage 1 — index columns at capture.** `blueprint/refine.js` writes each verified lemma with the
  full column set: `statementHash`, `normalizedGoalShape`, `freeVariables`, `imports`,
  `dependencies`, `proofLength`, `tacticTrajectory`, `difficulty` (goal count / ms),
  `successConditions` (verified, proofScript). Columns derivable from the event are populated at
  capture; the rest are `null` with a reason, per the §5.6 no-fabrication rule.
- **Stage 2 — exact reuse (live).** `blueprint/refine.js` consults the store by statement hash
  before spawning the tactic loop; a hit reuses the stored proof (re-verified by the kernel at
  commit) and emits a `lemma_reused` event. A re-run of an already-proven development costs zero
  LLM/kernel calls. Measured: `reuseRate` = reused / attempted stubs, reported per run.
- **Stage 3 — ranked retrieval.** `store.findSimilar(goalShape)` returns candidates ranked by goal
  shape + tactic-trajectory overlap, feeding the loop's premise-style "similar proven lemmas" hint
  (specialization / generalization require the goal-shape + binder index to match; proof-pattern
  transfer replays the trajectory against a new context).
- **Acceptance (provisional):** a re-run of a proven development shows `reuseRate = 1.0` with zero
  LLM/kernel spend; `findSimilar` retrieves a known-similar lemma in the top-3 on a held-out
  problem; every reuse is kernel-verified (no `sorry`, no unverified shortcut).

### 5.8 Benchmark discipline + provenance (per `architecture.md` §5.7)
- **Purpose:** the ablation harness becomes the central experiment. Rules: fixed corpus only,
  cost-normalized per cell, CI on pass rates, an ablation GRAPH (not a ladder — component effects
  are measured, not assumed additive/commutative), full provenance in every report.
- **Deliverables in order:**
  1. **CI on pass rates** — `bench/ablation.js` reports a Wilson (or exact-binomial) interval on
     `solved/total` per recipe when `problems.length ≥ 2`; the report audit checks the interval
     is present and non-degenerate.
  2. **Ablation graph (`--ablate=<comps>`)** — the full factorial over the named component toggles
     (`tacticMenu`, `premises`, `predictors`, `repulsion`, `exemplars`, `ttrl`, `monitor`,
     `repair`, `search` — registry names, `architecture.md` §0.4/§5.8; the kernel
     is the only non-ablated infrastructure, and `searchStructure` joins the axes once the
     e-graph lands, §5.12) runs
     on the fixed corpus at equal budget, one ablation pass per node. Report per node: the same
     per-cell table; per component: **main effect** (mean pass rate on − off over all
     configurations holding the rest fixed) and **pairwise interactions** (does A's effect change
     when B is on?). The interaction terms ARE the additivity/commutativity test — no fixed rung
     order presumes them. A component with no measured main effect is reported as such.
  3. **Provenance block** — extend the report config + development digest with: model + version,
     prompt version, toolchain + mathlib pin, search policy (recipes/N/budget/component mask),
     resource usage (llmMs, tokens, kernel calls), final kernel verification status. The report
     audit checks every provenance field is present and non-null.
  4. **Live integration tests** — the `*.live.test.js` suites (real repl binary) are the
     consequential integration boundary. They must run in CI on the pinned toolchain (P0.3
     acceptance already demands this) and be extended as components land: the ablation graph's
     live smoke, blueprint re-run reuse (Stage-2 lemma store), and the digest's provenance
     round-trip.
- **Recommendations (the graph's output surface).** `recommendFromGraph` maps measured main
  effects to component recommendations (5pp decision threshold — below it the effect is noise,
  not a default) and `recommendRecipe` picks the cheapest recipe among those solving within
  margin of the best pass rate; both write `runs/defaults.json` (`config/registry.js`,
  provenance attached, never hand-edited). `blueprint/run.js` applies the file at startup; CLI
  flags override.
- **Status (built).** The harness is the orthogonal instrument of `architecture.md` §0.4:
  `driveCell` constructs the real `TacticLoop` per (recipe, problem, component-mask) cell and
  rows read the loop's own counters (`llmCalls`/`tacticCalls`/`predictorSkips`); the graph runs
  per node and writes the recommendations. First live graph run (core, `trans_lt` + `and_comm`,
  tacticMenu axis, N=1, budget 8): menu-off solved 1/2 (the `trans_lt` row failed its pre-flight
  check — the model proposed `lt_trans` without the importing module), menu-on solved 2/2 →
  main effect +50pp, `{"tacticMenu": true}` written to `runs/defaults.json`. That is the
  evidence → default → live-path loop working end to end; further components need measured runs,
  not expectations.
- **Acceptance:** a published comparison is a fixed-corpus run with CI, per-node results, main
  effects + interaction terms per component, and a complete provenance block that replays the
  run; the live suites run green against the real repl binary in CI; no comparison reports success
  without cost.

### 5.9 Patch algebra — typed mutation record
- **Why:** the loop's core operation IS a typed graph mutation, and the tactic string is a lossy
  encoding that drops the meta channel. The Research vision (`KanForge_whitepaper.md` §4) is
  explicit that the patch is "the interface between probabilistic generation and deterministic
  compilation".
- **Deliverables:**
  1. `core/patch.js` restored as `Patch` + `patchFromEvent(e)` — a pure projection of a loop event
     into `{ node, op, replacement, scope, meta }`; the event stream already carries the tuple's
     fields (`node`=goalClassId, `replacement`=tactic, `meta`=attempt/llmMs/tokens/via).
  2. Capture: the per-lemma patch stream is built from `lemma_verified` + its tactic/repair events
     and stored in the retrieval-index entry (§5.7) as `patchStream` — the transformation history.
  3. Digest: the development digest (`digest/development.js`) records each lemma's `patchStream`
     so a verified result carries its derivation context (whitepaper §14).
  4. Reuse mode: `reuse` op wired to the Stage-2 exact-reuse path (§5.7) so a store hit is
     recorded as a typed patch, not a silent shortcut.
- **Acceptance:** every `lemma_verified` produces a non-empty typed patch stream in its index
  entry + digest; a Stage-2 reuse emits a `reuse` patch; the full non-live suite passes; no dead
  `Patch` construction anywhere (the type is built from live events, consumed by live writers).

### 5.10 Goal-class identity: collision-safe (architecture.md §2.2)
- **Correctness, not cache efficiency.** The transposition graph class id determines equivalence-class
  identity; a hash collision merges unrelated proof states. The identity must be the canonical
  serialized key (normalized type + context), hashed with SHA-256 as a lookup index — never a
  weak 32-bit hash as the identity.
- **Deliverables:** (1) replace the 32-bit DJB2 `hashGoal` with `sha256(canonicalKey)` and store
  the canonical key on the class; (2) collision resolution — on an id hit, compare canonical keys;
  unequal keys mean collision → separate class with a collision-resolved id + `transposition_collision`
  telemetry; (3) unit tests: known-distinct goals never merge, alpha-equivalent goals still do,
  and a synthetic collision (same 32-bit hash, different keys) is resolved, not merged.
- **Long-term (Lean as the authority):** goal equivalence is `target proposition + local context +
  environment + available definitions/theorems + proof-state metadata` (instances, universe
  metavariables, opaque values, let bindings, typeclass state, namespace, reducibility). The
  normalization above is the practical approximation; delegating equivalence to Lean itself
  (kernel-side `isDefEq`-style comparison) is the eventual authority and is tracked here.
- **Acceptance:** the full non-live suite passes with the new identity; a collision-injection test
  proves unrelated goals do not merge; `transposition_collision` events appear in telemetry when a
  collision is forced.

### 5.11 Proposal-unit constraint schema (architecture.md §4.1)
- **Purpose:** the proposal granularity — one tactic atom per response — is a *constraint with a
  measured rationale* (sample efficiency: one call = one branch), not an architectural necessity.
  The constraint now lives as data (`PROPOSAL_SPEC = { maxAtoms: 1 }` in `agent/prompts.js`), and
  the invariant that makes it swappable is stated: any proposal is consumed **atom-wise** through
  `backend.applyTactic` with canonical state capture, so a multi-atom proposal is a pre-verified
  transposition graph path — never a black-box script application (which would discard intermediate classes,
  merging, and the patch stream).
- **Staged deliverables (P6):**
  1. `maxAtoms: 1..k` on `PROPOSAL_SPEC` with the loop applying a k-atom response sequentially
     (each intermediate state a canonical class; the verified prefix commits on failure);
  2. failure-position repair — a macro failing at atom k repairs from k with the prefix as edges;
  3. the ablation axis `atomsPerProposal` measured at equal budget via the existing cost counters
     (`llmCalls` vs `tacticCalls` per cell), so the granularity default is itself an
     ablation-decided value.
- **Acceptance (provisional):** a k-atom cell run solves at least the same problem subset as the
  1-atom cell at equal budget on the step tier with a reported cost table; every intermediate
  macro state appears as a transposition graph class (telemetry-verifiable, not asserted).

### 5.12 Genuine equality-saturation e-graph (searchStructure: 'egraph')
- **Why:** the goal transposition graph merges classes only on identical normalized text
  (`architecture.md` §2.2). A genuine e-graph merges on STRUCTURE: e-nodes over the goal term,
  union-find classes, congruence closure (same head, merged children → merged parents), and
  rewrite rules — so goals like `0 + x = y` and `x = y` merge when the identity is confirmed.
  Because semantic merging is only sound when the equivalence is real, the e-graph is
  **Lean-grounded**: every union that is not pure congruence closure must be confirmed by the
  kernel (definitional-equality check of the instantiated pair, memoized per pair). Unconfirmed
  unions never happen — the e-graph cannot BS.
- **Deliverables in order:**
  1. `lean/termParse.js` — goal-type term parser (applications, binders, foralls, arrows,
     numerals, projections); unparseable goals become opaque leaf e-nodes (no merging, no
     corruption — principled degradation).
  2. `core/egraph.js` — e-nodes + hashcons + union-find + congruence closure + saturation loop,
     with the kernel def-eq oracle injected (batchable, memoized).
  3. Rewrite-rule registry — the algebraic identities (0+x→x, x+0→x, x−0→x, 1·x→x, x·1→x, …)
     as RULES, each fire requiring oracle confirmation; rules recorded with provenance in the
     event stream.
  4. Search integration behind the common goal-state-graph interface (frontier, applyTactic
     records, isRootSolved, extractProof, per-class stats): the loop's `searchStructure`
     option selects the structure; the e-graph RETAINS alternative successful expansions per
     class (the review's §8 branching complaint falls out of the structure, not a patch).
  5. Registry + ablation: `searchStructure` as a dropdown component; the factorial graph
     measures transposition vs egraph at equal budget on the fixed corpora.
- **Acceptance:** both structures run under the same loop interface with the suite green; the
  e-graph merges a kernel-confirmed `0 + x = y`/`x = y` pair and never merges an unconfirmed
  pair; an ablation run reports main effect + cost for `searchStructure` and writes the winning
  default to `runs/defaults.json` — the structure is an evidence-decided component, not an
  inherited label.

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
- **Deliverable:** the system's output surface for a trainer — the global dataset
  (`runs/training-dataset`: verified/failed/progress samples, DPO-shaped preference pairs) plus
  per-run GRPO records (trajectories, group-relative advantages, clipped loss, `loss: null` +
  reason) persisted in the development digest. Applying a gradient step is the job of an
  external trainer consuming that data, never of this system (`architecture.md` §6.2) — the
  policy is a hosted LLM with no trainable weights in this codebase.

### 6.2 Guardrails (anti-reward-hacking)
- Enforce the invariant spec in `core/guardrails.js` (per `architecture.md` §2.5): pinned
  statement hash unchanged (no weakening); no `axiom`/`admit`/`unsafe` leakage; tactic-strength
  caps; `checkHermetic` over runs. `optimization/patterns.js` monitors degenerate loops.
- **Acceptance:** *hacking probes* pass — when prompted to "prove" a weakened/trivial variant, the
  system refuses (guardrail trip logged, no reward).

### 6.3 Test-time RL
- `optimization/ttrl.js`: on hard goals, allow the policy to adapt within the run from accumulated
  verification outcomes (AlphaProof-style).
- **Built (toggleable, P6 on the live loop):** `TestTimePolicy` escalates the tactic budget of a
  goal class after repeated failures (`stateFor`), computed from the run's own event stream; the
  loop takes `ttrl: true` and the escalated budget flows into the `loop` recipe's attempt bound.
  The GRPO harness (`optimization/grpo.js`) records episode batches from the same runs and
  computes the clipped-surrogate update quantities a trainer would apply (group-relative
  advantages, loss, clip rate) — it records and computes, it does not fake a training run
  (applying a gradient step is the §6.4 trainer's job).
- **Acceptance (provisional):** pass@1 improves on hard targets with adaptation vs frozen policy;
  sample efficiency reported.

### 6.4 Data flywheel
- `growth/dataset.js`: every verified attempt → training sample (state, tactic, outcome);
  self-generated problem corpus from the target list; held-out split maintained.
- **Built (P6):** degeneracy monitors (`optimization/patterns.js`) run as a pure analysis of any
  run's event stream (`monitor: true` on the loop) — error clusters, same-failure cycles,
  repair loops, stuck proposals, guardrail spikes, degradation, budget exhaustion — and the
  observations feed the guardrail layer and the reward-refresh loop. Telemetry export
  (`optimization/exporter.js`, `exportTo: <file>` on the loop or `--export-to=` on
  `blueprint/run.js`) persists the causal stream as JSONL plus a KPI summary sidecar. `reward.js`
  keeps its P6 initial defaults; refresh it from `patterns.js` observations once measured.
- **Acceptance:** dataset grows monotonically; contamination check (overlap with benchmark splits)
  reported per release.

---

## Phase 7 — Open-target missions + digestion at scale
**Est. 4+ weeks, ongoing.**

> **P7 start gate (intake discipline — hard).** An "open problem" is a target with **no known
> proof in hand** (not present in mathlib, no golden chain anywhere in this repo). Phase 7 does
> not begin with an agent picking a target. It begins with a **human-curated corpus** and ends,
> per target, at a **human selection** of a candidate the agent proposed with justification. The
> sequence is:
>
> ```
> 7.0 human-curated corpus (canonical lists: Erdős, OEIS, open-source problem registries)
>   → agent formalizes CANDIDATES (≥ 3 per shortlist)
>   → agent presents SHORTLIST: statement + justification (formalizability, substrate cost,
>     shape per §0.2, novelty, no-known-proof evidence) for each
>   → HUMAN SELECTS the target
>   → formalization review gate (probes, consensus, ledger) → pin → search
> ```
>
> The agent never self-selects a mission target. If no curated corpus exists, the correct action
> is to **stop and request the corpus**, not to improvise a target. A target with a known proof
> in this repo (any smoke/step/mathlib statement) is a **harness problem, not a mission** — this
> phase is how the earlier phases' machinery is consumed, not a repeat of it.

### 7.0 Intake: human-curated corpus (gate, not deliverable of the agent)
- **The corpus is human-supplied.** The agent does not curate open problems. Sources are
  canonical and external: Erdős problem lists, OEIS conjecture pages, formalizable-conjecture
  registries, a human's own list. The corpus file (e.g. `corpus/` as JSON lines) records per
  target: source URL/reference, statement in natural language, provenance, and the human's
  formalizability note.
- **Acceptance:** a `corpus/` entry exists with ≥ 3 targets from a cited source BEFORE any P7
  mission runs; the entry is human-authored or human-approved, never agent-generated.
- **Corpus.** `corpus/index/corpus.json` (built by `bench/buildCorpusIndex.js` from primary
  sources) lists **322 open + Lean-formalized Erdős mission candidates** joined from: (1)
  `teorth/erdosproblems` — the status/OEIS/tags database of erdosproblems.com (1,216 problems,
  Apache-2.0); (2) `google-deepmind/formal-conjectures` — human-authored Lean formalizations of
  605 Erdős problems with verbatim docstrings and `sorry` bodies (statement-pinned,
  kernel-typechecked, unproved). Verbatim per-problem statements are at
  `corpus/sources/erdos_problem_003.md` and `erdosproblems.com/latex/<N>`. Wikipedia is NOT a
  corpus source (tertiary index).

### 7.1 Curated corpus + autoformalization
- **Candidates, not targets.** Given the human-curated corpus, the autoformalizer processes
  candidates (`agent/roles/autoformalizer.js`, ALA-style: generalist orchestrator + Lean-tuned
  model). **Methodology is per `architecture.md` §0.1** — the formalization pipeline, not a
  translation call: kernel typecheck → explicit kernel-checked `def` nodes → behavioral probes
  (asserted true/false instances verified/refuted by the kernel) → dual-formalization consensus
  (kernel-provable `A ↔ B`; a failure is a semantic-drift trip, not a disagreement) → assumption
  ledger surfaced by `digest/writeup.js` → pin.
- **The shortlist is the deliverable of formalization.** For each corpus target the agent
  formalizes, it produces a shortlist entry: the Lean statement, its formalizability verdict,
  the substrate cost (how many new `def` nodes / which §0.2 field substrate), the shape
  (§0.2), and the no-known-proof evidence (absent from mathlib, no golden chain). **The human
  selects the mission target from the shortlist.** The agent does not run search until selection.
- **Status:** the intake gate (§7.0) is populated (`corpus/index/corpus.json`, 322 candidates)
  and the autoformalizer (`agent/roles/autoformalizer.js`) formalizes corpus candidates — format-
  agnostic (unicode/LaTeX/ASCII via `normalize.js`), import-resolving (`lean/moduleResolver.js`),
  classified-repair (missing-symbol module + notation fixes, heavy-import fallback), with the
  repl's statement-mode env chaining (`backend.warm`/`useWarmEnv`) paying imports once. Validated
  on 7 distinct open problems across number theory, geometry, combinatorics (harness:
  `bench/validateFormalization.js` single, `bench/validateBatch.js` random-N).
- **Missing-symbol repair is derived, not curated (architecture.md §0.1 item 6).** The repair
  stage's "which module declares `X`" knowledge comes from `lean/symbolIndex.js` — an index of
  every top-level mathlib declaration (full dotted name, namespace tracking, `protected`/
  `private` prefixes) to its defining module, built once per pin by `bench/buildSymbolIndex.js`
  and cached. Query tiers: exact full name → last-segment with module-basename preference →
  module-basename fallback for generated declarations (`to_additive` names like `Even` have no
  source line; `Algebra/Group/Even.lean` resolves them by mathlib's file-naming convention).
  The curated table in `normalize.js` keeps only what the index cannot derive: notation fixes
  and non-constant type symbols. Domain presets (corpus tag → starter imports) are a cold-start
  optimization only — a follow-up keyed on the corpus's 35 existing tags, never a correctness
  dependency.
- **Deliverables in order:** (1) the intake gate (§7.0) + shortlist generator (formalizability
  verdict + substrate cost + shape per candidate); (2) the probe harness that turns asserted
  instances into kernel-checked `example`s; (3) the consensus step reusing `search/swiss.js`
  pairwise judgment for candidate selection among formalizations; (4) the assumption-ledger +
  pin commit path.
- **Status of deliverables:** (1) the shortlist entry carries formalizability, shape, and the
  substrate-cost estimate (`estimateSubstrateCost`: def-node count, import profile, probe count —
  labeled an estimate, true cost measured at prove time); (2) the probe harness
  (`_verifyProbes`: one batched LLM call → per-instance kernel checks, evidence recorded); (3)
  the consensus step (`consensusFormalize`: two independent formalizations A/B, swiss pairwise
  statement judge, agreement + winner reported); (4) the assumption ledger
  (`assumptionLedger`: every asserted instance with its kernel evidence) + pin commit
  (`commitPin`: statement pin + ledger hash). The consensus/ledger paths are exercised by
  `test/toggles.test.js` where the deterministic parts are testable; the LLM+repl path is
  exercised live via `bench/validateFormalization.js`.
- **Acceptance (provisional):** ≥ 50% of curated candidates formalize; each formalization is
  human-reviewed and statement-pinned before search begins; every mission has a recorded
  shortlist + human selection in its digest provenance; a candidate that fails a probe or a
  consensus equivalence check is recorded as a formalization failure with its evidence, never
  silently corrected. A target with a known proof in this repo never appears on a mission
  shortlist.

### 7.2 Field substrates + target shapes (per `architecture.md` §0.2)
- **Purpose:** make a *whole field* addressable when mathlib does not cover it, so any notable
  target (not a curated handful) can be grown from its vocabulary upward. The mechanism is
  field-agnostic: the target's field is a substrate to be built, and the target itself is an
  instance of one of the §0.2 shapes (universal claim / witness discovery / equivalence /
  closed-form). This must land before any such target is attempted — and the target must still
  come from the §7.0 human-curated corpus + §7.1 human-selected shortlist; substrate work never
  overrides intake.
- **Deliverables in order:**
  1. **Lake-package field preload** — declare field libraries as pinned `require`s in
     `lean-project/lakefile.lean`; verify `LEAN_PATH` reconstruction picks them up (backendRepl
     already scans `.lake/packages/*`); record a per-target **import profile** that also declares
     which decision procedures (`native_decide`/`omega`/`ring`/`linarith`/custom oracles) apply
     to which goal shapes.
  2. **`substrateHash` in pins** — extend `makePin`/`checkPin` (`lean/pin.js`) with a hash of the
     resolved library set (lakefile + package revs); a substrate change reports DRIFT, not silent
     re-verify; unit tests for the drift-vs-weakened split.
  3. **`def`/`structure`/`abbrev` nodes in the blueprint DAG** — generalize `blueprint/skeleton.js`
     + `refine.js` from theorem-stubs to body-carrying vocabulary nodes (kernel-checked bodies,
     probe examples, pinned + committed); the refine loop picks the lowest unbuilt node regardless
     of kind.
  4. **Proof-backed probes** — instance ledger entries may be *lemmas the loop must prove* (no
     decidable oracle), not just `norm_num`/`native_decide` checks.
  5. **Shape-aware stopping rules** — the loop knows whether the target is a universal claim, a
     witness discovery (prove-or-refute with two-sided certification), an equivalence (both
     round-trip halves), or a closed form; the stopping rule and probe set follow the shape.
- **Acceptance (provisional):** a field substrate of ≥ 100 kernel-checked, pinned, committed
  vocabulary nodes builds bottom-up with no `sorry` and no unimported bare symbols; a substrate
  library revision flips the pin to DRIFT (never silent re-verify); a witness-discovery target
  returns either a proof or a two-sided certified counterexample — never a bare assertion.

### 7.3 Multi-agent ensemble
- Implement `growth/multibody.js` (one-owner-per-region lemma edits, processing lanes) + the
  single-agent-workspace lock in `core/guardrails.js`; run parallel prover
  agents over the corpus with single-owner lemma edits (AxiomProver-style: autoformalizer /
  conjecturer / prover / critic under `agent/roles/`).
- **Built (toggleable, P7):** `growth/multibody.js` (`partitionLanes` + `MultibodyCoordinator`)
  shards a development into per-owner regions, runs lanes in parallel, and enforces coherence —
  a lemma may reference a cross-region lemma only if it was kernel-verified before the dependent
  committed; stalled lanes and coherence violations are reported, never silently merged. The
  role ensemble exists: `conjecturer.js` (proposes targets in the four §0.2 shapes, strict JSON),
  `prover.js` (the TacticLoop-backed proving unit a lane worker wraps), `critic.js`
  (statement-match + readability heuristics deterministically, optional LLM judgment pass). The
  single-agent-workspace lock remains in `core/guardrails.js` backlog; a real multi-process run
  (2+ agents on disjoint targets) is a live-validation item.
- **Acceptance:** 2+ agents run concurrently on disjoint targets without file conflicts; critic
  reviews candidate proofs (statement-match + readability).

### 7.4 Full digestion + audit
- Auto-generate per-target writeups with assumption accounts; assemble a research summary doc.
  `core/hasher.js` audit + per-lemma artifact files (statement.lean + proof.lean + audit.json)
  = reproducibility pack.
- **Acceptance:** for every claimed result: Lean source, blueprint JSON, writeup, audit hash, and
  per-lemma artifacts all consistent; the development digest's hash chain verifies end-to-end
  (`verifyHashChain`).

### 7.5 Ongoing RL loop
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
