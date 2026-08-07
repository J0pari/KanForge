// Passing `lazy` itself lets f build a tail thunk that references lazy.value lazily
// (coinductive streams).
import { Lazy } from './lazy.js';

export const fix = (f) => {
    const lazy = new Lazy(() => f(lazy));
    return lazy;
};
