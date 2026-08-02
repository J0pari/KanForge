# KanForge — Architecture & Interfaces

**Canonical source for**: repo layout, module/file names, API contracts, wire formats, event
vocabulary, reward defaults, guardrail spec, Lean backend interface, query API, module inventory.
Everything else references this document rather than restating it.

Related docs: `blueprint.md` (design narrative + module inventory), `build_order.md`
(phases + acceptance), `patterns_from_hct.md` (HCT → design patterns), `research_notes_2026.md`
(evidence base). Ownership map: `docs/README.md`.

---

## 1. Repo layout

ESM package, `"type": "module"`.

```
kanforge/
  core/                      # lazy/pull machinery + proof-state primitives
    lazy.js                  # Lazy, lazify (memoized thunks)
    template.js              # LazyTemplate (defer string building)
    functor.js               # LazyFunctor (map/extract over structured results)
    stream.js                # LazyStream (head-strict / tail-lazy)
    pipeline.js              # Pipeline.kleisli / compose
    context.js               # ConfigContext (per-run config threading)
    fix.js                   # coinductive fixed points
    promise.js               # PullPromise (async thunk)
    cache.js                 # PullCache + compact/eager split
    pullgraph.js             # proof DAG: nodes, edges, invalidate, serialize
    serialize.js             # StateSerializer
    hasher.js                # Hasher (statement/event hash chains)
    state.js                 # straighten / unstraighten (tree ↔ script)
    patch.js                 # typed patch envelope (Wave2 §4): node, op, replacement, scope, meta
    scheduler.js             # dependency-ordered dispatch over the PullGraph (Wave2 §7–8)
    guardrails.js            # invariant spec + guardrail logic (the Giraud axioms)
  lean/
    backend.js               # adapter interface + factory
    backendRepl.js           # leanprover-community/repl impl (JSON-lines, pool)
    backendCli.js            # `lean` CLI impl
    pin.js                   # toolchain + mathlib4 pin, statement hashing
  agent/
    agent.js                 # observe→propose→act→verify→repair→commit loop
    solve.js                 # universal-arrow stopping rule
    repair.js                # horn-filler repair
    prompts.js               # prompt builder from Lean terms
    llm.js                   # provider-neutral client (env-driven): gemini/openai/anthropic/copilot/openrouter + local ollama/vllm; secret only from KANFORGE_LLM_API_KEY or git-ignored .env
    roles/                   # P7 only (multi-agent ensemble)
      autoformalizer.js
      conjecturer.js
      prover.js
      critic.js
  blueprint/
    skeleton.js              # comonad: theorem → DAG of sorry-stubs
    refine.js                # monad: fill lowest stub (never edits statements)
    drift.js                 # re-verify pinned statement hashes
  search/
    bestofn.js               # baseline
    bfs.js                   # best-first over proof states
    mcgs.js                  # MCGS with transposition merging
    repulsion.js             # Goedel-style diversity penalty
    premises.js              # premise retrieval + premise-locked flag
  sharpening/
    bus.js                   # central event bus
    store.js                 # bounded event store (causal parent links)
    causal.js                # causal analysis (transition matrix, predictors)
    metrics.js               # KPI calculator
    patterns.js              # degeneracy / reward-hacking monitors
    exporter.js              # telemetry export
    reward.js                # reward function (initial defaults, §6)
    grpo.js                  # GRPO update harness
    ttrl.js                  # test-time RL
  digest/
    writeup.js               # Markdown/HTML/PDF with KaTeX
    auditPack.js             # the publication unit (§7)
  query/
    server.js                # signed query API
    formatters.js            # semantic text formatters
    gui/                     # WebSocket dashboard
  growth/
    commit.js                # commit-per-lemma (statement hash in message)
    lemmaStore.js            # content-addressed lemma store
    dataset.js               # verified attempts → training samples
    multibody.js             # hypercover multi-agent (P7)
  bench/
    harness.js               # run targets, collect KPIs
    kpis.js                  # pass@k, tokens/lemma, attempts/lemma, reuse, guardrail trips
  corpus/
    miniF2F-split/ putnam/ proverbench/ proofnet/ workbook/ open-targets/
```

---

## 2. Core contracts

### 2.1 `Lazy`
```js
Lazy.of(fn)         // memoized thunk
lazy.map(fn)        // functor map
lazy.flatMap(fn)    // monadic bind
lazy.get()          // force
```

### 2.2 `Pipeline`
```js
Pipeline.kleisli(...stages)      // (a) => b via monadic stages
Pipeline.compose(a, b)           // stage composition, checked
stage = { run(ctx, input) -> Promise<output>, name, track(evt) }
```

### 2.3 `PullGraph` — the proof DAG
Node:
```jsonc
{
  "id": "sha256(statement)",
  "kind": "goal" | "lemma" | "development",
  "statement": { "text": "...", "hash": "sha256", "pinned": true },
  "state": "STUB" | "PROVING" | "VERIFIED" | "FAILED" | "WEAKENED",
  "proof": null | { "script": "...", "tree": "...", "verifiedAt": "...", "checkpoint": "ref" },
  "deps": ["sha256(...)", ...],
  "interface": { "signature": "...", "hash": "sha256" }   // pinned; see §2.5 invariant 1
}
```
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
graph.pull(nodeId)                    // recurse deps, compute, cache; error boundary
graph.invalidate(nodeId)              // transitive re-prove downstream (context pullback)
graph.serialize() / deserialize(json) // checkpoint / resume (whole forest = transaction log)
graph.diff()                          // blueprint diff between runs
graph.subgraph(targetId)              // critical path extraction
```

### 2.4 `state.js` — straighten/unstraighten (tree ↔ script)
```js
straighten(tree) -> { script, map }        // tree → Lean script + provenance map
unstraighten(script, map) -> tree          // script → tree
assertRoundTrip(tree)                      // bijectivity check, enforced in tests
```
Rule: repairs edit the tree, then re-straighten; kernel successes un-straighten back. Never edit
one representation only (the dual of Wave2's "no representation diverges independently" — we keep
the tree↔script duality as the backbone and skip a third e-graph representation; see §10).

### 2.5 `guardrails.js` — the invariant spec (Giraud axioms)
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
rule list). `sharpening/patterns.js` feeds degeneracy observations here.

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
`pull()` is pull-driven; the scheduler adds the *concurrent* dimension: batch the goals `pull()`
would compute, ordered by the dependency DAG, and dispatch them to the backend pool.

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
  history → estimated cost → patch confidence (Wave2 §8). Ties break by node id (deterministic).
- Guarantees: no cyclic dispatch (DAG), bounded in-flight (concurrency), deterministic ordering,
  maximal independent parallelism.
- API: `enqueue(ids)`, `run()` -> `{ ok, results, failures }`, `onProgress`, timeout/kill-on-hang.
- Locality: work scales with affected subgraph depth, not project size (Wave2 §14).

### 2.7 `patch.js` — typed patch envelope (Wave2 §4)
Candidates are typed graph mutations, not source strings:
```js
p = { node, op, replacement, scope, meta }
op ∈ { 'tactic', 'lemma', 'rewrite', 'replace' }   // Lean-relevant subset of Wave2 §4
```
- `tactic`   — propose a tactic/script for a goal node (kernel check).
- `lemma`    — introduce a helper lemma (adds a stub child; statement pinned).
- `rewrite`  — alternative proof path (transposition-merge target; dedup, no tree mutation).
- `replace`  — replace a failing subproof subtree (tree-level repair, re-straighten).
Patches are first-class: reorderable, mergeable, discarded, replayed — independent of source
text. `meta` carries model id, prompt ref, confidence (feeds scheduler priority + reward).

---

## 3. Lean backend interface

```js
// backend.js — createBackend({ type: 'repl' | 'cli', ...config })
interface LeanBackend {
  check(statement, opts) ->
    { status: 'verified'|'error'|'timeout', goals: Goal[], error?: LeanError, warnings: [] }
  extractGoals(src, position) -> Goal[]        // goals + local context at a position
  verifyProof(script) -> { status, error }     // kernel check of a full proof
  getInfos() -> { toolchain, mathlibHash, backends, poolSize }
  pin() -> Pin                                  // toolchain + mathlib pin (idempotent)
}
// Worker/job contract (Wave2 §9, distribution-ready; multi-host deferred to P7):
// a job = { job: nodeId, run: () => backend.check(statement, opts), meta }
// scheduler.js dispatches jobs; the pool is a collection of workers over the same interface,
// so multi-host is a config change, not a rewrite.
```
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

```js
const agent = Pipeline.kleisli(observe, propose, act, verify, repair, commit)
observe(goal)   -> PromptInput        // goal + context + retrieved premises → prompt
propose(input)  -> Patch[]            // LLM: typed patches (§2.7): tactic, new lemma, rewrite, replace
act(patch)      -> Applied            // send to backend; get goals / pass / error
verify(result)  -> Verification       // kernel check; record VERIFY_PASS|FAIL
repair(fail)    -> Patch[]            // isolate failing sub-goal (Wave2 §11 error); low top-K retry
commit(verified)-> LemmaRef           // write file + growth/commit.js + store update
```

**Event vocabulary** (all stages emit to `sharpening/bus.js`; canonical — do not re-list in other
docs):
```
TARGET_SET        AUTOFO_ATTEMPT    SKETCH_GENERATED  TACTIC_PROPOSED
VERIFY_START      VERIFY_PASS       VERIFY_FAIL       SUBGOAL_ISOLATED
REPAIR_PROPOSED   LEMMA_PROVEN      LEMMA_COMMITTED   STATEMENT_WEAKENED
```
Event = `{ id, t, type, parent?, nodeId?, candidate?, detail }` — parent chaining gives the
causal DAG that `causal.js` consumes.

Stopping rule (`solve.js`): a goal is *solved* iff `kernel(verify(candidate))` returns VERIFIED
**and** `statement.hash === pinned.hash`.

---

## 5. Search

- `bestofn.js`: sample k candidates, take first verified. Pre-filter stage (Wave2: cost-model
  idea, CPU-side): reject known-failing patterns (causal predictors), premise-lock violations,
  and near-duplicate patches before verification.
- `bfs.js`: best-first over states by progress (open-goal spectrum decrease).
- `mcgs.js`: Monte Carlo Graph Search over the goal hypertree; **transposition merging** —
  alpha-equivalent / definitionally-equal goals hash to one node and share value/visit
  statistics (this is `pullgraph.js` hash-merge + edge structure). Node identity is normalized
  so *every* search variant inherits the merge, not just MCGS (the adopted core of Wave2's
  e-graph dedup; see §10).
- `repulsion.js`: log-ratio diversity penalty among concurrent samples.
- `premises.js`: relevance scoring over mathlib; `premiseLocked: true` restricts the generator to
  retrieved premises only.

---

## 6. Sharpening / RL

Reward (`reward.js`) — **initial defaults, to be tuned in P6**, not settled values:
```
+1.0  verified lemma
+0.1  goal-depth decrease
+0.05 lemma reused later
-0.1  repair round
-0.5  timeout / wasted candidate
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

## 8. Query API (signed)

```
/proof/{lemmaId}            // statement, status, proof tree/script, deps
/proof/explainFailure       // repair post-mortem
/proof/predictors           // failure predictors
/proof/criticalPath
/proof/bottlenecks
/proof/anomalies
/proof/guardrails           // invariant violation log
/integrity/verify           // re-check the hash chain + invariants
```
All endpoints require HMAC signature and are rate-limited. GUI (WebSocket dashboard) renders the
transition matrix, predictors, live frontier.

---

## 9. Module inventory

Per-module rationale and the build sequence are `blueprint.md` §3 and `build_order.md`. Summary
by role:

- **Foundations** (generic, fully unit-tested, no proof assumptions): `core/lazy`, `stream`,
  `promise`, `cache`, `pipeline`, `context`, `fix`, `functor`, `template`, `serialize`, `hasher`.
- **Proof domain** (the contribution that makes this a proof refinery): `core/pullgraph` (proof
  DAG), `core/state` (tree↔script), `core/patch`, `core/scheduler`, `core/guardrails`,
  `lean/*`, `agent/*`, `blueprint/*`, `search/*`.
- **Instrumentation / growth / query / digest**: `sharpening/*`, `growth/*`, `query/*`,
  `digest/*`, `bench/*`.

Lineage: the foundational primitives adapt established lazy-computation patterns documented in
`research_notes_2026.md` §4; provenance is evidence, not design argument — contracts here are
self-contained.

---

## 10. Deliberate non-adoptions (whitepaper / Wave2)

The aspirational vision docs — `docs/Research/whitepaper.md` and
`docs/Research/architecture wave2.md` — describe an ambitious synthesis
vision. Adopted (now or staged) is reflected above. Everything below was considered and deferred
for the stated reason; do not re-add without revisiting the reason.

- **E-graph as a synchronized third representation** (Wave2 §3/§6). Lean proof search is
  tactic-script generation, not term-rewrite saturation; a persistent e-graph adds a
  representation with no kernel counterpart. We keep tree↔script duality (state.js) and get
  e-graph's dedup benefit from **transposition merging** in `pullgraph.js`/`search/mcgs.js`
  (alpha-equivalent / definitionally-equal goals share a node). Revisit only for a genuinely
  rewrite-heavy target.
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
