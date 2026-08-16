// Goal transposition graph for Level 2 search (architecture.md §2.2).
//
// A GOAL-STATE TRANSPOSITION GRAPH, not an equality-saturation e-graph: classes merge only on
// identical normalized goal text (syntactic identity — alpha-renaming + whitespace), there are
// no e-nodes, no congruence closure, and no rewrite saturation. The genuine e-graph structure
// (core/egraph.js, staged) is a separate subsystem; ablation compares them at equal budget.
//
// The transposition merging enables shared statistics: different tactic sequences that produce
// the same normalized goal share a single class with shared stats — all search variants benefit.
//
// Class identity is COLLISION-SAFE (architecture.md §2.2, build_order.md §5.10): the id is
// sha256(canonicalKey), where canonicalKey is the deterministically-serialized normalized goal.
// The canonical key is the equality authority, stored on the class; the hash is a lookup index
// over it, never the identity itself. On an id hit the canonical keys are compared — unequal keys
// mean a hash collision, and the goals are NOT merged (separate class, collision-resolved id,
// transposition_collision telemetry). A weak 32-bit hash as identity would merge unrelated proof states.
//
// Each equivalence class contains:
// - id: sha256 of canonical key (alpha-equivalent goals map to same id)
// - canonicalKey: the serialized normalized goal — the equality authority
// - goals: array of concrete goals in the class (for debugging/extraction)
// - tactics: tactics applied to this class, producing subgoal classes
// - stats: shared visit counts, success rates, value estimates
// - parents: parent equivalence classes (multiple paths can reach same goal)

import crypto from 'node:crypto';

// Goal-type canonicalization (architecture.md §2.2). CLASS IDENTITY IS SYNTACTIC ONLY:
// whitespace-collapsed text under alpha-renaming. No algebraic simplification belongs in
// identity — merging `0 + x = y` with `x = y` assumes mathematical equivalence, but the two
// proof states are not interchangeable (a tactic that solves one need not solve the other), and
// a wrong merge corrupts solved-state propagation and shared statistics. Semantic (algebraic)
// normalization exists only as `semanticNormalize`, for retrieval similarity where the kernel
// re-verifies every reuse — never for class identity.
export function lexicalNormalize(type) {
    return String(type ?? '').trim().replace(/\s+/g, ' ').trim();
}

// Pure goal normalization (module-level): alpha-renaming of the context telescope + target
// under ONE substitution map, capture-avoiding. Shared by the graph class and the campaign
// goal memory (core/goalMemory.js) so cross-lemma memory keys match the incumbent structure's
// class identity exactly — a memory key IS the transposition canonical key.
export function normalizeGoalPure(type, context = [], normalizer = lexicalNormalize) {
    const varMap = new Map();
    let varCounter = 0;
    const usedNames = new Set(context.map(c => c.name));
    const fresh = () => {
        let n;
        do { n = `v${varCounter++}`; } while (usedNames.has(n));
        return n;
    };
    const renameVar = (name) => {
        if (!varMap.has(name)) varMap.set(name, fresh());
        return varMap.get(name);
    };
    for (const { name } of context) renameVar(name);
    const substitute = (text) => {
        let out = String(text);
        for (const [original, canonical] of varMap) {
            out = out.replace(new RegExp(`\\b${original}\\b`, 'g'), canonical);
        }
        return out;
    };
    return {
        type: normalizer(substitute(type)),
        context: context.map(({ name, type: varType }) => ({
            name: varMap.get(name) ?? name,
            type: substitute(varType)
        }))
    };
}

// Deterministic serialization of the normalized goal → the canonical key (equality authority).
export function canonicalKeyOf(normalizedGoal) {
    const { type, context = [] } = normalizedGoal;
    const contextStr = context.map(c => `${c.name}:${c.type}`).join(',');
    return `${type}|${contextStr}`;
}

// Canonical key straight from a concrete goal — the campaign-level identity of a goal shape.
// Uses the transposition graph's syntactic normalization (alpha-renaming + whitespace), the
// incumbent identity discipline. Retrieval consumers re-verify through the kernel, so a keying
// mismatch costs at most a wasted replay.
export function goalCanonicalKey(type, context = [], normalizer = lexicalNormalize) {
    return canonicalKeyOf(normalizeGoalPure(type, context, normalizer));
}

// Retrieval-only similarity form (lemmaStore §2.8): algebraic identities that make similar
// conclusions comparable for ranking. NOT used for class identity — the kernel re-verifies any
// lemma matched this way, and a retrieval mismatch costs at most a wasted attempt.
export function semanticNormalize(type) {
    let s = lexicalNormalize(type);
    s = s.replace(/\b0\s*\+\s*/g, '').replace(/\s*\+\s*\b0\b/g, '');
    s = s.replace(/\s*-\s*\b0\b/g, '');
    s = s.replace(/\b1\s*\*\s*/g, '').replace(/\s*\*\s*\b1\b/g, '');
    return s.replace(/\s+/g, ' ').trim();
}

export class GoalTranspositionGraph {
    // normalizer: optional `(goalType: string) => string` — applied before canonical-key
    // computation so mathematically-equivalent goals merge into one e-class. Cached per raw
    // input for zero repeat cost.
    constructor({ normalizer = null } = {}) {
        this.classes = new Map();
        this.rootId = null;
        this.frontier = [];
        this._normalizer = normalizer;
        this._normCache = new Map(); // rawType → normalizedType
    }

    _normalizeType(type) {
        if (!this._normalizer) return type;
        if (this._normCache.has(type)) return this._normCache.get(type);
        const norm = this._normalizer(type) ?? type;
        this._normCache.set(type, norm);
        return norm;
    }

    normalizeGoal(goal) {
        const { type, context = [] } = goal;
        return normalizeGoalPure(type, context, this._normalizeType.bind(this));
    }

    // Deterministic serialization of the normalized goal → the canonical key (equality authority).
    canonicalKey(normalizedGoal) {
        return canonicalKeyOf(normalizedGoal);
    }

    // SHA-256 of the canonical key — a lookup index over the key, not the identity itself.
    hashGoal(normalizedGoal) {
        return `goal_${crypto.createHash('sha256').update(this.canonicalKey(normalizedGoal)).digest('hex').slice(0, 16)}`;
    }

    // Collision-resolved id: when two DIFFERENT canonical keys land on the same id, the second is
    // re-keyed deterministically so both classes coexist without merging.
    collisionId(key) {
        return `goal_${crypto.createHash('sha256').update(`collision:${key}`).digest('hex').slice(0, 16)}`;
    }

    addGoal(goal, parentId = null) {
        const normalized = this.normalizeGoal(goal);
        const key = this.canonicalKey(normalized);
        const id = this.hashGoal(normalized);

        if (this.classes.has(id)) {
            const existingClass = this.classes.get(id);
            if (existingClass.canonicalKey === key) {
                // Same canonical goal → same equivalence class (transposition merge).
                existingClass.goals.push(goal);
                if (parentId && !existingClass.parents.includes(parentId)) {
                    existingClass.parents.push(parentId);
                }
                return id;
            }
            // Hash collision: different canonical keys under the same id. Do NOT merge. The new
            // goal gets its own class under a collision-resolved id.
            this.collisions = (this.collisions ?? 0) + 1;
            return this._addCollisionClass(goal, normalized, key, parentId);
        } else {
            this.classes.set(id, {
                id,
                canonicalKey: key,
                goals: [goal],
                tactics: [],
                stats: { visits: 0, successes: 0, value: 0.0 },
                parents: parentId ? [parentId] : [],
                depth: parentId ? (this.classes.get(parentId)?.depth ?? 0) + 1 : 0,
                state: 'OPEN'
            });
            return id;
        }
    }

    _addCollisionClass(goal, normalized, key, parentId) {
        // Ensure the collision-resolved id is itself free (a second collision on the same pair
        // would land on the same resolved id; append a counter until free).
        let cid = this.collisionId(key);
        let n = 2;
        while (this.classes.has(cid) && this.classes.get(cid).canonicalKey !== key) {
            cid = `goal_${crypto.createHash('sha256').update(`collision${n}:${key}`).digest('hex').slice(0, 16)}`;
            n++;
        }
        if (!this.classes.has(cid)) {
            this.classes.set(cid, {
                id: cid,
                canonicalKey: key,
                goals: [goal],
                tactics: [],
                stats: { visits: 0, successes: 0, value: 0.0 },
                parents: parentId ? [parentId] : [],
                depth: parentId ? (this.classes.get(parentId)?.depth ?? 0) + 1 : 0,
                state: 'OPEN'
            });
        }
        return cid;
    }

    // GoalStateGraph contract: direct class accessor (search recipes read parents/classes
    // through this, never through the raw field — the egraph future keeps the field private).
    getClass(classId) {
        return this.classes.get(classId) ?? null;
    }

    setRoot(goal) {
        const id = this.addGoal(goal);
        this.rootId = id;
        this.frontier = [id];
        return id;
    }

    // Apply a tactic to a goal class. The repl tactic API reports the FULL remaining
    // frontier after a tactic, not only the subgoals the tactic created — so this must
    // distinguish carried-over siblings (goals already open in the frontier) from
    // genuinely-new children. Only new children are attached under the tactic; carried
    // siblings stay on the frontier with their concrete instance refreshed (the repl
    // re-reports every open goal under the advanced proofState). The new frontier is the
    // returned goal sequence in order, which is exactly the order the repl will attack next.
    applyTactic(goalClassId, tactic, subgoals = []) {
        const goalClass = this.classes.get(goalClassId);
        if (!goalClass) {
            throw new Error(`Goal class ${goalClassId} not found`);
        }

        const frontierIds = this.frontier.length > 0 ? new Set(this.frontier) : new Set([goalClassId]);

        const created = [];
        const subgoalClasses = [];
        const carriedOver = [];
        const newFrontier = [];

        for (const g of subgoals) {
            // Carried-over siblings are NOT children of this tactic — a false parent edge would
            // corrupt MCGS backprop (reward would flow to sibling goals across unrelated
            // branches). Compute identity first: a carried-over class refreshes its concrete
            // instance only; a genuine child is added WITH the parent link, so MCGS._backprop
            // walks real ancestry (transposition merges push the parent into the existing
            // class's parents[]).
            const normalized = this.normalizeGoal(g);
            const key = this.canonicalKey(normalized);
            const id = this.hashGoal(normalized);
            const existing = this.classes.get(id);
            if (frontierIds.has(id) && existing?.canonicalKey === key) {
                existing.goals.push(g);
                carriedOver.push(id);
                newFrontier.push(id);
                continue;
            }
            const childId = this.addGoal(g, goalClassId);
            created.push(g);
            subgoalClasses.push(childId);
            newFrontier.push(childId);
        }

        const tacticRecord = {
            tactic,
            subgoalClasses,
            carriedOver,
            created,
            solved: subgoals.length === 0 || (subgoalClasses.length === 0 && !newFrontier.includes(goalClassId)),
            timestamp: Date.now()
        };

        goalClass.tactics.push(tacticRecord);
        goalClass.stats.visits++;

        if (tacticRecord.solved) {
            goalClass.state = 'SOLVED';
            goalClass.stats.successes++;
        }

        this.frontier = newFrontier;

        return tacticRecord;
    }

    // The patch algebra interface (architecture.md §0.3, Research doc §4): a `tactic` patch
    // carries the goal class, the tactic text, and the subgoal results from the kernel call.
    // applyPatch is the single mutation entry point — the graph never sees raw (classId, tactic,
    // subgoals) tuples directly; the Patch is the typed record.
    applyPatch(patch) {
        if (patch.op !== 'tactic') throw new Error(`GoalTranspositionGraph.applyPatch: unsupported op '${patch.op}'`);
        const subgoals = patch.meta?.newGoals ?? [];
        return this.applyTactic(patch.node, patch.replacement, subgoals);
    }

    markFailed(goalClassId) {
        const goalClass = this.classes.get(goalClassId);
        if (goalClass) {
            goalClass.state = 'FAILED';
        }
    }

    // Whole-script channel (contract): a multi-line repair writes the direct proof here; the
    // commit gate reads it instead of extracting a tree. `_directProof` is the storage field
    // behind the accessors — callers use the methods, never the field.
    getDirectProof(goalClassId) {
        return this.classes.get(goalClassId)?._directProof ?? null;
    }

    setDirectProof(goalClassId, proof) {
        const goalClass = this.classes.get(goalClassId);
        if (goalClass) goalClass._directProof = proof;
    }

    // Reuse-prelude channel (§2.8): a kernel-verified ASSEMBLED source (imports + inlined
    // closure declarations + target) the reuse engine wrote. The commit gate verifies THIS
    // source instead of re-assembling statement+script — the script alone cannot reference
    // the inlined declarations, which is exactly the KERNEL_REJECTED class the by-name reuse
    // paths produced at commit. Optional capability; set by the reuse engine only after the
    // kernel verified the source fresh.
    getDirectSource(goalClassId) {
        return this.classes.get(goalClassId)?._directSource ?? null;
    }

    setDirectSource(goalClassId, source) {
        const goalClass = this.classes.get(goalClassId);
        if (goalClass) goalClass._directSource = source;
    }

    // The operative concrete goal of a class: the FRESHEST instance. The repl tactic API
    // applies a tactic to the first goal of a proofState, and every tactic application
    // re-reports the remaining frontier under a new proofState — so earlier concrete
    // instances in goals[] may carry stale proofStates after a merge, while the last one
    // always belongs to the latest state. The loop must attack classes in frontier order
    // (getOpenGoals returns the frontier, head first) and always use this instance.
    currentGoal(goalClassId) {
        const goalClass = this.classes.get(goalClassId);
        return goalClass?.goals?.at(-1) ?? null;
    }

    getOpenGoals() {
        if (this.frontier.length === 0) {
            return Array.from(this.classes.values())
                .filter(gc => gc.state === 'OPEN' && gc.tactics.length === 0 && !this.isSolved(gc.id));
        }
        return this.frontier
            .map(id => this.classes.get(id))
            .filter(gc => gc && gc.state === 'OPEN' && gc.tactics.length === 0 && !this.isSolved(gc.id));
    }

    isSolved(classId, path = null) {
        const goalClass = this.classes.get(classId);
        if (!goalClass) return false;
        if (goalClass.state === 'SOLVED') return true;

        // Cycle guard: a tactic's subgoal may hash back to an ancestor class (e.g. applying
        // `rw [Nat.mul_comm]` twice on the same goal), which would otherwise recurse forever.
        // A class on the current resolution path is treated as not-yet-solved; the DAG-diamond
        // (shared subgoal under two parents) case is unaffected since each branch checks the
        // path independently.
        const pathSet = path ?? new Set();
        if (pathSet.has(classId)) return false;
        pathSet.add(classId);
        try {
            for (const tactic of goalClass.tactics) {
                if (tactic.solved) {
                    goalClass.state = 'SOLVED';
                    return true;
                }
                if (tactic.subgoalClasses.length > 0 && tactic.subgoalClasses.every(subId => this.isSolved(subId, pathSet))) {
                    goalClass.state = 'SOLVED';
                    return true;
                }
            }
            return false;
        } finally {
            pathSet.delete(classId);
        }
    }

    isRootSolved() {
        if (!this.rootId) return false;
        return this.isSolved(this.rootId);
    }

    isFullySolved() {
        return Array.from(this.classes.values())
            .every(gc => this.isSolved(gc.id));
    }

    extractProof() {
        if (!this.isRootSolved()) {
            return null;
        }

        const extractFrom = (classId) => {
            const path = new Set();
            const rec = (cid) => {
                if (path.has(cid)) return null; // cycle guard (path-local: shared classes recur per occurrence)
                path.add(cid);
                const goalClass = this.classes.get(cid);
                if (!goalClass || goalClass.tactics.length === 0) {
                    path.delete(cid);
                    return null;
                }

                const successfulTactic = goalClass.tactics.find(t =>
                    t.solved || (t.subgoalClasses.length > 0 && t.subgoalClasses.every(subId => this.isSolved(subId)))
                );

                if (!successfulTactic) {
                    path.delete(cid);
                    return null;
                }

                const subproofs = successfulTactic.subgoalClasses.map(rec).filter(sp => sp !== null);
                path.delete(cid);

                return {
                    tactic: successfulTactic.tactic,
                    subproofs
                };
            };
            return rec(classId);
        };

        return extractFrom(this.rootId);
    }

    getStats(classId) {
        const goalClass = this.classes.get(classId);
        return goalClass ? goalClass.stats : null;
    }

    updateValue(classId, value) {
        const goalClass = this.classes.get(classId);
        if (goalClass) {
            goalClass.stats.value = value;
        }
    }

    serialize() {
        return {
            structure: 'transposition',
            rootId: this.rootId,
            frontier: this.frontier,
            classes: Array.from(this.classes.entries())
        };
    }

    static deserialize(data, { normalizer = null } = {}) {
        const graph = new GoalTranspositionGraph({ normalizer });
        graph.rootId = data.rootId;
        graph.frontier = data.frontier ?? [];
        graph.classes = new Map(data.classes);
        // Old checkpoints predate the explicit `solved` flag; a record with no subgoals
        // then meant the tactic closed the goal.
        for (const [, gc] of graph.classes) {
            for (const t of gc.tactics ?? []) {
                if (t.solved === undefined) t.solved = t.subgoalClasses.length === 0;
            }
        }
        return graph;
    }
}
