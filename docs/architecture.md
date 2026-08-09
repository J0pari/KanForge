# KanForge — Architecture & Interfaces

**Canonical source for**: repo layout, module/file names, API contracts, wire formats, event
vocabulary, reward defaults, guardrail spec, Lean backend interface, query API, module inventory.
Everything else references this document rather than restating it.


## 0. The one workflow (design intent)

This system exists for exactly one purpose: to take an **open problem** — a target theorem with
no known answer in hand — and produce a kernel-verified Lean proof plus a reproducible audit
trail. Everything in the design below is load-bearing for that single workflow:

```
intake (natural language or Lean statement)
  → autoformalize into a Lean statement (agent/roles/autoformalizer.js)
  → blueprint DAG of kernel-typechecked sorry stubs (blueprint/skeleton.js)
  → prove bottom-up via tactic-level search (blueprint/refine.js → agent/loop.js):
      LLM proposes ONE tactic → kernel disposes → repair → repeat until root solved
  → verify the assembled full statement against the kernel (commit gate, §4)
  → digest: writeup + audit pack + per-lemma commit + hash chain (digest/, growth/commit.js)
```

Known-answer harnesses (the smoke sets, the ablation runner) are a safety net and nothing more:
they exist only to check that the machinery behaves as expected before it is pointed at an open
problem, so a failure in the open-problem pipeline is attributable to the problem, not the
plumbing. They are not the product, and no module below exists for their sake.

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
    egraph.js                # goal equivalence classes (Level 2 search structure, §2.2)
    hasher.js                # Hasher (statement/event hash chains)
    state.js                 # straighten / unstraighten (tree ↔ script)
    scheduler.js             # dependency-ordered dispatch over the PullGraph (Wave2 §7–8)
    guardrails.js            # invariant spec + guardrail logic
  lean/
    backend.js               # adapter interface + factory (createBackend)
    backendRepl.js           # leanprover-community/repl impl (JSON-lines, pool)
    backendCli.js            # `lean` CLI impl
    pin.js                   # toolchain + mathlib4 pin, statement hashing
    goalText.js              # goal text extraction / normalization
  agent/
    loop.js                  # the agent loop: observe→propose→act→verify→repair→commit; PullGraph + scheduler + backendRepl + one LLM adapter; node id = statement hash; oldest-sorry priority; stop budget; traced events
    solve.js                 # goal-solved / lemma-proved stopping rules
    repair.js                # error-driven repair (classify, retry)
    prompts.js               # prompt builder from Lean terms
    llm.js                   # sole LLM client: drives the opencode CLI (no API key; KANFORGE_LLM_MODEL selects the model)
    roles/                   # P7 only (multi-agent ensemble)
      autoformalizer.js
      conjecturer.js
      prover.js
      critic.js
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
    causal.js                # causal analysis (transition matrix, predictors)
    metrics.js               # KPI calculator (wired into the loop's per-run outcome)
    patterns.js              # degeneracy / reward-hacking monitors — not yet built
    exporter.js              # telemetry export — not yet built
    reward.js                # reward function (initial defaults, §6)
    grpo.js                  # GRPO update harness — not yet built
    ttrl.js                  # test-time RL — not yet built
  digest/
    writeup.js               # Markdown/HTML with KaTeX
    auditPack.js             # per-lemma publication unit (§7)
    development.js           # whole-development digest (writeup + audit + hash chain)
  growth/
    commit.js                # commit-per-lemma to a scratch repo (statement hash in message)
    lemmaStore.js            # content-addressed lemma store, persisted to <dir>/lemmas/*.json (write-through atomic, corruption-tolerant)
    dataset.js               # append-only JSONL training samples + deterministic held-out split + contamination check
    multibody.js             # multi-agent lemma-ownership lanes (P7)
  bench/
    ablation.js              # search-strategy ablation harness: smoke set × every recipe
    mathlibSmoke.js          # mathlib-backed smoke set (imports take 5-35s cold)
    premisesCorpus.js        # premise corpus for retrieval experiments
    run.js                   # benchmark run driver
    smoke.js                 # 23-problem miniF2F-style smoke set (5 tiers), runs over real repl
    stepSmoke.js             # multi-step tier problems (build_order.md §5.4)
    verifyStepSet.js         # full-paces chain verifier for the step tier
  test/                      # unit + integration tests (Node built-in test runner)
  corpus/                    # open-target corpus (P7) — not yet populated
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

**Level 2: Goal e-graph** (within each lemma)
- Root = the lemma's initial goal (the statement's type + empty context)
- Nodes = equivalence classes of goals (alpha-equivalent or definitionally-equal proof states)
- Edges = tactic applications that transform one equivalence class into zero or more subgoal classes
- A goal class is "solved" when a tactic closes all goals in the class (produces no subgoals)
- A lemma is "proved" when the root class is solved
- The proof is a tree of tactics extracted from the e-graph (root to solved leaves)
- Statistics (visit counts, success rates, value estimates) are shared across all goals in an equivalence class

The e-graph structure enables **transposition merging** (research_notes trick 4): different tactic sequences that produce equivalent goals share a single equivalence class with shared statistics. This is what makes search efficient — MCGS, BFS, and other search algorithms operate on the e-graph, not a tree, so they automatically benefit from transposition merging.

The LLM operates at Level 2: it proposes ONE tactic for ONE goal. The backend applies the tactic and returns new subgoals. The search operates on the e-graph: it searches over tactic sequences, and equivalent goals are automatically merged into the same equivalence class.

The scheduler operates at Level 1: it dispatches lemmas dependency-ordered. Within each lemma, the tactic-level search runs to completion (or budget exhaustion) before the lemma is marked verified or failed.

This two-level structure is what makes the loop's operations meaningful: a single tactic applied to
a single goal produces zero or more subgoal equivalence classes; a proof is a tree of such
applications extracted from the e-graph. The DAG tracks both levels: lemma dependencies at Level 1,
goal e-graphs at Level 2.

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

Node (Level 2 — goal equivalence class within a lemma's e-graph):
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

The `id` is computed from a **normalized** goal (alpha-equivalent renaming of bound variables, definitional equality reduction). Multiple concrete goals that are alpha-equivalent or definitionally-equal map to the same equivalence class. The `goals` array tracks all concrete goals in the class (for debugging and extraction). The `stats` are shared across all goals in the class, enabling transposition merging.

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
The `pull`/`subgraph`/`diff`/`morphism`/`compose` members once documented here were removed as dead
code (the loop and scheduler use only the surface above). The scheduler performs dependency-ordered
dispatch; the loop reads `nodes.get(id).computation.value` directly under its own budget.

### 2.4 `state.js` — straighten/unstraighten (tree ↔ script)
```js
straighten(tree) -> { script, map }        // tree → Lean script + provenance map
unstraighten(script, map) -> tree          // script → tree
assertRoundTrip(tree)                      // bijectivity check, enforced in tests
```
Rule: repairs edit the tree, then re-straighten; kernel successes un-straighten back. Never edit
one representation only (the dual of Wave2's "no representation diverges independently" — we keep
the tree↔script duality as the backbone and skip a third e-graph representation; see §10).

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
(the loop's per-lemma `_proveLemma`). The `pull()` member once documented here was removed as dead
code (nothing called it — the loop reads `nodes.get(id).computation.value` directly).

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
- Locality: work scales with affected subgraph depth, not project size (Wave2 §14).

### 2.7 Proof operations (was "typed patch envelope")
The candidate-mutation envelope (`Patch`/`PATCH_OPS`) once documented here was removed as dead code:
nothing constructed a `Patch`. The live loop works directly on the two-level structure — it proposes
a tactic string for one goal equivalence class, the backend applies it and returns new subgoal
classes (kernel-checked via `applyTactic`), and the e-graph records the edge. A proof is a tree of
tactic applications extracted from the e-graph (root equivalence class to solved leaves). If a typed
mutation envelope is ever needed it will be re-introduced with a live consumer; until then the loop
is the contract.

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
  at the pinned toolchain — no mocks, stubs, or facsimiles anywhere in the backend stack.
- **CLI**: real `lean` for CI batch verification.
- **lean4web**: *deferred.* Ships only once a real instance is exercised end-to-end; its API
  contract is not fabricated offline.
- **Statement pinning** (`pin.js`): canonical `#print`-normalized string → sha256. Any mutation
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

**Pin drift:** the canonical `#print`-normalized string is *version-sensitive* — a Lean/mathlib
update can change the printed form without changing meaning. Therefore `pin()` returns
`Pin = { toolchain, mathlibHash, leanVersion, normVersion, statementHash }`, and pin verification
re-normalizes on the current toolchain and compares `normVersion`; a mismatch reports `DRIFT`
(not `WEAKENED`), so the operator re-pins deliberately rather than silently or falsely. Never
compare a hash computed under a different `normVersion`.

---

## 4. Agent loop

The agent loop operates at Level 2 (goal e-graph within a single lemma). The scheduler dispatches lemmas at Level 1; for each lemma, the agent loop runs the tactic-level search below.

**Backward decomposition**: the loop works backwards from the target goal to simpler subgoals. Each tactic application reduces the current goal to zero or more simpler subgoals. The proof tree is built by working backwards: the root is the lemma's goal, each edge is a tactic that reduces complexity, and the leaves are solved goals (zero subgoals).

The loop is a class (`TacticLoop`, `agent/loop.js`), not a composed monadic pipeline. It implements
the observe → propose → act → verify → repair → commit stages as explicit methods over the e-graph,
with a stateful budget, concurrency, and repair path that a stateless composition would misrepresent:

```
observe(goal)   -> PromptInput        // goal (type + context) + retrieved premises → prompt
propose(input)  -> tactic             // LLM: ONE tactic string per call
act(tactic)     -> Applied            // backend.applyTactic(goal, tactic) → new subgoals
verify(result)  -> Verification       // kernel check of tactic application; record PASS|FAIL
repair(fail)    -> tactic             // isolate failing sub-goal (Wave2 §11 error); low top-K retry
commit(verified)-> LemmaRef           // all goals solved → compose proof script → verify full statement
```

(The `Pipeline.compose` stage-combinator once documented here was removed as dead code — nothing
called it; the loop is the contract. The `Patch` envelope is likewise gone; the loop passes tactic
strings directly. See §2.7.)

Each LLM call proposes ONE tactic for ONE goal. The backend applies it and returns zero or more new subgoals. The loop continues until all goal equivalence classes in the e-graph are solved (lemma proved) or the budget is exhausted. **Complexity reduction**: each tactic application should produce subgoals that are simpler than the parent goal; if a tactic produces subgoals of equal or greater complexity, it makes no progress.

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

Stopping rule (`solve.js`): a goal is *solved* iff `applyTactic(goal, tactic)` returns zero subgoals. A lemma is *proved* iff all goal equivalence classes in its e-graph are solved **and** `statement.hash === pinned.hash` (the composed proof script verifies the full statement).

---

## 5. Search

Search operates at Level 2 (within a lemma's goal e-graph). Each search algorithm explores tactic sequences over the e-graph structure: given a goal equivalence class, propose tactics that decompose it into simpler subgoal classes, apply them, repeat. The search works backwards from complex goals to simple subgoals, seeking tactics that maximally reduce complexity at each step.

The e-graph structure enables **transposition merging** (research_notes trick 4): different tactic sequences that produce equivalent goals share a single equivalence class with shared statistics (visit counts, success rates, value estimates). This is what makes search efficient — all search variants automatically benefit from transposition merging because they operate on the e-graph, not a tree.

- `bestofn.js`: for a single goal class, sample k tactic proposals, apply each, take first that succeeds. Pre-filter stage (Wave2: cost-model idea, CPU-side): reject known-failing patterns (causal predictors), premise-lock violations, and near-duplicate patches before verification.
- `bfs.js`: best-first over goal classes by progress (open-goal spectrum decrease). A state is the set of unsolved goal classes; a tactic application transitions to a new state with simpler subgoal classes.
- `mcgs.js`: Monte Carlo Graph Search over the e-graph; **transposition merging** is built into the e-graph structure — alpha-equivalent / definitionally-equal goals are already merged into equivalence classes with shared statistics. Node identity is normalized so *every* search variant inherits the merge, not just MCGS.
- `repulsion.js`: log-ratio diversity penalty among concurrent tactic samples. `RepulsionSampler`
  is the actionable form — it refuses to re-propose already-tried tactics (exact-duplicate penalty)
  and echoes the tried list into the prompt so the generator steers away; `MCGS`/`BestFirstSearch`
  take a `repulsion` flag that skips duplicate kernel re-checks.
- `premises.js`: relevance scoring over mathlib; `premiseLocked: true` restricts the generator to retrieved premises only.
- `swiss.js`: Swiss-tournament best-of-n selection (faithful to Open Proof Corpus methodology, arXiv:2506.21621 §5.5): round-robin tournament judged pairwise by the LLM, Bradley-Terry ratings fit by MLE, candidates applied in rating order with kernel-grounded fallthrough. OPC reports +17% improvement over naive best-of-n (26%→43% vs 26%→36%).
- `bench/ablation.js`: strategy-ablation harness that runs the smoke set through every recipe
  (`bestofn`, `swiss`, `swiss+repulsion`, `bfs`, `bfs+repulsion`, `mcgs`, `mcgs+repulsion`) under a
  shared LLM-call budget and reports pass rate AND cost per recipe. It is the measurement apparatus
  for the §5 acceptance criteria — "MCGS ≥ best-of-N at equal budget; compare, then decide" — and is
  what turns "swiss is the best choice" into a measured claim.

---

## 6. Sharpening / RL

Reward (`reward.js`) — **initial defaults, to be tuned in P6**, not settled values. Rewards operate at the tactic level (Level 2):
```
+1.0  goal solved (tactic produces zero subgoals)
+0.5  complexity reduction (subgoals simpler than parent goal)
+0.1  goal-depth decrease (fewer open goal equivalence classes in e-graph)
+0.05 lemma reused later (Level 1)
-0.1  repair round (tactic failed, retry)
-0.5  wasted tactic (no complexity reduction, no progress)
-1.0  guardrail trip
```

`causal.js` feeds RL and search:
- `getTransitionMatrix()` — action→action Markov probabilities
- `getFailurePredictors()` — sequences reliably preceding FAIL (negative rules)
- `getBottlenecks()`, `getAnomalies()` — time sinks / pathological runs
- `getCriticalPath()` — longest dependent chain in a development

`grpo.js`: GRPO over episode batches, policy model only; `patterns.js` monitors reward hacking /
loop degeneracy (error clusters, same-failure cycles). `ttrl.js`: test-time RL for hard goals.

---

## 7. Checkpoint / audit formats

Checkpoint (`graph.serialize()`): the full forest + event log tail + pins + repo HEAD — a
**resumable transaction**. Resume = `deserialize()` + guardrail check 5.

Audit pack (`digest/auditPack.js`):
```
theorem + statement pin + assumption account +
  dependency graph + critical path + causal trace (hash-chained) +
  guardrail report + checkpoints + human-readable writeup (MD/HTML/PDF, KaTeX)
```
Statement hash chain (`hasher.js`): every verified lemma appends
`sha256(prevHash || statement || proofHash || outcome)` — tamper-evident, reproducible runs.

---

## 8. Query API (not yet built — deferred)

A signed, rate-limited query API over the telemetry was once specified here with nine endpoints,
HMAC signing, and a WebSocket dashboard. It was removed as dead code: no server existed, nothing
constructed it, and `/integrity/verify` returned `{ ok: true }` unconditionally — a lie, not an
implementation. The proof-of-correctness surface that actually exists is the **development digest**
(`digest/development.js`): writeup + audit pack + hash chain written per blueprint completion, plus
`growth/commit.js`'s per-lemma git commits. If an operator-facing query API is wanted it will be
re-specified against a real consumer (P7), with `/integrity/verify` implemented as a real
`verifyHashChain` over the run's chain — never a hardcoded `ok`.

---

## 9. Module inventory

Per-module rationale and the build sequence are `blueprint.md` §3 and `build_order.md`. Summary
by role:

- **Foundations** (generic, unit-tested, no proof assumptions): `core/lazy` (memoized thunk used by
  `PullGraph`), `core/hasher`.
- **Proof domain** (the contribution that makes this a proof refinery): `core/pullgraph` (proof
  DAG), `core/egraph` (goal equivalence classes), `core/state` (tree↔script), `core/scheduler`,
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

The aspirational vision docs — `docs/Research/whitepaper.md` and
`docs/Research/architecture wave2.md` — describe an ambitious synthesis
vision. Adopted (now or staged) is reflected above. Everything below was considered and deferred
for the stated reason; do not re-add without revisiting the reason.

- **E-graph as a synchronized third representation** (Wave2 §3/§6). **Adopted for Level 2 search structure** (§2.2): the goal search tree is now an e-graph where nodes are equivalence classes of goals (alpha-equivalent or definitionally-equal). This enables transposition merging (research_notes trick 4) — different tactic sequences producing equivalent goals share statistics. The e-graph is the search structure itself, not a third synchronized representation alongside AST and script. We still keep tree↔script duality (state.js) for proof extraction.
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
