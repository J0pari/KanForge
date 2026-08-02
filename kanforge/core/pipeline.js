// Ported from scripts/builder.js:222-278 (J0pari/Builder, MIT) via tools/extract_modules.py.
// `withCache` dropped: it wired directly into Builder's global pullGraph/traceOrchestrator
// and is not part of the KanForge core contract.

import { Lazy } from './lazy.js';
import { LazyFunctor } from './functor.js';
import { PullPromise } from './promise.js';

export class Pipeline {
    static kleisli(...stages) {
        if (stages.length === 0) return x => LazyFunctor.lift(x);
        if (stages.length === 1) return stages[0];

        return stages.reduce((f, g) => {
            return (x) => {
                const fx = f(x);
                if (fx instanceof Lazy) {
                    return fx.flatMap(g);
                } else if (fx instanceof PullPromise) {
                    return new PullPromise(async () => {
                        const result = await fx.pull();
                        const gx = g(result);
                        if (gx instanceof PullPromise) {
                            return await gx.pull();
                        } else if (gx instanceof Lazy) {
                            return gx.value;
                        }
                        return gx;
                    });
                }
                return g(fx);
            };
        });
    }

    static compose(...stages) {
        return Pipeline.kleisli(...stages);
    }
}
