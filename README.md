# KanForge

**Tactic-level automated theorem prover for Lean 4**

KanForge is a pull-based, lazily-evaluated proof refinement system that uses LLM-guided tactic search to automatically prove Lean 4 theorems. It implements a two-level architecture: a lemma DAG for dependency-ordered dispatch, and a goal e-graph for tactic-level search with transposition merging.

## Key Features

- **Tactic-level search**: LLM proposes one tactic per call, backend applies it, subgoals are searched recursively
- **Goal e-graph**: Equivalence classes of goals with shared statistics enable efficient transposition merging
- **REPL integration**: Direct interaction with Lean 4 kernel via `leanprover-community/repl`
- **Causal telemetry**: Every event (tactic proposal, application, goal solving) is traced with parent links
- **Guardrails enforcement**: Statement pinning prevents weakening, kernel verification ensures correctness
- **Checkpoint/resume**: Long-running proofs can be interrupted and resumed from any verified lemma
- **Repair loops**: Failed tactics trigger error-driven repair attempts before giving up

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

**Level 2 (Tactic Loop)**: For each lemma, extracts the root goal, proposes tactics via LLM, applies them via the REPL, and recursively solves subgoals until the root is solved.

## Installation

### Prerequisites

- **Node.js** ≥ 18.0
- **Lean 4** with elan (install via [elan](https://github.com/leanprover/elan))
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
#   KANFORGE_REPL_BIN=/path/to/repl/binary
#   KANFORGE_LEAN_TOOLCHAIN=leanprover/lean4:v4.33.0-rc1
#   KANFORGE_LLM_API_KEY=your-api-key
```

### Building the REPL

The REPL must be built for your specific Lean toolchain:

```bash
cd lean-project
lake build repl
# Binary will be at .lake/build/bin/repl
```

## Usage

### Running the Smoke Test

```bash
# Run all smoke problems
node bench/run.js

# Run specific problems
node bench/run.js trans_lt add_double nat_sub

# Run with checkpointing
node bench/run.js --checkpoint-dir=runs/my_run
```

### Running Tests

```bash
npm test
```

Test suite includes:
- **Architectural tests**: Verify backward decomposition, atomic operations, proof tree structure
- **Integration tests**: End-to-end loop with mock backend
- **Live REPL tests**: Real kernel interaction (requires REPL binary)
- **Unit tests**: Goal parsing, state serialization, guardrails, scheduler

### Example Output

```
===== SMOKE SET RESULTS =====
OK   t1 trans_lt       ms=13112 goals=1 families=[omega]
      proof: by |   omega
OK   t1 add_double     ms=13194 goals=1 families=[omega]
      proof: by |   omega
OK   t1 nat_sub        ms=13245 goals=1 families=[omega]
      proof: by |   omega

Solved: 3/3 (100.0%), families used: omega, tier>=2 solved: 0, wall: 13s
```

## Project Structure

```
kanforge/
├── agent/              # Tactic loop and LLM integration
│   ├── loop.js         # Main tactic-level search loop
│   ├── llm.js          # LLM client (OpenAI/Anthropic)
│   ├── prompts.js      # Tactic proposal prompts
│   └── repair.js       # Error-driven repair
├── core/               # Foundational primitives
│   ├── egraph.js       # Goal equivalence graph
│   ├── pullgraph.js    # Pull-based dependency graph
│   ├── scheduler.js    # Dependency-ordered dispatch
│   ├── state.js        # Proof tree ↔ script conversion
│   └── guardrails.js   # Invariant enforcement
├── lean/               # Lean 4 backend
│   ├── backendRepl.js  # REPL protocol implementation
│   ├── goalText.js     # Goal string parsing
│   └── pin.js          # Statement pinning
├── optimization/       # Telemetry and metrics
│   ├── bus.js          # Event bus
│   ├── store.js        # Causal event store
│   └── metrics.js      # Performance metrics
├── bench/              # Benchmarking
│   ├── run.js          # Smoke test runner
│   └── smoke.js        # Problem definitions
├── test/               # Test suite
│   ├── architectural.test.js
│   ├── integration.test.js
│   └── live.repl.test.js
└── runs/               # Checkpoint and audit outputs
    └── run_<timestamp>/
        ├── checkpoint.json
        └── audit.json
```

## Current Capabilities

**Verified on real Lean 4 kernel:**
- ✅ Linear arithmetic (omega tactic)
- ✅ Propositional logic (intro, exact, constructor)
- ✅ Simple induction (induction, rfl, omega)
- ✅ Transposition merging (equivalent goals share statistics)
- ✅ Multi-lemma proofs with dependencies
- ✅ Checkpoint/resume for long-running proofs

**Smoke test results (20 problems):**
- Tier 1 (linear arithmetic): 7/7 solved
- Tier 2 (propositional logic): 4/4 solved
- Tier 3 (induction): 3/5 solved
- Tier 4 (harder): 1/4 solved
- **Overall: 15/20 (75%)**

## Design Principles

1. **Tactic-level search**: Each LLM call proposes ONE tactic for ONE goal. No monolithic proof generation.

2. **Kernel verification**: Every tactic application is checked by the Lean 4 kernel. No trusted LLM output.

3. **Transposition merging**: Equivalent goals (alpha-equivalent or definitionally equal) share statistics in the e-graph, avoiding redundant search.

4. **Causal telemetry**: Every event has a parent link, enabling reconstruction of the proof search trajectory.

5. **Guardrails enforcement**: Statement pins prevent weakening, forbidden tokens (sorry, admit, unsafe) are rejected.

6. **Resumability**: Each verified lemma is a checkpoint. Long proofs can be interrupted and resumed.

## Limitations

- **Core Lean only**: Current REPL has no Mathlib. Tactics like `ring`, `linarith`, `norm_num` are unavailable.
- **Single-tactic proposals**: LLM proposes one tactic at a time. No proof sketching or multi-step planning.
- **No premise retrieval**: Cannot automatically find relevant lemmas from Mathlib or user context.
- **Geometry weakness**: Synthetic geometry reasoning (angle chasing, cyclic quadrilaterals) is challenging.

## Roadmap

- [ ] **Mathlib integration**: Build REPL with Mathlib dependency
- [ ] **Best-of-n ranking**: Swiss tournament selection for proof attempts (+17% accuracy)
- [ ] **LLM-as-judge**: Train 8B model for tactic validation (90% accuracy)
- [ ] **Premise retrieval**: LeanDojo-style relevance scoring over Mathlib
- [ ] **Category-aware tactics**: Detect problem type (algebra, geometry, combinatorics) and adjust tactic libraries
- [ ] **Proof critic**: Auto-generate issue summaries to guide repair loops

## References

- **Architecture**: See `docs/architecture.md` for detailed system design
- **Build order**: See `docs/build_order.md` for phased implementation plan
- **Research notes**: See `docs/research_notes_2026.md` for state-of-the-art analysis

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Citation

If you use KanForge in your research, please cite:

```bibtex
@software{kanforge2026,
  title = {KanForge: Tactic-level Automated Theorem Prover for Lean 4},
  author = {J0pari},
  year = {2026},
  url = {https://github.com/J0pari/KanForge}
}
```

## Acknowledgments

- **leanprover-community/repl**: Lean 4 REPL for kernel interaction
- **Open Proof Corpus**: Research on LLM proof generation and best-of-n strategies
- **AlphaProof, Goedel-Prover, Seed-Prover**: Inspiration for tactic-level search and RL approaches
