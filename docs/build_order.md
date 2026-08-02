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

## Phase 0 — Foundations: toolchain + the pure core
**Est. 1–2 weeks.** No AI yet.

### 0.1 Toolchain
- Install `elan` + pinned `lean`/`mathlib4` toolchain; `lake` project with `lakefile.lean`.
- Stand up the Lean backend options (`lean/backend.js` + three impls, per `architecture.md` §3):
  - `lean4web` self-hosted (Apache-2.0) for web demos;
  - `leanprover-community/repl` built for the pinned toolchain (preferred, JSON-lines);
  - `lean` CLI for batch.
- **Deliverable:** `lean/backend.js` adapter interface + all three implementations passing a
  round-trip test: `example : 1 + 1 = 2 := by omega`.

### 0.2 Build the core
- Implement `Lazy`, `LazyTemplate`, `LazyFunctor`, `Pipeline`, `ConfigContext`, `LazyStream`, `lazify`,
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

---

## Phase 1 — Single-step tactic loop + telemetry
**Est. 2 weeks.**

### 1.1 Telemetry bus
- Implement `sharpening/bus.js` (central event bus), `store.js` (bounded event store, causal
  parent links), `metrics.js` (KPI calculator), `patterns.js` (degeneracy monitors),
  `exporter.js` (telemetry export), `core/hasher.js` (hash chains), and the invariant wiring in
  `core/guardrails.js` (names per `architecture.md` §1).
- Add the proof event vocabulary (`architecture.md` §4).
- **Deliverable:** every REPL call and LLM call is a traced causal event with `parent`.

### 1.2 LLM adapter + best-of-N
- `agent/llm.js`: OpenAI/Anthropic-compatible + local (vLLM/Ollama) clients; streaming optional.
- `search/bestofn.js`: for a goal, sample N candidate patches, verify each, keep passers. Pre-filter
  stage before verification (Wave2 cost-model idea, CPU-side): drop known-failing patterns (causal
  predictors), premise-lock violations, and near-duplicate patches.
- **Acceptance (provisional):** on a 20-problem miniF2F smoke set with a frontier model,
  pass@8 ≥ 1 problem; `sharpening/metrics.js` reports success rate, tokens/attempt,
  attempts/lemma. Re-set the threshold from the first run.
- **Search efficiency KPI:** compiler invocations eliminated by the pre-filter (Wave2 §15),
  logged per run.

### 1.3 Query API (vertical slice)
- Implement `query/server.js` (signed, rate-limited) + `/proof/*` endpoints returning events,
  transition matrix (even if sparse), health (endpoints per `architecture.md` §8).
- **Acceptance:** `node kanforge/query/server.js health` and `/proof/events` work over TCP + GUI.

---

## Phase 2 — Proof-state machine + checkpointing
**Est. 1–2 weeks.**

### 2.1 Lemmas as graph nodes
- Wire `PullGraph` to goals: node = goal/lemma with `statementHash`, `proof`, `deps`, cache.
- Error boundaries per node: fallback policy `retry→repair→skip (never weaken)`.
- **Deliverable:** proof of a theorem with 3+ lemmas produces a serializable forest; re-running
  hits the cache (cache-hit stats via `sharpening/metrics.js`).

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
  best-of-N at equal accuracy (report both via `sharpening/metrics.js`). The ≥ 5× figure is a first
  guess; the measured comparison is the fixed criterion.

### 3.2 Sub-proposition error feedback
- For conjunction/disjunction-heavy goals, align error text to the sub-proposition that failed
  (per the 2025 FOL literature).
- **Acceptance:** repair success on the smoke set reported; failure cases logged to
  `sharpening/store.js` for Phase 6 analysis.

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
- `search/bfs.js`, `search/mcgs.js`: best-first over proof states; merge nodes whose goals are
  alpha-equivalent or definitionally equal (share value/visit stats). Node identity is normalized
  in `pullgraph.js` (the adopted core of Wave2's e-graph dedup, `architecture.md` §10) so every
  search variant inherits the merge, not just MCGS.
- **Acceptance (provisional):** MCGS ≥ best-of-N at equal budget on the smoke set; merge rate
  reported. Compare, then decide.

### 5.2 Repulsion + premise retrieval
- `search/repulsion.js` (Goedel-style diversity penalty) and `search/premises.js`
  (LeanDojo-style relevance scoring over mathlib, "premise-locked" search).
- **Acceptance:** ablations logged (with/without each) on the smoke set.

### 5.3 Failure-aware search biasing
- Use `sharpening/causal.js` `getFailurePredictors()` to penalize action sequences known to
  precede FAIL.
- **Acceptance:** predictor list is non-empty and search budget spent on non-predictor branches
  increases.

---

## Phase 6 — RL sharpening
**Est. 4 weeks.**

### 6.1 Reward function + GRPO
- `sharpening/reward.js`: initial defaults per `architecture.md` §6 (tune, don't trust).
- `sharpening/grpo.js`: GRPO over trajectories sampled by the search layer, with Lean
  verification as the outcome oracle.
- **Deliverable:** training harness (single GPU fine-tune on Goedel-Prover-7B or
  DeepSeek-Prover-V2-7B style base); W&B/Prometheus metric export via `sharpening/exporter.js`.

### 6.2 Guardrails (anti-reward-hacking)
- Enforce the invariant spec in `core/guardrails.js` (per `architecture.md` §2.5): pinned
  statement hash unchanged (no weakening); no `axiom`/`admit`/`unsafe` leakage; tactic-strength
  caps; `checkHermetic` over runs. `sharpening/patterns.js` monitors degenerate loops.
- **Acceptance:** *hacking probes* pass — when prompted to "prove" a weakened/trivial variant, the
  system refuses (guardrail trip logged, no reward).

### 6.3 Test-time RL
- `sharpening/ttrl.js`: on hard goals, allow the policy to adapt within the run from accumulated
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
- Auto-generate per-target writeups with assumption accounts; assemble a research summary doc
  (HCT-doc style). `core/hasher.js` audit + git history = reproducibility pack.
- **Acceptance:** for every claimed result: Lean source, blueprint JSON, writeup, audit hash, and
  git commits all consistent and queryable via `/integrity/verify`.

### 7.4 Ongoing RL loop
- Fold every mission run back into 6.4; refresh reward/guardrails from `sharpening/patterns.js`
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
2. The sharpening loop demonstrably improves pass@1 on held-out targets with the same model
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
