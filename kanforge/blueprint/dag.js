// Blueprint DAG utilities (architecture.md §1, build_order.md §4.1/§4.2).
// A blueprint is { theorem, lemmas: [{ id, statement, deps, pinnedHash }] }:
// - id          content-address = hashStatement(statement)
// - statement   kernel-typechecked ':= by sorry' stub
// - deps        ids of lemmas this one depends on (dependency coverage + acyclicity audited)
// - pinnedHash  hashStatement(statement) — the drift check (blueprint/drift.js) re-hashes it
import { hashStatement } from '../lean/pin.js';

export function validateBlueprint(blueprint) {
    const errors = [];
    if (!blueprint || typeof blueprint !== 'object') {
        return { ok: false, errors: ['blueprint is not an object'] };
    }
    const { theorem, lemmas } = blueprint;
    if (typeof theorem !== 'string' || !theorem.trim()) {
        errors.push('theorem must be a non-empty statement string');
    }
    if (!Array.isArray(lemmas) || lemmas.length === 0) {
        errors.push('lemmas must be a non-empty array');
    }

    const ids = new Set();
    const byId = new Map();
    if (Array.isArray(lemmas)) {
        for (let i = 0; i < lemmas.length; i++) {
            const l = lemmas[i];
            const at = `lemmas[${i}]`;
            if (!l || typeof l !== 'object') {
                errors.push(`${at} is not an object`);
                continue;
            }
            if (typeof l.id !== 'string' || !l.id) errors.push(`${at}.id must be a non-empty string`);
            if (typeof l.statement !== 'string' || !l.statement.trim()) errors.push(`${at}.statement must be a non-empty string`);
            if (!Array.isArray(l.deps)) errors.push(`${at}.deps must be an array`);
            if (typeof l.pinnedHash !== 'string' || !l.pinnedHash) errors.push(`${at}.pinnedHash must be present`);
            if (typeof l.statement === 'string' && typeof l.pinnedHash === 'string' && l.pinnedHash) {
                const h = hashStatement(l.statement);
                if (l.pinnedHash !== h) errors.push(`${at} pinnedHash mismatch: statement hash is ${h}`);
            }
            if (typeof l.id === 'string' && l.id) {
                if (ids.has(l.id)) errors.push(`duplicate lemma id ${l.id}`);
                ids.add(l.id);
                byId.set(l.id, l);
            }
        }

        for (const [id, l] of byId) {
            for (const dep of l.deps ?? []) {
                if (typeof dep !== 'string' || !dep) errors.push(`lemma ${id} has a malformed dep entry`);
                else if (!byId.has(dep)) errors.push(`lemma ${id} depends on unknown lemma ${dep}`);
                else if (dep === id) errors.push(`lemma ${id} depends on itself`);
            }
        }

        const cycle = findCycle([...byId.values()]);
        if (cycle) errors.push(`blueprint has a dependency cycle: ${cycle.join(' -> ')}`);
    }

    return { ok: errors.length === 0, errors };
}

// Depth-first cycle detection over { id, deps } nodes. Returns the cycle as an id chain,
// or null when the node set is acyclic.
export function findCycle(lemmas) {
    const byId = new Map(lemmas.filter(l => l && l.id).map(l => [l.id, l]));
    const state = new Map(); // 0 = visiting, 1 = done
    const stack = [];

    function visit(id) {
        const s = state.get(id);
        if (s === 1) return null;
        if (s === 0) {
            const i = stack.indexOf(id);
            return stack.slice(i).concat(id);
        }
        state.set(id, 0);
        stack.push(id);
        const l = byId.get(id);
        for (const dep of l?.deps ?? []) {
            if (byId.has(dep)) {
                const c = visit(dep);
                if (c) return c;
            }
        }
        stack.pop();
        state.set(id, 1);
        return null;
    }

    for (const l of lemmas) {
        if (!l || typeof l.id !== 'string') continue;
        const c = visit(l.id);
        if (c) return c;
    }
    return null;
}

// Kahn's algorithm. A lemma is ordered strictly after all of its deps, so the returned
// order is a valid bottom-up fill order (leaves/roots first). Returns null on a cycle
// (or unknown dep), otherwise the deterministic order of lemma ids.
export function topologicalOrder(lemmas) {
    const byId = new Map(lemmas.filter(l => l && l.id).map(l => [l.id, l]));
    const indegree = new Map();
    const adj = new Map();
    for (const l of lemmas) {
        if (!l || typeof l.id !== 'string') continue;
        indegree.set(l.id, 0);
        adj.set(l.id, []);
    }
    for (const l of lemmas) {
        if (!l || typeof l.id !== 'string') continue;
        for (const dep of l.deps ?? []) {
            if (!byId.has(dep)) continue;
            adj.get(dep).push(l.id);
            indegree.set(l.id, (indegree.get(l.id) ?? 0) + 1);
        }
    }
    const q = [...indegree.keys()].filter(id => indegree.get(id) === 0).sort();
    const order = [];
    while (q.length) {
        const id = q.shift();
        order.push(id);
        const next = adj.get(id).slice().sort();
        for (const nxt of next) {
            indegree.set(nxt, indegree.get(nxt) - 1);
            if (indegree.get(nxt) === 0) q.push(nxt);
        }
        q.sort();
    }
    return order.length === indegree.size && indegree.size > 0 ? order : null;
}

// id -> set of lemma ids that list it as a dep. Used to find what re-splitting a stub
// must keep consistent (children add stubs, never edit existing statements).
export function dependentsIndex(lemmas) {
    const idx = new Map();
    for (const l of lemmas) {
        if (l && typeof l.id === 'string') idx.set(l.id, new Set());
    }
    for (const l of lemmas) {
        if (!l || typeof l.id !== 'string') continue;
        for (const dep of l.deps ?? []) {
            if (idx.has(dep)) idx.get(dep).add(l.id);
        }
    }
    return idx;
}
