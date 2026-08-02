// Dependency-ordered dispatch over a PullGraph (architecture.md §2.6; Wave2 §7–8).
// Adds the concurrent dimension to pull(): batch goals, order by the dependency DAG,
// dispatch to a checker (e.g. the Lean backend pool), track a 7-state lifecycle,
// with no cyclic dispatch, bounded concurrency, deterministic ordering, and
// timeout/kill-on-hang.

const LIFECYCLE = ['DIRTY', 'QUEUED', 'BUILDING', 'VERIFIED', 'FAILED', 'CACHED'];

export class Scheduler {
    constructor(graph, options = {}) {
        this.graph = graph;
        this.check = options.check; // async (nodeId) => result
        this.concurrency = options.concurrency ?? 4;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.priority = options.priority ?? null; // override (nodeId, ctx) => number
        this.onProgress = options.onProgress ?? null;
        this.maxFailures = options.maxFailures ?? null; // stop budget: halt once N nodes failed

        if (!this.check || typeof this.check !== 'function') {
            throw new Error('Scheduler requires an async check(nodeId) function');
        }

        this._queue = [];       // max-heap by priority (lower value dispatches first)
        this._inFlight = [];    // settled() promises of running jobs
        this._status = new Map(); // nodeId -> lifecycle state
        this._running = new Map(); // nodeId -> Promise
        this._criticality = null;  // lazy reverse-edge dependent counts
    }

    static get LIFECYCLE() {
        return LIFECYCLE;
    }

    status(nodeId) {
        const node = this.graph.nodes.get(nodeId);
        if (node?.cached) return 'CACHED';
        return this._status.get(nodeId) ?? 'DIRTY';
    }

    enqueue(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
            if (!this.graph.nodes.has(id)) {
                throw new Error(`Unknown node: ${id}`);
            }
            const node = this.graph.nodes.get(id);
            if (this._status.get(id) === 'QUEUED' || this._status.get(id) === 'BUILDING') {
                continue; // already pending or in flight
            }
            if (node?.cached) {
                this._status.set(id, 'CACHED');
                continue; // already verified: skip dispatch
            }
            this._status.set(id, 'QUEUED');
            this._push({ id, prio: this._prio(id) });
        }
        return this;
    }

    // Local (non-transitive) invalidation: marks only this node dirty, so the caller
    // can scope a re-verification batch to the affected subtree (locality). For the
    // transitive variant, call graph.invalidate(id) first, then enqueue the affected set.
    invalidate(nodeId) {
        const node = this.graph.nodes.get(nodeId);
        if (node) {
            node.cached = false;
            node.computation.reset();
        }
        this._status.delete(nodeId);
        return this;
    }

    async run() {
        this._failures = new Map();
        const results = new Map();
        const pending = [];

        while (this._queue.length || this._inFlight.length) {
            if (this.maxFailures && this._failures.size >= this.maxFailures) break;
            let dispatched = false;

            while (this._inFlight.length < this.concurrency && this._queue.length) {
                const { id } = this._pop();
                const gate = this._gate(id);

                if (gate.blocked) {
                    this._fail(id, gate.reason);
                    continue;
                }
                if (gate.ready) {
                    this._dispatch(id, results);
                    dispatched = true;
                } else {
                    pending.push(id);
                }
            }

            for (const id of pending) {
                this._push({ id, prio: this._prio(id) });
            }
            pending.length = 0;

            if (this._inFlight.length === 0 && this._queue.length) {
                const stuck = this._drainQueue();
                for (const id of stuck) {
                    this._fail(id, new Error('scheduler deadlock: dependencies never resolve (cycle or missing dep)'));
                }
                break;
            }

            if (dispatched || this._inFlight.length) {
                await Promise.race(this._inFlight.map(job => job.settled));
            }
        }

        // Let any still-running jobs (left by a stop budget break) settle so their failures are
        // counted, then report whether the run halted early.
        await Promise.allSettled(this._inFlight.map(job => job.result));

        return {
            ok: this._failures.size === 0,
            results,
            failures: this._failures,
            stopped: !!(this.maxFailures && this._failures.size >= this.maxFailures)
        };
    }

    _gate(nodeId) {
        const deps = this.graph.edges?.get(nodeId);
        if (!deps || deps.size === 0) {
            return { ready: true, blocked: false };
        }
        for (const dep of deps) {
            const st = this.status(dep);
            if (st === 'VERIFIED' || st === 'CACHED') continue;
            if (st === 'FAILED') {
                return { ready: false, blocked: true, reason: new Error(`dependency ${dep} failed`) };
            }
            return { ready: false, blocked: false }; // QUEUED/BUILDING/DIRTY/STUB
        }
        return { ready: true, blocked: false };
    }

    _dispatch(nodeId, results) {
        const job = this._spawn(nodeId);
        this._inFlight.push(job);
        this._status.set(nodeId, 'BUILDING');

        job.settled.then(() => {
            const idx = this._inFlight.indexOf(job);
            if (idx !== -1) this._inFlight.splice(idx, 1);
        });

        job.result
            .then(value => {
                this._status.set(nodeId, 'VERIFIED');
                const node = this.graph.nodes.get(nodeId);
                if (node) {
                    node.cached = true;
                    node.value = value;
                }
                results.set(nodeId, value);
            })
            .catch(error => this._fail(nodeId, error));
    }

    _spawn(nodeId) {
        const check = this.check;
        const timeoutMs = this.timeoutMs;
        const start = Date.now();
        const result = new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`timeout after ${timeoutMs}ms: ${nodeId}`));
                }
            }, timeoutMs);
            timer.unref?.();

            Promise.resolve()
                .then(() => check(nodeId))
                .then(value => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        this._progress(nodeId, { stage: 'complete', ms: Date.now() - start });
                        resolve(value);
                    }
                })
                .catch(error => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        this._progress(nodeId, { stage: 'failed', ms: Date.now() - start, error });
                        reject(error);
                    }
                });
        });

        let settleResolve;
        const settled = new Promise(res => { settleResolve = res; });
        // both outcomes settle the same promise, so Promise.race can never reject
        result.then(() => settleResolve(), () => settleResolve());
        this._progress(nodeId, { stage: 'start' });
        return { settled, result };
    }

    _fail(nodeId, reason) {
        this._status.set(nodeId, 'FAILED');
        const node = this.graph.nodes.get(nodeId);
        if (node) {
            node.value = { error: reason, value: undefined };
        }
        if (this._failures) {
            this._failures.set(nodeId, reason);
        }
        this._progress(nodeId, { stage: 'failed', error: reason });
    }

    _prio(nodeId) {
        if (this.priority) {
            return this.priority(nodeId, { scheduler: this });
        }
        const criticality = this._criticalityOf(nodeId);
        // higher criticality (more dependents) dispatches first; deterministic tie-break by id
        return -(criticality * 1_000_000 + nodeId.length);
    }

    _criticalityOf(nodeId) {
        if (this._criticality === null) {
            this._criticality = new Map();
            for (const [target, deps] of this.graph.edges ?? new Map()) {
                for (const dep of deps) {
                    this._criticality.set(dep, (this._criticality.get(dep) ?? 0) + 1);
                }
            }
        }
        return this._criticality.get(nodeId) ?? 0;
    }

    _push(entry) {
        this._queue.push(entry);
        let i = this._queue.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._queue[parent].prio <= this._queue[i].prio) break;
            [this._queue[parent], this._queue[i]] = [this._queue[i], this._queue[parent]];
            i = parent;
        }
    }

    _pop() {
        const top = this._queue[0];
        const last = this._queue.pop();
        if (this._queue.length > 0 && last !== undefined) {
            this._queue[0] = last;
            let i = 0;
            const n = this._queue.length;
            while (true) {
                const l = 2 * i + 1;
                const r = 2 * i + 2;
                let m = i;
                if (l < n && this._queue[l].prio < this._queue[m].prio) m = l;
                if (r < n && this._queue[r].prio < this._queue[m].prio) m = r;
                if (m === i) break;
                [this._queue[i], this._queue[m]] = [this._queue[m], this._queue[i]];
                i = m;
            }
        }
        return top;
    }

    _drainQueue() {
        const ids = this._queue.map(e => e.id);
        this._queue = [];
        return ids;
    }

    _progress(nodeId, info) {
        if (this.onProgress) {
            this.onProgress({ nodeId, ...info });
        }
    }
}
