import { Lazy } from './lazy.js';

export class LazyMapper {
    static map(f, lazyStructure) {
        if (lazyStructure instanceof Lazy) {
            return lazyStructure.map(f);
        }
        if (typeof lazyStructure === 'object' && lazyStructure !== null) {
            const result = {};
            for (const [k, v] of Object.entries(lazyStructure)) {
                result[k] = LazyMapper.map(f, v);
            }
            return result;
        }
        return f(lazyStructure);
    }

   
    // extract forces each Lazy leaf to its value (a naive map would keep the
    // structure lazy and never unwrap).
    static extract(lazyStructure) {
        if (lazyStructure instanceof Lazy) {
            return lazyStructure.value;
        }
        if (typeof lazyStructure === 'object' && lazyStructure !== null) {
            const result = {};
            for (const [k, v] of Object.entries(lazyStructure)) {
                result[k] = LazyMapper.extract(v);
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
