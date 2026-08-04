# KanForge — Patterns from HCT

This document records where several design *names* in KanForge came from. It is historical
lineage, not specification: the mechanisms are plain programming constructs whose contracts live
in `architecture.md`. No mapping below is load-bearing — none of them changes what the code does.

In plain terms, the resulting mechanisms are: lazy evaluation and lazily-forced unbounded search
frontiers; pipeline stage composition for the agent loop; a dual proof-tree / Lean-script
representation; LLM-propose + kernel-verify with a goal-solved stopping rule; error-driven
repair; pinned statements (no weakening); a blueprint skeleton → refine two-phase buildout
(currently stubs, P4); an eager-vs-lazy caching split; open-goal accounting for progress; and
sharded, coherence-checked distributed proving (P7). Each is detailed in `architecture.md` and
sequenced in `build_order.md`.

The seeded example documents (`output/primer.md`, `output/working.md`) are a 27-layer higher
category theory curriculum from which the names below were drawn. Most layers are exposition; the
rest reinforce the patterns without changing module decisions.

**Framing caveat:** these are engineering analogies that produced useful designs, not claims
about the mathematics of the agent. Use them to justify naming, not to predict behavior.

**Inspiration vs specification:** a mapping names a heuristic; it is not an algorithm and is never
implemented literally. When a mapping would require building the categorical object (a Kan
extension calculator, an adjunction solver), the module contract in `architecture.md` wins and the
mapping is re-framed; the specification is never bent to fit the metaphor. (`blueprint.md` §4.2.)

---

## The patterns (historical intuition — none are load-bearing)

1. **Simplicial sets & ∞-categories → coinductive lazy search.** ∞-structures are determined by
   their finite skeleta; composition is horn-filling. Keep an infinite, lazily-materialized
   frontier and force only what's needed (`core/stream.js`, `core/fix.js`). **Repair = horn
   filling**: a failing goal is a horn missing its filler; the repair agent's job is to propose a tactic that fills it,
   not to re-roll the whole proof (`agent/repair.js`).

2. **Straightening / unstraightening → the proof-tree ↔ tactic-script duality.** A fibration
   over C is equivalent to a functor C → Cat; geometry and algebra are two views of one thing.
   Keep the proof as a tree (for surgery, merging, parallelism) and as a script (for the kernel,
   storage, diffing), and convert losslessly (`core/state.js`). Rule: repairs edit the tree and
   re-straighten; kernel successes un-straighten back. Never edit one side only.

3. **Kan extensions → the search primitive.** A Kan extension is the best approximate extension
   of a functor along another. Every agent act is an extension: given the current partial proof
   and the target goal, find the most general fill (`agent/loop.js`). `fix` gives the infinite
   extension — a full proof from finite evidence.

4. **Adjunctions → generator ⊣ verifier.** LLM-generate is left adjoint to Lean-verify; unit is
   "candidate → its certificate", counit is "certificate → trusted theorem". A goal is *solved*
   at the universal arrow: candidate composes cleanly through verification, and the statement
   hash matches the pin (`agent/solve.js`).

5. **Monads → the loop as a monad.** The agent is a monadic effect stack (LLM call, Lean check,
   cache, log, reward). `Pipeline.kleisli` is Kleisli composition (`core/pipeline.js`); the loop
   is one monadic program, not ad-hoc async.

6. **Presentable / accessible categories → the caching rule.** Compact objects ↔ eagerly
   materialize small lemmas; filtered colimits ↔ lazily generate everything else
   (`core/cache.js`). `isCompact(node)` decides the split and governs the compute budget.

7. **Stable ∞-categories → residual tracking.** Every tactic application leaves its residual
   goal (the cofiber); the residuals form a spectrum of open goals. Progress = the spectrum
   strictly decreases in a well-founded order (`optimization/metrics.js`).

8. **Descent & hypercovers → distributed proving.** Shard a development into a hypercover of
   lemma sub-goals, prove locally, require coherence on every overlap before merging
   (`growth/multibody.js`, P7). Single-agent mode is the trivial hypercover.

9. **Modalities → the skeleton/refine phase switch.** Two idempotent phases: **Skeleton**
   (approximate a theorem by a DAG of typechecked `sorry`-stubs — `blueprint/skeleton.js`) and
   **Refine** (fill the lowest unproved stub — `blueprint/refine.js`). Invariant: the statement
   set never changes, only the stub count.

10. **Giraud axioms → an intrinsic invariant spec.** Define correctness by a minimal checkable
    invariant set, not by construction (`core/guardrails.js`): pinned statement hashes, kernel
    verification, no axiom/unsafe leakage, acyclic dependency-complete blueprint, resumable from
    any checkpoint.

11. **Internal language → Lean IS the language.** Statements, goals, and contexts are already
    Lean terms; build prompts from those terms (`agent/prompts.js`) rather than re-typed math.

12. **Base change → generalization/instantiation.** Pulling a proof back along a change of
    hypotheses is the generalize/instantiate service (deferred; would live under `agent/roles/` in
    P7 only if a target needs it).

---

## Deliberately excluded layers

Fibrations taxonomy (Layers 2–4), limits/colimits (6), monoidal structure (12), ∞-topoi internal
logic (13, 17), stack semantics (20), shape theory (21), classifying topoi (22), structured
universes (23), cohesion (25), and the (∞,2)-material (26–27) reinforce the patterns above but do
not independently change a module decision in `architecture.md`. If a future feature (e.g.
cohesion-based compute routing, a strategy library) is actually needed, those layers are the
place to re-derive its design — YAGNI until then.
