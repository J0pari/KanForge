// Environment gate for tests that depend on the materialized Mathlib source tree
// (lean-project/.lake/packages/mathlib — fetched by `lake exe cache get`).
//
// The reviewer-grade rule: a nominally unit test must not FAIL because a locally materialized
// dependency is absent — it must SKIP with a stated reason. Tests that need real resolution
// behavior gate on MATHLIB_PRESENT; tests that only need stable import text fall back to the
// raw module names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const MATHLIB_SRC = path.join(PACKAGE_ROOT, '..', 'lean-project', '.lake', 'packages', 'mathlib', 'Mathlib');
export const MATHLIB_PRESENT = fs.existsSync(MATHLIB_SRC);

export function skipWithoutMathlib(reason) {
    return MATHLIB_PRESENT
        ? false
        : `Mathlib source tree not materialized (run 'lake exe cache get' in lean-project): ${reason}`;
}
