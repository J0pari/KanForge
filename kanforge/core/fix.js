// Ported from scripts/builder.js:475-478 (J0pari/Builder, MIT).
// FIX (deviation from template): the original eagerly evaluated f(lazy.value),
// which recursed infinitely. Passing `lazy` itself lets f build a tail thunk
// that references lazy.value lazily (coinductive streams), which is the
// intended use (see builder.js:3566 telemetryStream).
import { Lazy } from './lazy.js';

export const fix = (f) => {
    const lazy = new Lazy(() => f(lazy));
    return lazy;
};
