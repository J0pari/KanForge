# KanForge — Blueprint

A pull-based, lazily-evaluated, telemetry-instrumented **agentic proof refinery** for Lean 4.
The design is self-contained: every module below exists because the goal in §1 or a pattern in §4
demands it. Implementation lineage (which existing libraries the foundational primitives adapt) is
a provenance matter, documented in `research_notes_2026.md` §4, not argued here.

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

## 3. Module inventory and design rationale

Everything in `kanforge/` exists because one of the goals in §1 or one of the patterns in §4
demands it. The table below is the *why* map — module → role in the system → the requirement it
satisfies. Contracts, file names, and interfaces are authoritative in `architecture.md`; this
section only argues the shape.

| Module | Role in KanForge | Why it exists |
|---|---|---|
| `core/lazy.js` | memoized thunk; `map`/`flatMap` monad | goals/lemmas are expensive; compute each at most once, only when forced (§4.6) |
| `core/template.js` | strings materialize only on `toString()` | build prompts/tactic templates without paying for unneeded text |
| `core/functor.js` | `map`/`extract` over "possibly-lazy" structures | work uniformly over results that may or may not be computed yet |
| `core/pipeline.js` | Kleisli stage composition | the agent loop is a monadic effect stack; stages compose with traced events (§4.5) |
| `core/context.js` | environment-passing | thread per-run config (budget, model, library) without globals |
| `core/stream.js` | head-strict / tail-lazy streams | search frontiers, event streams, telemetry windows are unbounded but cheaply forced |
| `core/fix.js`, `lazify` | coinductive fixed points; memoized proxied calls | self-referential search streams: an infinite frontier as a fixpoint (§4.1) |
| `core/pullgraph.js` | pull-based dependency DAG; invalidation; serialize/deserialize; error boundaries | **the proof DAG** — lemmas as nodes, dependency edges, checkpoint/resume, error containment (§4.6) |
| `core/promise.js` | async-thunk pull | async Lean round-trips without leaking partial state |
| `core/cache.js` | lazy keyed cache | lemma/mathlib caches; compact-eager vs general-lazy split (§4.6) |
| `core/hasher.js` | absorbing hash chains; integrity verify | statement pinning + tamper-evident audit trail |
| `core/state.js` | straighten/unstraighten (tree ↔ script) | lossless dual representation — the backbone (§4.2) |
| `core/patch.js` | typed patch envelope | candidates as reorderable/mergeable/discardable graph mutations |
| `core/scheduler.js` | dependency-ordered dispatch, 7-state lifecycle | concurrent verification of a goal batch over the DAG |
| `core/guardrails.js` | invariant spec + checks | correctness invariants checked continuously (Giraud-axiom style, §4.10) |
| `sharpening/bus.js` | central event bus | every stage emits a traced event here; entry point of the causal DAG |
| `sharpening/store.js` | bounded event store, causal parent links | full causal trace of the agent |
| `sharpening/causal.js` | transition matrix, failure predictors, bottlenecks, anomalies, critical path | the RL feature layer and the "why is it failing" answers |
| `sharpening/metrics.js` | KPI calculator | agent KPIs: pass@1/k, tokens/lemma, reuse, guardrail trips |
| `sharpening/patterns.js` | degradation/cluster/spike detection | reward-hacking and loop-degeneracy monitors |
| `sharpening/exporter.js` | telemetry export | metrics feed for RL and dashboards |
| `growth/commit.js` | commit-per-lemma | content-addressed library growth; statement hash in the message |
| `growth/lemmaStore.js` | content-addressed lemma store | reproducible lemma reuse |
| `growth/multibody.js` | one-owner-per-region, processing lanes | multi-agent single-owner lemma edits (P7) |
| `digest/writeup.js` | parse → render (Markdown/HTML/PDF, KaTeX) | human-readable, peer-reviewable proofs (warning 9, `research_notes_2026.md`) |
| `query/server.js` | signed, rate-limited query API over telemetry | "why is the agent failing" API for humans |
| `query/formatters.js` + `gui/` | semantic formatters; WebSocket dashboard | CLI/GUI explanations and the operator cockpit |

### 3.1 Layering
- **Foundations** — no proof-specific assumptions; generic lazy/pull primitives, fully
  unit-tested: `lazy`, `stream`, `promise`, `cache`, `pipeline`, `context`, `fix`, `functor`,
  `template`, `serialize`, `hasher`.
- **Proof domain** — what makes this a *proof* refinery rather than a generic build system:
  `pullgraph` (proof DAG), `state` (tree↔script), `patch`, `scheduler`, `guardrails`, plus
  `lean/*`, `agent/*`, `blueprint/*`, `search/*`.
- **Instrumentation, growth, presentation** — `sharpening/*`, `growth/*`, `query/*`,
  `digest/*`, `bench/*`.

Order of construction (which module lands in which phase) is `build_order.md`; precedence of
contracts is `architecture.md`.

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
                     Sharpening: causal analysis → reward → GRPO / search bias
                          │
                          ▼
                     Digestion (writeups) · per-lemma git commits · Hasher audit · query API
```

### 5.1 Component notes (behavior, not contracts)
- **`lean/backend.js`** — adapter interface + three implementations. Default for RL is the REPL
  over a process pool (Kimina-style). Statement pinning (`lean/pin.js`) makes every checked goal
  carry a hash; mutation = `WEAKENED` + guardrail trip.
- **`core/pullgraph.js`** — nodes are goals/lemmas, edges are typed dependency roles, `pull()`
  proves on demand, `serialize()` is the checkpoint. Error boundary per node:
  `retry → repair → skip (never weaken)`. Node identity is normalized so alpha-equivalent /
  definitionally-equal goals share a node (transposition merging; the adopted core of Wave2's
  e-graph dedup — `architecture.md` §10).
- **`core/patch.js` + `core/scheduler.js`** — candidates are typed patches (Wave2 §4; the
  Lean-relevant operator subset: tactic / lemma / rewrite / replace), and dispatch is a
  dependency-ordered scheduler with a 7-state lifecycle (Wave2 §7–8; `architecture.md` §2.6–2.7).
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
- **Internal KPIs** (`sharpening/metrics.js`): pass@1/k, tokens per verified lemma, attempts per
  lemma, repair-loop efficiency, lemma reuse rate, guardrail trips. Plus the four Wave2 §15
  dimensions (verification throughput, compilation efficiency, search efficiency, correctness
  preservation) — `build_order.md` "Evaluation dimensions".
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
