// Ported from scripts/builder.js:79-155 (J0pari/Builder, MIT) via tools/extract_modules.py.
// Telemetry globals (pullGraph, traceOrchestrator) stripped; pure memoized thunk.

export class Lazy {
    constructor(thunk) {
        this._thunk = thunk;
        this._originalThunk = thunk;
        this._cache = undefined;
        this._evaluated = false;
    }

    get value() {
        if (!this._evaluated) {
            try {
                this._cache = this._thunk();
                this._evaluated = true;
            } catch (error) {
                this._evaluated = true;
                this._cache = { error };
                throw error;
            } finally {
                this._thunk = null;
            }
        }

        if (this._cache && this._cache.error) {
            throw this._cache.error;
        }
        return this._cache;
    }

    force() {
        return this.value;
    }

    // Re-arms the memoized thunk so the next .value access recomputes.
    // Needed by PullGraph.invalidate, which must recompute dependencies
    // (the template's invalidate left the Lazy cache in place, a no-op).
    reset() {
        this._evaluated = false;
        this._cache = undefined;
        this._thunk = this._originalThunk;
        return this;
    }

    map(f) {
        return new Lazy(() => f(this.value));
    }

    flatMap(f) {
        return new Lazy(() => {
            const result = f(this.value);
            return result instanceof Lazy ? result.value : result;
        });
    }

    isEvaluated() {
        return this._evaluated;
    }

    toString() {
        return String(this.value);
    }

    valueOf() {
        return this.value;
    }
}
