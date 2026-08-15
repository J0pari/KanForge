// GoalStateGraph contract (architecture.md §2.2): the common interface the tactic loop, the
// search recipes (bestofn/bfs/mcgs/swiss), the commit gate, and the verifier harnesses use for
// Level-2 search state. Two structures implement it:
//   - core/transpositionGraph.js — the goal-state TRANSPOSITION GRAPH (syntactic identity:
//     alpha-renamed, whitespace-collapsed text; merges only identical normalized goals)
//   - core/egraph.js — the genuine EQUALITY-SATURATION E-GRAPH (structural identity via
//     congruence closure over parsed terms, plus kernel-confirmed rewrite unions)
// The loop and the ablation harness depend on THIS contract, never on a concrete structure, so
// the search structure is an ablation-decided configuration (`searchStructure`), not a code
// dependency.

// Methods the loop and recipes call. A structure missing any of these fails loudly at wiring
// time (assertGoalStateGraph), never with a TypeError deep inside the loop.
export const GOAL_STATE_GRAPH_METHODS = Object.freeze([
    'addGoal',      // (goal, parentId?) -> classId
    'setRoot',      // (goal) -> rootClassId
    'applyTactic',  // (classId, tactic, subgoals) -> tacticRecord { tactic, subgoalClasses, carriedOver, created, solved }
    'applyPatch',   // (Patch({op:'tactic'})) -> tacticRecord
    'markFailed',   // (classId) -> void
    'currentGoal',  // (classId) -> freshest concrete goal instance (type/context/proofState)
    'getOpenGoals', // () -> open class objects in frontier order
    'isSolved',     // (classId) -> bool (terminating — cycle-guarded)
    'isRootSolved', // () -> bool
    'isFullySolved',// () -> bool
    'extractProof', // () -> proof tree | null (root to solved leaves)
    'getStats',     // (classId) -> { visits, successes, value } | null
    'updateValue',  // (classId, value) -> void
    'getDirectProof',  // (classId) -> proof string | null — the ad-hoc whole-script channel a
                       // multi-line repair writes; the commit gate reads it instead of extracting
    'setDirectProof',  // (classId, proof) -> void — writes the whole-script channel
    'serialize'     // () -> { rootId, frontier, classes } — resumable shape
]);

// OPTIONAL capabilities (structures may provide them; callers duck-type with typeof):
//   saturateGoalClass(classId) -> Promise<int> — the e-graph's kernel-confirmed rule
//     saturation; the transposition graph has none and simply omits the method. The
//     SearchEngine runs it opportunistically after tactic applications.
//   serialize()/deserialize must round-trip each structure's own state; the shapes share the
//     top-level fields but each structure serializes its identity data (canonical keys vs
//     confirmed-union evidence) independently.

// Static method every structure carries.
export const GOAL_STATE_GRAPH_STATIC_METHODS = Object.freeze(['deserialize']);

// Fields the loop and search recipes read directly. Documented here, not enforced.
//   classes: Map<classId, GoalClass>
//   rootId:  classId | null
//   frontier: classId[]
// GoalClass = { id, goals: [concreteGoal], tactics: [tacticRecord], stats, parents: [classId],
//   state: 'OPEN' | 'SOLVED' | 'FAILED' }
export const GOAL_STATE_GRAPH_FIELDS = Object.freeze(['classes', 'rootId', 'frontier']);

// Loud conformance check: the wiring point calls this once per structure; a missing contract
// method is a configuration error, reported with the structure label and the method name.
export function assertGoalStateGraph(instance, { label = 'goal-state structure' } = {}) {
    const missing = [];
    for (const m of GOAL_STATE_GRAPH_METHODS) {
        if (typeof instance?.[m] !== 'function') missing.push(m);
    }
    if (missing.length) {
        throw new Error(`${label} does not implement the GoalStateGraph contract; missing: ${missing.join(', ')}`);
    }
    return instance;
}
