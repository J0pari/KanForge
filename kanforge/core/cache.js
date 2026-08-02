import { Lazy } from './lazy.js';

export class PullCache {
    constructor(generator) {
        this.generator = generator;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            this.cache.set(key, new Lazy(() => this.generator(key)));
        }
        return this.cache.get(key).value;
    }

    has(key) {
        return this.cache.has(key) && this.cache.get(key)._evaluated;
    }
}
