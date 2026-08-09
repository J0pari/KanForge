# KanForge

**LLM-guided proof refinery for Lean 4**

KanForge is a pull-based, lazily-evaluated proof refinement system that uses LLM-guided tactic search to construct Lean 4 proofs. It implements a two-level architecture: a lemma DAG for dependency-ordered dispatch, and a goal e-graph for tactic-level search with transposition merging. Every tactic proposal is checked against the real Lean kernel before it is committed — the LLM proposes, the kernel disposes.

## Key Features

- **Tactic-level search**: LLM proposes one tactic per call, the backend applies it, and subgoals are searched recursively
- **Goal e-graph**: Equivalence classes of goals with shared statistics enable efficient transposition merging
- **REPL integration**: Direct interaction with the Lean kernel via `leanprover-community/repl`
- **Causal telemetry**: Every event (tactic proposal, application, goal solving) is traced with parent links
- **Guardrails enforcement**: Statement pinning prevents weakening; kernel verification ensures correctness
- **Checkpoint/resume**: Verified lemmas are serialized to `state.json` and can be resumed from any checkpoint
- **Error-driven repair**: Failed tactics are classified and retried through a repair prompt before giving up

## Architecture

```
Level 1: Lemma DAG                    Level 2: Goal E-Graph
┌─────────────────┐                   ┌─────────────────┐
│ Lemma A         │                   │ Goal Class 1    │
│ (verified)      │──────depends─────▶│ (root goal)     │
└─────────────────┘                   └────────┬────────┘
                                               │
┌─────────────────┐                   ┌────────▼────────┐
│ Lemma B         │                   │ Goal Class 2    │
│ (proving...)    │                   │ (subgoal)       │
└─────────────────┘                   └────────┬────────┘
                                               │
┌─────────────────┐                   ┌────────▼────────┐
│ Lemma C         │                   │ Goal Class 3    │
│ (pending)       │                   │ (solved)        │
└─────────────────┘                   └─────────────────┘
```

**Level 1 (Scheduler)**: Dispatches lemmas in dependency order. A lemma can only be proved after all its dependencies are verified.

**Level 2 (Tactic Loop)**: For each lemma, extracts the root goal, proposes tactics via the LLM, applies them via the REPL, and recursively solves subgoals until the root is solved.

## Installation

### Prerequisites

- **Node.js** ≥ 18.0
- **Lean 4** with elan (install via [elan](https://github.com/leanprover/elan))
- **opencode CLI** (`npm install -g opencode-ai`) — the sole LLM provider; no API key is needed
- **leanprover-community/repl** built for your toolchain

### Setup

```bash
# Clone the repository
git clone https://github.com/J0pari/KanForge.git
cd KanForge/kanforge

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env to set:
#   KANFORGE_REPL_BIN=<path to a repl binary>   (see "Building the REPL")
#   KANFORGE_LEAN_TOOLCHAIN=leanprover/lean4:v4.33.0-rc1
# No API key is required: all model interaction goes through the opencode CLI.
```

### Building the REPL

Two repl flavors are supported, distinguished by `KANFORGE_REPL_BIN`:

1. **Standalone core-Lean repl** (P0–P1 smoke gate): fast startup, no Mathlib. Build the
   `leanprover-community/repl` binary for your toolchain and point `KANFORGE_REPL_BIN` at it.
2. **Mathlib-enabled repl** (P0.1; premise retrieval, corpus targets): built inside
   `lean-project`, which pins mathlib4 and the repl at the same toolchain rev:

```bash
cd lean-project
lake exe cache get            # fetch prebuilt mathlib oleans (network required)
lake build repl               # binary at .lake/packages/repl/.lake/build/bin/repl
```

Then point `KANFORGE_REPL_BIN` at that binary (`.exe` on Windows) and set
`KANFORGE_LEAN_PROJECT` to the `lean-project` directory. The backend spawns the repl with the
toolchain `bin` on `PATH` (its runtime DLLs) and `LEAN_PATH` built from
`.lake/build/lib/lean` + `.lake/packages/*/.lake/build/lib/lean`, so every repl session can
`import Mathlib` (the repl's `initSearchPath` only honors the sysroot plus `LEAN_PATH`, which is
why `lake env <repl>` is the documented invocation). Full `import Mathlib` takes minutes per
process; statements should import the specific Mathlib modules they need.

## Usage

### Running the blueprint pipeline

The blueprint runner takes a target theorem and produces a kernel-verified proof plus a
reproducible audit trail (architecture.md §0). Mission targets come from the human-curated corpus
(§7.0) and are human-selected from the formalized shortlist (§7.1). The example below is a
harness statement with a known proof, shown to exercise the machinery:

```bash
node blueprint/run.js "import Mathlib.Data.Nat.Basic

example (a b c d : Nat) (hab : a ≤ b) (hcd : c ≤ d) : a * c ≤ b * d := by sorry" \
  --out-dir=runs/my_target --repo-dir=runs/my_target_repo

# A re-run of an already-proven development reuses the stored proofs (zero LLM/kernel spend)
node blueprint/run.js "<same theorem>" --out-dir=runs/my_target_rerun
```

The run writes `development.md` / `development.html` / `development.json` (writeup + audit pack +
hash chain) and commits each verified lemma to the scratch repo with its statement hash in the
commit message. Missions additionally record the corpus entry + shortlist + human selection in
the digest's provenance.

### Running the component ablation graph

```bash
# Full factorial over component toggles: main effects + pairwise interactions at equal budget
node bench/ablation.js --set=core --ablate=menu,premises,predictors --max-llm-calls=60
```

### Running the smoke harness

```bash
# Run all 23 core smoke problems
node bench/run.js

# Run all 12 Mathlib problems (ring/linarith/norm_num/decide/positivity/field_simp/tauto over
# Real, Int, Nat.Prime; each imports the specific modules it needs; one repl process per problem)
node bench/run.js --set=mathlib

# Run specific problems
node bench/run.js trans_lt add_double nat_sub
node bench/run.js --set=mathlib ring_distrib real_sq_ring

# Run with checkpointing (writes state.json into the given directory)
node bench/run.js --checkpoint-dir=runs/my_run

# Resume from a checkpoint
node bench/run.js --resume=runs/my_run/state.json
```

The smoke set (`bench/smoke.js`) is 23 problems across five escalating tiers: T1 linear
arithmetic via `omega` (7), T2 propositional logic (4), T3 functions/induction (5),
T4 harder/ceiling (4), T5 complex multi-step induction (3). Every problem is a well-typed
`:= by sorry` stub that runs over the real kernel — no aggregate pass rate is claimed here;
the harness reports exactly what it observes.

### Running Tests

```bash
npm test
```

Test suite includes:

- **Architectural tests**: backward decomposition, atomic bounded operations, proof-tree straightening
- **Integration tests**: end-to-end loop with a mock backend
- **Live REPL tests**: real kernel interaction (gated on `KANFORGE_REPL_BIN` pointing at a repl binary)
- **Swiss-tournament tests**: Bradley-Terry fitting, pairwise judging, best-of-n selection
- **Unit tests**: goal parsing, state serialization, guardrails, e-graph, telemetry

## Project Structure

```
kanforge/
├── agent/              # Tactic loop and LLM integration
│   ├── loop.js         # Main tactic-level search loop
│   ├── llm.js          # LLM client (sole provider: opencode CLI)
│   ├── prompts.js      # Tactic proposal prompts
│   ├── repair.js       # Error-driven repair (classify, retry)
│   └── solve.js        # Per-lemma solving logic
├── core/               # Foundational primitives
│   ├── lazy.js         # Memoized thunks (used by PullGraph)
│   ├── egraph.js       # Goal equivalence graph
│   ├── pullgraph.js    # Memoized dependency DAG
│   ├── scheduler.js    # Dependency-ordered dispatch
│   ├── patch.js        # Typed mutation record (Patch + patchFromEvent)
│   ├── state.js        # Proof tree ↔ script conversion
│   ├── hasher.js       # Statement/event hash chains
│   └── guardrails.js   # Invariant enforcement
├── lean/               # Lean 4 backends (all drive the real kernel)
│   ├── backend.js      # Backend interface
│   ├── backendRepl.js  # REPL protocol implementation
│   ├── backendCli.js   # Lean CLI backend
│   ├── goalText.js     # Goal string parsing
│   └── pin.js          # Statement pinning
├── optimization/       # Telemetry and metrics
│   ├── bus.js          # Event bus
│   ├── store.js        # Causal event store
│   └── metrics.js      # Performance metrics
├── blueprint/          # Theorem → DAG of stubs, then fill bottom-up
│   ├── skeleton.js     # LLM decomposition → kernel-typechecked sorry-stubs
│   ├── dag.js          # Blueprint validation + topological order
│   ├── refine.js       # Fill lowest unproved stub; re-split on failure
│   └── run.js          # Skeleton → refine CLI driver
├── growth/             # Persistence for the growth loop
│   ├── lemmaStore.js   # Content-addressed lemma store (write-through JSON)
│   ├── dataset.js      # Append-only training samples + held-out split
│   └── commit.js       # Per-lemma git commits to a scratch repo
├── digest/             # Publication units
│   ├── writeup.js      # Markdown/HTML proof writeups
│   ├── auditPack.js    # Per-lemma audit pack
│   └── development.js  # Whole-development digest (writeup + audit + hash chain)
├── search/             # Search strategies — ablation-recipes + live-loop augmentations
│   ├── swiss.js        # Swiss-tournament best-of-n (OPC App. B) — wired into the loop (opt-in)
│   ├── bestofn.js      # Naive best-of-n baseline — ablation recipe
│   ├── bfs.js          # Best-first search — ablation recipe
│   ├── mcgs.js         # UCB-guided graph search — ablation recipe
│   ├── premises.js     # BM25 premise retriever (premise-locked) — wired into the loop (opt-in)
│   ├── tacticMenu.js   # Goal-shape-keyed tactic capability menu — ablation component
│   └── repulsion.js    # Goedel diversity penalty — ablation recipe modifier
├── bench/              # Benchmarking
│   ├── run.js          # Smoke test runner
│   ├── smoke.js        # 23-problem smoke set (tiers 1–5)
│   └── ...
├── test/               # Test suite (node:test)
└── runs/               # Per-lemma audit output and checkpoints
    └── run_<timestamp>/
        ├── state.json  # Checkpoint (resumable)
        └── <lemma>/    # audit.json, proof.md, proof.html
```

## Current Status

**Kernel-verified scope.** Every "verified against the real Lean kernel" claim below is against
the **Mathlib-enabled repl** build in `lean-project` (v4.33.0-rc1): `import Mathlib` works — the
live suite covers a Mathlib-only module (`Mathlib.Data.Real.Basic`, `#check Real` →
`Real : Type`) in addition to the core Lean + Std cases. Mathlib-only tactics — `ring`,
`linarith`, `norm_num`, `tauto`, etc. — are available when the statement imports the module that
provides them (e.g. `Mathlib.Data.Real.Basic` / `Mathlib.Data.Nat.Basic`).

**Verified against the real Lean 4 kernel** (live REPL suite, no mocks; core Lean + Std, plus the
Mathlib-enabled repl in `lean-project`):

- Linear arithmetic over `Nat` via `omega` — `trans_lt` proved end-to-end by the loop
- Multi-goal decomposition via `induction` (case `zero` / `succ`), closed with `rfl`
- Kernel verification of the assembled full-source proof script
- Blueprint pipeline (`test/blueprint.live.test.js`): skeleton stubs (statement hash pinned per
  stub) typecheck under the real kernel; a three-lemma development refines end-to-end
  (skeleton → refine → lemma store/dataset capture) with no `sorry` remaining

**Verified by unit/integration tests** (mock kernel):

- E-graph normalization and transposition merging
- Proof-tree ↔ script straightening (round-trip bijectivity)
- Guardrail invariants (statement weakening, leakage/`sorry`/`admit` rejection)
- Checkpoint/resume via `state.json`
- Causal telemetry (event bus + store query)
- Swiss-tournament best-of-n selection (Bradley-Terry ranking + kernel-grounded fallthrough)
- Blueprint DAG validation + topological ordering (`blueprint/dag.js`)
- Skeleton decomposition parsing + stub normalization (incl. `lemma` → `theorem`)
- Refine loop: bottom-up fill, re-split (adds children, never edits statements), drift checks
- Lemma-store persistence + **retrieval index** (build_order.md §5.7): index columns at capture,
  exact-reuse lookup, `findSimilar` ranked retrieval
- Training-dataset append/split/contamination logic
- Premise retrieval (`search/premises.js`): BM25 lexical scorer ranks a premise corpus against the
  goal; `TacticLoop` injects the top-k premises into the prompt, and premise-locked mode makes
  `premise-locked` commit-time guardrail tripping a kernel-verified proof that cites an unretrieved
  premise. The lexical baseline is the bar any learned retriever must beat.
- Search ablation harness (`bench/ablation.js`): runs the smoke set through every recipe —
  `bestofn`, `swiss`, `swiss+repulsion`, `bfs`, `bfs+repulsion`, `mcgs`, `mcgs+repulsion` — under a
  shared LLM-call budget and writes per-recipe + per-problem comparison tables (pass rate + Wilson
  CI + cost), implementing the "compare, then decide" acceptance of `build_order.md` §5.1.
- Component ablation **graph** (`bench/ablation.js --ablate=<comps>`, build_order.md §5.8): full
  factorial over component toggles with per-configuration pass rates, component **main effects**,
  and **pairwise interactions** — the additivity/commutativity test, with no assumed rung order.
- Metrics catalog (`optimization/metrics.js`, architecture.md §6.1): search efficiency/quality,
  planning, learning, and economic KPIs from the event stream; values the stream cannot produce
  are `null`, never fabricated.
- Repulsion (Goedel-style diversity): `search/repulsion.js` `RepulsionSampler` steers proposals away
  from already-tried tactics ("do not repeat") and refuses duplicate re-checks in `MCGS`/`BestFirstSearch`.

**Not built / stubbed — do not treat as working behavior:**

- **Search baselines in the live loop** — `agent/loop.js` consumes `swiss` (via `useSwiss: true`)
  as a per-goal strategy. `bestofn`, `bfs`, `mcgs`, `repulsion` are runnable as standalone
  strategies and as recipes of the ablation harness (`bench/ablation.js`), but the loop has no
  goal-selection mode that consumes them directly yet — that wiring is the measured next step once
  the ablation comparison exists.
- **`kanforge/runs/`** — older entries are audit packs from **mock-backend test runs** (e.g.
  `P → Q` "proved" by `intro h; omega`) that are **not** kernel-verified; do not cite them as
  evidence. Newer runs from `blueprint/run.js` write a kernel-verified development digest
  (writeup + audit + hash chain) plus per-lemma commits; those are real.
- **CI** — no CI configuration; `npm test` runs locally only. The `*.live.test.js` suites (real
  repl binary) skip automatically when the binary/project is unavailable.

**Foundations:** `core/lazy` and `core/hasher` are the surviving foundational primitives; the
`query/` API is deferred (architecture.md §8). The patch algebra lives in `core/patch.js`
(`Patch`, `patchFromEvent`) — the typed mutation record projected from the live event stream,
captured per lemma into the retrieval index + development digest as the transformation history.

## Design Principles

1. **Tactic-level search**: Each LLM call proposes ONE tactic for ONE goal. No monolithic proof generation.

2. **Kernel verification**: Every tactic application is checked by the Lean kernel. No trusted LLM output.

3. **Transposition merging**: Equivalent goals (alpha-equivalent or definitionally equal) share statistics in the e-graph, avoiding redundant search. Class identity is collision-safe: the canonical serialized goal key is the equality authority, hashed with SHA-256 as a lookup index — a collision never merges unrelated proof states.

4. **Causal telemetry**: Every event has a parent link, enabling reconstruction of the proof search trajectory.

5. **Guardrails enforcement**: Statement pins prevent weakening; forbidden tokens (`sorry`, `admit`, `unsafe`) are rejected.

6. **Resumability**: Each verified lemma is serialized as a checkpoint (`state.json`). Long proofs can be interrupted and resumed.

## Limitations

- **Single-tactic proposals**: The LLM proposes one tactic at a time — no proof sketching or multi-step planning. This is a deliberate design decision, not a missing feature.
- **Mathlib-dependent tactics**: `ring`, `linarith`, `norm_num`, `tauto`, etc. are available with
  the Mathlib-enabled repl (P0.1, built in `lean-project` and exercised by the live suite). Each
  statement must `import` the Mathlib module that provides the tactic/symbol — a full
  `import Mathlib` costs minutes per process, so module-level imports are used instead. See "Current Status".
- **Premise retrieval**: A lexical (BM25) baseline is implemented and wired into the loop
  (`premises`/`premiseLocked`/`premiseTopK` options). The LeanDojo-style *learned* retriever needs
  the Mathlib-enabled repl build (P0.1) for a real Mathlib corpus — a placeholder corpus can be
  exercised today.
- **Search strategies in the live path**: the loop consumes the default single-tactic strategy,
  with `swiss` (`useSwiss: true`) and `premises` as opt-in augmentations. `bestofn`, `bfs`, `mcgs`,
  `repulsion`, and `tacticMenu` are not in the loop — they are exercised by the ablation harness
  (`bench/ablation.js`) as recipes and factorial-graph components. Per `build_order.md` §5.1's
  "compare, then decide", a strategy enters the live path only when it shows a measured advantage
  at normalized cost; that wiring is gated on the §5.6 held-out comparison.
- **Blueprint refine vs. multi-goal roots**: multi-goal roots are now provable end-to-end: `GoalEGraph` models the repl's "remaining goals" frontier (siblings carried over are not re-attached as children), `straighten` emits Lean-valid bullet scripts (sequential tactics align at one column), and the live suite proves a `constructor`-split conjunction root against the real kernel.
- **Geometry weakness**: Synthetic geometry reasoning (angle chasing, cyclic quadrilaterals) is challenging.

## Roadmap

- [x] **Swiss-tournament best-of-n selection** — `search/swiss.js`, faithful to the Open Proof Corpus
      methodology (arXiv:2506.21621, §5.5 / App. B): round-robin tournament judged pairwise by the LLM,
      Bradley-Terry ratings fit by MLE, candidates applied in rating order. OPC reports this strategy
      improves best-of-n accuracy by 17% (26% → 43% vs 26% → 36% on its 134-problem subset).
- [x] **Wire Swiss ranking into the live loop** — `agent/loop.js` consumes `search/swiss.js`
      when `useSwiss: true` (opt-in; `swissN` sets tournament size, default 8)
- [x] **Blueprint skeleton** — `blueprint/skeleton.js`: LLM decomposition of a theorem into a DAG of
      kernel-typechecked `sorry`-stubs (backend-checks each stub; statement hash pinned; `lemma`→`theorem`)
- [x] **Blueprint refine** — `blueprint/refine.js`: fills the lowest unproved stub bottom-up via the
      loop, re-splits stuck stubs (adds children, never edits statements), drift-checked each round
- [x] **Growth persistence** — `growth/lemmaStore.js` (content-addressed, write-through) and
      `growth/dataset.js` (append-only JSONL, held-out split, contamination check)
- [x] **Development digest + per-lemma commits** — `blueprint/run.js` writes the whole-development
      writeup/audit/hash-chain (`digest/development.js`) and commits each verified lemma to a
      scratch repo (`growth/commit.js`); every run emits a reproducible publication artifact.
- [x] **Mathlib-enabled REPL** — P0.1 build in `lean-project` (`lake exe cache get && lake build repl`);
      unblocks learned premise retrieval and the miniF2F corpus. Live suite exercises `Mathlib.Data.Real.Basic`
      via the `LEAN_PATH` the backend reconstructs from `KANFORGE_LEAN_PROJECT`.
- [x] **Premise retrieval (lexical baseline)** — `search/premises.js`: BM25 scorer, top-k retrieval,
      premise-locked prompt + commit-time guardrail; wired into `agent/loop.js`. Learned
      LeanDojo-style relevance scoring over Mathlib is the remaining P0.2 goal (needs the Mathlib
      repl build).
- [x] **Search ablation harness** — `bench/ablation.js`: smoke set × every recipe (bestofn, swiss,
      ±repulsion, bfs, mcgs) under a shared budget, with per-recipe/per-problem comparison tables
      (pass rate + Wilson CI + LLM/kernel cost). This is the "compare, then decide" machinery that settles
      swiss-vs-mcgs empirically; wiring a strategy into the live loop is gated on the §5.6
      held-out, cost-normalized comparison (architecture.md §5 integration contract).
- [x] **Ablation graph + benchmark discipline** — `bench/ablation.js --ablate=<comps>` runs the
      full factorial over component toggles with main effects + pairwise interactions
      (build_order.md §5.8); every report carries a full provenance block (toolchain, model,
      corpus, policy, resource usage).
- [x] **Metrics catalog** — `optimization/metrics.js` emits the §6.1 KPI catalog
      (search efficiency/quality, planning, learning, economic) from the event stream; loop
      instruments llm latency/tokens + first-success rank.
- [x] **Lemma store → retrieval index** — `growth/lemmaStore.js` indexes by goal shape, imports,
      deps, proof length, tactic trajectory; `blueprint/refine.js` exact-reuses stored proofs
      (build_order.md §5.7).
- [x] **§7.0 intake corpus** — `corpus/index/corpus.json` (built by `bench/buildCorpusIndex.js`):
      322 open + Lean-formalized Erdős mission candidates joined from primary sources
      (`teorth/erdosproblems` status DB + `google-deepmind/formal-conjectures` Lean
      formalizations, both Apache-2.0).
- [x] **Autoformalizer (P7.1)** — `agent/roles/autoformalizer.js`: prose → kernel-typechecked
      Lean statement via the §0.1 pipeline (strict-JSON propose → static validation → warm
      session → kernel check → batched probes → pin). Format-agnostic input: `normalize.js`
      converts unicode/LaTeX/ASCII to canonical Lean, and `lean/moduleResolver.js` resolves
      proposed imports to modules that exist in the pinned mathlib (e.g. stale
      `Mathlib.Data.Nat.Prime` → `.Prime.Defs`). Repair is classified and targeted: missing
      symbols map to their providing modules + a notation fix (e.g. obsolete `s.sum f` →
      `∑ x ∈ s, f x`), and heavy-import timeouts fall back to the light module. The repl pool
      gained statement-mode **environment chaining** (`backend.warm` + `useWarmEnv`), so a
      candidate's mathlib imports are paid once (~18s) and subsequent checks are ~0.2s. Validated
      on 7 distinct Erdős problems across number theory, geometry, and combinatorics.
      `bench/validateFormalization.js` + `bench/validateBatch.js` are the harnesses.
- [ ] **LLM-as-judge** — trained 8B validator for tactic ranking and proof grading
- [ ] **Category-aware tactics** — detect problem type (algebra, geometry, combinatorics) and adjust tactic libraries
- [ ] **Proof critic** — auto-generate issue summaries to guide repair loops

## References

- **Architecture**: See `docs/architecture.md` for detailed system design
- **Build order**: See `docs/build_order.md` for the phased implementation plan
- **Research notes**: See `docs/research_notes_2026.md` for state-of-the-art analysis
- **Open Proof Corpus**: See the paper for best-of-n selection methodology

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Citation

If you use KanForge in your research, please cite:

```bibtex
@software{kanforge2026,
  title = {KanForge: LLM-guided Proof Refinery for Lean 4},
  author = {J0pari},
  year = {2026},
  url = {https://github.com/J0pari/KanForge}
}
```

## Acknowledgments

- **leanprover-community/repl**: Lean 4 REPL for kernel interaction
- **Open Proof Corpus**: Research on LLM proof generation and best-of-n strategies
- **AlphaProof, Goedel-Prover, Seed-Prover**: Inspiration for tactic-level search and RL approaches
