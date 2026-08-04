# KanForge — Blueprint

A pull-based, lazily-evaluated, telemetry-instrumented **agentic proof refinery** for Lean 4.
The design is self-contained: every module below exists because the goal in §1 or a pattern in §4
demands it. Implementation lineage (which existing libraries the foundational primitives adapt) is
a provenance matter, documented in `research_notes_2026.md` §4, not argued here.

**Working title:** *KanForge*. The name comes from an early "Kan-extension" framing — "find the
best extension of a partial proof" — but the mechanisms are ordinary programming constructs
(lazy evaluation, pipeline stage composition, a proof DAG, pinned statements). Nothing here
implements or depends on category theory. The historical metaphor lineage is documented in
`patterns_from_hct.md`; it is intuition, not a claim about the mathematics of the agent.

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
3. **decomposes** it into an audited blueprint DAG of lemmas (Level 1),
4. **proves** the DAG bottom-up: for each lemma, a tactic-level search (Level 2) works backwards from the goal to simpler subgoals — proposes ONE tactic per LLM call, applies it to decompose the goal, gets simpler subgoals, repeats until all subgoals are trivially solved,
5. **verifies** every step with the Lean kernel (REPL / CLI; `lean4web` deferred),
6. **repairs** failures using Lean's error feedback,
7. **sharpens** itself — telemetry → causal analysis → RL signal → better search,
8. **digests** results into human-readable, peer-reviewable writeups.

**Status of this vision (what works today vs planned).** The tactic-level loop (steps 4–6) is
implemented and kernel-verified against core Lean + Std (`agent/loop.js`). The rest is
planned work tracked in `build_order.md`: step 1 intake, 2 (autoformalization, P7), 3
(blueprint skeleton, P4 — currently stubs), 7 (RL, P6), 8 (digestion, P4.3/P7). The Mathlib-enabled
repl that steps 2–3 need is not built in this checkout. See README "Current Status".

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
| `core/lazy.js` | memoized thunk; `map`/`flatMap` sequential composition | goals/lemmas are expensive; compute each at most once, only when forced (§4.6) |
| `core/template.js` | strings materialize only on `toString()` | build prompts/tactic templates without paying for unneeded text |
| `core/functor.js` | `map`/`extract` over "possibly-lazy" structures | work uniformly over results that may or may not be computed yet |
| `core/pipeline.js` | stage composition | the agent loop is a pipeline of stages; stages compose in order and each emits traced events (§4.5) |
| `core/context.js` | environment-passing | thread per-run config (budget, model, library) without globals |
| `core/stream.js` | head-strict / tail-lazy streams | search frontiers, event streams, telemetry windows are unbounded but cheaply forced |
| `core/fix.js`, `lazify` | lazy self-referential streams; memoized proxied calls | search frontiers are unbounded but only forced as far as needed (§4.1) |
| `core/pullgraph.js` | pull-based dependency DAG; invalidation; serialize/deserialize; error boundaries | **the proof DAG** — two levels: lemma nodes (Level 1, dependency edges) and goal equivalence classes (Level 2, tactic edges within each lemma's e-graph); checkpoint/resume, error containment (§4.6) |
| `core/promise.js` | async-thunk pull | async Lean round-trips without leaking partial state |
| `core/cache.js` | lazy keyed cache | lemma/mathlib caches; compact-eager vs general-lazy split (§4.6) |
| `core/hasher.js` | absorbing hash chains; integrity verify | statement pinning + tamper-evident audit trail |
| `core/state.js` | straighten/unstraighten (tree ↔ script) | lossless dual representation — the backbone (§4.2) |
| `core/patch.js` | typed patch envelope | candidates as reorderable/mergeable/discardable graph mutations |
| `core/scheduler.js` | dependency-ordered dispatch, 7-state lifecycle | concurrent verification of a goal batch over the DAG |
| `core/guardrails.js` | invariant spec + checks | correctness invariants checked continuously |
| `optimization/bus.js` | central event bus | every stage emits a traced event here; entry point of the causal DAG |
| `optimization/store.js` | bounded event store, causal parent links | full causal trace of the agent |
| `optimization/causal.js` | transition matrix, failure predictors, bottlenecks, anomalies, critical path | the RL feature layer and the "why is it failing" answers |
| `optimization/metrics.js` | KPI calculator | agent KPIs: pass@1/k (lemma-level), tactics/lemma, tactics/goal, tactic success rate, reuse, guardrail trips |
| `optimization/patterns.js` | degradation/cluster/spike detection | reward-hacking and loop-degeneracy monitors |
| `optimization/exporter.js` | telemetry export | metrics feed for RL and dashboards |
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
- **Instrumentation, growth, presentation** — `optimization/*`, `growth/*`, `query/*`,
  `digest/*`, `bench/*`.

Order of construction (which module lands in which phase) is `build_order.md`; precedence of
contracts is `architecture.md`.

---

## 4. Where the design came from (plain terms first, then the metaphors)

The transformed example documents (`output/primer.md`, `output/working.md`) are a 27-layer higher
category theory curriculum that this project was seeded from; it is where several *names* for
design elements originated. The mechanisms themselves are all ordinary programming constructs —
nothing here is a category-theory object. The mappings below are historical lineage, not
specification; `architecture.md` defines the actual contract in plain terms.

The mechanisms in plain language (the only load-bearing part):

- **Lazy evaluation everywhere**: memoized thunks, lazily-forced unbounded streams,
  self-referential frontiers (`core/lazy`, `core/fix`, `core/stream`).
- **Pipeline stage composition for the loop**: observe → propose → act → verify → repair →
  commit, each stage emitting a traced event (`core/pipeline`, `agent/loop.js`).
- **Dual proof representation**: a proof tree (for surgery) and a Lean script (for the kernel),
  converted losslessly (`core/state.js`).
- **LLM proposes, kernel disposes**: every tactic is verified by Lean before commit; a goal is
  solved when a tactic closes it, a lemma is proved when its full statement is kernel-verified
  (`agent/solve.js`).
- **Error-driven repair**: failed tactics are classified and retried with structured feedback
  (`agent/repair.js`).
- **Pinned statements**: no weakening of a statement or interface; mutation trips a guardrail
  (`core/guardrails.js`).
- **Blueprint skeleton → refine**: decompose a theorem into typechecked `sorry` stubs, then fill
  the lowest stub bottom-up (`blueprint/`, P4).
- **Caching split**: eagerly materialize small objects, lazily generate the rest
  (`core/cache.js`).
- **Open-goal accounting for progress**: a lemma makes progress when its open-goal count/rank
  strictly decreases.
- **Distributed proving (P7)**: shard a development across agents with single-owner lemma edits
  and coherence checks on overlaps before merging (`growth/multibody.js`).

The HCT names those mechanisms were derived from (historical; the full 27-layer walk-through and
mapping table are in `patterns_from_hct.md`):

| Design mechanism (plain) | HCT name it was derived from |
|---|---|
| lazily-forced unbounded search frontier | simplicial sets & ∞-categories (coinductive lazy search) |
| error-driven repair of a failing goal | horn-filling |
| proof-tree ↔ tactic-script duality | straightening / unstraightening |
| lazy repair loop over the goal frontier | Kan extensions (the original working title) |
| LLM-propose + kernel-verify stopping rule | adjunction (generator ⊣ verifier) |
| pipeline stage composition | monad / Kleisli composition |
| eager-vs-lazy caching split by object size | presentable/accessible categories |
| open-goal accounting for progress | stable ∞-categories (residual tracking) |
| sharded, coherence-checked distributed proving | descent / hypercovers |
| skeleton → refine two-phase buildout | modalities (comonad/monad) |
| minimal checkable invariant set | Giraud axioms |
| prompts built from Lean terms | internal language |
| generalize/instantiate over hypotheses (deferred, P7) | base change |

### 4.1 The resulting design patterns (summary, plain terms)

- Dual proof representations with lossless straighten/unstraighten.
- LLM-propose + kernel-verify loop with a goal-solved stopping rule.
- Blueprint skeleton → refine two-phase buildout (statements never change; stubs shrink).
- Lazily-forced unbounded search frontiers.
- Coherence-checked distributed proving (P7).
- Open-goal accounting for progress.
- Eager-vs-lazy caching split by object size.
- Pipeline stage composition of the whole loop.

### 4.2 Inspiration vs specification

The HCT mappings are historical heuristics that *named* the design; they are not the
specification. Rule: wherever a mapping would require implementing the categorical object
literally, the module contract in `architecture.md` wins.

- "Kan extensions = the search primitive" named the lazy repair loop over the goal frontier. It
  does **not** mean computing Kan extensions; `core/fix.js` is a lazy self-referential stream,
  nothing more.
- "Adjunctions = generator ⊣ verifier" named the LLM/Lean pairing with kernel-verified stopping
  (`agent/solve.js`), not a theorem about adjoint functors.
- "Monads = the loop" named stage composition of the pipeline (`core/pipeline.js`), not a
  category-theory library.

Implementors must not add a category-theory dependency or a "Kan-extension engine". If a mapping
and a module contract disagree, the contract wins and the mapping is re-framed — never the
reverse. (`patterns_from_hct.md` framing caveat states the same rule at the source.)

---

## 5. System architecture (overview)

Detailed contracts: `architecture.md`. This is the shape.

```
   target (NL / Lean) ──▶ Autoformali-zer ─▶ Blueprint ─▶ ProofState PullGraph
                                                   │
   LLM adapters ◀─▶  Agent Loop (pipeline): observe→propose→act→verify→repair→commit
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
- **`lean/backend.js`** — adapter interface + two implementations (REPL over a process pool,
  `lean` CLI; `lean4web` is deferred until a real instance is exercised). Default for RL is the
  REPL over a process pool (Kimina-style). Statement pinning (`lean/pin.js`) makes every checked goal
  carry a hash; mutation = `WEAKENED` + guardrail trip.
- **`core/pullgraph.js`** — two-level structure: Level 1 lemma nodes (theorems, dependency edges) and Level 2 goal e-graph (equivalence classes of proof states, tactic edges within each lemma's e-graph); `pull()`
  proves on demand, `serialize()` is the checkpoint. Error boundary per node:
  `retry → repair → skip (never weaken)`. Node identity is normalized so alpha-equivalent /
  definitionally-equal goals share an equivalence class (transposition merging; the adopted core of Wave2's
  e-graph structure — `architecture.md` §2.2, §10).
- **`core/patch.js` + `core/scheduler.js`** — candidates are typed patches (Wave2 §4; the
  Lean-relevant operator subset: tactic / lemma / rewrite / replace), and dispatch is a
  dependency-ordered scheduler with a 7-state lifecycle (Wave2 §7–8; `architecture.md` §2.6–2.7).
- **`agent/loop.js`** — the six-stage pipeline loop (observe → propose → act → verify → repair →
  commit); every stage emits a traced event.
- **`blueprint/skeleton.js` + `refine.js`** — the skeleton → refine pair (currently **stubs**,
  P4); the design intent is that stub statements are typechecked so the DAG is kernel-valid even
  before proving.
- **`optimization/*`** — `causal.js` produces the transition matrix, failure predictors,
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
- **Internal KPIs** (`optimization/metrics.js`): pass@1/k (lemma-level), tactics per verified lemma, tactics per goal, tactic success rate, repair-loop efficiency, lemma reuse rate, guardrail trips. Plus the four Wave2 §15
  dimensions (verification throughput, compilation efficiency, search efficiency, correctness
  preservation) — `build_order.md` "Evaluation dimensions".
- **Ablations** (log, don't pre-commit): best-of-N vs BFS vs MCGS; no-repair vs repair;
  no-RL vs GRPO; no-blueprint vs blueprint; no-premise-retrieval vs premise-locked. Each maps to
  a build-order phase.
- **Open-target corpus**: curated Erdős/OEIS problems with *formalizable*, auditable statements;
  start at 20 targets.
- **Gating**: evaluation is how phases *earn* progression, not a report card at the end. Each
  phase's acceptance metric is a stage gate (`build_order.md` "Stage gates"); no later phase
  starts until the earlier metric passes. Benchmarks are earned by the loop, not by the
  infrastructure.
- **Early-loop metrics** (before any benchmark is reachable): first-lemma time-to-verify;
  minimal-loop reliability (fraction of runs that complete without hang/restart);
  guardrail trips per attempt.
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
| Complexity before a single lemma | de-risk ordering + stage gates (`build_order.md`); P0–P1 first-lemma gate before any machinery beyond the loop |
| Category-theory over-specification | mappings are named heuristics; §4.2 boundary rule — never implement the metaphor |
| Backend brittleness (hangs, crashes, parse) | pool lifecycle + resilience suite, `architecture.md` §3.1; P0.3 gate |
| All-or-nothing guardrails paralyze the agent | scoped permission model, `architecture.md` §2.5; stubs are phase-scoped, hard invariants never relax |
