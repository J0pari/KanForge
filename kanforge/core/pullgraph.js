// Ported from scripts/builder.js:481-786 (J0pari/Builder, MIT) via tools/extract_modules.py.
// Telemetry stripped: traceOrchestrator traces, performance marks, process.memoryUsage,
// CONFIG.processing.progress thresholds. Progress callback kept as an opt-in hook.

import { Lazy } from './lazy.js';

export class PullGraph {
    constructor() {
        this.objects = new Map();
        this.morphisms = new Map();
        this.identities = new Map();
        this.compositions = new Map();

        this.pullCount = 0;
        this.cacheHits = 0;
        this.totalPulls = 0;
        this.errorBoundaries = new Map();
        this.progressCallback = null;
        this.progressInterval = 1;
    }

    register(id, computation, errorHandler = null) {
        const obj = {
            computation: computation instanceof Lazy ? computation : new Lazy(computation),
            cached: false,
            value: undefined,
            pullCount: 0,
            category: 'pull-graph'
        };

        this.objects.set(id, obj);
        this.identities.set(id, x => x);

        if (errorHandler) {
            this.errorBoundaries.set(id, errorHandler);
        }
    }

    morphism(sourceId, targetId, transform = x => x) {
        const morphId = `${sourceId}->${targetId}`;
        this.morphisms.set(morphId, {
            source: sourceId,
            target: targetId,
            transform: transform instanceof Lazy ? transform : new Lazy(() => transform),
            category: 'morphism'
        });

        if (!this.edges) this.edges = new Map();
        if (!this.edges.has(targetId)) {
            this.edges.set(targetId, new Set());
        }
        this.edges.get(targetId).add(sourceId);
    }

    compose(f, g) {
        if (f.target !== g.source) {
            throw new Error(`Cannot compose morphisms: ${f.source}->${f.target} and ${g.source}->${g.target}`);
        }

        const composed = {
            source: f.source,
            target: g.target,
            transform: new Lazy(() => {
                const fx = f.transform.value;
                const gx = g.transform.value;
                return x => gx(fx(x));
            }),
            category: 'composed-morphism'
        };

        const compId = `${f.source}->>${g.target}`;
        this.compositions.set(compId, composed);
        return composed;
    }

    dependsOn(nodeId, dependencyId) {
        this.morphism(dependencyId, nodeId);
    }

    get nodes() {
        return this.objects;
    }

    pull(nodeId, pullPath = []) {
        const node = this.objects.get(nodeId);
        if (!node) {
            return { error: new Error(`Unknown object: ${nodeId}`), value: undefined };
        }

        if (!node.cached) {
            const currentPath = [...pullPath, nodeId];

            if (this.progressCallback && this.pullCount % this.progressInterval === 0) {
                this.progressCallback({
                    pullCount: this.pullCount,
                    totalPulls: this.totalPulls,
                    cacheHits: this.cacheHits,
                    nodeId,
                    stage: 'dependencies',
                    pullPath: currentPath
                });
            }

            const deps = this.edges?.get(nodeId);
            if (deps) {
                for (const depId of deps) {
                    const depResult = this.pull(depId, currentPath);
                    if (depResult?.error) {
                        node.value = depResult;
                        node.cached = true;
                        return depResult;
                    }
                }
            }

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

            if (this.progressCallback) {
                this.progressCallback({
                    pullCount: this.pullCount,
                    nodeId,
                    stage: 'complete',
                    value: node.value,
                    pullPath: currentPath
                });
            }
        }

        return node.value;
    }

    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    setProgressInterval(n) {
        this.progressInterval = n;
    }

    invalidate(nodeId) {
        const node = this.objects.get(nodeId);
        if (node) {
            node.cached = false;
            node.computation.reset();
            if (this.edges) {
                for (const [id, deps] of this.edges) {
                    if (deps.has(nodeId)) {
                        this.invalidate(id);
                    }
                }
            }
        }
    }

    serialize() {
        const serialized = {
            objects: [],
            morphisms: [],
            pullCount: this.pullCount,
            timestamp: Date.now()
        };

        for (const [id, obj] of this.objects) {
            if (obj.cached && obj.value !== undefined) {
                const entry = {
                    id,
                    value: obj.value,
                    pullCount: obj.pullCount,
                    category: obj.category
                };

                if (obj.contentHash) {
                    entry.contentHash = obj.contentHash;
                }

                serialized.objects.push(entry);
            }
        }

        for (const [morphId, morph] of this.morphisms) {
            serialized.morphisms.push({
                id: morphId,
                source: morph.source,
                target: morph.target
            });
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
                if (obj.contentHash) {
                    node.contentHash = obj.contentHash;
                }
            }
        }

        for (const morph of data.morphisms) {
            if (graph.objects.has(morph.source) && graph.objects.has(morph.target)) {
                graph.morphism(morph.source, morph.target);
            }
        }

        return graph;
    }
}
