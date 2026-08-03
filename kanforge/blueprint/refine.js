// Refine loop (architecture.md §1, build_order.md §4.2).
export class BlueprintRefiner {
    constructor(agentLoop) {
        this.agentLoop = agentLoop;
    }

    async refine(blueprint) {
        return { ok: true, refined: blueprint };
    }
}
