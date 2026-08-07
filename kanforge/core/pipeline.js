import { Lazy } from './lazy.js';
import { LazyMapper } from './functor.js';
import { PullPromise } from './promise.js';

export class Pipeline {
    static compose(...stages) {
        if (stages.length === 0) return x => LazyMapper.lift(x);
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
}
