# KanForge: A Compiler Architecture for Incremental Verified Synthesis

## Abstract

KanForge is a compiler-oriented architecture for AI-assisted formal synthesis. Its central abstraction is a verified build: a specification enters as an immutable interface, candidate implementations are represented structurally, transformations are explored over dependency-aware intermediate representations, and a concrete artifact is admitted only after compiler and kernel verification.

The architecture separates probabilistic search from deterministic semantic authority. A language model proposes localized structural mutations rather than being trusted to produce correctness directly. Abstract syntax trees provide deterministic structural editing; equality-saturation graphs retain alternative equivalent forms; a dependency DAG scopes invalidation and compilation; a scheduler dispatches independent work; and compiler workers provide the final correctness gate.

The resulting system is best understood as a proof-and-program compiler whose optimization problem is not merely generation quality but the efficient maintenance of a verified artifact graph.

---

## 1. Architectural Model

A project is represented as:

\[
\mathcal P=(G,\Sigma,C)
\]

where:

- \(G\) is a dependency DAG,
- \(\Sigma\) is a synchronized structural representation,
- \(C\) is the compiler verification function.

Each graph node contains:

- a source artifact,
- an AST,
- an e-graph fragment,
- dependency metadata,
- verification state and cache,
- an immutable interface fingerprint.

Edges express compilation dependencies.

The architecture has a strict separation of concerns:

```text
Specification
     │
     ▼
Structured Program State
     │
     ├── AST
     ├── E-Graph
     └── Dependency Graph
     │
     ▼
Candidate Structural Mutation
     │
     ▼
Dependency-Aware Scheduling
     │
     ▼
Compiler / Kernel Verification
     │
     ├── rejected
     └── verified
```

The model proposes transformations. The graph determines their scope. The scheduler determines their execution. The compiler determines correctness.

---

## 2. Immutable Specifications and Mutable Implementations

Every artifact has an interface boundary separating what is being proved or implemented from how it is realized.

Immutable specifications include:

- exported function signatures,
- theorem statements,
- public types,
- module interfaces.

Mutable artifacts include:

- proofs,
- implementations,
- helper definitions,
- optimization rewrites.

Let \(I(v)\) denote the immutable interface of node \(v\). An accepted patch preserves:

\[
I(v)=I'(v)
\]

unless an explicitly authorized interface migration is part of the specification.

This makes interface preservation an architectural invariant. Synthesis can alter an implementation without silently redefining the problem that implementation must solve.

Cryptographic fingerprints provide identity for the pinned interface and make unauthorized changes mechanically detectable.

---

## 3. Synchronized Intermediate Representations

Each compilation unit exists simultaneously in three coordinated representations:

```text
Source
   ↕
 AST
   ↕
E-Graph
```

They serve different purposes.

| Representation | Responsibility |
|---|---|
| Source | Human-readable artifact and compiler input |
| AST | Deterministic structural editing |
| E-Graph | Equivalence-aware rewrite exploration |

Synchronization is maintained by deterministic transformations between representations.

The architectural invariant is:

> No accepted transformation leaves one representation semantically or structurally detached from the others.

The source representation provides the concrete artifact; the AST supplies a stable tree-shaped editing surface; the e-graph preserves alternative forms that would otherwise be discarded by sequential rewriting.

---

## 4. Patch Algebra

A candidate synthesis operation is a typed graph mutation:

\[
p=(n,o,r,s,m)
\]

where:

- \(n\) is the target node,
- \(o\) is the edit operator,
- \(r\) is the replacement subtree,
- \(s\) defines dependency scope,
- \(m\) stores verification metadata.

Representative operators include:

- Replace Subtree,
- Insert Node,
- Delete Node,
- Rewrite Equivalence,
- Introduce Helper Lemma,
- Inline Definition.

A patch is therefore a semantic object rather than a source-string delta. It can be:

- validated,
- ranked,
- reordered,
- merged,
- discarded,
- replayed,
- associated with a verification result.

The patch algebra is the interface through which probabilistic synthesis enters the deterministic build system.

---

## 5. Equality Saturation

Sequential rewriting commits to one path at every step:

```text
A → B → C
```

Equality saturation instead maintains an equivalence class:

```text
A ~ B ~ C
```

within an e-graph.

Multiple candidate forms coexist until extraction. This provides:

- reduced premature commitment,
- structural reuse,
- deduplicated rewrite search,
- parallel candidate evaluation,
- extraction as an explicit optimization problem.

The e-graph does not replace the compiler's semantic authority. Its equivalence relation is an exploration mechanism whose admissibility depends on the rewrite system and its soundness conditions.

Extraction selects a concrete representation from an equivalence class according to a cost model. The extracted AST then supplies the structurally precise artifact from which source is generated.

---

## 6. Incremental Dependency Graph

The dependency graph is an acyclic build graph:

\[
G=(V,E)
\]

Each node occupies a deterministic build state:

```text
Clean
Dirty
Queued
Building
Verified
Failed
Cached
```

The principal transition paths are:

```text
Dirty
  ↓
Queued
  ↓
Building
  ├──→ Verified
  └──→ Failed
```

A mutation invalidates only dependency descendants of its target. Unrelated nodes retain their cached state.

This locality property changes the unit of recompilation from the project to the affected dependency region.

If \(n\) is the number of graph nodes, \(k\) the number of modified nodes, and \(d\) the number of affected descendants, verification work is scoped to \(d\) rather than \(n\), with the useful regime being:

\[
d \ll n.
\]

The graph is therefore simultaneously a dependency representation, invalidation mechanism, cache index, and execution substrate.

---

## 7. Scheduler Semantics

The scheduler performs dependency-aware dispatch over graph state.

Task priority incorporates:

1. dependency criticality,
2. cache reuse,
3. verification history,
4. estimated compile cost,
5. patch confidence.

Its execution semantics enforce:

- acyclic dispatch,
- bounded worker queues,
- dependency ordering,
- maximal independent parallelism.

Independent graph regions can therefore proceed concurrently while dependent work waits for the required verified artifacts.

The scheduler does not decide correctness. It decides which admissible work receives computational resources and in what order.

---

## 8. Heterogeneous Execution

The architecture assigns workloads according to their computational character.

| Component | Primary Hardware | Function |
|---|---|---|
| Patch Proposal Engine | AI accelerator | Candidate structural mutations |
| Graph / E-Graph Engine | GPU | Deduplication, rewrite analysis, candidate filtering |
| Build Scheduler | CPU | Dependency routing and asynchronous dispatch |
| Compiler Workers | Multi-core CPU | Parsing, elaboration, type checking, kernel verification |

The graph engine is naturally suited to data-parallel operations such as:

- subtree hashing,
- graph deduplication,
- rewrite clustering,
- candidate scoring,
- parallel sorting.

Compiler workers handle branch-heavy, memory-intensive operations such as:

- parsing,
- elaboration,
- dependent type checking,
- kernel verification,
- artifact generation.

Hardware assignment is an execution optimization. It does not alter the semantic model.

---

## 9. Verification Semantics

The compiler defines the sole correctness relation:

\[
C(p)=
\begin{cases}
1 & \text{verified}\\
0 & \text{rejected}
\end{cases}
\]

Only a candidate satisfying \(C(p)=1\) can modify verified graph state.

Model confidence, heuristic scores, historical success, and GPU filtering never override compiler rejection.

For formal proof artifacts, Lean's kernel is the semantic authority. The model and search machinery are therefore outside the trusted correctness boundary; they optimize discovery without deciding truth.

---

## 10. Error Recovery

Compiler failures become structured search information rather than opaque logs.

A failure record contains information such as:

\[
T=(location,\ constraint,\ expected,\ actual,\ dependencies)
\]

The diagnostic maps back to the affected graph neighborhood.

Repair consequently operates on the failed structural region:

```text
Candidate Patch
      ↓
Compiler
      ↓
Structured Diagnostic
      ↓
Affected Graph Region
      ↓
Alternative Patch
```

Verified regions remain stable while the failed neighborhood is explored again.

This makes compiler failure part of the synthesis state rather than a reason to regenerate an entire artifact.

---

## 11. Incremental Caching

Persistent caches contain reusable structural and compilation artifacts, including:

- parsed ASTs,
- e-graph fragments,
- compiled modules,
- proof artifacts,
- dependency fingerprints,
- rewrite histories.

Cache invalidation follows dependency topology.

An artifact remains reusable when its interface identity, relevant dependencies, and compilation assumptions remain valid. A mutation invalidates the artifacts whose correctness depends on it, not unrelated portions of the graph.

Caching therefore operates at the same structural granularity as synthesis and verification.

---

## 12. Correctness Invariants

Four global invariants define the architecture.

### I. Interface Preservation

Public specifications remain unchanged under ordinary synthesis.

### II. Structural Consistency

Source, AST, and e-graph representations remain synchronized.

### III. Incremental Verification

Only dependency descendants become invalid after a local mutation.

### IV. Compiler Authority

No graph mutation enters verified state without compiler and kernel acceptance.

These invariants separate system correctness from model behavior.

---

## 13. Constructive Dependency Order

The architecture has an intrinsic dependency order independent of any implementation history.

The semantic substrate establishes:

1. specification identity and interface fingerprints;
2. dependency graph and artifact identity;
3. synchronized source, AST, and e-graph representations;
4. patch algebra over those representations;
5. equality-aware search and extraction;
6. compiler lowering and verification;
7. incremental invalidation and caching;
8. scheduling and heterogeneous execution;
9. structured repair and telemetry;
10. feedback-directed optimization.

This is a construction order: each layer depends on semantic objects supplied by the preceding layers. It is not a chronology of versions. The resulting architecture is the complete system described by these interacting abstractions.

---

## 14. Feedback-Directed Optimization

The architecture records structured telemetry from synthesis and verification:

- candidate generation,
- candidate rejection,
- rewrite application,
- cache hits and misses,
- compiler failures,
- repair attempts,
- successful verification,
- dependency and scheduling behavior.

These traces support learned predictors for:

- tactic or transformation success,
- expected verification cost,
- useful premise or rewrite classes,
- repairability,
- proof-state difficulty,
- candidate priority.

The resulting feedback loop is:

```text
Build
 ↓
Telemetry
 ↓
Causal / Statistical Analysis
 ↓
Search Policy
 ↓
Candidate Prioritization
 ↓
Build
```

The learned layer changes search efficiency, not the correctness criterion. Its predictions can be wrong; the compiler remains the final arbiter.

---

## 15. Provenance

A verified artifact carries the information required to reconstruct its semantic and build context:

- specification identity,
- interface fingerprint,
- environment identity,
- dependency identities,
- proof or implementation artifact,
- structural representation,
- verification outcome,
- relevant search and repair events,
- cache provenance.

A tamper-evident event sequence can bind build events into a reproducible history.

Provenance is therefore not an after-the-fact log. It is part of the artifact model: a verified result has both a semantic identity and a derivation context.

---

## 16. Evaluation

The architecture is evaluated as an incremental verification system.

### Verification throughput

Verified patches per compiler invocation.

### Compilation efficiency

Reduction in rebuild time relative to full recompilation.

### Search efficiency

Compiler invocations eliminated by structural filtering, deduplication, and cached search state.

### Correctness preservation

Rate of interface violations and specification drift.

### Incremental reuse

Fraction of graph state retained after localized mutations.

### Repair locality

Size of the structural region regenerated after a compiler failure.

These measures expose the architectural properties that matter most: reuse, locality, verification efficiency, and strict specification preservation.

---

## 17. Architectural Summary

KanForge is organized around a single separation of responsibilities:

```text
LLM / Search
    │
    │ proposes
    ▼
Patch Algebra
    │
    │ transforms
    ▼
AST + E-Graph
    │
    │ scoped by
    ▼
Dependency DAG
    │
    │ scheduled by
    ▼
Compiler Workers
    │
    │ decide
    ▼
Verified Artifact
```

The language model supplies exploration. The intermediate representations supply structure. Equality saturation supplies alternative forms without premature commitment. The dependency graph supplies locality. The scheduler supplies execution order and parallelism. The compiler and kernel supply semantic authority.

The architecture's defining property is therefore not merely that it combines AI with formal verification. It places probabilistic synthesis **inside a deterministic incremental compilation system** whose representations, dependencies, caches, repairs, and execution semantics are all organized around the final verification boundary.
