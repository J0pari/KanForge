// Ported from scripts/builder.js:281-321 (J0pari/Builder, MIT) via tools/extract_modules.py.
// `ConfigContext.create()` dropped: it pulled Builder globals (TIME/LIMITS/CONFIG).
// Per the architecture contract, the environment is passed in per-run.

import { Lazy } from './lazy.js';

export class ConfigContext {
    constructor(value, environment) {
        this.value = value;
        this.environment = environment instanceof Lazy ? environment : new Lazy(() => environment);
    }

    extract() {
        return this.value;
    }

    extend(f) {
        return new ConfigContext(
            f(this),
            this.environment
        );
    }

    asks(f) {
        return new Lazy(() => f(this.environment.value));
    }

    derive(computation) {
        return this.extend(ctx =>
            new Lazy(() => computation(ctx.environment.value))
        );
    }
}
