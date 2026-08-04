// Refine loop (architecture.md §1, build_order.md §4.2).
//
// STUB: NOT IMPLEMENTED. `refine()` passes the blueprint through unchanged and reports success.
// Real behavior (build_order.md §4.2) is a loop that fills the lowest unproved stub via the
// Phase 3 agent loop; tracked under the "Replace stubs" plan in README.md.
export class BlueprintRefiner {
    constructor(agentLoop) {
        this.agentLoop = agentLoop;
    }

    async refine(blueprint) {
        return { ok: true, refined: blueprint };
    }
}
