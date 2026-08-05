// Public API surface (architecture.md §1 module inventory).

// Agent loop
export { TacticLoop } from './agent/loop.js';
export { createLLM, loadLLMConfig, LLMClient, LLMError } from './agent/llm.js';
export { buildTacticPrompt } from './agent/prompts.js';
export { classifyError, buildRepairPrompt } from './agent/repair.js';
export { isGoalSolved, isLemmaProved } from './agent/solve.js';

// Lean backends
export { createBackend, LEAN_BACKEND_TYPES } from './lean/backend.js';
export { BackendRepl } from './lean/backendRepl.js';
export { BackendCli } from './lean/backendCli.js';
export { hashStatement, normalizeStatement, makePin, checkPin, NORM_VERSION } from './lean/pin.js';
export { parseGoalText, formatBinders, splitGoalBlocks } from './lean/goalText.js';

// Core
export { PullGraph } from './core/pullgraph.js';
export { Scheduler } from './core/scheduler.js';
export { GoalEGraph } from './core/egraph.js';
export { Guardrails, HARD_INVARIANTS, FORBIDDEN_TOKENS } from './core/guardrails.js';
export { straighten, unstraighten, assertRoundTrip, buildProofSource } from './core/state.js';
export { Patch, PATCH_OPS } from './core/patch.js';
export { Lazy } from './core/lazy.js';
export { Pipeline } from './core/pipeline.js';
export { Hasher, hashChainEntry, verifyHashChain } from './core/hasher.js';

// Search (premise retrieval, selection baselines)
export { PremiseRetriever, buildPremisePrompt, findPremiseLockViolations, premisesUsedIn, tokenize, extractIdentifiers } from './search/premises.js';
export { RepulsionSampler, computeRepulsionPenalty } from './search/repulsion.js';

// Optimization (telemetry / RL parameterization)
export { EventBus } from './optimization/bus.js';
export { EventStore } from './optimization/store.js';
export { computeMetrics } from './optimization/metrics.js';
export { computeReward, REWARDS } from './optimization/reward.js';

// Environment
export { loadEnv } from './env.js';
