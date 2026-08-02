import { Lazy } from './lazy.js';

export const lazify = (obj) => {
    const cache = new Map();
    
    return new Proxy(obj, {
        get(target, prop) {
            if (!cache.has(prop)) {
                const value = target[prop];
                if (typeof value === 'function') {
                   
                    cache.set(prop, (...args) => {
                        const key = JSON.stringify(args);
                        if (!cache.has(`${prop}_${key}`)) {
                            cache.set(`${prop}_${key}`, new Lazy(() => value(...args)));
                        }
                        return cache.get(`${prop}_${key}`).value;
                    });
                } else if (typeof value === 'object' && value !== null) {
                   
                    cache.set(prop, lazify(value));
                } else {
                   
                    cache.set(prop, new Lazy(() => value));
                }
            }
            const cached = cache.get(prop);
            return cached instanceof Lazy ? cached.value : cached;
        }
    });
};
