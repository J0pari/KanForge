// Ported from scripts/builder.js:158-192 (J0pari/Builder, MIT) via tools/extract_modules.py.
// The global `pull(part)` branch (which resolved PullGraph node objects) is stripped:
// core templates handle Lazy/LazyTemplate/plain values only.

import { Lazy } from './lazy.js';

export class LazyTemplate {
    constructor(parts) {
        this.parts = parts;
        this._cache = undefined;
        this._evaluated = false;
    }

    toString() {
        if (!this._evaluated) {
            try {
                this._cache = this.parts.map(part => {
                    if (part instanceof Lazy || part instanceof LazyTemplate) {
                        return part.toString();
                    }
                    return String(part);
                }).join('');
                this._evaluated = true;
            } catch (error) {
                this._evaluated = true;
                this._cache = { error };
                throw error;
            } finally {
                this.parts = null;
            }
        }
        if (this._cache && this._cache.error) {
            throw this._cache.error;
        }
        return this._cache;
    }
}
