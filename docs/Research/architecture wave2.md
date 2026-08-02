# KanForge: Incremental Verified Code Synthesis via Dependency Graphs, Equality Saturation, and Compiler-Governed Repair

## Abstract

Large Language Models (LLMs) have substantially improved automatic program synthesis, yet existing verification pipelines continue to treat generated programs as complete textual artifacts that repeatedly enter an expensive compile-and-repair loop. This architecture conflates probabilistic generation with deterministic verification, resulting in redundant compilation, specification drift, and poor scalability for formally verified software.

KanForge decouples these concerns by treating AI synthesis as a sequence of structured graph transformations operating inside an incremental build system. Rather than emitting complete programs, the language model proposes localized mutations to verified program structure. Candidate mutations are represented over synchronized Abstract Syntax Trees (ASTs) and Equality Saturation Graphs (E-Graphs), evaluated using incremental dependency analysis, filtered through parallel graph processing, and admitted only after successful verification by the Lean 4 kernel.

The resulting architecture preserves immutable interface contracts, limits recompilation to affected dependency subgraphs, and treats compiler verification—not model confidence—as the sole correctness authority. KanForge therefore reframes verified program synthesis as an incremental systems problem whose performance is governed primarily by dependency management, structural reuse, and compiler scheduling rather than language model capability.

---

# 1. Introduction

Modern LLMs excel at producing syntactically plausible source code but remain fundamentally probabilistic. Formal verification systems, by contrast, require deterministic correctness. Existing AI-assisted verification workflows bridge these incompatible paradigms through repeated generate-compile-repair cycles:

```
Generate Program
      ↓
Compile
      ↓
Failure
      ↓
Generate Again
```

Although straightforward, this approach suffers from three systemic inefficiencies.

**Specification Drift.**
Language models frequently satisfy verification goals by implicitly weakening specifications rather than repairing implementations.

**Global Recompilation.**
Minor edits often trigger complete rebuilds despite affecting only localized dependency regions.

**Structural Instability.**
Repeated manipulation of raw source text introduces unrelated syntactic changes that obscure the true verification problem.

KanForge addresses these issues by replacing whole-program generation with structured graph mutation.

Instead of asking the model to produce an entire verified program, the system asks it to propose a localized transformation over an existing verified graph.

Verification becomes an incremental graph maintenance problem.

---

# 2. System Model

A project is represented as

[
\mathcal P=(G,\Sigma,C)
]

where

* (G) is a dependency DAG,
* (\Sigma) is the synchronized program representation,
* (C) is the compiler verification function.

Each node

[
v\in G
]

contains

* source artifact
* AST
* e-graph fragment
* dependency metadata
* verification cache
* interface fingerprint

Edges denote compilation dependencies.

---

# 3. Synchronized Program Representation

Each compilation unit simultaneously exists in three equivalent representations.

```
Source
   ↕
AST
   ↕
E-Graph
```

Each representation serves a distinct purpose.

| Representation | Primary Responsibility           |
| -------------- | -------------------------------- |
| Source         | Human editing and compiler input |
| AST            | Deterministic structural editing |
| E-Graph        | Simultaneous rewrite exploration |

Synchronization satisfies

[
Source
\leftrightarrow
AST
\leftrightarrow
EGraph
]

through deterministic transformations.

The system invariant is

> Every accepted mutation preserves semantic equivalence across all synchronized representations.

No representation may diverge independently.

---

# 4. Patch Algebra

Rather than representing candidate solutions as source strings, KanForge models every proposal as a typed graph mutation

[
p=(n,o,r,s,m)
]

where

* (n) is the target node,
* (o) is the edit operator,
* (r) is the replacement subtree,
* (s) defines dependency scope,
* (m) stores verification metadata.

Supported operators include

* Replace Subtree
* Insert Node
* Delete Node
* Rewrite Equivalence
* Introduce Helper Lemma
* Inline Definition

Every patch therefore possesses explicit structural semantics.

Patches become first-class objects that may be reordered, merged, discarded, or replayed independently of source text.

---

# 5. Interface Invariance

Every project partitions artifacts into immutable specifications and mutable implementations.

Immutable artifacts include

* exported function signatures,
* theorem statements,
* public types,
* module interfaces.

Mutable artifacts include

* proofs,
* implementations,
* helper definitions,
* optimization rewrites.

Let

[
I(v)
]

denote the immutable interface of node (v).

Every accepted patch satisfies

[
I(v)=I'(v)
]

unless an explicitly authorized interface migration is performed.

Consequently, synthesis may improve implementations but cannot redefine correctness.

---

# 6. Equality Saturation

Conventional rewriting performs irreversible transformations

```
A
↓
B
↓
C
```

KanForge instead maintains an equivalence relation

[
A
\sim
B
\sim
C
]

within an e-graph.

Multiple implementations coexist until extraction.

Advantages include

* elimination of premature commitment,
* maximal structural reuse,
* deduplicated rewrite search,
* parallel optimization.

Extraction becomes a cost optimization problem rather than a rewrite sequence.

---

# 7. Incremental Dependency Graph

The project dependency graph

[
G=(V,E)
]

is acyclic.

Every node maintains one of seven states.

```
Clean

Dirty

Queued

Building

Verified

Failed

Cached
```

State transitions are deterministic.

```
Dirty

↓

Queued

↓

Building

↓

Verified
```

or

```
Dirty

↓

Queued

↓

Building

↓

Failed
```

Only descendants of modified nodes transition to Dirty.

All unrelated nodes remain Cached.

This locality property bounds recompilation cost by affected dependency depth rather than total project size.

---

# 8. Scheduler Semantics

The scheduler performs dependency-aware dispatch over verified graph state.

Each task receives priority according to

1. dependency criticality,
2. cache reuse,
3. verification history,
4. estimated compile cost,
5. patch confidence.

The scheduler guarantees

* no cyclic dispatch,
* bounded worker queues,
* deterministic dependency ordering,
* maximal independent parallelism.

Compilation therefore becomes graph scheduling rather than sequential retries.

---

# 9. Heterogeneous Execution

KanForge assigns computation according to algorithmic characteristics.

| Component        | Hardware       |
| ---------------- | -------------- |
| LLM              | AI Accelerator |
| Graph Processing | GPU            |
| Scheduler        | CPU            |
| Compiler         | Multi-core CPU |

GPU execution performs

* subtree hashing,
* graph deduplication,
* rewrite clustering,
* cost evaluation,
* parallel sorting.

Compiler workers perform

* parsing,
* elaboration,
* type checking,
* kernel verification,
* artifact generation.

Each subsystem executes workloads naturally aligned with its architecture.

---

# 10. Verification Semantics

Compiler verification defines the sole correctness relation.

Given

[
C(p)=
\begin{cases}
1 & \text{verified}\
0 & \text{rejected}
\end{cases}
]

only

[
C(p)=1
]

permits graph mutation.

Model confidence, heuristic scores, or historical success never override compiler rejection.

The compiler therefore remains the trusted computing base.

---

# 11. Error Recovery

Compiler failures produce structured telemetry

[
T=
(location,
constraint,
expected,
actual,
dependencies)
]

rather than free-form logs.

Telemetry maps directly back to affected graph regions.

Repair therefore operates over failed graph neighborhoods instead of regenerating entire files.

Previously verified regions remain immutable throughout subsequent repair iterations.

---

# 12. Incremental Caching

KanForge maintains persistent caches for

* parsed ASTs,
* e-graph fragments,
* compiled modules,
* proof artifacts,
* dependency fingerprints,
* rewrite histories.

Cache invalidation follows dependency topology exclusively.

No unaffected artifact is recompiled.

---

# 13. Correctness Invariants

KanForge maintains four global invariants.

### I. Interface Preservation

Public specifications never change during synthesis.

### II. Structural Consistency

Source, AST, and e-graph remain synchronized.

### III. Incremental Verification

Only dependency descendants become invalid.

### IV. Compiler Authority

No graph mutation is committed without kernel verification.

These invariants define the correctness boundary of the architecture independently of language model quality.

---

# 14. Complexity

Let

* (n) be graph nodes,
* (k) modified nodes,
* (d) dependency descendants.

Traditional synthesis performs

[
O(n)
]

compilation after every iteration.

KanForge instead limits verification to

[
O(d)
]

where typically

[
d\ll n.
]

Graph preprocessing scales with affected rewrite regions rather than entire projects.

As project size increases, expected savings arise primarily from reduced compiler invocations rather than faster code generation.

---

# 15. Evaluation Methodology

KanForge should be evaluated along four independent dimensions.

**Verification Throughput**

Verified patches per compiler invocation.

**Compilation Efficiency**

Reduction in incremental rebuild time relative to full recompilation.

**Search Efficiency**

Compiler invocations eliminated through graph filtering.

**Correctness Preservation**

Rate of interface violations and specification drift.

Unlike conventional benchmarks emphasizing generated lines of code, these metrics directly evaluate synthesis as an incremental verification system.

---

# 16. Discussion

The central observation underlying KanForge is that formal verification is dominated not by token generation but by dependency management and compiler execution.

Accordingly, the architecture elevates structured program state to the primary abstraction.

The language model proposes mutations.

The dependency graph determines scope.

The scheduler determines execution.

The compiler determines correctness.

This separation of responsibilities transforms probabilistic generation into a deterministic, compiler-governed synthesis pipeline whose correctness depends on explicit architectural invariants rather than language model behavior.

---

# Conclusion

KanForge reframes verified AI-assisted programming as incremental graph maintenance instead of repeated source generation. By representing candidate repairs as typed graph mutations over synchronized ASTs and e-graphs, limiting recompilation through dependency-aware scheduling, preserving immutable interface contracts, and assigning final authority exclusively to the Lean compiler kernel, the architecture cleanly separates probabilistic search from deterministic verification.

The resulting system is not a new compiler nor a new language model. It is a synthesis engine that integrates both within a formally constrained build architecture, allowing verified software development to scale through structural reuse, incremental compilation, and compiler-enforced correctness.
