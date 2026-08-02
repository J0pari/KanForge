import { Lazy } from './lazy.js';

export class LazyFunctor {
    static map(f, lazyStructure) {
        if (lazyStructure instanceof Lazy) {
            return lazyStructure.map(f);
        }
        if (typeof lazyStructure === 'object' && lazyStructure !== null) {
            const result = {};
            for (const [k, v] of Object.entries(lazyStructure)) {
                result[k] = LazyFunctor.map(f, v);
            }
            return result;
        }
        return f(lazyStructure);
    }

   
    // FIX (deviation from template): original mapped lazies back into new lazies
    // (LazyFunctor.map wraps through lazyStructure.map), so extract never
    // unwrapped. Recursing directly forces each Lazy leaf to its value.
    static extract(lazyStructure) {
        if (lazyStructure instanceof Lazy) {
            return lazyStructure.value;
        }
        if (typeof lazyStructure === 'object' && lazyStructure !== null) {
            const result = {};
            for (const [k, v] of Object.entries(lazyStructure)) {
                result[k] = LazyFunctor.extract(v);
            }
            return result;
        }
        return lazyStructure;
    }

   
    static lift(value) {
        if (value instanceof Lazy) return value;
        return new Lazy(() => value);
    }
}
