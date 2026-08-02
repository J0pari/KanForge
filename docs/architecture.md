# KanForge — Architecture & Interfaces

**Canonical source for**: repo layout, module/file names, API contracts, wire formats, event
vocabulary, reward defaults, guardrail spec, Lean backend interface, query API, ported-vs-new.
Everything else references this document rather than restating it.

Related docs: `blueprint.md` (design narrative + Builder reuse map), `build_order.md`
(phases + acceptance), `patterns_from_hct.md` (HCT → design patterns), `research_notes_2026.md`
(evidence base). Ownership map: `docs/README.md`.

---

## 1. Repo layout

New package, sibling to the seeded `scripts/`. ESM, `"type": "module"`.

```
kanforge/
  core/                      # ported lazy/pull machinery + proof-state primitives
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
    guardrails.js            # invariant spec + guardrail logic (the Giraud axioms)
  lean/
    backend.js               # adapter interface + factory
    backendLean4Web.js       # lean4web impl
    backendRepl.js           # leanprover-community/repl impl (JSON-lines, pool)
    backendCli.js            # `lake build` / `lean` impl
    pin.js                   # toolchain + mathlib4 pin, statement hashing
  agent/
    agent.js                 # observe→propose→act→verify→repair→commit loop
    solve.js                 # universal-arrow stopping rule
    repair.js                # horn-filler repair
    prompts.js               # prompt builder from Lean terms
    llm.js                   # OpenAI/Anthropic-compatible + local (vLLM/Ollama) clients
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
    bus.js                   # TraceOrchestrator port (central event bus)
    store.js                 # EventStore port
    causal.js                # CausalAnalysis port (transition matrix, predictors)
    metrics.js               # MetricsCalculator port
    patterns.js              # PatternDetection port
    exporter.js              # TelemetryExporter port
    reward.js                # reward function (initial defaults, §6)
    grpo.js                  # GRPO update harness
    ttrl.js                  # test-time RL
  digest/
    writeup.js               # Markdown/HTML/PDF with KaTeX
    auditPack.js             # the publication unit (§7)
  query/
    server.js                # QueryServer port (signed API)
    formatters.js            # semantic text formatters
    gui/                     # WebSocket dashboard
  growth/
    commit.js                # LazyGit port: commit-per-lemma
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

### 2.1 `Lazy` (ported; style adjusted)
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
  "deps": ["sha256(...)", ...]
}
```
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
one representation only.

### 2.5 `guardrails.js` — the invariant spec (Giraud axioms)
```js
checkAll(graph, ctx) -> { ok, violations[] }
// 1. statements are pinned hashes (no weakening)
// 2. every VERIFIED lemma passed kernel check
// 3. no axiom/admit/unsafe/set_option leakage
// 4. blueprint acyclic + dependency-complete
// 5. resumable from any checkpoint (serialize/deserialize identity)
// plus: checkHermetic over the run
```
The planner checks every proposed move against these before acting (guardrails-as-logic, not a
rule list). `sharpening/patterns.js` feeds degeneracy observations here.

---

## 3. Lean backend interface

```js
// backend.js — createBackend({ type: 'lean4web' | 'repl' | 'cli', ...config })
interface LeanBackend {
  check(statement, opts) ->
    { status: 'verified'|'error'|'timeout', goals: Goal[], error?: LeanError, warnings: [] }
  extractGoals(src, position) -> Goal[]        // goals + local context at a position
  verifyProof(script) -> { status, error }     // kernel check of a full proof
  getInfos() -> { toolchain, mathlibHash, backends, poolSize }
  pin() -> Pin                                  // toolchain + mathlib pin (idempotent)
}
```
`Goal = { type: string /* Lean expr */, context: { name, type }[], pos }`
`LeanError = { span?, message, subErrors: [] }`

Implementation notes:
- **REPL** (default for RL): JSON-lines over a process pool (like Kimina Lean Server); parallel
  verification; warm workers; kill-on-hang timeout.
- **lean4web**: REST/WebSocket to hosted or self-hosted instance; zero-install demos.
- **CLI**: `lake build` / `lean` for CI batch verification.
- **Statement pinning** (`pin.js`): canonical `#print`-normalized string → sha256. Any mutation
  of goal text during search flips the hash → node `WEAKENED` + guardrail trip.

---

## 4. Agent loop

```js
const agent = Pipeline.kleisli(observe, propose, act, verify, repair, commit)
observe(goal)   -> PromptInput        // goal + context + retrieved premises → prompt
propose(input)  -> Candidate[]        // LLM: tactic(s), new lemma, or rewrite
act(candidate)  -> Applied            // send to backend; get goals / pass / error
verify(result)  -> Verification       // kernel check; record VERIFY_PASS|FAIL
repair(fail)    -> Candidate[]        // isolate failing sub-goal; low top-K retry
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

- `bestofn.js`: sample k candidates, take first verified.
- `bfs.js`: best-first over states by progress (open-goal spectrum decrease).
- `mcgs.js`: Monte Carlo Graph Search over the goal hypertree; **transposition merging** —
  alpha-equivalent / definitionally-equal goals hash to one node and share value/visit
  statistics (this is `pullgraph.js` hash-merge + edge structure).
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

`causal.js` (ported CausalAnalysis) feeds RL and search:
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

## 8. Query API (ported QueryServer, signed)

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
All endpoints require HMAC signature and are rate-limited. GUI (ported QuerySession + WebSocket)
renders the transition matrix, predictors, live frontier.

---

## 9. Ported vs new

**Ported from `scripts/builder.js` / `scripts/query.js`** (full inventory with line refs in
`blueprint.md` §3): `Lazy`+`lazify`, `LazyTemplate`, `LazyFunctor`, `Pipeline`, `ConfigContext`,
`LazyStream`, `fix`, `PullPromise`, `PullCache`, `PullGraph`, `StateSerializer`, `LazyGit`,
`Hasher`, `ConflictDetector` (via `growth/multibody.js`), `ProcessLockManager`, `LazyEventSystem`,
`TraceOrchestrator`, `EventStore`, `CausalAnalysis`, `MetricsCalculator`, `PatternDetection`,
`TelemetryExporter`, `InvariantChecker` (folded into `core/guardrails.js`), `QueryServer`,
query.js formatters + GUI, `DocumentProcessor`/modalities (via `digest/writeup.js`).

**New** (nothing in Builder to reuse): `core/state.js`, `core/guardrails.js`, `lean/*`, `agent/*`,
`blueprint/*`, `search/*`, `sharpening/reward|grpo|ttrl`, `growth/lemmaStore|dataset`,
`digest/auditPack.js`, `bench/*`.
