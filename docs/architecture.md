# KanForge — Architecture & Interfaces

**Canonical source for**: repo layout, module/file names, API contracts, wire formats, event
vocabulary, reward defaults, guardrail spec, Lean backend interface, query API, module inventory.
Everything else references this document rather than restating it.


## 0. The workflow

This system takes an **open problem** — a target theorem with no known answer in hand — and
produces a kernel-verified Lean proof plus a reproducible audit trail:

```
7.0 intake: human-curated corpus of open problems (canonical external sources — build_order.md §7.0)
  → autoformalize CANDIDATES (agent/roles/autoformalizer.js; kernel-checked, probes, consensus)
  → present SHORTLIST with justification (formalizability, substrate cost, shape, novelty)
  → human selects the mission target (build_order.md §7.1)
  → blueprint DAG of kernel-typechecked sorry stubs (blueprint/skeleton.js)
  → prove bottom-up via tactic-level search (blueprint/refine.js → agent/loop.js):
      LLM proposes ONE tactic → kernel disposes → repair → repeat until root solved
  → verify the assembled full statement against the kernel (commit gate, §4)
  → digest: writeup + audit pack + per-lemma artifacts + hash chain (digest/, growth/commit.js)
```

The known-answer harnesses (the smoke sets, the ablation runner) check that the machinery behaves
as expected before it is pointed at an open problem; a failure in the open-problem pipeline is
attributable to the problem, not the plumbing.

### 0.1 Formalizing problems that are not stated in Lean idioms

Most open targets are not presented as Lean statements. They arrive as prose from any field of
mathematics — geometry, topology, combinatorics, number theory — and their first translation into
Lean is where meaning can silently change. The design treats formalization as a *verification
problem*, not a translation problem. A formal statement is **uncontroversial** iff the following
all hold; each is a mechanical or kernel-grounded check, not an appeal to the LLM's authority:

1. **Kernel typecheck.** The candidate `theorem ... := by sorry` (and every definition it
   introduces) passes `backend.check` under the pinned toolchain. A statement that does not
   typecheck is rejected at the door — this is the same gate `blueprint/skeleton.js` applies to
   every decomposition stub.

2. **Explicit definitions, checked first.** A problem from a disparate field almost always needs
   vocabulary mathlib does not provide (an invariant, a construction, a predicate). Every such
   term is emitted as a *kernel-checked `def` node in the blueprint DAG before the theorem that
   uses it*. The theorem depends on the definitions, so "does the theorem say what the prose said"
   reduces to "do the definitions say what the prose said" — and definitions are the smallest,
   most checkable units. An undefined or misdefined term cannot be smuggled in as a bare symbol.

3. **Behavioral probes (instance ledger).** The informal problem is accompanied by concrete
   instances the source asserts are true and are false. The formalization states 3–5 of each;
   every instance becomes an `example` the kernel must verify or refute (via `norm_num`,
   `native_decide`, or a one-line proof). A formalization that flips an asserted instance is
   wrong, automatically. Probes pin *meaning* where syntax alone cannot.

4. **Dual-formalization consensus.** Two independent formalization attempts of the same prose
   target are produced (the generalist orchestrator and the critic). If the kernel cannot prove
   `A ↔ B` between them, that is a **semantic-drift trip** — the same class of guardrail trip as
   `STATEMENT_WEAKENED` — and the statements are re-derived until the field settles. The system
   never adjudicates by argument; it adjudicates by kernel-checked equivalence.

5. **Assumption ledger + human gate.** Every formalization choice — the sort of `2`, the meaning
   of "divides", which base case was taken — is recorded as an explicit entry in the ledger, which
   `digest/writeup.js` surfaces as the assumption account. The final statement is pinned
   (`lean/pin.js`) and reviewed by a human before search begins. The human does not trust the
   sentence; they audit the ledger + probes + consensus record, which is the reproducible evidence
   the sentence is the prose.

6. **Missing-symbol repair is derived, not curated.** When a candidate fails typecheck with
   "Unknown constant `X`" / "identifier `X` is unknown", the repair stage must know which mathlib
   module declares `X`. That knowledge is **derived once from the pinned mathlib source**, not
   hand-maintained: `lean/symbolIndex.js` maps every top-level declaration (full dotted name,
   namespace nesting and `protected`/`private` prefixes tracked) to its defining module, built by
   `bench/buildSymbolIndex.js` and cached per mathlib pin. Query tiers: (1) exact full-name match;
   (2) last-segment match, preferring a module whose basename equals the segment; (3) module-
   basename fallback for declarations with no source line at all — `to_additive`-generated names
   like `Even` never appear in a source file, and mathlib's convention (the definition lives in a
   file named after it, e.g. `Algebra/Group/Even.lean`) is the only signal that resolves them.
   The curated table in `normalize.js` shrinks to what the index cannot derive: notation fixes
   (`s.sum f` → `∑ x ∈ s, f x`) and non-constant type symbols (`ℕ`). This boundary is deliberate:
   derived knowledge covers ANY symbol in ANY domain (the corpus spans 35 problem tags; a
   Millennium-list target spans complex analysis, PDE, algebraic geometry, topology, complexity —
   none of which a hand table can be "comprehensive" against in advance); curated knowledge
   survives only where a module version changed the notation, which no source scan can recover.

   Domain presets (corpus tag → starter import list, e.g. number theory →
   `Nat.Prime.Defs` + `Nat.Parity`) are a **cold-start optimization only**: they seed the first
   proposal so repair round-trips are fewer. Correctness never depends on them — the derived
   index answers any missing symbol on the first repair. Presets key on the corpus's existing
   tags and are a §7.1 follow-up, not a prerequisite of formalization.

The methodology is the agent loop, lifted one level: `observe` (prose + asserted instances +
retrieved definitions) → `propose` (independent candidate formalizations) → `act` (kernel
typecheck) → `verify` (probes + pairwise `A ↔ B`) → `repair` (correct and re-derive on any
failure) → `commit` (pin + ledger + human gate). Selection among surviving candidates reuses the
pairwise-judge machinery of `search/swiss.js`. This is the only formalization path in the design;
there is no "trust the model, translate it" path to shorten it.

### 0.2 Field substrates and target shapes (any field)

The mechanisms in this section are field-agnostic. A notable result in *any* field — low-dimensional
topology, derived algebraic geometry, analytic number theory, condensed mathematics, extremal
combinatorics — lands in this system as an instance of a small set of **target shapes** over a
**substrate** whose vocabulary mathlib may not ship. The design names the mechanisms; the field
supplies instances. (The two results that motivated this section — the unknotting-number
non-additivity counterexample and the geometric Langlands equivalence — appear below only as
illustrations of two shapes, never as special cases.)

**Substrate: vocabulary the target needs.** Whether the gap is one term or an entire field's
infrastructure, the situation is the same: the target uses vocabulary mathlib does not provide. The
pipeline does not *translate*; it **grows the substrate as a pinned Lean library first**, under the
same verification discipline as every lemma.

1. **Field libraries are lake packages.** A field is represented by one or more pinned `require`s
   in `lean-project/lakefile.lean` (mathlib and the repl are already pinned this way). Their oleans
   join `LEAN_PATH` automatically (the backend scans `.lake/packages/*`), and each target imports
   the specific module subset it needs. Preloading a field = adding the pinned package + recording
   the target's **import profile**; no backend code changes. A target that needs vocabulary no
   package ships declares those `def`/`structure`/`abbrev` nodes and the pipeline builds them as a
   substrate DAG (§0.1.2).

2. **The substrate is pinned as a unit.** `makePin`/`checkPin` carry a `substrateHash` — a hash of
   the resolved library set (lakefile + pinned package revs). A substrate-library revision can
   change the meaning of a term without changing the toolchain, so it must report **DRIFT** (re-pin
   deliberately), never silently re-verify. Today's pin fingerprints only toolchain + mathlib; the
   field mechanism extends it to the whole substrate so a substrate change is a reviewed event.

3. **Definitions are staged like proofs.** The blueprint DAG holds `def`/`structure`/`abbrev`
   nodes with *bodies* (not `sorry`), each kernel-checked, pinned, and committed — the same
   bottom-up, dependency-ordered build as theorem refinement, generalized from claims to
   vocabulary. The autoformalizer never emits a bare symbol: the checked substrate it imports is
   the only source of vocabulary. The blueprint's `refine` loop picks the lowest unbuilt node
   regardless of kind; a `def` is "proved" when its body typechecks and its probe examples verify.

4. **Automation is part of the substrate declaration.** A target's import profile bundles the
   field's decision procedures: which goal shapes `native_decide`/`omega`/`ring`/`linarith`/custom
   oracles close outright, and which need proof-backed fallbacks. The probe ledger (below) spans
   the same spectrum — some probes are computations, some are lemmas the loop must prove.

**Target shapes: what "solved" means.** The loop's stopping rule and probe set are not
field-dependent but *shape*-dependent, and the same shapes recur across every field:

1. **Universal claim** — `∀ x, P x`. Prove it via the tactic loop; subgoals are instances of `P x`.
2. **Witness discovery (prove-or-refute)** — "is property P universal?" When the universal claim
   stalls, invert the search: enumerate a *bounded space of candidate structures* and, for each,
   try to certify a witness to the negation **two-sided** — an explicit construction verifying one
   inequality/direction, plus an invariant or obstruction forcing the other. Both halves must be
   kernel-verified or the witness is discarded, never asserted. (The unknotting-number result is
   this shape: the search found a pair of knots, the construction certified
   `u(K₁#K₂) ≤ u(K₁)+u(K₂)`, and a non-additive invariant certified strictness.) This is a
   metalevel search: candidate structures at Level 1, the tactic loop at Level 2 within each.
3. **Equivalence / isomorphism** — "these two structures are the same" (e.g. the geometric
   Langlands claim `IndCoh(LocSys_G) ≃ D-mod(Bun_G)`). Build both maps, then prove the round-trip
   (unit/counit, or bijectivity on objects and morphisms). Solved iff both halves close.
4. **Closed form / explicit value** — "this construction equals N." The probe ledger pins small
   asserted cases; the loop proves the general equality.

Consensus (§0.1.4) extends to definitions: two candidate formalizations must produce structures the
kernel proves equivalent (definitional equality or an explicit isomorphism), not merely two strings
that both typecheck.

Consequence for target scale: the system's claim is never "prove <the famous result>" in one shot.
It is "build the substrate, then prove the top node" — the open target is the top of a substrate
DAG constructed under the same rules as any lemma, and the substrate build is itself a measured
deliverable (nodes built, kernel-checked, pinned, committed) before the theorem above it is
attempted. Sequencing and acceptance live in `build_order.md` §7.

### 0.3 Compiler pipeline — interconnection blueprint

The system is a **proof compiler**: a language model proposes local structural mutations (patches);
a deterministic build system validates, scopes, schedules, verifies, and commits them. The
interconnection is adapted from the Research doc (`docs/Research/KanForge_architecture.md` §17)
and mapped to the code modules below. Each arrow names a data contract.

```
                     ┌──────────┐
                     │  CORPUS   │ corpus/index/corpus.json (322 candidates)
                     │  INTAKE   │ prose + source + tags per candidate
                     └────┬─────┘
                          │
            ┌─────────────▼─────────────┐
            │   AUTO-FORMALIZER         │ agent/roles/autoformalizer.js
            │   kernel-typechecks the   │   → normalize.js, moduleResolver.js
            │   statement from prose    │   → symbolIndex.js (derived repair)
            │   emits: shortlist entry  │   → consensus + ledger + pin
            └─────────────┬─────────────┘
                          │ pinned, kernel-verified statement (:= by sorry)
                          │
            ┌─────────────▼─────────────┐
            │   HUMAN GATE               │ shortlist persisted; human selection
            │   selects the mission      │   is the architectural rule, not automated
            │   target from shortlist    │
            └─────────────┬─────────────┘
                          │ selected statement
                          │
     ┌────────────────────▼────────────────────┐
     │             BLUEPRINT PIPELINE           │
     │                                         │
     │  ┌──────────┐     ┌──────────────┐      │
     │  │ SKELETON  │────▶│    REFINE    │      │
     │  │ decompose │     │  bottom-up   │      │
     │  │ theorem → │     │  fill +      │      │
     │  │ DAG of    │     │  re-split    │      │
     │  │ stubs     │     │  on failure  │      │
     │  └──────────┘     └──────┬───────┘      │
     │       ▲                  │               │
     │       │    kernel-typechecked stubs      │
     │       │    per lemma;                    │
     │       │    hash-pinned per stub          │
     │       └──────────────────┘               │
     └────────────────────┬────────────────────┘
                          │ refinement loop: per round, pick lowest unproved stub
                          │ with all dependencies proved; stalled lemmas wait
                          │
     ┌────────────────────▼────────────────────┐
     │            TACTIC SEARCH LOOP            │
     │  agent/loop.js                          │
     │                                         │
     │  ┌──────────┐   ┌──────────────┐        │
     │  │  LLM     │   │   BACKEND    │        │
     │  │ propose  │──▶│  kernel-apply│        │
     │  │ tactic   │   │  tactic      │        │
     │  └──────────┘   └──────┬───────┘        │
     │       ▲                │                │
     │       │     goal text + context         │
     │       └────────────────┘                │
     │                                         │
     │  ┌──────────────────────────┐           │
     │  │   GOAL transposition graph           │           │
     │  │   equivalence classes    │           │
     │  │   + transposition merge  │           │
     │  │   + lexical math norms   │           │
     │  │   core/transpositionGraph.js         │           │
     │  └──────────────┬───────────┘           │
     │                 │                      │
     │  ┌──────────────▼───────────┐           │
     │  │   PROOF EXTRACTION       │           │
     │  │   tree → script          │           │
     │  │   core/state.js          │           │
     │  └──────────────┬───────────┘           │
     └─────────────────┼───────────────────────┘
                       │ composed proof script
                       │
           ┌───────────▼───────────┐
           │   COMMIT GATE          │ core/guardrails.js
           │   pin unchanged?       │   agent/solve.js
           │   kernel-verified?     │   core/hasher.js (hash chain)
           │   no PREMISE_LOCK      │   pre-flight check of the
           │   violation?           │   assembled source
           └───────────┬───────────┘
                       │ verified lemma
                       │
           ┌───────────▼───────────┐
           │   LEMMA STORE          │ growth/lemmaStore.js — GLOBAL
           │   + DATASET            │ growth/dataset.js — GLOBAL
           │   + ARTIFACTS           │ growth/commit.js (statement.lean + proof.lean + audit.json per lemma)
           │   content-addressed    │
           │   retrieval index     │
           └───────────┬───────────┘
                       │
           ┌───────────▼───────────┐
           │   DEVELOPMENT DIGEST   │ digest/development.js
           │   + AUDIT PACK         │ digest/auditPack.js
           │   + HASH CHAIN         │ core/hasher.js
           └───────────────────────┘
```

**Contracts between stages (arrow labels above):**

| From | To | Contract |
|---|---|---|
| Corpus | Autoformalizer | prose string + source id + asserted instances (`bench/validateFormalization.js`) |
| Autoformalizer | Shortlist | kernel-verified statement + hash + shape + substrate cost (`_entry()` → shortlist JSON) |
| Shortlist | Blueprint | human-selected pinned statement with imports (`blueprint/run.js --statement-file=`) |
| Blueprint Skeleton | Refine | validated DAG of kernel-typechecked stubs (`blueprint/skeleton.js` → `refine.js`) |
| Refine | Tactic Loop | stub statement per lemma attempt (`refine.js._attempt` → `new TacticLoop`) |
| Tactic Loop | LLM | `llm.complete(prompt)` → tactic text (`agent/llm.js`, opencode CLI) |
| Tactic Loop | Backend | `applyTactic(goal, tactic)` → subgoals (`lean/backendRepl.js` repl pool) |
| Tactic Loop | Backend | `extractGoals(statement)` → root goal list (leased session in repl pool) |
| Tactic Loop | transposition graph | `transposition graph.applyPatch(Patch({op:'tactic', ...}))` — the patch is the mutation record, never a raw tuple |
| transposition graph | Proof Extraction | `transposition graph.extractProof()` → proof tree (`core/state.js` straighten) |
| Extraction | Commit Gate | `Guardrails.assertLemmaCommit({pin, statement, proof, verification})` |
| Commit Gate | Lemma Store | `lemmaStore.put(hash, index)` |
| Lemma Store | Dataset | `dataset.addSample(lemma, proof, outcome)` |
| Lemma Store | Digest | `assembleDevelopmentDigest(...)` |
| Refine Loop | Checkpoint | `RunCheckpoint.save({ lemmas, rounds, hashChain })` after each round |
| Blueprint Run | Checkpoint | `RunCheckpoint.load()` + resume — proved and stalled lemmas are restored, the hash chain continues |
| Loop | Feedback | `this.predictors.rejects(tacticHead(tactic), history)` — causal predictor pre-filter before kernel call |
| Loop | Lemma Store | `lemmaStore.findByGoal(goalType)` — the stored lemma is INLINED (declaration + proof) into the source and closed with `exact`; the kernel re-verifies the combined source |

**The run is a cycle, not a shot.** A proof development proceeds over arbitrarily many
resume cycles: `blueprint/run.js --problem=<id>` resumes `runs/<id>/checkpoint.json` when it
exists and never overwrites it; `--fresh` archives the old workdir first; `--list` reports every
problem's rounds/proved/lemmas. Proven lemmas are skipped on resume, stalled lemmas stay stalled
(they only un-stall when one of their dependencies is proved), and the lemma store plus training
dataset are GLOBAL (`runs/lemma-store`, `runs/training-dataset`) — a lemma proved for one problem
is reusable, kernel-verified, in any other problem's session. Everything else (checkpoint,
blueprint, events, digest) is scoped to the problem's workdir.

**Backend worker roles.** The repl pool runs two worker roles: the **warm worker** (first spawned)
serves stateless checks from a chained warm environment so re-split and skeleton checks reuse one
mathlib import; **leased workers** serve `extractGoals` sessions and are killed and replaced after
each lemma, so memory is released between lemmas. When the warm worker is replaced, it re-warms
from the last warmup statement automatically.

**Planned extensions (Research doc §3–§7 framing not yet in the code):** a structural AST
synchronized with the transposition graph (the proof tree is currently the only structural form, extracted at
commit time); transposition graph-driven invalidation scoping over the dependency DAG; scheduler dispatch
keyed on build states; and corpus-tag domain presets for starter imports. The patch algebra is
live as the mutation interface; the loop proposes tactics, which are the tactic-level patch
operator.

### 0.4 Measurement layer — role separation

Three roles, one implementation each; no component exists twice:

- **The live path is the only implementation.** Every proof step — proposal, kernel check,
  repair, search, learning — executes inside `TacticLoop` (`agent/loop.js`), driven by
  `blueprint/run.js`. There is no second tactic loop, no parallel search driver, and no
  re-implemented LLM or backend anywhere in the repo; `bench/` contains no proof machinery.
- **The registry is the only component catalog.** `config/registry.js` names every toggleable
  component (recipe, budgets, repulsion, premises, tacticMenu, predictors, exemplars, ttrl,
  monitor, repair) with its widget shape, safe default, and measured recommendation. The GUI,
  the ablation graph, and `blueprint/run.js`'s flags all key on these names (§5.8).
- **The ablation harness is a measurement instrument, not a second system.** It treats the live
  loop as the system under test: each experimental configuration (recipe + component mask) is
  mapped onto the loop's own constructor options, run, and the loop's own counters
  (`llmCalls`, `tacticCalls`, `predictorSkips`) are read back. The instrument's only machinery
  is experimental design (full factorial over the component toggles at equal budget),
  statistics (Wilson CI, main effects, pairwise interactions), and record-keeping (reports,
  provenance). Its output surface is `runs/defaults.json` — recommendations the live path and
  the GUI consume, never the loop's behavior (§5.7).

### 0.5 The managed resource: redundant reasoning

The resource every layer of this system manages is *redundant reasoning* — the design rationale
is stated here once and the mechanisms are named where they live (the conceptual grounding is
`research_notes_2026.md` §5). Four compression claims, each with a live mechanism:

1. **State equivalence** — the goal-state transposition graph (§2.2) quotients tactic histories
   that reach the same normalized state, so search statistics are shared, not recomputed.
2. **Reusable lemmas** — the blueprint DAG and the lemma store (§2.8) turn a theorem family into
   a small set of reused dictionary entries; every reuse is kernel re-verified, because a
   corrupted dictionary entry is worthless.
3. **Task-relevant context** — premise retrieval, the tactic menu, and prompt synthesis (§4)
   send the next decision the information sufficient for it, discarding the irrelevant bulk of
   the environment.
4. **Learned search priors** — failure predictors and the dataset (§6) compress historical
   outcomes into rejection rules and preference pairs; the exploration rate is their pressure
   valve against over-compression.

Kernel accountability is the unifying constraint: a compressed representation counts only when
it re-expands into a kernel-verified artifact. The direct measurement of compression itself —
proof description length, library-relative description length, and the amortized-cost curve
across accumulated lemmas — is staged in the §6.1 metrics backlog, not fabricated before the
instrumentation exists.


---

## 1. Repo layout

ESM package, `"type": "module"`.

```
kanforge/
  index.js                   # root entry point
  env.js                     # environment/config loader
  core/                      # memoized DAG + proof-state primitives (the live surface only)
    lazy.js                  # Lazy (memoized thunks) — used by PullGraph
    pullgraph.js             # proof DAG: nodes, edges, invalidate, serialize
    transpositionGraph.js                # goal equivalence classes (Level 2 search structure, §2.2)
    hasher.js                # Hasher (statement/event hash chains)
    state.js                 # straighten / unstraighten (tree ↔ script)
    scheduler.js             # dependency-ordered dispatch over the PullGraph (Wave2 §7–8)
    patch.js                 # typed mutation record: Patch + patchFromEvent (§2.7)
    guardrails.js            # invariant spec + guardrail logic
    checkpoint.js            # run-level checkpoint: blueprint state + rounds + hash chain + events — resumable
  lean/
    backend.js               # adapter interface + factory (createBackend)
    backendRepl.js           # leanprover-community/repl impl (JSON-lines, pool)
    backendCli.js            # `lean` CLI impl
    pin.js                   # toolchain + mathlib4 pin, statement hashing
    goalText.js              # goal text extraction / normalization
    moduleResolver.js        # stale-alias → real module resolution within the pinned mathlib tree
    symbolIndex.js           # derived symbol → defining-module index (built from the mathlib source; cached per pin)
  agent/
    loop.js                  # the agent loop: observe→propose→act→verify→repair→commit; PullGraph + scheduler + backendRepl + one LLM adapter; node id = statement hash; oldest-sorry priority; stop budget; traced events
    solve.js                 # goal-solved / lemma-proved stopping rules
    repair.js                # error-driven repair (classify, retry)
    prompts.js               # prompt builder from Lean terms
    llm.js                   # sole LLM client: drives the opencode CLI (no API key; KANFORGE_LLM_MODEL selects the model)
    roles/                   # multi-agent ensemble (P7)
      autoformalizer.js      # prose → kernel-typechecked statement (+ probes, consensus, ledger, pin)
      conjecturer.js         # proposes targets in the four §0.2 shapes (strict JSON)
      prover.js              # the ensemble's proving unit (TacticLoop-backed)
      critic.js              # statement-match + readability review (deterministic + optional LLM)
  blueprint/
    skeleton.js              # theorem → DAG of kernel-typechecked sorry-stubs (LLM decomposition; every stub backend-checked; lemma→theorem normalization)
    dag.js                   # blueprint validation, topological order, cycle detection, dependents index
    refine.js                # fill the lowest unproved stub bottom-up via the loop; re-split on failure (adds children, never edits statements)
    run.js                   # skeleton → refine CLI driver; writes per-run lemma store + training dataset + development digest + per-lemma commits under runs/
    drift.js                 # re-verify pinned statement hashes
  search/
    bestofn.js               # baseline
    bfs.js                   # best-first over proof states
    mcgs.js                  # MCGS with transposition merging
    repulsion.js             # Goedel-style diversity penalty
    premises.js              # premise retrieval + premise-locked flag
    swiss.js                 # Swiss-tournament best-of-n (Bradley-Terry ranking, LLM pairwise judge, §5)
    tacticMenu.js            # goal-shape-keyed tactic capability menu
  optimization/
    bus.js                   # central event bus
    store.js                 # bounded event store (causal parent links)
    causal.js                # causal TELEMETRY / trace analysis (Markov transitions, failure correlations, timing, critical path) — NOT causal inference (see §6)
    metrics.js               # KPI calculator (wired into the loop's per-run outcome; catalog in §6.1)
    patterns.js              # degeneracy / reward-hacking monitors (pure function of the event stream)
    exporter.js              # telemetry export (JSONL events + KPI summary sidecar)
    reward.js                # reward function (initial defaults, §6)
    grpo.js                  # GRPO update harness (trajectories, group advantages, clipped loss)
    ttrl.js                  # test-time RL (within-run budget adaptation from outcomes)
  digest/
    writeup.js               # Markdown/HTML with KaTeX
    auditPack.js             # per-lemma publication unit (§7)
    development.js           # whole-development digest (writeup + audit + hash chain)
  growth/
    commit.js                # per-lemma artifact writer: statement.lean + proof.lean + audit.json into the workdir
    lemmaStore.js            # content-addressed lemma store → retrieval index (§2.8): statementHash, goal shape, imports, deps, proof length, tactic trajectory, difficulty
    dataset.js               # append-only JSONL training samples + deterministic held-out split + contamination check
    multibody.js             # multi-agent lemma-ownership lanes (P7)
  config/
    registry.js              # canonical component registry (§5.8): widget shapes, safe defaults, measured recommendations; runs/defaults.json is its evidence-written output surface
  bench/
    ablation.js              # measurement instrument (§0.4): drives the live TacticLoop across recipe × component-mask cells; factorial graph + recommendations
    mathlibSmoke.js          # mathlib-backed smoke set (imports take 5-35s cold)
    premisesCorpus.js        # premise corpus for retrieval experiments
    run.js                   # benchmark run driver
    smoke.js                 # 23-problem miniF2F-style smoke set (5 tiers), runs over real repl
    stepSmoke.js             # multi-step tier problems (build_order.md §5.4)
    verifyStepSet.js         # full-paces chain verifier for the step tier
    buildSymbolIndex.js      # one-time symbol→module index build from the pinned mathlib source (cached per pin)
  test/                      # unit + integration tests (Node built-in test runner)
  corpus/                    # open-target corpus (P7 intake gate §7.0): sources/ (primary docs) + index/corpus.json (322 open + Lean-formalized Erdős candidates)
```

---

## 2. Core contracts

### 2.1 `Lazy`
```js
Lazy.of(fn)         // memoized thunk
lazy.map(fn)        // transform
lazy.flatMap(fn)    // sequential composition
lazy.get()          // force
```

### 2.2 Two-level proof structure

KanForge operates on two distinct but related structures:

**Level 1: Lemma DAG** (the dependency graph)
- Nodes = lemmas (theorems to prove)
- Edges = "uses" dependencies (lemma A's proof may reference lemma B)
- Scheduler dispatches lemmas dependency-ordered
- Each lemma has a pinned statement and a proof (initially null, built from Level 2 search)

**Level 2: Goal transposition graph** (within each lemma — the incumbent structure; the genuine
e-graph is the staged `searchStructure` alternative, build_order.md §5.12)
- Root = the lemma's initial goal (the statement's type + empty context)
- Nodes = equivalence classes of goals (identical under the syntactic normalization of §2.2)
- Edges = tactic applications that transform one equivalence class into zero or more subgoal classes
- A goal class is "solved" when a tactic closes all goals in the class (produces no subgoals)
- A lemma is "proved" when the root class is solved
- The proof is a tree of tactics extracted from the transposition graph (root to solved leaves)
- Statistics (visit counts, success rates, value estimates) are shared across all goals in an equivalence class

The transposition graph enables **transposition merging** (research_notes trick 4): different tactic sequences that produce the same normalized goal share a single equivalence class with shared statistics. This is what makes search efficient — MCGS, BFS, and other search algorithms operate on the graph, not a tree, so they automatically benefit from transposition merging.

The LLM operates at Level 2: it proposes ONE tactic for ONE goal. The backend applies the tactic and returns new subgoals. The search operates on the transposition graph: it searches over tactic sequences, and identically-normalized goals are automatically merged into the same equivalence class.

The scheduler operates at Level 1: it dispatches lemmas dependency-ordered. Within each lemma, the tactic-level search runs to completion (or budget exhaustion) before the lemma is marked verified or failed.

**The GoalStateGraph contract (`core/goalStateGraph.js`).** The loop, the search recipes, the
commit gate, and the verifier harnesses consume Level 2 through one interface — `addGoal`,
`setRoot`, `applyTactic`, `applyPatch`, `markFailed`, `currentGoal`, `getOpenGoals`, `isSolved`,
`isRootSolved`, `isFullySolved`, `extractProof`, `getStats`, `updateValue`, `serialize`/
`deserialize`, plus the class shape (`id`, `goals`, `tactics`, `stats`, `parents`, `state`).
Both structures implement it, and `assertGoalStateGraph` fails loudly at wiring time if a
structure misses a method. A shared conformance suite (`test/goalStateGraphConformance.js`)
runs identical scenarios against both, so the structure is a configuration, not a code
dependency.

This two-level structure is what makes the loop's operations meaningful: a single tactic applied to
a single goal produces zero or more subgoal equivalence classes; a proof is a tree of such
applications extracted from the transposition graph. The DAG tracks both levels: lemma dependencies at Level 1,
goal transposition graphs at Level 2.

### 2.3 `PullGraph` — the proof DAG
Node (Level 1 — lemma):
```jsonc
{
  "id": "sha256(statement)",
  "kind": "lemma",
  "statement": { "text": "...", "hash": "sha256", "pinned": true },
  "state": "STUB" | "PROVING" | "VERIFIED" | "FAILED" | "WEAKENED",
  "proof": null | { "script": "...", "tree": "...", "verifiedAt": "...", "checkpoint": "ref" },
  "deps": ["sha256(...)", ...],
  "interface": { "signature": "...", "hash": "sha256" }
}
```

Node (Level 2 — goal equivalence class within a lemma's transposition graph):
```jsonc
{
  "id": "sha256(normalizedGoalType + normalizedContext)",
  "kind": "goal-class",
  "lemmaId": "sha256(parent lemma statement)",
  "goals": [
    { "type": "...", "context": [{ "name": "...", "type": "..." }] }
  ],
  "state": "OPEN" | "SOLVED" | "FAILED",
  "tactics": [{ "tactic": "...", "subgoalClasses": ["sha256(...)", ...] }],
  "stats": { "visits": 0, "successes": 0, "value": 0.0 },
  "parents": ["sha256(parent goal class)" | null]
}
```

The `id` is computed from a **normalized** goal — whitespace-collapsed text with the context
binders alpha-renamed under one substitution (applied to the binder names, every context
binder's TYPE, and the target type, with capture-avoiding fresh names). That normalization is
the identity: no definitional-equality reduction and no algebraic simplification. Multiple
concrete goals that normalize identically map to the same equivalence class. The `goals` array
tracks all concrete goals in the class (for debugging and extraction). The `stats` are shared
across all goals in the class, enabling transposition merging.

**Terminology and identity semantics.** The incumbent Level 2 structure is a **goal-state
transposition graph** — a memoized proof-state graph that merges identical normalized goal
descriptions. It is NOT an equality-saturation e-graph: there are no e-nodes, no congruence
closure, and no rewrite saturation; classes merge only when the normalized text is equal. Two
goals that are mathematically equivalent but textually different (`0 + x = y` vs `x = y`) stay
in different classes: a tactic that solves one need not solve the other, and a wrong merge
would corrupt solved-state propagation and shared statistics. Semantic (algebraic)
normalization exists only as `semanticNormalize`, used by the lemma store's retrieval index
where the kernel re-verifies every match — it is never class identity. Parent edges
(`parents[]`) are populated by tactic expansion (genuine children get their parent class id;
carried-over siblings do not), so MCGS backpropagation walks real ancestry through
transposition merges.

The genuine equality-saturation e-graph — `core/egraph.js`: e-nodes over the goal term
structure, union-find classes, congruence closure, and rewrite rules whose every union is
confirmed by the Lean backend (definitional-equality check, memoized) — is the staged
`searchStructure: 'egraph'` alternative (build_order.md §5.12). It merges goals the
transposition graph cannot (e.g. `0 + x = y` with `x = y` when Lean confirms the identity),
retains alternative successful expansions per class, and is measured against the incumbent at
equal budget — the winning default is written to `runs/defaults.json` like any other
component.

**Class identity is collision-safe (correctness, not just cache efficiency).** The class id is
`sha256(normalizedGoalType + normalizedContext)` — the canonical serialized key is the identity,
and the hash is a lookup index over it, never the identity itself. Because the id determines
equivalence-class identity, a collision would merge unrelated proof states and corrupt the search
graph; therefore:

- The **canonical key** (normalized type + normalized context, deterministically serialized) is
  stored on the class and is the equality authority.
- The id is the **SHA-256** of that canonical key (64 hex chars). A weak 32-bit hash is not
  acceptable for identity — it is only a pre-filter, and any pre-filter hit must be confirmed by
  comparing the canonical keys before merging classes.
- On a key mismatch under the same id (hash collision), the class is **not merged**; the new goal
  is inserted under its own canonical key with a collision-resolved id, and the collision is
  recorded as telemetry (count of `transposition_collision` events).
- Equivalence is decided by canonical-key equality, not by hash equality.

The `state` axis is proof-semantic; the scheduler adds a parallel lifecycle axis
(`DIRTY/QUEUED/BUILDING/VERIFIED/FAILED/CACHED`, §2.6). Statement + interface pins together
implement "no interface weakening" (Wave2 §5): synthesis may improve proofs, never redefine
correctness.
Edge:
```jsonc
{ "source": "id", "target": "id", "role": "uses" | "implies" | "defines", "lifting": "ctx" }
```
API:
```js
graph.register(nodeId, computation, errorHandler?) // register a memoized computation (Lazy-wrapped)
graph.dependsOn(nodeId, depId)                    // record a dependency edge
graph.resolve(nodeId)                             // force a memoized value (scheduler dispatch path)
graph.invalidate(nodeId)                          // transitive re-prove downstream (invalidate dependents)
graph.serialize() / deserialize(json)             // checkpoint / resume (whole forest = transaction log)
```
The PullGraph surface is the API above; the scheduler performs dependency-ordered dispatch, and
the loop reads `nodes.get(id).computation.value` directly under its own budget.

### 2.4 `state.js` — straighten/unstraighten (tree ↔ script)
```js
straighten(tree) -> { script, map }        // tree → Lean script + provenance map
unstraighten(script, map) -> tree          // script → tree
assertRoundTrip(tree)                      // bijectivity check, enforced in tests
```
Rule: repairs edit the tree, then re-straighten; kernel successes un-straighten back. Never edit
one representation only (the dual of Wave2's "no representation diverges independently" — we keep
the tree↔script duality as the backbone and skip a third transposition graph representation; see §10).

### 2.5 `guardrails.js` — the invariant spec
```js
checkAll(graph, ctx) -> { ok, violations[] }
// 1. interfaces are pinned (no weakening): statement + signature hash unchanged;
//    immutable = theorem statements, signatures, public types, module interfaces
//    (Wave2 §5); mutable = proofs, implementations, helper definitions, rewrites
// 2. every VERIFIED lemma passed kernel check
// 3. no axiom/admit/unsafe/set_option leakage
// 4. blueprint acyclic + dependency-complete
// 5. resumable from any checkpoint (serialize/deserialize identity)
// 6. incremental verification: invalidation touches only dependency descendants
//    of a changed node (Wave2 §7), never unrelated cached nodes
// 7. scoped relaxations (below) are recorded, expire, and never touch HARD invariants
// plus: checkHermetic over the run
```
The planner checks every proposed move against these before acting (guardrails-as-logic, not a
rule list). `optimization/patterns.js` feeds degeneracy observations here.

**Permission model (scoped relaxation, not an off-switch).** Invariants are tiered so the agent
is not paralyzed by its own guardrails:

- **HARD — never relaxed:** kernel verification (2), no axiom/admit/unsafe leakage (3),
  statement + interface pins (1), checkpoint identity (5).
- **PHASE-SCOPED — relaxable within a named phase, always recorded:** `sorry` stubs during the
  skeleton/refine phases (invariant 4 is "acyclic + dependency-complete", not "no stubs");
  unverified `PROVING` states during search; unpinned exploratory goals.

`ctx.permissions` grants scoped relaxations `{ kind, phases: [...], expiresAt }`; every grant and
its expiry is an event on the causal bus, and `checkAll` verifies grants are in-scope and
unexpired (invariant 7). VERIFIED and COMMITTED require the full hard set with no outstanding
grants. "Never weaken" applies to statement/interface pins (hard), not to proof-state stubs
(scoped) — allowing a stub during skeleton does not switch the guardrail system off, and a
violation of even a scoped grant still trips.

### 2.6 `scheduler.js` — dependency-ordered dispatch (Wave2 §7–8)
The scheduler operates at Level 1 (lemma DAG): it dispatches lemmas dependency-ordered to the backend pool. Within each lemma, the tactic-level search (Level 2, §4) runs to completion.

The graph is memoized per node; the scheduler adds the *concurrent* dimension: batch the lemmas,
order by the dependency DAG, and dispatch them to the backend pool via a `check(nodeId)` callback
(the loop's per-lemma `_proveLemma`); the loop reads `nodes.get(id).computation.value` directly.

Node lifecycle (extends the proof-state axis in §2.3; the scheduler's view):
```
DIRTY → QUEUED → BUILDING → VERIFIED   (kernel accepted)
                    └──────→ FAILED    (kernel rejected / timeout)
CACHED   (restored from a checkpoint; skipped, never re-dispatched)
```
- Only descendants of a modified node go DIRTY; unrelated nodes stay CACHED (invariant 6, §2.5).
- A node dispatches only when all its deps are VERIFIED or CACHED; a failed dep fails its
  dependents without dispatch (never weaken).
- Priority tuple (default, overridable): dependency criticality → cache reuse → verification
  history → estimated cost (Wave2 §8). Ties break by node id (deterministic).
- Guarantees: no cyclic dispatch (DAG), bounded in-flight (concurrency), deterministic ordering,
  maximal independent parallelism.
- API: `enqueue(ids)`, `run()` -> `{ ok, results, failures }`, `onProgress`, timeout/kill-on-hang.
- **Cancellation semantics are explicit.** The scheduler's `timeoutMs` is a LOGICAL timeout: when
  it fires, the scheduler aborts its own signal, stops waiting, and reports the node FAILED. It
  does not stop the underlying computation — cooperative cancellation is the `check` callback's
  obligation via the AbortSignal, and hard cancellation (killing a worker) is the backend's
  responsibility (§3.1 kill-on-hang). The loop sets `timeoutMs = null` and relies on the
  backend's kill-on-hang precisely so the scheduler's semantics are never mistaken for process
  control.
- Locality: work scales with affected subgraph depth, not project size (Wave2 §14).

### 2.7 Patch algebra — the typed mutation record (`core/patch.js`)
The patch is the interface between probabilistic generation and deterministic compilation
(`docs/Research/KanForge_whitepaper.md` §4): the loop's core operation is a typed graph
mutation, and the patch is its typed form:

```js
p = { node, op, replacement, scope, meta }
op ∈ { 'tactic', 'lemma', 'rewrite', 'replace', 'reuse' }
```

- `tactic`   — ONE tactic applied to a goal equivalence class, producing zero or more subgoal classes (kernel check via `applyTactic`)
- `lemma`    — introduce a helper lemma (adds a stub child at Level 1; statement pinned)
- `rewrite`  — alternative proof path (transposition-merge target; dedup, no tree mutation)
- `replace`  — replace a failing subproof subtree (tree-level repair, re-straighten)
- `reuse`    — apply a stored lemma from the retrieval index (§2.8; exact/specialization/generalization/pattern-transfer)

The patch is **derived from the live event stream, not a parallel dead type**: every loop event
(`tactic_proposed`/`applied`/`failed`, `subgoal_created`, `goal_solved`, `lemma_verified`,
`repair_*`) already carries the patch tuple's fields (`node`=goalClassId, `replacement`=tactic,
`meta`=attempt/llmMs/tokens/via). `core/patch.js` provides `patchFromEvent(e)` — a pure projection
of an event into the typed form — and the patch stream is captured per lemma and stored in the
retrieval index + development digest as the transformation history (whitepaper §14). A proof is a
tree of tactic applications extracted from the transposition graph; the patch stream is the typed trace of how
that tree was built.

### 2.8 Lemma store as retrieval index (`growth/lemmaStore.js`)

The lemma store is content-addressed today (`statement hash → artifact`), but its design intent is a
**retrieval index**: theorem proving becomes partly a retrieval problem. Given a new goal, retrieve
a similar *proven* lemma and decide between the four reuse modes:

```
new goal
   │
   ▼
retrieve similar proven lemma
   │
   ├── exact reuse        — same statement hash: reuse the stored proof as-is (no LLM/kernel spend)
   ├── specialization     — the stored lemma is more general: instantiate it
   ├── generalization     — the stored lemma is a special case: abstract it
   └── proof-pattern transfer — different statement, similar shape: replay the tactic trajectory
```

Each stored lemma carries the index columns (captured at `lemma_verified`):
`statementHash`, `normalizedGoalShape`, `freeVariables`, `imports`, `dependencies`,
`proofLength`, `tacticTrajectory`, `difficulty` (goal count / wall ms), `successConditions`
(verified, proofScript). The store's API is:

```js
store.put(lemmaIndex)              // index columns + artifact, atomic per lemma
store.get(statementHash)           // exact-reuse lookup (O(1))
store.findSimilar(goalShape)       // ranked candidates by goal-shape / trajectory overlap
```

**Reuse modes in the pipeline.** Exact reuse is the first live mode: `blueprint/refine.js` consults
the store before spawning the tactic loop and takes the stored proof when the statement hash
matches — a re-run of an already-proven development costs no LLM or kernel calls. The other three
modes are staged (build_order.md §5.7): specialization/generalization need the goal-shape and
binder index to match against; proof-pattern transfer needs the tactic trajectory to be replayed
against a new goal's context, which the loop's premise/tactic-menu machinery already supports.
A reuse is always verified by the kernel at commit — retrieval never bypasses verification.

---

## 3. Lean backend interface

```js
// backend.js — createBackend({ type: 'repl' | 'cli', ...config })
interface LeanBackend {
  applyTactic(goal, tactic) ->
    { status: 'ok'|'error', newGoals: Goal[], error?: LeanError }
  check(statement, opts) ->
    { status: 'verified'|'error'|'timeout', goals: Goal[], error?: LeanError, warnings: [] }
  extractGoals(src, position) -> Goal[]        // goals + local context at a position
  verifyProof(script) -> { status, error }     // kernel check of a full proof
  getInfos() -> { toolchain, mathlibHash, backends, poolSize }
  pin() -> Pin                                  // toolchain + mathlib pin (idempotent)
}
```

`applyTactic` is the primary interface for the tactic-level loop: given a goal (type + context) and a single tactic string, apply the tactic and return the resulting subgoals. This is the atomic operation that the LLM proposes and the backend executes. Each call is bounded (1-3s kernel check), so no timeout is needed at this level.

`check` verifies a complete statement (for batch verification and final proof validation). `extractGoals` extracts goals from a source position (for interactive editing). `verifyProof` checks a full proof script.
`Goal = { type: string /* Lean expr */, context: { name, type }[], pos }`
`LeanError = { span?, message, subErrors: [] }` — structured per Wave2 §11:
`{ location, constraint, expected, actual, dependencies }`; maps back to the failed graph
neighborhood for repair (never regenerate whole files; verified regions stay immutable).

Implementation notes:
- **REPL** (default for RL): JSON-lines over a process pool (like Kimina Lean Server); parallel
  verification; warm workers; kill-on-hang timeout. Driven against the *real* `repl` binary built
  at the pinned toolchain — no mocks, stubs, or facsimiles anywhere in the backend stack. The
  REPL is the **authoritative interactive proof engine**: it holds live proof states across
  tactic applications, which is what tactic-level search needs.
- **CLI**: real `lean` for CI batch verification. It reconstructs `example <binders> : <goal> :=
  by <tactic>` per application, so it loses what a live proof state naturally possesses (implicit
  and instance binder structure cannot be round-tripped through `formatBinders` faithfully). It
  is the batch-verification fallback, not a substitute for the interactive semantics.
- **lean4web**: *deferred.* Ships only once a real instance is exercised end-to-end; its API
  contract is not fabricated offline.
- **Statement pinning** (`pin.js`): whitespace-collapsed canonical text → sha256 — a CONTENT pin
  (textual mutation detector), not semantic theorem identity: it does not canonicalize
  alpha-equivalence, elaboration, notation, or definitional unfolding. Any mutation
  of goal text during search flips the hash → node `WEAKENED` + guardrail trip.

### 3.1 Pool lifecycle and resilience

The REPL pool is the correctness bottleneck, so its failure modes are specified up front, not
discovered at scale.

- **Lifecycle:** warm worker pool at startup; bounded concurrency (`scheduler.concurrency`);
  a check is a single request/response over one worker; on success the worker returns to the
  pool; on crash the worker is replaced and the job retried on a fresh worker (≤ 1 retry per
  job, then it fails loudly).
- **Kill-on-hang:** every check has a timeout (`scheduler.timeoutMs`); a worker that exceeds it
  is killed and replaced, with exponential backoff on repeated kills of the same worker profile.
- **Parsing resilience:** JSON-lines output is parsed per-line; a malformed line is skipped,
  logged, and attributed to the current job as `parseError` (never silently dropped the whole
  batch). stderr is captured separately and surfaced in `LeanError.detail` for repair.
- **Single-flight:** identical statements checked concurrently are deduped to one kernel
  invocation (cache hit for the rest) — a natural consequence of node identity in `pullgraph.js`.
- **Graceful drain:** on shutdown, in-flight checks finish or are killed within `timeoutMs`;
  partial results are checkpointed so resume does not redo them.
- **Health counters** surfaced via `getInfos()`: `{ poolSize, restarts, hangs, timeouts,
  parseErrors, poolUptime }`. Acceptance: normal runs hold `restarts = hangs = parseErrors = 0`
  (P0.3 resilience suite, `build_order.md`), asserted in `test/backend.repl.live.test.js` against
  the real `repl` binary.

**Pin drift:** the whitespace-normalized canonical text is *version-sensitive* — a Lean/mathlib
update can change the printed form without changing meaning. Therefore `pin()` returns
`Pin = { toolchain, mathlibHash, leanVersion, normVersion, statementHash }`, and pin verification
re-normalizes on the current toolchain and compares `normVersion`; a mismatch reports `DRIFT`
(not `WEAKENED`), so the operator re-pins deliberately rather than silently or falsely. Context
comparison is tri-state: a field known at pin time and unknown now reports DRIFT (uncertainty is
not equality). Never compare a hash computed under a different `normVersion`.

---

## 4. Agent loop

The agent loop operates at Level 2 (goal transposition graph within a single lemma). The scheduler dispatches lemmas at Level 1; for each lemma, the agent loop runs the tactic-level search below.

**Backward decomposition**: the loop works backwards from the target goal to simpler subgoals. Each tactic application reduces the current goal to zero or more simpler subgoals. The proof tree is built by working backwards: the root is the lemma's goal, each edge is a tactic that reduces complexity, and the leaves are solved goals (zero subgoals).

The loop is a class (`TacticLoop`, `agent/loop.js`). It implements
the observe → propose → act → verify → repair → commit stages as explicit methods over the transposition graph,
with a stateful budget, concurrency, and repair path:

**Role split.** The loop is orchestration; two extracted modules own the heavy seams:
- `agent/proposalEngine.js` (`ProposalEngine`) — the single LLM seam. Every model call the loop
  and its delegated recipes make (proposals, repairs, swiss proposals + pairwise judges, bfs/mcgs
  calls) flows through its walled client, giving exactly one owner for (a) LLM-call accounting
  (write-through counting — no path under- or over-counts, and cost-normalized ablation reads
  the same counter), (b) the `maxLlmCalls` budget wall (after exhaustion every further call
  returns an empty response, so the budget is hard for every recipe, not only the inline path),
  and (c) **failure kinds** — `abstention` (no usable tactic), `budget-exhausted`, and
  `provider-failure` (transport/CLI threw) are distinguished, so a dead provider is never
  reported as a silent model.
- `agent/commitGate.js` (`runCommitGate`) — the verification-and-policy sequence: pin drift,
  proof assembly (tree → script → full source), pre-flight, whole-source kernel verify,
  premise lock, the HARD guardrail gate (leakage scan over the complete source), and the hash
  chain entry. It makes no LLM calls and returns typed outcomes the loop maps to events.

```
observe(goal)   -> PromptInput        // goal (type + context) + retrieved premises → prompt
propose(input)  -> tactic             // LLM: ONE tactic string per call
act(tactic)     -> Applied            // backend.applyTactic(goal, tactic) → new subgoals
verify(result)  -> Verification       // kernel check of tactic application; record PASS|FAIL
repair(fail)    -> tactic             // isolate failing sub-goal (Wave2 §11 error); low top-K retry
commit(verified)-> LemmaRef           // all goals solved → compose proof script → verify full statement
```

The loop passes tactic strings directly; the typed mutation record of these operations is the
patch algebra (§2.7).

Each LLM call proposes ONE tactic for ONE goal. The backend applies it and returns zero or more new subgoals. The loop continues until all goal equivalence classes in the transposition graph are solved (lemma proved) or the budget is exhausted. **Complexity reduction**: each tactic application should produce subgoals that are simpler than the parent goal; if a tactic produces subgoals of equal or greater complexity, it makes no progress.

**Event vocabulary** (all stages emit to `optimization/bus.js`; canonical — do not re-list in other
docs):
```
TARGET_SET        AUTOFO_ATTEMPT    SKETCH_GENERATED  TACTIC_PROPOSED
TACTIC_APPLIED    SUBGOAL_CREATED   GOAL_SOLVED       GOAL_FAILED
VERIFY_START      VERIFY_PASS       VERIFY_FAIL       SUBGOAL_ISOLATED
REPAIR_PROPOSED   LEMMA_PROVEN      LEMMA_COMMITTED   STATEMENT_WEAKENED
```
Event = `{ id, t, type, parent?, nodeId?, candidate?, detail }` — parent chaining gives the
causal DAG that `causal.js` consumes.

Stopping rule (`solve.js`): a goal is *solved* iff `applyTactic(goal, tactic)` returns zero subgoals. A lemma is *proved* iff all goal equivalence classes in its transposition graph are solved **and** `statement.hash === pinned.hash` (the composed proof script verifies the full statement).

### 4.1 Proposal-unit constraint (granularity schema)

The loop asks the LLM for a **proposal** bounded by `PROPOSAL_SPEC` (`agent/prompts.js`) and
enforces it atom-wise. The schema is data, not prose: `{ maxAtoms: 1 }` — one response may
propose one kernel-applicable tactic for one goal — and every prompt path (the loop's,
`bestofn`'s, `bfs`'s, `mcgs`'s, `swiss`'s) renders it from that one source.

**The invariant that makes granularity swappable: atom-wise application with canonical state
capture.** A proposal, whatever its granularity, is consumed by applying each tactic atom
through `backend.applyTactic`; every intermediate goal state gets a canonical key and merges
into the transposition graph as an ordinary class, and every atom is a `Patch({op:'tactic'})` in the patch
stream. A multi-atom proposal is therefore a pre-committed, kernel-verified *path* — it feeds
the transposition graph (more material for transposition merging and shared statistics), never bypasses it.
The contra-indicated variant is black-box script application (kernel checks the whole script and
returns only the final state): that discards intermediate classes, merging, and the patch
stream, and is out of contract.

**Two granularities are already live.** The proposal path runs at 1 atom; the repair path runs
at whole-script granularity — a multi-line repair response is verified as complete source
(`isMultiLineProof` → `backend.check` → the root class carries `_directProof`) and skips
per-goal application. Multi-step replay through the transposition graph frontier is likewise already
exercised by `bench/verifyStepSet.js`'s golden chains (`replayChain` over `GoalTranspositionGraph`/`open[0]`),
so the atom-wise act machinery has no single-atom assumption.

**The default stays 1 atom for search — deliberately, for sample efficiency.** One LLM call is
one branch; a k-atom macro commits k atoms down one branch where k single-atom calls explore k
branches. The frontier systems run both granularities in different phases (coarse sketch to
seed, fine tactic search to refine); the schema makes that phase choice a configuration, not an
architecture change. The staged axis (`build_order.md` §5.11) is `maxAtoms: 1..k` measured at
equal budget via the existing cost counters (`llmCalls` vs `tacticCalls` per cell), with
failure-position repair (a macro failing at atom k commits its verified prefix as transposition graph edges
and repairs from the failure point — strictly richer feedback than single-atom failure). The
DAG (Level 1) is untouched by any of this: its proposal unit — a whole lemma decomposition —
is already coarse-grained via the skeleton, and the schema generalizes the same idea to
Level 2.

---

## 5. Search

Search operates at Level 2 (within a lemma's goal transposition graph). Each search algorithm explores tactic sequences over the transposition graph structure: given a goal equivalence class, propose tactics that decompose it into simpler subgoal classes, apply them, repeat. The search works backwards from complex goals to simple subgoals, seeking tactics that maximally reduce complexity at each step.

The transposition graph structure enables **transposition merging** (research_notes trick 4): different tactic sequences that produce equivalent goals share a single equivalence class with shared statistics (visit counts, success rates, value estimates). This is what makes search efficient — all search variants automatically benefit from transposition merging because they operate on the transposition graph, not a tree.

- `bestofn.js`: for a single goal class, sample k tactic proposals, apply each, take first that succeeds. Pre-filter stage (Wave2: cost-model idea, CPU-side): reject known-failing patterns (causal predictors), premise-lock violations, and near-duplicate patches before verification.
- `bfs.js`: best-first over goal classes by progress (open-goal spectrum decrease). A state is the set of unsolved goal classes; a tactic application transitions to a new state with simpler subgoal classes.
- `mcgs.js`: **UCB-guided graph search over the open goal equivalence classes.** Selection descends
  from the root by UCB (`value/visits + exploration·√(ln(parentVisits)/visits)`) over per-class
  stats; expansion applies ONE tactic via the backend (the LLM proposes, the kernel disposes);
  backpropagation updates the selected class and ALL its parents (transpositions share statistics).
  This is deliberately **not textbook MCTS**: there is no cheap random rollout — the "simulation"
  is an expensive LLM + kernel call — so the phases are selection / expansion / backprop only, and
  the UCB values are a *heuristic* whose statistical meaning must be validated empirically, not
  assumed. **Open empirical question (see `build_order.md` §5.6):** does MCGS outperform simpler
  best-first / beam / BFS strategies on held-out theorem families once LLM-call and
  kernel-verification cost are normalized?   Transposition merging is built into the transposition graph
  structure — identically-normalized goals share one class (§2.2) — and node identity is
  normalized so *every* search variant inherits the merge, not just MCGS. MCGS backpropagation
  walks the parent edges that tactic expansion populates, so transpositions share the update
  across real ancestry.
- `repulsion.js`: log-ratio diversity penalty among concurrent tactic samples. `RepulsionSampler`
  is the actionable form — it refuses to re-propose already-tried tactics (exact-duplicate penalty)
  and echoes the tried list into the prompt so the generator steers away; `MCGS`/`BestFirstSearch`
  take a `repulsion` flag that skips duplicate kernel re-checks.
- `premises.js`: relevance scoring over mathlib; `premiseLocked: true` restricts the generator to retrieved premises only.
- `swiss.js`: Swiss-tournament best-of-n selection (faithful to Open Proof Corpus methodology, arXiv:2506.21621 §5.5): round-robin tournament judged pairwise by the LLM, Bradley-Terry ratings fit by MLE, candidates applied in rating order with kernel-grounded fallthrough. OPC reports +17% improvement over naive best-of-n (26%→43% vs 26%→36%).
- `bench/ablation.js`: the measurement instrument for §5.7. It has no proof machinery of its
  own: each cell constructs a real `TacticLoop` with the cell's options (the recipe name maps
  onto the loop's `searchRecipe` + `repulsion`; the component mask maps onto
  `menu`/`exemplars`/`ttrl`/`monitor`/`repair`/`predictors`/`premises`), runs it under a shared
  LLM-call budget (`maxLlmCalls`), and reads the loop's own counters. The report carries pass
  rate + cost per recipe; the `--ablate=<comps>` graph adds main effects + interactions and
  writes recommended defaults to `runs/defaults.json`.

**Integration contract (what is in the live path).** The live loop (`agent/loop.js`) is fully
ablatable: every strategy is a toggle, not a one-way gate. The loop accepts a `searchRecipe`
option naming which strategy handles per-lemma goal selection and proposal —
`loop` (default inline single-tactic), `bestofn`, `bfs`, `mcgs`, or `swiss` — plus orthogonal
toggles for `repulsion`, `premises`, `menu` (tactic capability menu), `exemplars`, `predictors`,
`ttrl`, `monitor`, and `repair`, and a per-lemma LLM-call budget (`maxLlmCalls`). The
open-problem pipeline (`blueprint/refine.js`) passes the configured recipe through, so a mission
runs under whatever strategy combination is selected, and the ablation graph
(`bench/ablation.js --ablate`) measures the same toggles the loop can take. The registry
(`config/registry.js`, §5.8) is the single catalog of these components; the graph writes its
measured recommendations to `runs/defaults.json`, which `blueprint/run.js` applies at startup
(CLI flags override). This makes "compare, then decide" (build_order.md §5.1) a runtime switch,
not a rebuild: a strategy with a measured advantage is enabled by configuration, and one without
is disabled — both without code change.

### 5.7 Benchmark discipline (fixed corpus, ablation graph, provenance)

The ablation harness is the project's central experiment. Its rules make every claim reproducible
and every comparison cost-normalized:

- **Fixed corpus.** `bench/smoke.js` (core), `bench/mathlibSmoke.js`, `bench/stepSmoke.js` are the
  fixed corpora; a run identifies the corpus + problem subset + seed in its report config. No
  ad-hoc problem sets in a published comparison.
- **Reported per cell (where the event stream supports it, else `null` per §6.1):** success rate,
  wall-clock time, LLM calls, Lean (kernel) calls, token usage, proof length — plus confidence
  intervals on the pass rate (binomial/Wilson on `solved/total`) where the cell has ≥ 2 problems.
- **Component ablation GRAPH, not a ladder** (`bench/ablation.js --ablate=<comps>`). There is no
  known hierarchy of merit among components, and component effects are neither assumed additive
  nor assumed commutative — the experiment must *measure* that. So the design is a factorial graph
  over component toggles:
  - Each **node** is a full configuration: a subset of the registry's component names —
    `{tacticMenu, premises, predictors, repulsion, exemplars, ttrl, monitor, repair, search}` —
    where `search` is the recipe axis (bestofn vs mcgs) and `repulsion` composes with it. The
    goal-state search structure itself becomes an axis when both exist: `searchStructure`
    (transposition graph vs e-graph, build_order.md §5.12) is measured like any other
    component — the kernel is the only non-ablated infrastructure.
  - Each **edge** connects two configurations differing in exactly ONE toggle — the graph is the
    Boolean hypercube of configurations, not a fixed linear order.
  - The report gives, per node, the same per-cell table; and per component, its **main effect**
    (mean pass rate with the component on minus off, over all configurations holding the rest
    fixed), plus **pairwise interactions** (does the effect of A change when B is on?). A
    component with no measured main effect is reported as such. The additivity/commutativity
    question is answered by the interaction terms — never assumed away by a rung ordering.
- **Recommendations are the graph's output surface.** `recommendFromGraph` turns measured main
  effects into component recommendations (a 5-percentage-point decision threshold — below it, a
  component's measured effect is noise, not a default), and `recommendRecipe` picks the cheapest
  recipe among those solving within margin of the best pass rate. Both are written to
  `runs/defaults.json` by `config/registry.js` with provenance; `blueprint/run.js` applies them
  at startup and CLI flags override. The file is written only by the ablation harness, never
  hand-edited.
- **Provenance is a first-class research feature.** Every run's report config carries:
  `theorem/statement hash, toolchain + mathlib pin, model + version, prompt version, search
  policy (recipes, N, budget, component mask), proof trace + dependency graph (development
  digest), resource usage (llmMs, tokens, kernel calls), and the final kernel verification
  status`. The development digest (`digest/development.js`) already carries the hash chain; the
  ablation report config carries the run parameters. A result is reproducible iff the report
  config + digest + commit hash can be replayed — that is the acceptance bar.

### 5.8 Component registry (`config/registry.js`)

One catalog for every toggleable, slidable, or selectable component of the live loop, with three
consumers:

- **GUI** — each entry declares its widget (toggle / slider / dropdown) with range, current
  value, and label; the GUI reads `effectiveDefaults()` for initial state and
  `recommended` for the measured value.
- **Ablation graph** — the factorial components are registry names (§5.7); a measured run
  updates `recommended` via `runs/defaults.json`.
- **Live path** — `blueprint/run.js` loads `runs/defaults.json` at startup
  (`applyRecommendations`) and resolves `effectiveValue(name)` = `recommended ?? default`;
  CLI flags override.

Components: `recipe` (dropdown: `loop`/`bestofn`/`swiss`/`swiss+repulsion`/`bfs`/`mcgs`),
`maxTacticsPerGoal`, `maxGoalsPerLemma`, `maxLlmCalls` (sliders), `repulsion`, `premises`,
`premiseLocked`, `premiseTopK`, `tacticMenu`, `predictors`, `exemplars`, `ttrl`, `monitor`,
`repair` (toggles). A component's `recommended` is `null` until evidence sets it; `default` is
the safe initial. Components absent from the registry are not configurable by any consumer.

---

## 6. Sharpening / RL

Reward (`reward.js`) — **initial defaults, to be tuned in P6**, not settled values. Rewards operate at the tactic level (Level 2):
```
+1.0  goal solved (tactic produces zero subgoals)
+0.5  complexity reduction (subgoals simpler than parent goal)
+0.1  goal-depth decrease (fewer open goal equivalence classes in transposition graph)
+0.05 lemma reused later (Level 1)
-0.1  repair round (tactic failed, retry)
-0.5  wasted tactic (no complexity reduction, no progress)
-1.0  guardrail trip
```

`causal.js` is **causal telemetry / trace infrastructure, not causal inference.** The name is
intentional about what it does NOT claim: the parent chain supplies a *causal ordering* (per-lemma
emit order), but not causal *identification*. What it computes is sequence statistics over that
ordered stream — a Markov transition matrix, failure *correlations* (contiguous tactic-head windows
ending in FAIL), timing aggregation, and event-chain analysis:
- `getTransitionMatrix()` — action→action Markov probabilities (sequence statistics, not causes)
- `getFailurePredictors()` — tactic-head windows *correlated* with FAIL (negative rules; see §5.3)
- `getBottlenecks()`, `getAnomalies()` — time sinks / pathological runs
- `getCriticalPath()` — longest dependent chain in a development

The confounders are everywhere and known: goal shape, theorem family, available hypotheses,
imported tactics, premise retrieval, previous tactics, proof depth, LLM sampling, toolchain
behavior. A pattern `A → B → FAIL` does not establish that A or B *caused* the failure. The
engineering value of this module is exactly as a **trace layer**: it turns the event stream into
features and failure hypotheses. The *causal* questions are future, intervention-based work
(`build_order.md` §5.6): holding goal shape constant, does choosing tactic X materially change the
probability of eventual proof versus tactic Y? That requires randomized or counterfactual controls,
not correlation mining.

**Predictor use is safety-gated, not an optimization KPI.** A failure predictor that the search
layer uses to reject actions before kernel verification has a dangerous feedback loop: observed
failure → predictor → reject future attempt → future success becomes impossible. This is
unacceptable when the predictor is mined from tiny samples. A predictor may suppress an action
ONLY when ALL of the following hold (hard gate, enforced by `compilePredictors`):

- **Minimum support** — the pattern must be observed at least `minSupport` times (default 2, never
  configurable below 2 for the reject path).
- **Held-out evidence** — the pattern's confidence must be verified on data the pattern was not
  mined from (a held-out split of the event stream), not just the mining set; a pattern with
  training-set confidence only is a hypothesis, not a gate.
- **Bounded confidence** — the pattern's FAIL confidence must be above `minConfidence` AND below a
  ceiling (default 0.95): a pattern that *always* precedes FAIL on tiny support is exactly the
  overfit case, and near-1.0 confidence on small samples is rejected rather than trusted.
- **False-rejection accounting** — `falseRejectionRate` is a hard safety metric: every rejected
  action is recorded as a rejection event with its counterfactual (would the kernel have
  accepted it?), and the rate is reported per run; a run whose false-rejection rate exceeds the
  safety threshold fails the report audit, not just a KPI.

A predictor with no held-out evidence, or whose support is below the gate, is treated as inert
(no rejection). The telemetry layer may still mine and report such patterns — they are
hypotheses — but the search layer never suppresses on them.

**Exploration rate (no permanent self-confirmation).** Even a gated rejection removes all future
evidence about the rejected action — the predictor would otherwise confirm itself forever. The
loop therefore re-tests rejected tactics with probability `predictorExploration` (loop option,
default 0.02): the counterfactual application is emitted as a `predictor_explored` event, so the
false-rejection accounting always has fresh evidence. Over-compression is the known failure mode
of this layer, and the exploration rate is its pressure valve.

### 6.1 Evaluation metrics (`optimization/metrics.js`)

`computeMetrics(events)` turns the loop's event stream into a KPI bundle attached to every run
outcome. The current surface is deliberately smaller than the event stream it consumes; the catalog
below is what a *quantitative* evaluation needs (vs. today's functional "it solved / it didn't").
Each metric is grouped by the property it measures; a metric is emitted as `null` when the events
in hand cannot produce it (it needs instrumentation the loop does not yet emit — listed in
`build_order.md` §5.6):

- **Search efficiency** — cost to reach a solved theorem:
  `kernelChecksPerSolved`, `llmCallsPerSolved`, `uniqueStatesExplored`, `duplicateStatesAvoided`
- **Search quality** — the search's own behavior:
  `firstSuccessRank` (avg proposal rank of the solving tactic), `branchingFactor`,
  `meanDepth`, `deadEndRate`, `transpositionHitRate`
- **Planning quality** — blueprint-level (skeleton/refine), not tactic-level:
  `blueprintLemmasPerTheorem`, `resplitsPerTheorem`, `unusedHelperLemmas`, `dependencyDepth`
- **Learning quality** — the failure-predictor pre-filter (§5.3):
  `predictorPrecision`, `predictorRecall`, `falseRejectionRate`, `performanceBeforeAfterPredictor`,
  `heldOutImprovement`
- **Economic quality** — wall / compute cost:
  `secondsPerTheorem`, `llmLatencyPerTheorem`, `kernelCallsPerSuccessfulProof`
- **Compression quality** — the §0.5 quantities, measured directly (staged; `null` with a
  documented reason until instrumented):
  `proofDescriptionLength` (the final proof script's length under the canonical `state.js`
  layout), `libraryRelativeDescriptionLength` (the residual description once referenced stored
  lemmas are taken as dictionary entries), `amortizedCostCurve` (cost to solve problem `T_i` as
  a function of the verified lemma library accumulated from `T_1..T_{i−1}` — the falling curve
  is the claim "knowledge is being compressed into reusable mathematics" made measurable)

The metrics module's contract: pure function of the event stream; never calls the backend or LLM;
every emitted value is derivable from events (or `null` with a documented reason).

The learning/adaptation modules are all toggleable on the live loop and pure where they can be:
`patterns.js` runs as a pure analysis of any run's event stream (`monitor: true`) and detects
error clusters, same-failure cycles, repair loops, stuck proposals, guardrail spikes,
degradation, and budget exhaustion; `ttrl.js` (`ttrl: true`) escalates the tactic budget of a
goal class after repeated failures — within-run adaptation from the run's own outcomes; `grpo.js`
computes the clipped-surrogate update quantities a trainer would apply (group-relative
advantages, loss, clip rate); `exporter.js` (`exportTo: <file>`) persists the causal stream and
KPI summary. The observer never calls the backend or LLM.

### 6.2 The learning stack shapes search and records data — it never trains

The LLM is a hosted model reached through the opencode CLI (`agent/llm.js`). The policy has no
trainable weights in this system, and no gradient step is applied anywhere: a locally
weight-adjustable model would be a different system. The learning stack therefore does exactly
two things — shape *which branches get search budget*, and *record data a trainer could consume*.

**Failure-predictor mining is temporal held-out in the live path.** At run start,
`blueprint/run.js` compiles failure predictors from the GLOBAL dataset
(`runs/training-dataset`): every sample in it was appended by a prior run or a prior cycle, so
the reject gate can never be contaminated by the current cycle's outcomes. The mining is a pure
function over prior samples (`optimization/causal.js`), and the compiled matcher is subject to
the §6 support/confidence gates. The ablation harness (`bench/ablation.js`) mines and applies
within one run — there the mined patterns are hypotheses, not gates, exactly as the
`compilePredictors` contract states. The two paths share one gate; they differ in held-out
discipline, and the live path has it.

**Preference pairs are recorded, not discarded.** Every swiss tournament computes pairwise
tactic judgments (`A ≻ B` for one goal) to rank candidates; those judgments are preference data.
The loop persists them into the global dataset (`preferences.jsonl`) at zero extra LLM cost —
the judgments were already computed for ranking. A trainer consuming this dataset gets
DPO-shaped pairs (goal shape, tactic A, tactic B, winner) with the same deterministic
held-out split as samples.

**Reward channel has three levels.** The dataset's outcome vocabulary is `verified` (lemma
proved), `failed` (lemma exhausted), and `progress` (tactic applied with subgoals — the
accepted-but-not-closed signal). All three are projected from events the loop already emits;
nothing is synthesized. The per-step `progress` records carry the goal type so a reward model
can condition on state, not just outcome.

**GRPO records are per-run trainer-consumable data.** `grpo.js` computes trajectories,
group-relative advantages, and the clipped-surrogate loss over each run's episodes; the refiner
aggregates them and the development digest persists them (`development.json` + writeup). The
loss is recorded with the policy probabilities a trainer must supply — the harness computes the
update quantities, never applies them.

---

## 7. Checkpoint / audit formats

Two distinct persistence models, not one "checkpoint":

- **Memoization snapshot** — `graph.serialize()` covers the CACHED nodes of the PullGraph (a
  cache of computed values). It is not a full computation-state checkpoint: uncached/dirty nodes
  are outside its scope, so it alone cannot resume an interrupted development.
- **Resumable computation state** — `RunCheckpoint` (`core/checkpoint.js`) is the resume record:
  per-lemma statements, proofs, stalled flags, rounds, and the run hash chain, written to
  `runs/<problem>/checkpoint.json` after every refine round. `blueprint/run.js --problem=<id>`
  resumes from it; proved lemmas are restored (and the lemma store's proofs are re-verified, not
  trusted), stalled lemmas stay stalled. Resume = load + guardrail check 5.

The in-memory event store (`optimization/store.js`) is bounded and indexed (O(1) id lookup;
evicted events are counted, and a causal chain queried after eviction starts at its oldest
surviving member). The durable full-stream record is the telemetry export (`exporter.js`, JSONL)
and the checkpoint's event tail — the store itself is an index, not an archive.

Audit pack (`digest/auditPack.js`):
```
theorem + statement pin + assumption account +
  dependency graph + critical path + causal trace (hash-chained) +
  guardrail report + checkpoints + human-readable writeup (MD/HTML/PDF, KaTeX)
```
Statement hash chain (`hasher.js`): every verified lemma appends
`sha256(prevHash || statement || proofHash || outcome)` — tamper-evident, reproducible runs.
The chain is **integrity evidence, not cryptographic authenticity**: it detects accidental or
partial corruption, but there is no external secret/signature, so anyone able to rewrite the
artifact files can recompute the whole chain. Artifacts that need attested provenance must add
a signing step outside this system — the chain itself is evidence of internal consistency, not
of authorship.

---

## 8. Query API

A signed, rate-limited query API over the telemetry is not part of the system. The
proof-of-correctness surface is the **development digest** (`digest/development.js`): writeup +
audit pack + hash chain written per blueprint completion, plus `growth/commit.js`'s per-lemma
artifact files (statement.lean + proof.lean + audit.json) under the problem workdir. An
operator-facing query API would be specified against a real consumer, with
`/integrity/verify` implemented as a real `verifyHashChain` over the run's chain.

---

## 9. Module inventory

Per-module rationale and the build sequence are `blueprint.md` §3 and `build_order.md`. Summary
by role:

- **Foundations** (generic, unit-tested, no proof assumptions): `core/lazy` (memoized thunk used by
  `PullGraph`), `core/hasher`.
- **Proof domain** (the contribution that makes this a proof refinery): `core/pullgraph` (proof
  DAG), `core/transpositionGraph` (goal equivalence classes), `core/state` (tree↔script), `core/scheduler`,
  `core/guardrails`, `lean/*` (incl. `goalText`), `agent/*`, `blueprint/*`,
  `search/*` (incl. `swiss`).
- **Instrumentation / growth / digest**: `optimization/*`, `growth/*`, `digest/*`, `bench/*`
  (incl. `smoke`).

Lineage: `core/lazy` and `core/hasher` are the only foundational primitives that survived the
dead-code audit (see build_order.md §5.5); the rest of the former lazy/pipeline/patch family was
removed because nothing used it. Provenance is evidence, not design argument — contracts here are
self-contained.

---

## 10. Deliberate non-adoptions (whitepaper / Wave2)

The aspirational vision docs — `docs/Research/KanForge_whitepaper.md` and
`docs/Research/KanForge_architecture.md` — describe an ambitious synthesis
vision. Adopted (now or staged) is reflected above. Everything below was considered and deferred
for the stated reason; do not re-add without revisiting the reason.

- **E-graph as a synchronized third representation** (Wave2 §3/§6). **Adopted in two parts.**
  The goal transposition graph is the incumbent Level 2 search structure (§2.2) — not a third
  synchronized representation alongside AST and script (we keep tree↔script duality, state.js,
  for extraction). The genuine equality-saturation e-graph is the staged `searchStructure`
  alternative (core/egraph.js, build_order.md §5.12): e-nodes, congruence closure, and
  Lean-confirmed rewrite rules — the structure the Research vision describes, measured against
  the incumbent at equal budget.
- **GPU/CUDA graph filtering** (whitepaper diagram; Wave2 §9). The kernel is CPU-bound; the
  useful core is **structural dedup** (hash candidates/goals before dispatch), done on CPU now.
  GPU revisit only if CPU dedup measurably saturates.
- **Distributed (multi-host) worker pool** (Wave2 §9). The job-based worker contract is baked
  into `backend.js` (below); actual multi-host runs stay in P7 (ConflictDetector/descent).
- **"Vesicular dispatch"** (whitepaper §1.3). Label without a distinct mechanism; the mechanism
  is §2.6 scheduling. Not used.
- **Compiled-module (olean) caching** (Wave2 §12). Lake/mathlib owns this; we cache proof
  artifacts and fingerprints, not builds.
- **Patch operators for program synthesis** (Wave2 §4: inline definition, insert/delete node).
  We prove theorems, not code; only the Lean-relevant subset (§2.7) is used.
