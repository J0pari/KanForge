import Lake
open Lake DSL

package kanforge

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git"

-- Mathlib-enabled REPL (architecture.md §3, build_order.md P0.1): the repl is a dependency
-- of this project so `lake exe cache get && lake build repl` produces a repl binary whose
-- sessions can `import Mathlib` (premise retrieval, corpus targets). Pinned to the rev whose
-- lean-toolchain matches this project (v4.33.0-rc1). Until it is built, KANFORGE_REPL_BIN
-- keeps pointing at the standalone core-Lean repl used for the P0–P1 gate (bench/smoke.js).
require repl from git
  "https://github.com/leanprover-community/repl.git" @ "1d238373119fa7cdb72ed7c24f6723d135b5b5fc"

@[default_target]
lean_lib KanForge
