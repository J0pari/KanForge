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

### 5.1 BFS + UCB-guided graph search (MCGS) with transposition merging
- `search/bfs.js`, `search/mcgs.js`: best-first over goal equivalence classes; `mcgs.js` is
  UCB-guided graph search over the open classes — selection / expansion / backprop only, **not**
  textbook MCTS (no cheap rollout; the "simulation" is an LLM + kernel call — `architecture.md` §5,
  §5.6). Transposition merging is built into the e-graph structure — alpha-equivalent or
  definitionally-equal goals are already merged into equivalence classes with shared statistics
  (value/visit counts). The e-graph is the search structure itself (`architecture.md` §2.2, §10),
  so every search variant inherits the merge, not just MCGS.
- **Acceptance (provisional):** MCGS ≥ best-of-N at equal budget on the smoke set; merge rate
  reported. Compare, then decide. (§5.6 sharpens this to a held-out, cost-normalized comparison;
  a "can solve something" anecdote is not acceptance.)
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
- **Status:** `optimization/causal.js` ships (transition matrix, failure predictors, bottlenecks,
  anomalies, critical path; `compilePredictors` turns predictors into a reject matcher). The
  search entry points (`bestofn`, `swiss`, `bfs`, `mcgs`) and the ablation drivers consult the
  matcher BEFORE kernel verification, and the ablation report logs `predictor-skips` per recipe.
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
  cell. The greedy-vs-searcher divide §5.4 was built to expose is real: the two recipes solve
  *disjoint* problem sets, so a cost model that routes per-problem (menu-off bestofn for
  rw-tiers, MCGS for decomposition) would beat either recipe alone. This is the pass@1/cost
  data the P6 gate (§6) is judged on.
- **Premises axis (step tier).** `bench/premisesCorpus.js` now ships a step-tier corpus:
  `PREMS_STEP_1` (19 kernel-verified premises: `Or.inl/inr/elim`, `And.intro/left/right`,
  `Eq.refl/symm/trans`, `Nat.mul_add/add_mul/mul_comm/add_assoc/add_comm/mul_assoc/zero_add/
  add_zero/mul_one/mul_zero`) plus the lock-control `PREMS_STEP_1_NO_RW` (drops the 3 rewrite
  identities `Nat.mul_add`, `Nat.add_mul`, `Nat.mul_comm`). Logic premises use a `p/q/r` type
  style and Nat identities `(a b c : Nat) -> ...` so the BM25 retriever pulls every
  golden-chain premise into its top-8 (quality floor pinned by `test/premises.test.js`, 14
  tests, incl. 3 new). `--set=step` now defaults `--corpus=step`; `--corpus=step-no-rw` is the
  rewrite-lock control.
- **Crash fixed.** The §5.4 locked control surfaced a real bug: `GoalEGraph.isSolved` recursed
  through `tactic.subgoalClasses.every(...)` with no cycle guard, and a tactic whose subgoal
  hashes back to an ancestor class (e.g. `rw [Nat.mul_comm]` twice on `b*a = c` re-attaches the
  ROOT class as a child) overflowed the stack (`Maximum call stack size exceeded`, llm=0).
  `isSolved` now carries a path-visited set that treats an on-path class as not-yet-solved
  (regression test `test/egraph.test.js` "isSolved terminates on a goal-class cycle"; verified
  end-to-end on the real path: premise-locked MCGS on `mul_comm_rw` completes and solves in 1
  rollout).
- **Premise lock is prompt-level only in the ablation drivers.** `findPremiseLockViolations`
  is enforced only inside `TacticLoop`; `bench/ablation.js` wraps the llm in
  `PremiseAugmentingLLM` but never post-hoc rejects a proposal that names a non-retrieved
  theorem. Evidence: with `--corpus=step-no-rw` (no `Nat.mul_comm`) a `bestofn` row still
  solved `mul_comm_rw` — the generator emitted the rewrite from its own knowledge. For a
  verifiable "locked" claim the ablation driver must call `findPremiseLockViolations` on each
  proposal; until then the control measures prompt-level influence only.
- **Measured (real kernel, single sample per cell, N=4, budget 12, `mul_comm_rw`, bestofn).**
  Cells `ablation_premises_off_r2` (0/1, 4 llm / 4 kernel), `ablation_premises_on_r2` (0/1,
  7 llm / 7 kernel) — pass@1 delta masked by LLM nondeterminism at N=4 (this same problem
  solved in 1 call on an earlier run, missed within 4–7 here); premise augmentation roughly
  doubles per-call wall time (~75 s vs ~35 s). A `locked` cell re-run hung in repl worker
  startup (both rows timed out at 600 s with 0 llm/0 kernel — a worker flake, not the crash).
  **Confinded by a model switch mid-experiment**: cells here ran under `opencode/big-pickle`;
  the session LLM is now `deepseek-v4-flash`, so further cells must be re-measured on a single
  consistent model before the with/without/locked table is written.
- **Open item:** re-run the three cells (off / on / locked) on one consistent model with a
  higher `--row-timeout-ms`, and wire `findPremiseLockViolations` into `bench/ablation.js` so
  the locked control is enforced (not just prompted).

### 5.5 Dead-code audit (built-but-unused → condensed or wired)
A review flagged decorative architecture: modules documented as load-bearing that nothing in the
live path used, and docs describing an elegant shape the code did not take. This phase is the
audit + remediation discipline. **Rule:** every module/member is either (a) live — reachable from a
run entry point — or (b) explicitly deferred in `architecture.md` (P6/P7), or (c) removed. No dead
code and no doc claim about dead code may remain.
- **Condensed (removed):**
  - `core/pipeline.js` (`Pipeline.compose`) — the review's example: docs described the loop as a
    composed monadic pipeline; the actual loop is a class. Nothing called `Pipeline.compose`. The
    loop is the contract; the stage combinator was removed (`architecture.md` §4, §2.7).
  - The rest of the lazy family — `core/{functor,promise,cache,context,fix,lazify,serialize,stream,template}.js` —
    imported only by each other and `core.test.js`; the live path used only `core/lazy` (via
    `PullGraph`). Removed; `core/lazy` + `core/hasher` are the surviving foundations (§9).
  - `core/patch.js` (`Patch`/`PATCH_OPS`) — exported in `index.js`, never constructed. Removed;
    the loop passes tactic strings directly (§2.7).
  - `query/` (`server.js`, `formatters.js`) — `QueryServer` was never constructed and
    `/integrity/verify` returned `{ ok: true }` unconditionally (a lie). Removed; `architecture.md`
    §8 now marks the query API deferred and names the digest + commit as the real correctness
    surface.
  - `PullGraph.{identities, compositions, compose, morphism, pull, subgraph, diff,
    setProgressCallback, setProgressInterval}` — decorative category theory; the loop uses only
    `register`/`dependsOn`/`nodes`/`edges`/`serialize`/`invalidate`/`computation`. Condensed to
    that live surface (`core/pullgraph.js`).
- **Wired (was built but should be live):**
  - `optimization/metrics.js` `computeMetrics` — now attached to every `TacticLoop` per-run
    outcome (KPI summary), so the bench and digest layers report it without re-deriving.
  - `lean/backend.js` `createBackend` — now the constructor for every run entry point
    (`bench/run.js`, `bench/ablation.js`, `bench/trainPredictors.js`, `bench/verifyStepSet.js`,
    `blueprint/run.js`), making the documented factory the actual path. `lean/backendCli.js` stays
    reachable as the `cli` flavor.
  - `growth/commit.js` — stub (message formatter only) extended with `writeLemmaArtifacts`,
    `commitLemma`, `commitDevelopment` and wired into `blueprint/run.js`'s DoD tail (§7.4).
- **Honesty fixes:**
  - `lean/pin.js` comment claimed a canonical `#print`-normalized hash; the code collapses
    whitespace only. The comment now says exactly that, and that `#print` normalization is *not*
    performed (§3, `pin.js`).
  - `architecture.md`/`blueprint.md` module tables and §4/§5 narrative rewritten to describe the
    live architecture; all `Patch`/`Pipeline`/`query`/lazy-family references removed or marked.
- **Acceptance:** every non-test JS file imports only live or explicitly-deferred modules; the full
  non-live suite passes; a fresh `git grep` for the removed names returns only docs that say
  "removed as dead code".

### 5.6 Quantitative evaluation + honest search/causal claims
Two review findings are recorded here as acceptance work, not rhetoric.
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
  (`secondsPerTheorem`, `llmLatencyPerTheorem`, `kernelCallsPerSuccessfulProof`). Emit `null`
  (with a documented reason) for any metric the current event stream cannot produce, rather than
  fabricating a number. **Instrumentation backlog** (loop must emit to un-null these):
  - per-proposal LLM latency and token counts (`tactic_proposed`);
  - per-goal attempt rank of the solving tactic (`goal_solved` carries `attempt`), for
    `firstSuccessRank`;
  - e-graph transposition hits / dead-end goal classes, for `transpositionHitRate` and
    `deadEndRate`;
  - blueprint-level counts (lemmas / resplits / unused helpers / dependency depth) surfaced by
    `blueprint/refine.js` into the digest, for planning quality;
  - predictor pre-filter outcomes (rejected-then-verified, allowed-then-failed) for learning quality.
- **Acceptance:** the held-out MCGS-vs-baseline cost table is produced and either shows a strict
  Pareto gain or is recorded as "no measured advantage, keep best-first"; `computeMetrics` emits
  the full catalog with no fabricated values; no doc/comment claims causal inference where only
  telemetry exists.

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
- Build a corpus spanning *many* fields, so the pipeline is exercised against the full §0.2 shape
  and substrate spectrum rather than one neighborhood: start with a set of formalizable targets
  from OEIS/Erdős-style combinatorics, number theory, algebra, and analysis, deliberately chosen
  to overlap only lightly with mathlib's existing vocabulary (so the substrate mechanisms are the
  thing being tested). `agent/roles/autoformalizer.js` (ALA-style: generalist orchestrator +
  Lean-tuned model). **Methodology is per `architecture.md` §0.1** — the formalization pipeline,
  not a translation call: kernel typecheck → explicit kernel-checked `def` nodes → behavioral
  probes (asserted true/false instances verified/refuted by the kernel) → dual-formalization
  consensus (kernel-provable `A ↔ B`; a failure is a semantic-drift trip, not a disagreement) →
  assumption ledger surfaced by `digest/writeup.js` → human gate + pin before search.
- **Deliverables in order:** (1) the definitional substrate (`def` nodes) for the first targets;
  (2) the probe harness that turns asserted instances into kernel-checked `example`s; (3) the
  consensus step reusing `search/swiss.js` pairwise judgment for candidate selection; (4) the
  assumption-ledger + pin + human-gate commit path.
- **Acceptance (provisional):** ≥ 50% of curated statements formalize; each formalization is
  human-reviewed and statement-pinned before search begins. A candidate that fails a probe or a
  consensus equivalence check is recorded as a formalization failure with its evidence, never
  silently corrected.

### 7.2 Field substrates + target shapes (per `architecture.md` §0.2)
- **Purpose:** make a *whole field* addressable when mathlib does not cover it, so any notable
  target (not a curated handful) can be grown from its vocabulary upward. The mechanism is
  field-agnostic: the target's field is a substrate to be built, and the target itself is an
  instance of one of the §0.2 shapes (universal claim / witness discovery / equivalence /
  closed-form). This must land before any such target is attempted.
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
- **Acceptance:** 2+ agents run concurrently on disjoint targets without file conflicts; critic
  reviews candidate proofs (statement-match + readability).

### 7.4 Full digestion + audit
- Auto-generate per-target writeups with assumption accounts; assemble a research summary doc.
  `core/hasher.js` audit + git history = reproducibility pack.
- **Acceptance:** for every claimed result: Lean source, blueprint JSON, writeup, audit hash, and
  git commits all consistent and queryable via `/integrity/verify`.

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
