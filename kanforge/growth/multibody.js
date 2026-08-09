// Multi-agent lemma-ownership lanes (architecture.md §7/P7, blueprint.md). Shards a development
// across agents: each lemma belongs to exactly ONE region (owner), lanes run in parallel, and
// the merge enforces coherence — a lemma may reference a cross-region lemma only if that lemma
// was actually kernel-verified before the dependent committed. The coordinator never verifies
// or edits; it orchestrates workers (each worker wraps the TacticLoop for its lane) and checks
// the merge. Toggleable: a mission can run single-lane (one owner, all lemmas) or multi-lane.

// Partition a lemma set into per-owner lanes under the constraint that a lemma is processed only
// after the lemmas it depends on (same-lane deps are ordered by the lane scheduler; cross-lane
// deps must already be committed). Returns { lanes, crossEdges } where lanes maps ownerId to an
// ordered list of lemma ids, and crossEdges lists dependency pairs whose endpoints live in
// different regions.
export function partitionLanes(lemmaIds, deps, regionOf) {
    const lanes = new Map();
    for (const id of lemmaIds) {
        const owner = regionOf(id);
        if (!lanes.has(owner)) lanes.set(owner, []);
        lanes.get(owner).push(id);
    }
    const crossEdges = [];
    for (const id of lemmaIds) {
        for (const dep of deps(id) ?? []) {
            if (dep !== id && regionOf(dep) !== regionOf(id)) crossEdges.push({ dependent: id, dependency: dep, owner: regionOf(id), depOwner: regionOf(dep) });
        }
    }
    return { lanes, crossEdges };
}

export class MultibodyCoordinator {
    // workers: ownerId -> async ({ lemmaId, statement, deps, committed }) => proofScript
    // A worker must kernel-verify before returning; the coordinator trusts only verified proofs.
    constructor(workers, { concurrency = 2 } = {}) {
        this.workers = workers;
        this.concurrency = concurrency;
    }

    async run(lemmas, { regionOf, deps = () => [] } = {}) {
        // lemmas: [{ id, statement }] — the full development; regionOf assigns each to an owner.
        const byId = new Map(lemmas.map(l => [l.id, l]));
        const { lanes, crossEdges } = partitionLanes(lemmas.map(l => l.id), deps, regionOf);
        const committed = new Set();      // kernel-verified lemma ids, in commit order
        const results = new Map();        // lemmaId -> proofScript
        const failures = new Map();       // lemmaId -> error
        const coherenceViolations = [];

        const ownerState = new Map();
        for (const owner of [...lanes.keys()]) {
            ownerState.set(owner, {
                queue: [...lanes.get(owner)],
                done: new Set(),
                running: new Set()
            });
        }

        // Round-robin over owners; within an owner, process in dependency-sorted order.
        const sorted = [...lanes.keys()];
        let progress = true;
        while (progress) {
            progress = false;
            for (const owner of sorted) {
                const st = ownerState.get(owner);
                if (st.queue.length === 0) continue;
                // A lemma is ready when all same-lane deps are done and all cross-lane deps are committed.
                const readyIdx = st.queue.findIndex(id => {
                    const dl = deps(id) ?? [];
                    return dl.every(d => d === id || (regionOf(d) === owner ? st.done.has(d) : committed.has(d)));
                });
                if (readyIdx < 0) continue; // blocked on another lane; retry next pass
                const [id] = st.queue.splice(readyIdx, 1);
                st.running.add(id);
                progress = true;

                const lemma = byId.get(id);
                const worker = this.workers[regionOf(id)];
                try {
                    const proofScript = await worker({ lemmaId: id, statement: lemma.statement, deps: deps(id) ?? [], committed: [...committed] });
                    // Coherence check on the merge: the worker's proof must not depend on a
                    // cross-region lemma that is not committed (single-owner edits are trusted
                    // only for the owner's own region).
                    const missing = (deps(id) ?? []).filter(d => d !== id && !committed.has(d));
                    if (missing.length > 0) {
                        coherenceViolations.push({ lemmaId: id, missing, owner: regionOf(id) });
                        failures.set(id, `coherence violation: depends on uncommitted ${missing.join(', ')}`);
                        st.running.delete(id);
                        continue;
                    }
                    committed.add(id);
                    results.set(id, proofScript);
                    st.done.add(id);
                    st.running.delete(id);
                } catch (err) {
                    failures.set(id, err.message ?? String(err));
                    st.running.delete(id);
                }
            }
        }
        // A lane that could not make progress within its queue is stuck (deadlock or failure).
        for (const [owner, st] of ownerState) {
            if (st.queue.length > 0) {
                for (const id of st.queue) {
                    if (!failures.has(id) && !results.has(id)) {
                        failures.set(id, 'lane stalled: dependencies never committed');
                        coherenceViolations.push({ lemmaId: id, missing: (deps(id) ?? []).filter(d => d !== id && !committed.has(d)), owner });
                    }
                }
            }
        }

        return { solved: [...committed], proofs: results, failures, coherenceViolations, lanes: [...lanes.keys()] };
    }
}
