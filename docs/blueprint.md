# KanForge — Blueprint

A pull-based, lazily-evaluated, telemetry-instrumented **agentic proof refinery** for Lean 4.
The design is self-contained: every module below exists because the goal in §1 or a pattern in §4
demands it. Implementation lineage (which existing libraries the foundational primitives adapt) is
a provenance matter, documented in `research_notes_2026.md` §4, not argued here.

**Working title:** *KanForge*. The mechanisms are ordinary programming constructs (lazy
evaluation, pipeline stage composition, a proof DAG, pinned statements). Historical name lineage
is documented in `patterns_from_hct.md`; it is intuition, not a claim about the mathematics of the
agent.

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
implemented and kernel-verified against core Lean + Std (`agent/loop.js`). Step 3 (blueprint
skeleton → refine, P4) is implemented and live-kernel-tested. The rest is planned work tracked
in `build_order.md`: step 1 intake, 2 (autoformalization, P7), 7 (RL, P6), 8 (digestion, P4.3/P7).
The Mathlib-enabled
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
| `core/lazy.js` | memoized thunk | goals/lemmas are expensive; PullGraph registers each computation lazily (§4.6) |
| `core/pullgraph.js` | memoized dependency DAG; invalidation; serialize/deserialize | **the proof DAG** — two levels: lemma nodes (Level 1, dependency edges) and goal equivalence classes (Level 2, tactic edges within each lemma's e-graph); checkpoint/resume, error containment (§4.6) |
| `core/hasher.js` | absorbing hash chains; integrity verify | statement pinning + tamper-evident audit trail |
| `core/state.js` | straighten/unstraighten (tree ↔ script) | lossless dual representation — the backbone (§4.2) |
| `core/scheduler.js` | dependency-ordered dispatch, 7-state lifecycle | concurrent verification of a goal batch over the DAG |
| `core/patch.js` | typed mutation record (`Patch`, `patchFromEvent`) | the interface between probabilistic generation and deterministic compilation — the typed trace of the loop's mutations (§2.7) |
| `core/guardrails.js` | invariant spec + checks | correctness invariants checked continuously |
| `optimization/bus.js` | central event bus | every stage emits a traced event here; entry point of the causal DAG |
| `optimization/store.js` | bounded event store, causal parent links | full causal trace of the agent |
| `optimization/causal.js` | causal TELEMETRY / trace analysis: Markov transitions, failure correlations, timing, critical path | the trace layer + failure hypotheses — NOT causal inference (§6); feeds search biasing and the "why is it failing" answers |
| `optimization/metrics.js` | KPI calculator (wired into the loop's per-run outcome) | the quantitative evaluation catalog (§6.1): search efficiency/quality, planning, learning, economic KPIs |
| `optimization/patterns.js` | degradation/cluster/spike detection | reward-hacking and loop-degeneracy monitors |
| `optimization/exporter.js` | telemetry export | metrics feed for RL and dashboards |
| `growth/commit.js` | commit-per-lemma to a scratch repo | content-addressed library growth; statement hash in the message |
| `growth/lemmaStore.js` | content-addressed lemma store → retrieval index | reproducible lemma reuse: exact reuse / specialization / generalization / proof-pattern transfer (§2.8) |
| `growth/multibody.js` | one-owner-per-region, processing lanes | multi-agent single-owner lemma edits (P7) |
| `digest/writeup.js` | parse → render (Markdown/HTML, KaTeX) | human-readable, peer-reviewable proofs (warning 9, `research_notes_2026.md`) |
| `digest/development.js` | whole-development digest (writeup + audit + hash chain) | the publication unit (§7) |

**Foundations:** `core/lazy` and `core/hasher` are the foundational primitives. The patch algebra
lives in `core/patch.js` (`Patch`, `patchFromEvent`) — the typed mutation record projected from
the live event stream, captured per lemma into the retrieval index + digest.

### 3.1 Layering
- **Foundations** — no proof-specific assumptions; unit-tested: `core/lazy`, `core/hasher`.
- **Proof domain** — what makes this a *proof* refinery rather than a generic build system:
  `pullgraph` (proof DAG), `state` (tree↔script), `scheduler`, `guardrails`, plus
  `lean/*`, `agent/*`, `blueprint/*`, `search/*`.
- **Instrumentation, growth, presentation** — `optimization/*`, `growth/*`, `digest/*`, `bench/*`.

Order of construction (which module lands in which phase) is `build_order.md`; precedence of
contracts is `architecture.md`.

---

## 4. Design patterns (plain terms)

The mechanisms below are ordinary programming constructs — lazy evaluation, pipeline stage
composition, a proof DAG, pinned statements. Historical name lineage is documented in
`patterns_from_hct.md`; it is intuition, not a claim about the mathematics of the agent.
`architecture.md` defines the actual contract in plain terms.

The mechanisms in plain language (the only load-bearing part):

- **Memoized pull DAG**: each lemma/goal computation is a memoized thunk registered on the DAG;
  the scheduler dispatches dependency-ordered (`core/lazy`, `core/pullgraph`, `core/scheduler`).
- **Stage-structured loop**: observe → propose → act → verify → repair → commit, each stage
  emitting a traced event (`agent/loop.js` — a class, not a composed monadic pipeline).
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
- **Open-goal accounting for progress**: a lemma makes progress when its open-goal count/rank
  strictly decreases.
- **Distributed proving (P7)**: shard a development across agents with single-owner lemma edits
  and coherence checks on overlaps before merging (`growth/multibody.js`).
- **Lemma reuse as retrieval** (§2.8): index proven lemmas by statement hash / goal shape /
  imports / deps / proof length / tactic trajectory; a new goal retrieves a similar proven lemma
  for exact reuse, specialization, generalization, or proof-pattern transfer. Retrieval never
  bypasses kernel verification.

### 4.1 The resulting design patterns (summary, plain terms)

- Dual proof representations with lossless straighten/unstraighten.
- LLM-propose + kernel-verify loop with a goal-solved stopping rule.
- Blueprint skeleton → refine two-phase buildout (statements never change; stubs shrink).
- Memoized dependency-ordered dispatch over the proof DAG.
- Coherence-checked distributed proving (P7).
- Open-goal accounting for progress.
- Stage-structured loop (observe → propose → act → verify → repair → commit) as a class.

### 4.2 Inspiration vs specification

The name lineage in `patterns_from_hct.md` is historical; it is not the specification. The rule:
wherever a historical mapping would require implementing its literal mathematical object, the module
contract in `architecture.md` wins and the mapping is re-framed — never the reverse. Implementors
must not add a category-theory dependency or a "Kan-extension engine".

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
                     Digestion (writeups) · per-lemma git commits · Hasher audit · development digest
```

### 5.1 Component notes (behavior, not contracts)
- **`lean/backend.js`** — adapter interface + factory (`createBackend`), two implementations (REPL
  over a process pool, `lean` CLI; `lean4web` is deferred until a real instance is exercised).
  Default is the REPL over a process pool (Kimina-style). Statement pinning (`lean/pin.js`) makes
  every checked goal carry a hash; mutation = `WEAKENED` + guardrail trip.
- **`core/pullgraph.js`** — two-level structure: Level 1 lemma nodes (theorems, dependency edges) and Level 2 goal e-graph (equivalence classes of proof states, tactic edges within each lemma's e-graph); memoized per node, `serialize()` is the checkpoint, `invalidate()` triggers transitive re-verification. The scheduler dispatches via a `check(nodeId)` callback; the loop reads
  `nodes.get(id).computation.value` directly. Error boundary per node:
  `retry → repair → skip (never weaken)`. Node identity is normalized so alpha-equivalent /
  definitionally-equal goals share an equivalence class (transposition merging; the adopted core of Wave2's
  e-graph structure — `architecture.md` §2.2, §10).
- **`core/scheduler.js`** — dependency-ordered dispatch with a 7-state lifecycle (Wave2 §7–8;
  `architecture.md` §2.6).
- **`core/patch.js`** — the typed mutation record (§2.7, §5.9): `Patch` + `patchFromEvent(e)`,
  the pure projection of a loop event into `{ node, op, replacement, scope, meta }`. The patch is
  the interface between probabilistic generation and deterministic compilation; its stream is the
  transformation history captured per lemma into the retrieval index + digest.
- **`agent/loop.js`** — the six-stage loop (observe → propose → act → verify → repair →
  commit) as a class; every stage emits a traced event.
- **`blueprint/skeleton.js` + `refine.js`** — the skeleton → refine pair (built, P4; live-kernel
  tested): stub statements are kernel-typechecked so the DAG is kernel-valid even before proving;
  refine fills the lowest unproved stub bottom-up and re-splits stuck stubs (never edits statements).
- **`optimization/*`** — `causal.js` is causal *telemetry*: Markov transitions, failure
  correlations, timing, critical path — the trace layer + failure hypotheses, NOT causal inference
  (confounders everywhere; see `architecture.md` §6). `metrics.js` KPIs (the §6.1 catalog) attach
  to every loop outcome.
- **`search/*`** — best-of-N baseline, BFS, UCB-guided graph search (MCGS), repulsion,
  premise retrieval, goal-shape tactic menu.
- **`growth/commit.js`** — commit-per-lemma to a scratch repo with statement hash in the message;
  the lemma store is content-addressed. Wired into `blueprint/run.js`'s DoD tail.
- **`digest/writeup.js` + `auditPack.js` + `development.js`** — per-lemma and whole-development
  writeups plus the full reproducible artifact set (writeup, audit JSON, hash chain).
- **Query API** — not part of the system; see `architecture.md` §8.

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
- **Open-target corpus**: HUMAN-curated Erdős/OEIS problems with *formalizable*, auditable
  statements; start at 20 targets (build_order.md §7.0 — the agent never curates or self-selects;
  it formalizes candidates and the human selects the mission target from the shortlist).
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
