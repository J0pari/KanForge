// Memoized dependency DAG (architecture.md §2.3). This is the live surface the proof loop and
// scheduler actually use: register a memoized computation per node, record dependency edges
// (dependsOn), force via the scheduler's check callback, serialize/deserialize for checkpoint
// resume, and invalidate transitively. No categorical decoration — the review's dead
// identities/compositions/compose/pull/subgraph/diff members were removed (nothing read them).

import { Lazy } from './lazy.js';
import { Guardrails } from './guardrails.js';

export class PullGraph {
    constructor() {
        this.objects = new Map();
        this.edges = new Map();          // nodeId -> Set(dependencyIds)

        this.pullCount = 0;
        this.cacheHits = 0;
        this.totalPulls = 0;
        this.errorBoundaries = new Map();
    }

    register(id, computation, errorHandler = null) {
        const obj = {
            computation: computation instanceof Lazy ? computation : new Lazy(computation),
            cached: false,
            value: undefined,
            pullCount: 0
        };
        this.objects.set(id, obj);
        if (errorHandler) {
            this.errorBoundaries.set(id, errorHandler);
        }
        return obj;
    }

    dependsOn(nodeId, dependencyId) {
        if (!this.edges.has(nodeId)) {
            this.edges.set(nodeId, new Set());
        }
        this.edges.get(nodeId).add(dependencyId);
    }

    get nodes() {
        return this.objects;
    }

    // Force a node's memoized computation through its error boundary (or surface the error).
    resolve(nodeId) {
        const node = this.objects.get(nodeId);
        if (!node) {
            return { error: new Error(`Unknown object: ${nodeId}`), value: undefined };
        }
        if (node.cached) {
            this.cacheHits++;
            return node.value;
        }
        this.totalPulls++;
        this.pullCount++;
        const errorHandler = this.errorBoundaries.get(nodeId);
        if (errorHandler) {
            try {
                node.value = node.computation.value;
            } catch (error) {
                node.value = errorHandler(error, nodeId);
            }
        } else {
            try {
                node.value = node.computation.value;
            } catch (error) {
                node.value = { error, value: undefined };
                node.cached = true;
                return node.value;
            }
        }
        node.cached = true;
        return node.value;
    }

    // Transitive re-verification of dependents (architecture.md §2.3, §2.5 invariant 6).
    // Enforcement point: the invalidation sweep is audited against checkInvalidationLocality
    // here — the ONLY place invalidation happens in the live path. The audit result is returned
    // so callers surface a violation instead of silently clearing unrelated cache.
    invalidate(nodeId) {
        const invalidatedIds = [];
        const walk = (id) => {
            const node = this.objects.get(id);
            if (!node) return;
            node.cached = false;
            node.computation.reset();
            invalidatedIds.push(id);
            for (const [dependentId, deps] of this.edges) {
                if (deps.has(id)) walk(dependentId);
            }
        };
        walk(nodeId);
        const locality = Guardrails.checkInvalidationLocality(this, [nodeId], invalidatedIds);
        return { invalidatedIds, locality };
    }

    serialize() {
        const serialized = {
            objects: [],
            edges: [],
            pullCount: this.pullCount,
            timestamp: Date.now()
        };
        for (const [id, obj] of this.objects) {
            if (obj.cached && obj.value !== undefined) {
                serialized.objects.push({ id, value: obj.value, pullCount: obj.pullCount });
            }
        }
        for (const [id, deps] of this.edges) {
            for (const dep of deps) {
                serialized.edges.push({ source: id, target: dep });
            }
        }
        return serialized;
    }

    static deserialize(data, computationRegistry) {
        const graph = new PullGraph();
        graph.pullCount = data.pullCount;
        for (const obj of data.objects) {
            const computation = computationRegistry?.get(obj.id);
            if (computation) {
                graph.register(obj.id, computation);
                const node = graph.objects.get(obj.id);
                node.cached = true;
                node.value = obj.value;
                node.pullCount = obj.pullCount;
            }
        }
        for (const edge of data.edges ?? []) {
            if (graph.objects.has(edge.source) && graph.objects.has(edge.target)) {
                graph.dependsOn(edge.source, edge.target);
            }
        }
        return graph;
    }
}
