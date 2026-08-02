# KanForge — Blueprint

A pull-based, lazily-evaluated, telemetry-instrumented **agentic proof refinery** for Lean 4,
built by adapting the internals of `J0pari/Builder` (the HCT lazy build system).

**Working title:** *KanForge* — "a forge of Kan extensions: find the best extension of a partial
proof." (The Kan-extension framing is elaborated in `patterns_from_hct.md`; it is a heuristic
frame, not a claim about the mathematics of the agent.)

> This document is the design narrative. It states *why* and *what*. The *how* — module
> contracts, file layout, event vocabulary, reward defaults, wire formats — lives in
> `architecture.md` and is authoritative there. Sequencing, deliverables, and acceptance live in
> `build_order.md`. The evidence base lives in `research_notes_2026.md`.

---

## 1. Goal and non-goals

### 1.1 Goal
A general agentic loop that:
1. takes a target theorem (natural language or Lean statement),
2. **autoformalizes** it into Lean 4,
3. **decomposes** it into an audited blueprint DAG of lemmas,
4. **proves** the DAG bottom-up with an LLM proposing tactics/lemmas,
5. **verifies** every step with the Lean kernel (lean4web / REPL / CLI),
6. **repairs** failures using Lean's error feedback,
7. **sharpens** itself — telemetry → causal analysis → RL signal → better search,
8. **digests** results into human-readable, peer-reviewable writeups.

### 1.2 Non-goals
- A Lean language server. (We *consume* lean4web/REPL/LSP.)
- Reimplementing mathlib. (We *use* mathlib4.)
- Solving the long tail of all open problems. (Target corpus is curated and finite.)

---

## 2. Evidence base

The design decisions below are not novel claims; they are applications of the field's current
consensus. The systems table, the ten working tricks, and the ten warnings are in
`research_notes_2026.md`. The three constraints that shape this blueprint most:

1. **Verifier-as-reward RL is the engine** (trick 1) → telemetry, reward, and search biasing are
   first-class from P1, not a bolt-on.
2. **Open-problem hit rate is low even for DeepMind** (warning 4) → curated, throughput-batched
   corpus; expect partial results.
3. **Reward hacking is structural, not a bug** (warning 2) → guardrails are invariants checked
   continuously, not a feature flag.

---

## 3. What `J0pari/Builder` gives us — module inventory and reuse map

The seeded repo (`scripts/builder.js` ~8k lines, `scripts/query.js` ~1.2k lines) is a lazy
pull-based build system for math documents with deep runtime telemetry. The following modules are
the reusable machinery. Line refs are to the seeded files (they will drift as we port; the mapping
is the stable part).

| Builder module | Line ref | What it does | How we adapt it |
|---|---|---|---|
| `Lazy` | builder.js:79 | memoized thunk (monad: `map`/`flatMap`) | deferred computation of proof goals/lemmas → `core/lazy.js` |
| `LazyTemplate` | builder.js:158 | string only on `toString()` | lazy prompt/tactic templating → `core/template.js` |
| `LazyFunctor` | builder.js:195 | map/extract/lift over lazy structures | work with "possibly-lazy" result trees → `core/functor.js` |
| `Pipeline.kleisli/compose` | builder.js:222 | monadic stage composition | the agent loop as Kleisli composition → `core/pipeline.js` |
| `ConfigContext` | builder.js:281 | environment-passing | per-run config threading (budget, model, lib) → `core/context.js` |
| `LazyStream` | builder.js:324 | head-strict/tail-lazy infinite streams | search frontiers, event streams, telemetry windows → `core/stream.js` |
| `lazify` / `fix` | builder.js:444/475 | proxies; coinductive fixed points | self-referential search streams → `core/lazy.js`, `core/fix.js` |
| `PullGraph` | builder.js:481 | pull-based dependency DAG, invalidation, serialize/deserialize, error boundaries | **the proof DAG** — lemmas as nodes, tactics as morphisms, checkpoint/resume → `core/pullgraph.js` |
| `PullPromise` | builder.js:789 | async-thunk pull | async Lean round-trips → `core/promise.js` |
| `PullCache` | builder.js:821 | lazy keyed cache | lemma/mathlib caches → `core/cache.js` |
| `LazyGit` | builder.js:1108 | stage→commit→push pipeline | **library growth**: commit each verified lemma → `growth/commit.js` |
| `StateSerializer` | builder.js:1250 | pluggable serialization | telemetry snapshots, checkpoints → `core/serialize.js` |
| `ConfigPatternValidator` | builder.js:1389 | config hygiene, magic-number detection | prompt/param hygiene; weird-constant detection → `core/guardrails.js` |
| `EventStore` | builder.js:2922 | bounded event store, LRU maps, causal parent links | full causal trace of the agent → `sharpening/store.js` |
| `CausalAnalysis` | builder.js:2993 | Markov transition matrix, failure predictors, bottlenecks, anomalies, critical path | **the RL feature layer** — which actions lead to FAIL → `sharpening/causal.js` |
| `MetricsCalculator` | builder.js:3244 | rates, memory pressure, task success, perf profile | agent KPIs (success rate, tokens/proof) → `sharpening/metrics.js` |
| `PatternDetection` | builder.js:3362 | memory-leak/degradation/cluster/spike detection | reward-hacking / loop-degeneracy monitors → `sharpening/patterns.js` |
| `TelemetryExporter` | builder.js:3443 | Prometheus/Datadog/JSON, lazy telemetry tree | metrics feed for the RL loop and dashboards → `sharpening/exporter.js` |
| `InvariantChecker` | builder.js:3720 | hermeticity, cache validity, incremental correctness | folded into the guardrail invariant spec → `core/guardrails.js` |
| `TraceOrchestrator` | builder.js:3787 | facade wiring everything; `trace()`, `error()`, `performance()` | central event bus → `sharpening/bus.js` |
| `ConflictDetector` | builder.js:4123 | one-owner-per-region, processing lanes | multi-agent single-owner lemma edits → `growth/multibody.js` |
| `Hasher` | builder.js:4211 | absorbing hash chains, integrity verify | statement pinning + tamper-evident audit → `core/hasher.js` |
| `DocumentProcessor` / `LaTeXProcessor` | builder.js:4336/4748 | parse → sections → math blocks | digesting theorem statements and proof writeups → `digest/writeup.js` |
| `HTML/PDF/MarkdownModality` | builder.js:5113+ | multi-format rendering with KaTeX | **digestion layer** output (human-readable proofs) → `digest/writeup.js` |
| `ProcessLockManager` | builder.js:6470 | single-instance lock | one agent per workspace → `core/guardrails.js` |
| `watch()` + dedup | builder.js:7179 | incremental rebuild on change | react to library/statement changes → `core/pullgraph.js` |
| `QueryServer` | builder.js:7570 | signed, rate-limited TCP query API over telemetry | **"why is the agent failing" API** → `query/server.js` |
| query.js formatters | query.js:141+ | semantic text formatters (transition matrix, predictors, critical path) | CLI/GUI explanations → `query/formatters.js` |
| `QuerySession` + GUI | query.js:360+/674+ | interactive session, WebSocket dashboard | the operator cockpit → `query/gui/` |

### 3.1 Reuse strategy
- **Port verbatim (style adjusted):** the pure machinery — `Lazy`, `LazyStream`, `PullPromise`,
  `PullCache`, `Pipeline`, `fix`, `lazify`, `PullGraph`, `StateSerializer`. These have no domain
  assumptions and full unit-test coverage in the seeded repo.
- **Rebind the domain types:** "document/section" → "development/lemma"; "file hash" →
  "statement hash"; "format pipeline" → "proof pipeline"; "build" → "prove-and-verify".
- **Extend `TraceOrchestrator`'s event vocabulary** with proof events (canonical list in
  `architecture.md` §4).
- **Reuse `Hasher` + query.js's hash-chained logger** as the audit trail for reproducibility.
- **Port, don't re-architect:** `ConflictDetector`, `ProcessLockManager`, `MetricsCalculator`,
  `CausalAnalysis`, `PatternDetection` have behavior we need; we port them and add proof-specific
  event types on top.

---

## 4. How the HCT documents elicit the patterns

The transformed example documents (`output/primer.md`, `output/working.md`) are a 27-layer higher
category theory curriculum. The **load-bearing** mappings — the ones that actually drive design
decisions in `architecture.md` — are:

1. **Simplicial sets & ∞-categories → coinductive lazy search.** ∞-structures are determined by
   all finite skeleta. Keep an infinite, lazily-materialized frontier; the agent forces only the
   finite skeleton it needs. **Horn-filling = the repair loop**: a failing goal is a horn missing
   its filler.
2. **Straightening / unstraightening → the proof-tree ↔ tactic-script duality.** A fibration over
   C *is* a functor C → Cat. Keep the proof as a tree (good for surgery) and as a script (good for
   Lean) and switch representations losslessly — `core/state.js`. **This is the backbone; never
   edit only one side.**
3. **Kan extensions → the search primitive.** A Kan extension is the best approximate extension
   of a functor. Every agent act is a Kan extension: given the current partial proof and the
   target, find the most general fill. `fix`/coinduction gives the infinite extension.
4. **Adjunctions → generator ⊣ verifier.** LLM-generate is left adjoint to Lean-verify. A goal is
   solved at the *universal arrow*: when the generator's candidate composes cleanly through the
   verifier's certificate. Two-sided — search *and* filter for free.
5. **Monads & algebras → the loop as a monad.** `Pipeline.kleisli` is Kleisli composition; the
   agent is a monadic effect stack (LLM, Lean check, cache, log, reward).
6. **Presentable/accessible categories → the caching rule.** Compact objects (finite data) ↔
   eagerly materialize small lemmas; filtered colimits ↔ lazily generate everything else.
7. **Stable ∞-categories → residual tracking.** Every tactic application carries its residual goal
   (cofiber); the collection of residuals is a spectrum of open goals; progress = the spectrum
   strictly decreases in a well-founded order.
8. **∞-topoi, descent, hypercovers → distributed proving.** Shard a development into a hypercover
   of lemma sub-goals, verify locally, require *descent* (coherence on overlaps) before merging.
9. **Modalities → the skeleton/refine phase switch.** **Skeleton** (idempotent comonad:
   approximate a theorem by a DAG of `sorry`-stub lemmas) and **Refine** (idempotent monad: fill
   the lowest `sorry`). The blueprint statement set never changes — only unproved stubs shrink.
10. **Giraud axioms → an intrinsic invariant spec.** Like Giraud axioms characterize a topos,
    define correctness by a minimal checkable invariant set (`core/guardrails.js`), not by
    construction.
11. **Internal language / type-theoretic semantics → Lean IS the internal language.** Statements,
    goals, and contexts are already Lean terms; the agent reasons *in* Lean syntax, not about it.
12. **Base change → generalization/instantiation.** Pulling a proof back along a change of
    hypotheses is the agent's generalize/instantiate engine (deferred; would live under
    `agent/roles/` in P7 if a target needs it).

The remaining layers (fibrations taxonomy, monoidal structure, ∞-topoi internal logic, cohesion,
(∞,2)-categories, etc.) reinforce these but do not independently change a module decision. The
full 27-layer walk-through and a mapping table are in `patterns_from_hct.md`.

### 4.1 The resulting design patterns (summary)
- Dual proof representations with lossless straighten/unstraighten.
- Adjoint generator/verifier with universal-arrow stopping.
- Idempotent skeleton/refine modality oscillation.
- Coinductive, lazily-forced infinite frontiers.
- Descent-checked distributed proving (hypercovers, P7).
- Well-founded residual spectra for progress.
- Presentability-flavored caching (compact eager, general lazy).
- Kleisli composition of the whole loop.

---

## 5. System architecture (overview)

Detailed contracts: `architecture.md`. This is the shape.

```
   target (NL / Lean) ──▶ Autoformali-zer ─▶ Blueprint ─▶ ProofState PullGraph
                                                   │
   LLM adapters ◀─▶  Agent Loop (Pipeline.kleisli): observe→propose→act→verify→repair→commit
                          │
                          ▼
                     Lean Backend: lean4web | REPL | CLI  (kernel = the only truth)
                          │
                          ▼
                     Sharpening: EventStore/CausalAnalysis → reward → GRPO / search bias
                          │
                          ▼
                     Digestion (writeups) · LazyGit commits · Hasher audit · QueryServer
```

### 5.1 Component notes (behavior, not contracts)
- **`lean/backend.js`** — adapter interface + three implementations. Default for RL is the REPL
  over a process pool (Kimina-style). Statement pinning (`lean/pin.js`) makes every checked goal
  carry a hash; mutation = `WEAKENED` + guardrail trip.
- **`core/pullgraph.js`** — nodes are goals/lemmas, edges are typed dependency roles, `pull()`
  proves on demand, `serialize()` is the checkpoint. Error boundary per node:
  `retry → repair → skip (never weaken)`.
- **`agent/agent.js`** — the six-stage Kleisli loop; every stage emits a traced event.
- **`blueprint/skeleton.js` + `refine.js`** — the modality pair; stub statements are typechecked
  so the DAG is kernel-valid even before proving.
- **`sharpening/*`** — `causal.js` produces the transition matrix, failure predictors,
  bottlenecks, critical path. These are the RL features and the "why is it failing" answers.
- **`search/*`** — best-of-N baseline, BFS, MCGS with transposition merging, repulsion,
  premise retrieval.
- **`growth/commit.js`** — commit-per-lemma with statement hash in the message; the lemma store
  is content-addressed.
- **`query/server.js`** — signed API answering the questions above for humans; GUI via `query/gui/`.
- **`digest/writeup.js` + `auditPack.js`** — human-readable proofs plus the full reproducible
  artifact set.

---

## 6. Evaluation plan

- **Benchmarks** (held-out splits): miniF2F (smoke), then PutnamBench, ProverBench, ProofNet,
  Lean Workbook, uproof. Rationale: saturation — `research_notes_2026.md` warning 3.
- **Internal KPIs** (from `MetricsCalculator`): pass@1/k, tokens per verified lemma, attempts per
  lemma, repair-loop efficiency, lemma reuse rate, guardrail trips.
- **Ablations** (log, don't pre-commit): best-of-N vs BFS vs MCGS; no-repair vs repair;
  no-RL vs GRPO; no-blueprint vs blueprint; no-premise-retrieval vs premise-locked. Each maps to
  a build-order phase.
- **Open-target corpus**: curated Erdős/OEIS problems with *formalizable*, auditable statements;
  start at 20 targets.
- **Phase acceptance criteria** are the source of truth for "done": `build_order.md`.

---

## 7. Risks and mitigations

The full warnings list is `research_notes_2026.md` §3; each maps to a guardrail in
`architecture.md` §2.5. The risks most likely to actually sink this project:

| Risk | Mitigation |
|---|---|
| Proof of wrong/weakened statement | statement pinning, assumption accounting, human review gate |
| Reward hacking | guardrail invariants, tactic caps, degeneracy monitors |
| Compute cost explosion | repair loops, low top-K, premise pruning, dedup, state merging |
| Long-run drift | resumable transactions, drift detection, per-lemma commits |
| Benchmark contamination | held-out + novel targets |
| Low hit rate on open problems | batch throughput over curated corpus; publish partial lemmas |
| Mathlib dependency drift | pinned toolchain + isolated workspaces |
| Human digestion bottleneck | automated writeups, blueprint diffs, prose translations |
