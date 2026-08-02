// Lean backend factory + interface (architecture.md §3).
// createBackend({ type, ...config }) -> LeanBackend for type in repl | cli.
// Every backend drives the real Lean kernel: no mocks, stubs, or facsimiles.
//   - repl (preferred): JSON-lines pool over the real `leanprover-community/repl` binary.
//   - cli: one `lean` invocation per check (CI batch).
// lean4web is deferred: it ships only once we exercise a real instance end-to-end; its
// API contract is not fabricated offline.

import { BackendRepl } from './backendRepl.js';
import { BackendCli } from './backendCli.js';

export const LEAN_BACKEND_TYPES = ['repl', 'cli'];

export function createBackend(options = {}) {
    const type = options.type ?? 'repl';
    switch (type) {
        case 'repl': return new BackendRepl(options);
        case 'cli': return new BackendCli(options);
        default: throw new Error(`unknown lean backend type: ${type} (expected one of ${LEAN_BACKEND_TYPES.join(', ')})`);
    }
}
