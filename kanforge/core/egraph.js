// Goal e-graph for Level 2 search (architecture.md §2.2).
//
// The e-graph structure enables transposition merging: different tactic sequences that produce
// equivalent goals share a single equivalence class with shared statistics. This is what makes
// search efficient — all search variants automatically benefit from transposition merging.
//
// Each equivalence class contains:
// - id: hash of normalized goal (alpha-equivalent, definitionally-equal goals map to same id)
// - goals: array of concrete goals in the class (for debugging/extraction)
// - tactics: tactics applied to this class, producing subgoal classes
// - stats: shared visit counts, success rates, value estimates
// - parents: parent equivalence classes (multiple paths can reach same goal)

export class GoalEGraph {
    constructor() {
        this.classes = new Map(); // id -> equivalence class
        this.rootId = null;
        this.frontier = []; // ordered open class ids (repl proof-state order, head first)
    }

    normalizeGoal(goal) {
        const { type, context = [] } = goal;
        const varMap = new Map();
        let varCounter = 0;
        
        const renameVar = (name) => {
            if (!varMap.has(name)) {
                varMap.set(name, `v${varCounter++}`);
            }
            return varMap.get(name);
        };
        
        const normalizedContext = context.map(({ name, type: varType }) => ({
            name: renameVar(name),
            type: varType
        }));
        
        let normalizedType = type;
        for (const [original, canonical] of varMap) {
            normalizedType = normalizedType.replace(new RegExp(`\\b${original}\\b`, 'g'), canonical);
        }
        
        return {
            type: normalizedType,
            context: normalizedContext
        };
    }

    hashGoal(normalizedGoal) {
        const { type, context = [] } = normalizedGoal;
        const contextStr = context.map(c => `${c.name}:${c.type}`).join(',');
        const goalStr = `${type}|${contextStr}`;
        
        let hash = 0;
        for (let i = 0; i < goalStr.length; i++) {
            const char = goalStr.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return `goal_${Math.abs(hash).toString(16)}`;
    }

    addGoal(goal, parentId = null) {
        const normalized = this.normalizeGoal(goal);
        const id = this.hashGoal(normalized);
        
        if (this.classes.has(id)) {
            const existingClass = this.classes.get(id);
            existingClass.goals.push(goal);
            if (parentId && !existingClass.parents.includes(parentId)) {
                existingClass.parents.push(parentId);
            }
            return id;
        } else {
            this.classes.set(id, {
                id,
                goals: [goal],
                tactics: [],
                stats: { visits: 0, successes: 0, value: 0.0 },
                parents: parentId ? [parentId] : [],
                state: 'OPEN'
            });
            return id;
        }
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
            const id = this.hashGoal(this.normalizeGoal(g));
            if (frontierIds.has(id)) {
                this.classes.get(id)?.goals.push(g);
                carriedOver.push(id);
                newFrontier.push(id);
            } else {
                const childId = this.addGoal(g, goalClassId);
                created.push(g);
                subgoalClasses.push(childId);
                newFrontier.push(childId);
            }
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

    markFailed(goalClassId) {
        const goalClass = this.classes.get(goalClassId);
        if (goalClass) {
            goalClass.state = 'FAILED';
        }
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

    isSolved(classId) {
        const goalClass = this.classes.get(classId);
        if (!goalClass) return false;
        if (goalClass.state === 'SOLVED') return true;

        for (const tactic of goalClass.tactics) {
            if (tactic.solved) {
                goalClass.state = 'SOLVED';
                return true;
            }
            if (tactic.subgoalClasses.length > 0 && tactic.subgoalClasses.every(subId => this.isSolved(subId))) {
                goalClass.state = 'SOLVED';
                return true;
            }
        }
        return false;
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
            rootId: this.rootId,
            frontier: this.frontier,
            classes: Array.from(this.classes.entries())
        };
    }

    static deserialize(data) {
        const egraph = new GoalEGraph();
        egraph.rootId = data.rootId;
        egraph.frontier = data.frontier ?? [];
        egraph.classes = new Map(data.classes);
        // Old checkpoints predate the explicit `solved` flag; a record with no subgoals
        // then meant the tactic closed the goal.
        for (const [, gc] of egraph.classes) {
            for (const t of gc.tactics ?? []) {
                if (t.solved === undefined) t.solved = t.subgoalClasses.length === 0;
            }
        }
        return egraph;
    }
}
