// Genuine equality-saturation e-graph for Level 2 search (architecture.md §2.2, build_order.md
// §5.12). Unlike the transposition graph (syntactic identity over goal text), this structure
// reasons over the TERM STRUCTURE of goal types:
//
//   - e-nodes: interned term nodes { sym, children: eclassIds[] } (hashconsed)
//   - e-classes: union-find sets of equivalent e-nodes
//   - congruence closure: same sym + equal child classes → same class (pure structure, sound by
//     construction — no kernel involvement)
//   - rebuild: on a union, parent enodes whose child class moved are re-keyed; re-collisions
//     union the parents transitively
//   - rewrite rules: algebraic identities (x+0→x, …). A rule fire is ONLY a candidate — the
//     union is performed after the kernel oracle confirms the instantiated equality is
//     definitional (lean/defEqOracle.js). Unconfirmed unions never happen: the e-graph cannot
//     merge goals that are not actually equal under Lean's definitional equality.
//
// Goal plumbing: a goal class = (type eclass, alpha-normalized context signature). Goals merge
// iff their type classes and context signatures are equal. The class retains ALL successful
// tactic expansions (alternative branches are first-class records, not discarded), implements
// the GoalStateGraph contract (core/goalStateGraph.js), and serializes confirmed unions as
// recorded evidence so deserialization never re-queries the kernel.

import crypto from 'node:crypto';
import { parseGoalType, termToText } from '../lean/termParse.js';

// ---- alpha-normalization (binder names → capture-avoiding vN) -------------------------------

function alphaNormalizeTerm(term, scope = new Map(), fresh = null) {
    if (!term) return null;
    if (fresh === null) fresh = { n: 0, used: new Set(collectNames(term)) };
    switch (term.kind) {
        case 'const': {
            const mapped = scope.get(term.name);
            return mapped ? { kind: 'const', name: mapped } : term;
        }
        case 'num': return term;
        case 'opaque': return term; // opaque leaves keep their text; no structure to rename
        case 'implicit': return { kind: 'implicit', term: alphaNormalizeTerm(term.term, scope, fresh) };
        case 'instance': return { kind: 'instance', term: alphaNormalizeTerm(term.term, scope, fresh) };
        case 'arrow': return {
            kind: 'arrow',
            domain: alphaNormalizeTerm(term.domain, scope, fresh),
            body: alphaNormalizeTerm(term.body, scope, fresh)
        };
        case 'forall':
        case 'exists': {
            const inner = new Map(scope);
            const binders = term.binders.map(b => {
                const bType = alphaNormalizeTerm(b.type, inner, fresh);
                if (b.name != null) {
                    let name;
                    do { name = `v${fresh.n++}`; } while (fresh.used.has(name));
                    inner.set(b.name, name);
                    return { name, type: bType, pred: b.pred ?? null };
                }
                return { name: null, type: bType, pred: b.pred ?? null };
            });
            return { kind: term.kind, binders, body: alphaNormalizeTerm(term.body, inner, fresh) };
        }
        case 'binderGroup': {
            const inner = new Map(scope);
            const binders = term.binders.map(b => {
                const bType = alphaNormalizeTerm(b.type, inner, fresh);
                if (b.name != null) {
                    let name;
                    do { name = `v${fresh.n++}`; } while (fresh.used.has(name));
                    inner.set(b.name, name);
                    return { name, type: bType, pred: b.pred ?? null };
                }
                return { name: null, type: bType, pred: b.pred ?? null };
            });
            return { kind: 'binderGroup', binders };
        }
        case 'app': return {
            kind: 'app',
            fn: alphaNormalizeTerm(term.fn, scope, fresh),
            args: term.args.map(a => alphaNormalizeTerm(a, scope, fresh))
        };
        default: return null;
    }
}

function collectNames(term, out = new Set()) {
    if (!term) return out;
    switch (term.kind) {
        case 'const': out.add(term.name); break;
        case 'app': collectNames(term.fn, out); term.args.forEach(a => collectNames(a, out)); break;
        case 'arrow': collectNames(term.domain, out); collectNames(term.body, out); break;
        case 'forall': case 'exists': case 'binderGroup':
            term.binders.forEach(b => collectNames(b.type, out));
            collectNames(term.body, out);
            break;
        case 'implicit': case 'instance': collectNames(term.term, out); break;
    }
    return out;
}

// Alpha-normalize a goal: context telescope names → v0.. in position order, applied to the
// context types AND the target type under one map (same discipline as the transposition graph).
function alphaNormalizeGoal(goal) {
    const type = parseGoalType(goal.type);
    if (type === null) return null;
    const context = goal.context ?? [];
    const scope = new Map();
    const fresh = { n: 0, used: new Set(context.map(c => c.name)) };
    const normContext = context.map((c, i) => {
        const name = `v${i}`;
        scope.set(c.name, name);
        const t = parseGoalType(c.type);
        return { name, type: t, raw: c };
    });
    return {
        type,
        context: normContext,
        scope,
        fresh
    };
}

// ---- term → e-node interning ----------------------------------------------------------------

function enodeKey(sym, childIds) {
    return `${sym}|${childIds.join(',')}`;
}

function symOfTerm(term) {
    switch (term.kind) {
        case 'const': return `const:${term.name}`;
        case 'num': return `num:${term.value}`;
        case 'opaque': return `opaque:${String(term.text).trim().replace(/\s+/g, ' ')}`;
        case 'app': return 'app';
        case 'arrow': return 'arrow';
        case 'forall': return 'forall';
        case 'exists': return 'exists';
        case 'implicit': return 'implicit';
        case 'instance': return 'instance';
        case 'binderGroup': return 'binderGroup';
        default: return `opaque:${String(term?.text ?? '').trim()}`;
    }
}

function childTerms(term) {
    switch (term.kind) {
        case 'app': return [term.fn, ...term.args];
        case 'arrow': return [term.domain, term.body];
        case 'forall': case 'exists': case 'binderGroup':
            return [...term.binders.map(b => b.type ?? { kind: 'opaque', text: '' }), term.body];
        case 'implicit': case 'instance': return [term.term];
        default: return [];
    }
}

// ---- rewrite rules --------------------------------------------------------------------------

// A rule: { name, lhs: '<pattern text with ?holes>', rhs: '<replacement text>' }. Holes are
// consts named ?x. A fire builds the RHS instance and returns the candidate pair; the union
// itself is gated on the kernel oracle (confirmDefEq).
export const DEFAULT_EGRAPH_RULES = Object.freeze([
    { name: 'add_zero_right', lhs: '?x + 0', rhs: '?x' },
    { name: 'add_zero_left', lhs: '0 + ?x', rhs: '?x' },
    { name: 'sub_zero', lhs: '?x - 0', rhs: '?x' },
    { name: 'mul_one_right', lhs: '?x * 1', rhs: '?x' },
    { name: 'mul_one_left', lhs: '1 * ?x', rhs: '?x' }
]);

function compileRule(rule) {
    const pattern = parseGoalType(rule.lhs);
    const replacement = parseGoalType(rule.rhs);
    if (!pattern || !replacement) return null; // unparseable rule text: inert
    return { name: rule.name, pattern, replacement };
}

// Structural match of `pattern` against `term`; holes (?x consts) bind to the matched SUBTERM
// (first binding wins; later occurrences must match the same term by structural equality).
function matchTerm(pattern, term, bindings = new Map()) {
    if (!pattern || !term) return null;
    if (pattern.kind === 'const' && pattern.name.startsWith('?')) {
        const existing = bindings.get(pattern.name);
        if (existing) return JSON.stringify(existing) === JSON.stringify(term) ? bindings : null;
        bindings.set(pattern.name, term);
        return bindings;
    }
    if (pattern.kind !== term.kind) return null;
    switch (pattern.kind) {
        case 'const': return pattern.name === term.name ? bindings : null;
        case 'num': return pattern.value === term.value ? bindings : null;
        case 'opaque': return pattern.text === term.text ? bindings : null;
        case 'implicit': case 'instance':
            return matchTerm(pattern.term, term.term, bindings);
        case 'arrow':
            return matchTerm(pattern.domain, term.domain, bindings) &&
                matchTerm(pattern.body, term.body, bindings) ? bindings : null;
        case 'forall': case 'exists': case 'binderGroup': {
            if (pattern.binders.length !== term.binders.length) return null;
            for (let i = 0; i < pattern.binders.length; i++) {
                if (pattern.binders[i].pred !== term.binders[i].pred) return null;
                if (pattern.binders[i].name != null && term.binders[i].name != null &&
                    pattern.binders[i].name !== term.binders[i].name) return null;
                if (!matchTerm(pattern.binders[i].type, term.binders[i].type, bindings)) return null;
            }
            return matchTerm(pattern.body, term.body, bindings);
        }
        case 'app': {
            if (pattern.fn.kind !== term.fn.kind) return null;
            if (pattern.args.length !== term.args.length) return null;
            if (!matchTerm(pattern.fn, term.fn, bindings)) return null;
            for (let i = 0; i < pattern.args.length; i++) {
                if (!matchTerm(pattern.args[i], term.args[i], bindings)) return null;
            }
            return bindings;
        }
        default: return null;
    }
}

function instantiate(pattern, bindings) {
    if (!pattern) return null;
    if (pattern.kind === 'const' && pattern.name.startsWith('?')) {
        const bound = bindings.get(pattern.name);
        return bound ? JSON.parse(JSON.stringify(bound)) : null;
    }
    const clone = JSON.parse(JSON.stringify(pattern));
    switch (clone.kind) {
        case 'app':
            clone.fn = instantiate(clone.fn, bindings);
            clone.args = clone.args.map(a => instantiate(a, bindings));
            return clone;
        case 'arrow':
            clone.domain = instantiate(clone.domain, bindings);
            clone.body = instantiate(clone.body, bindings);
            return clone;
        case 'forall': case 'exists': case 'binderGroup':
            clone.binders = clone.binders.map(b => ({ ...b, type: instantiate(b.type, bindings) }));
            clone.body = instantiate(clone.body, bindings);
            return clone;
        case 'implicit': case 'instance':
            clone.term = instantiate(clone.term, bindings);
            return clone;
        default: return clone;
    }
}

// ---- the e-graph -----------------------------------------------------------------------------

export class GoalEGraph {
    constructor({ oracle = null, rules = DEFAULT_EGRAPH_RULES, onUnion = null } = {}) {
        this._nextEnode = 0;
        this._enodes = new Map();      // enodeId -> { id, sym, children: eclassId[] }
        this._hashcons = new Map();    // key -> enodeId
        this._uf = new Map();          // eclassId -> eclassId (union-find parent)
        this._classNodes = new Map();  // eclassId -> Set<enodeId>
        this._classTerms = new Map();  // eclassId -> representative term (for oracle text)
        this._classTexts = new Map();  // eclassId -> canonical text
        this._parents = new Map();     // eclassId -> Set<enodeId> (enodes referencing the class)
        this._confirmed = new Map();   // "minId|maxId" -> outcome (oracle memo)
        this._confirmedPairs = [];     // recorded unions [[lhsText, rhsText, reason]]
        this.oracle = oracle;          // { confirm(lhsText, rhsText, context) => Promise<bool> }
        this.onUnion = onUnion;        // (a, b, reason, confirmed) => void — provenance events
        this.rules = (rules ?? []).map(compileRule).filter(Boolean);
        this.unions = 0;
        this.ruleFires = 0;
        this.ruleRejections = 0;

        // Goal plumbing (GoalStateGraph contract, core/goalStateGraph.js)
        this.classes = new Map();      // goalClassId -> goal class
        this.rootId = null;
        this.frontier = [];
        this._nextGoal = 0;
    }

    // --- union-find / congruence machinery --------------------------------------------------

    find(id) {
        let root = id;
        while (this._uf.has(root) && this._uf.get(root) !== root) root = this._uf.get(root);
        let cur = id;
        while (this._uf.has(cur) && this._uf.get(cur) !== cur) {
            const next = this._uf.get(cur);
            this._uf.set(cur, root);
            cur = next;
        }
        return root;
    }

    _ensureClass(id) {
        if (!this._classNodes.has(id)) this._classNodes.set(id, new Set());
    }

    _unionRaw(a, b) {
        // Merge b into a (a becomes the representative); returns a.
        this._classNodes.get(a).forEach(n => this._classNodes.get(b).add(n));
        this._uf.set(b, a);
        const parents = this._parents.get(b) ?? new Set();
        const parentSet = this._parents.get(a) ?? new Set();
        for (const p of parents) parentSet.add(p);
        this._parents.set(a, parentSet);
        this._parents.delete(b);
        this._classNodes.delete(b);
        // Keep the SHORTER canonical text as the representative (stable oracle queries).
        const ta = this._classTexts.get(a) ?? '';
        const tb = this._classTexts.get(b) ?? '';
        if (tb.length && (tb.length < ta.length || !ta.length)) {
            this._classTexts.set(a, tb);
            const tbTerm = this._classTerms.get(b);
            if (tbTerm) this._classTerms.set(a, tbTerm);
        }
        this.unions++;
        return a;
    }

    union(a, b, { reason = 'congruence', confirmed = true } = {}) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return ra;
        this.onUnion?.(ra, rb, reason, confirmed);
        const rep = this._unionRaw(ra, rb);
        // Rebuild: enodes whose child class moved must be re-keyed (congruence closure).
        const queue = [...(this._parents.get(rep) ?? [])];
        const seen = new Set(queue);
        while (queue.length) {
            const enodeId = queue.shift();
            const node = this._enodes.get(enodeId);
            if (!node) continue;
            const newKey = enodeKey(node.sym, node.children.map(c => this.find(c)));
            const existing = this._hashcons.get(newKey);
            if (existing !== undefined && existing !== enodeId) {
                const e1 = this.find(enodeId);
                const e2 = this.find(existing);
                if (e1 !== e2) {
                    const rep2 = this._unionRaw(e1, e2);
                    for (const p of this._parents.get(rep2) ?? []) {
                        if (!seen.has(p)) { seen.add(p); queue.push(p); }
                    }
                }
            } else {
                this._hashcons.set(newKey, enodeId);
            }
        }
        // Goal classes hash over find() of their type e-classes; the union changed those.
        // Re-key so a fresh addGoal of the same content lands on the SAME class (identity
        // stability is part of the contract — the loop and recipes cache class ids).
        if (this.classes.size > 0) this._rekeyGoalClasses();
        return rep;
    }

    addEnode(sym, childTerms) {
        const childIds = childTerms.map(t => this.addTerm(t));
        const key = enodeKey(sym, childIds);
        if (this._hashcons.has(key)) return this._hashcons.get(key);
        const id = this._nextEnode++;
        this._enodes.set(id, { id, sym, children: childIds });
        this._hashcons.set(key, id);
        for (const c of childIds) {
            const cRoot = this.find(c);
            if (!this._parents.has(cRoot)) this._parents.set(cRoot, new Set());
            this._parents.get(cRoot).add(id);
        }
        if (!this._classNodes.has(id)) this._classNodes.set(id, new Set());
        this._classNodes.get(id).add(id);
        return id;
    }

    // Intern a term (alpha-normalized first); returns its eclassId.
    addTerm(term) {
        if (!term) return this.addEnode('opaque', []);
        const norm = alphaNormalizeTerm(term);
        if (!norm) return this.addEnode('opaque', []);
        const sym = symOfTerm(norm);
        if (sym.startsWith('opaque:') || sym.startsWith('const:') || sym.startsWith('num:')) {
            const id = this.addEnode(sym, []);
            if (!this._classTerms.has(this.find(id))) this._classTerms.set(this.find(id), norm);
            const text = termToText(norm) || sym;
            this._classTexts.set(this.find(id), text);
            return this.find(id);
        }
        const id = this.addEnode(sym, childTerms(norm));
        const root = this.find(id);
        if (!this._classTerms.has(root)) this._classTerms.set(root, norm);
        this._classTexts.set(root, termToText(norm) || sym);
        return root;
    }

    sameClass(a, b) {
        return this.find(a) === this.find(b);
    }

    classText(classId) {
        const root = this.find(classId);
        const term = this._classTerms.get(root);
        if (term) return termToText(term);
        return this._classTexts.get(root) ?? '';
    }

    // --- oracle-gated unions -----------------------------------------------------------------

    // Kernel-gated merge: union happens ONLY if the oracle confirms definitional equality of the
    // two class texts under the given context telescope. Returns true iff a union happened.
    async mergeIfConfirmed(a, b, { reason = 'oracle', context = [] } = {}) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return false;
        // Capture the pair texts BEFORE the union — post-union both classes share the merged
        // representative text and the recorded evidence would collapse to 'x = x'.
        const lhs = this.classText(ra);
        const rhs = this.classText(rb);
        if (!lhs || !rhs) return false;
        const memoKey = `${Math.min(ra, rb)}|${Math.max(ra, rb)}`;
        if (this._confirmed.has(memoKey)) {
            if (!this._confirmed.get(memoKey)) { this.ruleRejections++; return false; }
            this.union(ra, rb, { reason, confirmed: true });
            this._confirmedPairs.push([lhs, rhs, reason]);
            return true;
        }
        if (!this.oracle) { this.ruleRejections++; return false; } // no oracle: no unions (never unverified)
        const ok = await this.oracle.confirm(lhs, rhs, context);
        this._confirmed.set(memoKey, !!ok);
        if (!ok) { this.ruleRejections++; return false; }
        this.union(ra, rb, { reason, confirmed: true });
        this._confirmedPairs.push([lhs, rhs, reason]);
        return true;
    }

    // Match every rule against the given goal type class AND its subterms; each fire is a
    // candidate whose union is oracle-gated. Subterm unions propagate to the whole goal
    // automatically via congruence rebuild (e.g. confirming `x + 0 = x` unions the Eq parents
    // of `x + 0 = y` and `x = y` without any further rule work). `canonicalContext` is the
    // goal's alpha-normalized telescope [{ name: 'v0', type: '<text>' }, ...]. Returns the
    // number of unions performed.
    async saturateGoal(typeClassId, canonicalContext = []) {
        let unions = 0;
        const root = this.find(typeClassId);
        const term = this._classTerms.get(root);
        if (!term) return 0;
        const queue = [term];
        while (queue.length) {
            const t = queue.shift();
            const tClass = this.addTerm(t);
            for (const rule of this.rules) {
                const bindings = matchTerm(rule.pattern, t);
                if (!bindings) continue;
                const rhs = instantiate(rule.replacement, bindings);
                if (!rhs) continue;
                this.ruleFires++;
                const rhsClass = this.addTerm(rhs);
                const lhsText = termToText(t);
                const rhsText = termToText(rhs);
                if (!lhsText || !rhsText || lhsText === rhsText) continue;
                if (await this.mergeIfConfirmed(this.find(tClass), rhsClass, { reason: `rule:${rule.name}`, context: canonicalContext })) unions++;
            }
            for (const child of childTerms(t)) queue.push(child);
        }
        return unions;
    }

    // Saturate a GOAL class: match the rules against the goal's type class with the goal's own
    // canonical context. Returns the number of unions performed.
    async saturateGoalClass(goalClassId) {
        const gc = this.classes.get(goalClassId);
        if (!gc || gc.typeClass == null) return 0;
        return this.saturateGoal(gc.typeClass, gc.canonicalContext);
    }

    // --- goal plumbing (GoalStateGraph contract) ---------------------------------------------

    // Goal identity: (type eclass, context signature). The context telescope is alpha-normalized
    // positionally (v0..vn) with each binder type interned; two goals merge iff the type classes
    // and every signature type class are equal.
    _goalKey(goal) {
        const norm = alphaNormalizeGoal(goal);
        if (norm === null) {
            // Unparseable type: opaque identity over the normalized text (merge only with
            // identical opaque text — never structurally).
            const text = String(goal.type ?? '').trim().replace(/\s+/g, ' ');
            return { kind: 'opaque', text, ctx: JSON.stringify(goal.context ?? []) };
        }
        const typeClass = this.addTerm(norm.type);
        const signature = norm.context.map((c, i) => {
            const typeClassCtx = c.type ? this.addTerm(c.type) : null;
            return { name: `v${i}`, typeClass: typeClassCtx };
        });
        return { kind: 'term', typeClass, signature };
    }

    _canonicalGoalKey(key) {
        if (key.kind === 'opaque') return `opaque:${key.text}|${key.ctx}`;
        return `term:${this.find(key.typeClass)}|${key.signature.map(s => `${s.name}:${s.typeClass == null ? '?' : this.find(s.typeClass)}`).join(',')}`;
    }

    addGoal(goal, parentId = null) {
        const key = this._goalKey(goal);
        const canonical = this._canonicalGoalKey(key);
        const hash = `goal_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
        const existing = this.classes.get(hash);
        if (existing && existing.canonicalKey === canonical) {
            existing.goals.push(goal);
            if (parentId && !existing.parents.includes(parentId)) existing.parents.push(parentId);
            return hash;
        }
        if (existing) {
            // Canonical-key collision under the same hash: do NOT merge (same discipline as the
            // transposition graph); re-key deterministically.
            this.collisions = (this.collisions ?? 0) + 1;
            let n = 2;
            let cid = `goal_${crypto.createHash('sha256').update(`collision:${canonical}`).digest('hex').slice(0, 16)}`;
            while (this.classes.has(cid) && this.classes.get(cid).canonicalKey !== canonical) {
                cid = `goal_${crypto.createHash('sha256').update(`collision${n}:${canonical}`).digest('hex').slice(0, 16)}`;
                n++;
            }
            if (!this.classes.has(cid)) {
                this.classes.set(cid, this._newGoalClass(cid, canonical, goal, parentId, key));
            }
            return cid;
        }
        this.classes.set(hash, this._newGoalClass(hash, canonical, goal, parentId, key));
        return hash;
    }

    _newGoalClass(id, canonicalKey, goal, parentId, key) {
        // Canonical type text + context telescope (alpha-normalized names), used by the kernel
        // oracle: rule-fired unions are checked as `example (v0 : T0) … : (lhs) = (rhs) := by
        // rfl` with the canonical binders, so the texts the kernel sees match the terms.
        let typeText = '';
        let canonicalContext = [];
        if (key.kind === 'term') {
            const norm = alphaNormalizeGoal(goal);
            typeText = norm ? termToText(norm.type) : String(goal.type ?? '').trim();
            canonicalContext = norm
                ? norm.context.map(c => ({ name: c.name, type: c.type ? termToText(c.type) : '' }))
                : [];
        } else {
            typeText = String(goal.type ?? '').trim();
        }
        return {
            id,
            canonicalKey,
            typeClass: key.kind === 'term' ? key.typeClass : null,
            signature: key.kind === 'term' ? key.signature : [],
            typeText,
            canonicalContext,
            goals: [goal],
            tactics: [],
            stats: { visits: 0, successes: 0, value: 0.0 },
            parents: parentId ? [parentId] : [],
            depth: parentId ? (this.classes.get(parentId)?.depth ?? 0) + 1 : 0,
            state: 'OPEN'
        };
    }

    // GoalStateGraph contract: direct class accessor (same role as the transposition graph's —
    // search recipes read classes through this, never through the raw field).
    getClass(classId) {
        return this.classes.get(classId) ?? null;
    }

    setRoot(goal) {
        const id = this.addGoal(goal);
        this.rootId = id;
        this.frontier = [id];
        return id;
    }

    applyTactic(goalClassId, tactic, subgoals = []) {
        const goalClass = this.classes.get(goalClassId);
        if (!goalClass) throw new Error(`Goal class ${goalClassId} not found`);
        const frontierIds = this.frontier.length > 0 ? new Set(this.frontier) : new Set([goalClassId]);

        const created = [];
        const subgoalClasses = [];
        const carriedOver = [];
        const newFrontier = [];

        for (const g of subgoals) {
            const key = this._goalKey(g);
            const canonical = this._canonicalGoalKey(key);
            const hash = `goal_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
            const existing = this.classes.get(hash);
            if (frontierIds.has(hash) && existing?.canonicalKey === canonical) {
                existing.goals.push(g);
                carriedOver.push(hash);
                newFrontier.push(hash);
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
        // Alternative expansions are RETAINED: every successful application is a first-class
        // record on the class (extractProof picks a successful one; stats aggregate).
        goalClass.tactics.push(tacticRecord);
        goalClass.stats.visits++;
        if (tacticRecord.solved) {
            goalClass.state = 'SOLVED';
            goalClass.stats.successes++;
        }
        this.frontier = newFrontier;
        return tacticRecord;
    }

    applyPatch(patch) {
        if (patch.op !== 'tactic') throw new Error(`GoalEGraph.applyPatch: unsupported op '${patch.op}'`);
        return this.applyTactic(patch.node, patch.replacement, patch.meta?.newGoals ?? []);
    }

    markFailed(goalClassId) {
        const gc = this.classes.get(goalClassId);
        if (gc) gc.state = 'FAILED';
    }

    // Whole-script channel (contract): same semantics as the transposition graph — the
    // multi-line repair writes here, the commit gate reads here, via the contract methods.
    getDirectProof(goalClassId) {
        return this.classes.get(goalClassId)?._directProof ?? null;
    }

    setDirectProof(goalClassId, proof) {
        const gc = this.classes.get(goalClassId);
        if (gc) gc._directProof = proof;
    }

    currentGoal(goalClassId) {
        return this.classes.get(goalClassId)?.goals?.at(-1) ?? null;
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
        const gc = this.classes.get(classId);
        if (!gc) return false;
        if (gc.state === 'SOLVED') return true;
        const pathSet = path ?? new Set();
        if (pathSet.has(classId)) return false;
        pathSet.add(classId);
        try {
            for (const tactic of gc.tactics) {
                if (tactic.solved) { gc.state = 'SOLVED'; return true; }
                if (tactic.subgoalClasses.length > 0 && tactic.subgoalClasses.every(subId => this.isSolved(subId, pathSet))) {
                    gc.state = 'SOLVED';
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
        return Array.from(this.classes.values()).every(gc => this.isSolved(gc.id));
    }

    extractProof() {
        if (!this.isRootSolved()) return null;
        const extractFrom = (classId) => {
            const path = new Set();
            const rec = (cid) => {
                if (path.has(cid)) return null;
                path.add(cid);
                const gc = this.classes.get(cid);
                if (!gc || gc.tactics.length === 0) { path.delete(cid); return null; }
                const successful = gc.tactics.find(t =>
                    t.solved || (t.subgoalClasses.length > 0 && t.subgoalClasses.every(subId => this.isSolved(subId)))
                );
                if (!successful) { path.delete(cid); return null; }
                const subproofs = successful.subgoalClasses.map(rec).filter(sp => sp !== null);
                path.delete(cid);
                return { tactic: successful.tactic, subproofs };
            };
            return rec(classId);
        };
        return extractFrom(this.rootId);
    }

    getStats(classId) {
        return this.classes.get(classId)?.stats ?? null;
    }

    updateValue(classId, value) {
        const gc = this.classes.get(classId);
        if (gc) gc.stats.value = value;
    }

    serialize() {
        return {
            structure: 'egraph',
            rootId: this.rootId,
            frontier: this.frontier,
            classes: Array.from(this.classes.entries()),
            confirmedPairs: this._confirmedPairs.map(p => [...p])
        };
    }

    static deserialize(data, { oracle = null, rules = DEFAULT_EGRAPH_RULES } = {}) {
        const graph = new GoalEGraph({ oracle, rules });
        graph.rootId = data.rootId;
        graph.frontier = data.frontier ?? [];
        graph.classes = new Map(data.classes);
        for (const [, gc] of graph.classes) {
            for (const t of gc.tactics ?? []) {
                if (t.solved === undefined) t.solved = t.subgoalClasses.length === 0;
            }
        }
        // Rebuild the e-classes from the recorded goal terms (deterministic — no oracle calls).
        // Iterate SNAPSHOTS: addGoal mutates the class's goals[] (merge pushes the instance),
        // so iterating the live array would grow it forever.
        for (const gc of Array.from(graph.classes.values())) {
            for (const g of [...(gc.goals ?? [])]) {
                graph.addGoal(g);
            }
        }
        // Replay confirmed unions from recorded evidence (kernel-confirmed at run time; never
        // re-queried here).
        for (const [lhs, rhs, reason] of data.confirmedPairs ?? []) {
            graph._replayUnion(lhs, rhs, reason);
        }
        // Re-key the goal classes: the recorded classes were hashed BEFORE the unions were
        // replayed, so their canonical keys are stale. Recomputing them (and folding classes
        // that the unions made identical) makes deserialized identity match a live graph's.
        graph._rekeyGoalClasses();
        return graph;
    }

    _rekeyGoalClasses() {
        const old = new Map(this.classes);
        this.classes = new Map();
        const remap = new Map();
        for (const [, gc] of old) {
            const first = gc.goals?.[0];
            if (!first) continue;
            const key = this._goalKey(first);
            const canonical = this._canonicalGoalKey(key);
            const hash = `goal_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
            const existing = this.classes.get(hash);
            if (existing && existing.canonicalKey === canonical) {
                for (const g of gc.goals) existing.goals.push(g);
                for (const t of gc.tactics) existing.tactics.push(t);
                existing.stats.visits += gc.stats.visits;
                existing.stats.successes += gc.stats.successes;
                existing.stats.value += gc.stats.value;
                for (const p of gc.parents) if (!existing.parents.includes(p)) existing.parents.push(p);
                if (gc.state === 'SOLVED') existing.state = 'SOLVED';
                remap.set(gc.id, hash);
            } else {
                gc.canonicalKey = canonical;
                gc.typeClass = key.kind === 'term' ? key.typeClass : null;
                gc.signature = key.kind === 'term' ? key.signature : [];
                this.classes.set(hash, gc);
                remap.set(gc.id, hash);
            }
        }
        const mapId = id => remap.get(id) ?? id;
        this.rootId = mapId(this.rootId);
        this.frontier = this.frontier.map(mapId);
        for (const gc of this.classes.values()) {
            gc.parents = gc.parents.map(mapId);
            for (const t of gc.tactics) {
                t.subgoalClasses = t.subgoalClasses.map(mapId);
                t.carriedOver = t.carriedOver.map(mapId);
            }
        }
    }

    _rootForText(text) {
        for (const [id, t] of this._classTexts) {
            if (t === text) return this.find(id);
        }
        return null;
    }

    _replayUnion(lhsText, rhsText, reason) {
        const a = this._rootForText(lhsText);
        const b = this._rootForText(rhsText);
        if (a != null && b != null && a !== b) {
            this.union(a, b, { reason, confirmed: true });
        }
    }
}
