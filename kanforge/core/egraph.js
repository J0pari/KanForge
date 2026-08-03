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
        return id;
    }

    applyTactic(goalClassId, tactic, subgoals = []) {
        const goalClass = this.classes.get(goalClassId);
        if (!goalClass) {
            throw new Error(`Goal class ${goalClassId} not found`);
        }

        const subgoalClassIds = subgoals.map(subgoal => 
            this.addGoal(subgoal, goalClassId)
        );

        const tacticRecord = {
            tactic,
            subgoalClasses: subgoalClassIds,
            timestamp: Date.now()
        };

        goalClass.tactics.push(tacticRecord);
        goalClass.stats.visits++;

        if (subgoals.length === 0) {
            goalClass.state = 'SOLVED';
            goalClass.stats.successes++;
        }

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
    // (getOpenGoals returns creation order) and always use this instance.
    currentGoal(goalClassId) {
        const goalClass = this.classes.get(goalClassId);
        return goalClass?.goals?.at(-1) ?? null;
    }

    getOpenGoals() {
        return Array.from(this.classes.values())
            .filter(gc => gc.state === 'OPEN' && gc.tactics.length === 0 && !this.isSolved(gc.id));
    }

    isSolved(classId) {
        const goalClass = this.classes.get(classId);
        if (!goalClass) return false;
        if (goalClass.state === 'SOLVED') return true;

        for (const tactic of goalClass.tactics) {
            if (tactic.subgoalClasses.length === 0) {
                goalClass.state = 'SOLVED';
                return true;
            }
            const allSubgoalsSolved = tactic.subgoalClasses.every(subId => this.isSolved(subId));
            if (allSubgoalsSolved) {
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
            const goalClass = this.classes.get(classId);
            if (!goalClass || goalClass.tactics.length === 0) {
                return null;
            }

            const successfulTactic = goalClass.tactics.find(t => 
                t.subgoalClasses.length === 0 || t.subgoalClasses.every(subId => this.isSolved(subId))
            );

            if (!successfulTactic) return null;

            const subproofs = successfulTactic.subgoalClasses.map(extractFrom);

            return {
                tactic: successfulTactic.tactic,
                subproofs: subproofs.filter(sp => sp !== null)
            };
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
            classes: Array.from(this.classes.entries())
        };
    }

    static deserialize(data) {
        const egraph = new GoalEGraph();
        egraph.rootId = data.rootId;
        egraph.classes = new Map(data.classes);
        return egraph;
    }
}
