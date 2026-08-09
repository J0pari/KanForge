# KanForge: A Compiler Architecture for Formal Proof

## Executive Summary

KanForge treats formal proof construction as a compilation problem.

A theorem or verified program specification is an immutable interface. Its implementation is a structured artifact distributed across synchronized source, abstract-syntax, and equality-saturation representations. Candidate transformations enter as typed structural patches. A dependency DAG determines the scope of recomputation; equality saturation retains alternative equivalent forms; a scheduler allocates verification work; and Lean provides the final semantic authority.

The central architectural distinction is between **search** and **truth**.

Language models, ranking systems, rewrite engines, caches, and schedulers determine which possibilities are worth exploring. They do not establish correctness. Correctness enters the system only through compiler and kernel acceptance of the resulting artifact.

This makes the system compiler-like in a strong sense. The theorem is a specification; proof structure is intermediate representation; a tactic or rewrite is a transformation; a compiler diagnostic is a structured failure state; a verified lemma is a reusable build artifact; the dependency graph is a mathematical build graph; and accumulated telemetry becomes a profile from which search policy can be optimized.

---

## 1. The Central Problem

Probabilistic synthesis and formal verification have different semantic roles.

A language model can propose plausible transformations without guaranteeing that they satisfy the specification. A formal kernel can determine whether a concrete artifact is valid, but it does not decide which candidate is worth trying.

A useful architecture therefore cannot collapse the two functions into a single generation step.

The appropriate structure is:

```text
Specification
      ↓
Probabilistic Search
      ↓
Structured Transformation
      ↓
Deterministic Verification
```

The architecture becomes powerful when the space between search and verification is itself structured.

That space contains the representations, dependencies, equivalences, caches, schedulers, diagnostics, and repair operations that determine how efficiently the system reaches a verified artifact.

---

## 2. The Specification Boundary

The theorem statement or public interface is the fixed boundary of the synthesis problem.

For formal mathematics, this means that the proposition being proved is not merely another piece of generated text. It is the specification against which all implementations are measured.

For software, the analogous objects are:

- exported signatures,
- public types,
- module interfaces,
- declared contracts.

For each node \(v\), let \(I(v)\) denote its interface. Synthesis acts on implementation structure while preserving:

\[
I(v)=I'(v).
\]

An interface fingerprint makes this identity explicit and mechanically enforceable.

This produces an important architectural asymmetry:

```text
Specification
     │
     │ fixed boundary
     ▼
Implementation
     │
     │ freely explored
     ▼
Verified Artifact
```

The system can search aggressively because the specification boundary does not move with the search.

---

## 3. Structure Instead of Strings

Raw source text is too coarse to serve as the sole representation of synthesis.

KanForge maintains three synchronized views:

```text
                 Source
                ↕      ↕
              AST  ↔ E-Graph
```

The source is the concrete artifact and human-readable form.

The AST is the deterministic structural representation. It provides a precise tree on which localized edits can operate.

The e-graph represents equivalence classes of alternatives. It allows several forms to coexist without requiring the system to commit to one textual realization at every transformation.

The three views answer different questions:

- **Source:** what artifact is compiled?
- **AST:** what structural object is being edited?
- **E-Graph:** what equivalent alternatives are available?

Their synchronization is an architectural invariant.

---

## 4. The Patch as the Fundamental Unit of Search

The language model does not need to produce an entire program or proof.

It proposes a patch:

\[
p=(n,o,r,s,m).
\]

The patch identifies:

- where a transformation applies,
- what operation it performs,
- what structure replaces the target,
- what dependency scope is affected,
- what verification information accompanies the proposal.

Typical patch operations include:

- subtree replacement,
- node insertion,
- node deletion,
- equivalence rewrite,
- helper-lemma introduction,
- definition inlining.

This changes the granularity of synthesis.

Instead of:

```text
generate entire artifact
        ↓
compile entire artifact
        ↓
start again
```

the system operates on:

```text
verified structure
        ↓
localized patch
        ↓
affected dependency region
        ↓
verification
```

The patch is therefore the interface between probabilistic generation and deterministic compilation.

---

## 5. Equality Saturation and Delayed Commitment

A sequential rewrite system chooses one form and discards alternatives:

```text
A → B → C
```

An equality-saturation system maintains:

```text
A ~ B ~ C
```

inside an equivalence graph.

This has an important architectural consequence: **search does not have to commit at the moment it discovers an alternative**.

Equivalent proof or program structures can coexist while the system accumulates rewrite opportunities. Extraction becomes the point at which a concrete representation is selected.

The cost model can incorporate properties such as:

- structural complexity,
- verification cost,
- dependency impact,
- reuse,
- robustness,
- downstream compilation effects.

The e-graph therefore acts as a space of possibilities, while the AST and source act as concrete extracted representations.

For formal proof, this is especially useful because many proof transformations differ syntactically while preserving the proposition that must be established.

---

## 6. The Dependency Graph

The dependency DAG is the architecture's global structural skeleton:

\[
G=(V,E).
\]

A node represents a build artifact; an edge represents a dependency whose validity constrains the dependent artifact.

The graph gives the system something a text-generation loop lacks: **a precise notion of affectedness**.

When node \(v\) changes, its relevant descendants become invalid. An unrelated node does not need to be regenerated merely because another proof or implementation changed.

The graph consequently serves four roles simultaneously:

1. dependency representation,
2. invalidation mechanism,
3. cache structure,
4. execution plan.

The build state of a node can be represented as:

```text
Clean → Dirty → Queued → Building
                         ├──→ Verified
                         └──→ Failed
```

Verified artifacts can enter the cache and unlock dependent nodes.

---

## 7. Incrementality as a Semantic Property

Incremental compilation is not simply a performance trick.

It follows from the dependency semantics of the artifacts.

If a node's correctness depends on a particular set of upstream artifacts, then a mutation outside that dependency closure does not change the node's verification conditions.

This yields the locality principle:

> Invalidation follows dependency reachability.

If \(n\) is the total number of artifacts and \(d\) is the affected descendant set, the relevant verification region is \(d\), not \(n\).

The practical consequence is profound for formal synthesis: the computational cost of repairing a local proof failure can be tied to the logical neighborhood of that failure rather than to the size of the entire development.

---

## 8. The Scheduler

Once proof construction is a graph problem, execution becomes a scheduling problem.

The scheduler sees:

- dependency readiness,
- graph criticality,
- cache availability,
- verification history,
- estimated compilation cost,
- patch confidence.

It uses these properties to select work while preserving dependency order.

Independent branches can execute concurrently.

Dependent branches wait.

Failed branches generate structured repair work rather than forcing unrelated work back through the system.

The scheduler thus turns the graph's static structure into an execution discipline.

---

## 9. The Verification Boundary

All of the machinery above is subordinate to one relation:

\[
C(p)=1
\]

means the candidate artifact is accepted; \(C(p)=0\) means it is rejected.

For formal proof, Lean's elaboration and kernel constitute the semantic authority.

This creates a clean trust boundary:

```text
                 UNTRUSTED / HEURISTIC
    ┌────────────────────────────────────────┐
    │ LLM                                    │
    │ Search                                 │
    │ Ranking                                │
    │ Equality-aware exploration             │
    │ Repair                                 │
    │ Caching policy                         │
    │ Scheduling policy                      │
    └────────────────────┬───────────────────┘
                         │
                  structured artifact
                         │
                         ▼
                 TRUSTED SEMANTICS
    ┌────────────────────────────────────────┐
    │ Lean elaboration / kernel              │
    │ Formal verification                    │
    └────────────────────────────────────────┘
```

A high model score cannot compensate for a failed proof.

A historically successful tactic cannot compensate for a failed proof.

A GPU filter cannot compensate for a failed proof.

The system's optimization layers determine **what to try**. The kernel determines **what counts**.

---

## 10. Compiler Errors as Search State

A compiler failure contains semantic information.

Rather than treating an error as an opaque textual event, the architecture represents it structurally:

\[
T=(location,\ constraint,\ expected,\ actual,\ dependencies).
\]

This representation maps the failure back onto the dependency and proof structures.

The repair process therefore becomes:

```text
Candidate
   ↓
Verification
   ↓
Structured Failure
   ↓
Failure Neighborhood
   ↓
Patch Generation
   ↓
Verification
```

A successful branch remains stable while the failed branch is reconsidered.

This is one of the deepest consequences of the compiler architecture: **failure becomes data for the next transformation rather than evidence that the whole artifact must be regenerated.**

---

## 11. Verified Artifacts as Reusable Knowledge

A successful proof is more than a Boolean result.

It is a reusable artifact with:

- a specification identity,
- dependency identity,
- environment identity,
- structural representation,
- verified status.

The cache therefore becomes a store of verified mathematical knowledge.

When a later proof depends on the same lemma, the system can reuse its verified artifact rather than rediscovering the proof.

This produces two distinct forms of reuse:

### Artifact reuse

Reuse something already proved.

### Search reuse

Reuse information about which transformations and proof-state paths tend to succeed.

The first reduces formal work. The second reduces exploratory work.

---

## 12. Heterogeneous Computation

The architecture separates workloads by their computational structure.

LLM inference is suited to AI accelerators.

Graph operations such as hashing, deduplication, clustering, sorting, and candidate filtering are suited to data-parallel execution.

Scheduling and asynchronous coordination are CPU-oriented.

Lean elaboration and kernel verification are branch-heavy and memory-intensive CPU workloads.

The resulting division is:

| Layer | Computational character |
|---|---|
| LLM | high-throughput learned inference |
| E-Graph / graph engine | data-parallel structural computation |
| Scheduler | asynchronous dependency coordination |
| Lean workers | deterministic branch-heavy verification |

The hardware topology follows the algorithmic topology.

The semantic boundary remains unchanged regardless of where a computation executes.

---

## 13. Telemetry and Feedback

Every transformation produces useful evidence.

The architecture can record:

- candidate generation,
- rewrite selection,
- candidate rejection,
- cache hits and misses,
- compiler failures,
- repair attempts,
- successful verification,
- dependency behavior,
- execution cost.

This creates a profile of proof and program search.

A learned policy can then estimate which transformation is likely to be useful in a given structural context.

The feedback loop is:

```text
Search
  ↓
Verification
  ↓
Telemetry
  ↓
Learned Cost / Success Model
  ↓
Search Prioritization
```

The crucial property is that learning changes the **search distribution**, not the **correctness relation**.

A poor predictor wastes computation.

It cannot turn an invalid proof into a valid one.

---

## 14. Provenance

The architecture treats provenance as part of the verified artifact.

A proof artifact is associated with:

- its specification,
- interface fingerprint,
- dependency graph,
- structural representation,
- compiler environment,
- verification result,
- relevant transformation history,
- cache provenance.

This makes it possible to answer not merely:

> Is this theorem accepted?

but also:

> Which specification, dependencies, transformations, and verification context produced this accepted artifact?

That distinction matters for high-assurance mathematical systems because reproducibility is not only a property of source text. It is a property of the entire semantic build context.

---

## 15. The Architecture as a Compiler

The correspondence can be made explicit:

| Formal synthesis concept | Compiler analogue |
|---|---|
| Theorem / interface | Source specification |
| Proof or implementation | Program |
| Proof-state representation | Intermediate representation |
| AST | Structural IR |
| E-Graph | Equality-aware optimization IR |
| Patch | Transformation / rewrite |
| Dependency DAG | Build graph |
| Compiler diagnostic | Structured failure state |
| Verified lemma | Build artifact |
| Cache | Artifact store |
| Scheduler | Build executor |
| LLM | Learned search heuristic |
| Lean kernel | Semantic backend |
| Search telemetry | Profile |
| Learned ranking | Cost model / optimization policy |

The analogy is not decorative. It explains the architecture.

A compiler does not merely translate text into machine code. It maintains semantic structure across representations, applies transformations, tracks dependencies, schedules work, caches artifacts, and uses a trusted semantic backend.

KanForge applies the same organizational logic to formal synthesis.

---

## 16. Construction Order

The architecture has a natural dependency order:

```text
Specification identity
        ↓
Dependency graph
        ↓
Synchronized representations
        ↓
Patch algebra
        ↓
Equality-aware search
        ↓
Concrete extraction
        ↓
Compiler verification
        ↓
Incremental invalidation and caching
        ↓
Scheduling and parallel execution
        ↓
Structured repair
        ↓
Telemetry and learned optimization
```

Each layer presupposes the semantic objects established below it.

The result is a single coherent system: a verified artifact graph whose search mechanism is probabilistic, whose transformations are structural, whose recomputation is incremental, and whose semantic boundary is deterministic.

---

## 17. What Makes the Architecture Interesting

The most consequential idea is not the presence of an LLM.

It is the relocation of the LLM inside the architecture.

A conventional AI coding system makes generation the center:

```text
LLM → source text → compiler
```

KanForge makes the verified artifact graph the center:

```text
                 Dependency Graph
                /       |        \
             AST     E-Graph    Cache
              \        |        /
               \     Patches   /
                \      |      /
                 Search / Repair
                       │
                       ▼
                    Lean
```

The model becomes one participant in a much larger computational structure.

That change has several consequences.

### Search becomes local

A candidate acts on a structural neighborhood rather than rewriting an entire artifact.

### Equivalence becomes persistent

Alternative representations can coexist rather than being discarded after each rewrite.

### Verification becomes incremental

Only affected dependency regions require new checking.

### Failure becomes informative

A compiler error identifies a region and a constraint that guide the next search step.

### Proof becomes reusable

Verified artifacts become persistent graph nodes rather than ephemeral successful strings.

### Learning becomes operational

Historical traces improve search policy without becoming part of the trust boundary.

The result is a system in which formal correctness is not an afterthought applied to AI output. It is the organizing constraint around which generation, representation, optimization, execution, caching, and repair are arranged.

---

## 18. Conclusion

KanForge is a compiler architecture for formal synthesis in which probabilistic search operates over structured, dependency-aware artifacts and deterministic verification establishes semantic authority.

The architecture consists of:

- immutable specification boundaries,
- synchronized source, AST, and e-graph representations,
- typed structural patches,
- equality-aware exploration,
- an incremental dependency DAG,
- dependency-aware scheduling,
- persistent verified artifacts,
- structured compiler diagnostics,
- localized repair,
- heterogeneous execution,
- provenance,
- and feedback-directed search optimization.

Its deepest principle is the separation of **exploration from acceptance**.

The search system can be probabilistic, approximate, learned, parallel, and aggressively optimized. The semantic boundary remains exact.

That division allows the architecture to combine the generative breadth of language models with the determinism of formal verification without asking either component to perform the other's job.

The result is not simply an AI system that writes proofs. It is a compiler-shaped system in which proofs are structured artifacts, transformations are typed operations, dependencies determine recomputation, failures become search signals, verified results become reusable build products, and the kernel remains the final semantic authority.
