KanForge: A Correctness‑Preserving, Lazy, ML‑Guided Proof Refinery
Whitepaper Synthesis
KanForge is a system for constructing Lean 4 proofs using a lazy dependency graph, a dual proof representation, a structured propose/verify/repair loop, and telemetry‑driven reinforcement learning. Its design is shaped by two constraints stated in the architecture documents:

“Statement pinning makes every checked goal carry a hash; mutation = WEAKENED + guardrail trip.”
“Keep the proof as a tree and as a script and switch representations losslessly — never edit only one side.”

These constraints define the system’s correctness envelope and determine how every component behaves.

1. Architecture
1.1 Lazy dependency graph
KanForge maintains a DAG of lemma statements. Each node is forced only when needed. Invalidation propagates downstream, and serialization captures the entire forest for resumability. This structure ensures that partial progress is preserved and recomputation is localized.

1.2 Dual representation
Each lemma has two synchronized forms:

a structured proof tree

an executable Lean script

Round‑trip consistency is enforced. Repairs modify the tree; verification checks the script. This prevents corruption of either representation and ensures that structural edits remain aligned with executable code.

1.3 Structured agent loop
The agent loop is a Kleisli pipeline:

observe → propose → act → verify → repair → commit
The generator proposes candidates; the Lean kernel verifies them. Verification is the only acceptance criterion. Failed candidates produce structured residuals that guide repair.

1.4 Telemetry and reinforcement learning
Every action is logged. Causal analysis identifies failure patterns, bottlenecks, and critical paths. Reinforcement learning biases future proposals toward historically successful strategies. Guardrails prevent reward‑driven deviations from correctness.

2. Capabilities
2.1 Correctness preservation
Pinned statements, kernel verification, and guardrails ensure that no lemma is accepted unless it satisfies Lean’s type system and matches its pinned hash. This prevents silent weakening and enforces semantic stability.

2.2 Structured repair
Failures are localized to subgoals. Repairs operate on the proof tree, preserving global structure. This allows the system to recover from incorrect proposals without discarding progress.

2.3 Efficient search
Lazy forcing restricts exploration to relevant regions of the proof space. Monte Carlo Graph Search with transposition merging reduces redundant work by identifying definitional equality among goals.

2.4 Reproducibility
Hash‑chained audit trails and full serialization of the proof forest guarantee reproducible runs. Every verified lemma is committed with its statement hash.

3. Limitations
3.1 Proposal quality
LLM proposals may be invalid or unhelpful. The architecture assumes this. Verification rejects invalid candidates, and repair isolates failures. Telemetry improves proposal quality over time.

3.2 Search difficulty
Hard goals may produce long repair loops. Lazy forcing prevents global stalls, and RL biases search toward effective strategies. Partial progress is preserved.

3.3 Verification cost
Lean kernel checks are expensive. Process pools amortize cost, and memoization reduces repeated work. Checkpoints avoid recomputation across runs.

3.4 Blueprint decomposition
Autoformalization and skeleton generation may produce suboptimal DAGs. Typechecking and pinning prevent incorrect structures. Refinement shrinks stubs without altering statements.

4. Applicability Beyond Lean
KanForge’s architecture generalizes to domains requiring correctness under ML guidance, lazy dependency management, structured repair, and reproducible audit trails.

4.1 Scientific computing
Simulation pipelines often involve large dependency graphs, expensive recomputation, and correctness constraints. PullGraph maps directly onto simulation DAGs; guardrails enforce physical invariants; telemetry supports failure analysis.

4.2 Robotics
Planning and control systems require structured plans, executable policies, safety constraints, and failure recovery. Dual representation maps to plan IR ↔ controller code; the agent loop matches closed‑loop planning; guardrails enforce safety.

4.3 Compilers
Incremental compilation, IR ↔ source round‑trip consistency, and ML‑guided optimization align closely with KanForge’s architecture. PullGraph becomes the compilation DAG; guardrails enforce semantic preservation; telemetry profiles optimization passes.

5. Conclusion
KanForge integrates lazy dependency management, dual proof representation, structured repair, kernel‑verified correctness, telemetry, causal analysis, and reinforcement learning into a single system. Its limitations are operational rather than structural, and its design generalizes to multiple high‑value domains where correctness, reproducibility, and ML‑guided search must coexist.