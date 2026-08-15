// Refine loop (architecture.md §1, build_order.md §4.2).
// Repeatedly picks the lowest unproved stub (topological order), runs the Phase-1 tactic loop
// on it via agent/loop.js, and either records the verified proof or re-splits the stub into
// child stubs (re-split adds children; existing statements are never edited). Drift is
// re-checked every round via blueprint/drift.js. The blueprint statement set is invariant
// across the run.
import fs from 'node:fs';
import path from 'node:path';
import { TacticLoop } from '../agent/loop.js';
import { SkeletonGenerator, normalizeStub } from './skeleton.js';
import { validateBlueprint, topologicalOrder } from './dag.js';
import { checkDrift } from './drift.js';
import { hashStatement } from '../lean/pin.js';
import { buildProofSource, buildReuseSource } from '../core/state.js';
import { buildLemmaIndex } from '../growth/lemmaStore.js';
import { Patch, patchStreamFromEvents } from '../core/patch.js';
import { RunCheckpoint } from '../core/checkpoint.js';
import { GoalMemory } from '../core/goalMemory.js';
import { lemmaTrajectory } from '../optimization/causal.js';
import { trajectoriesFromEvents, groupAdvantages } from '../optimization/grpo.js';
import { harvestableIdentifiers, appendHarvestFile } from '../search/livePremises.js';

// Cycle repair: repeatedly find a dependency cycle and remove the NEWEST UNPROVED lemma in
// it (children are appended to the array, so array position is the recency proxy). Proved
// lemmas are never pruned — only unproved, newest-first. Returns the pruned ids.
export function repairCycles(lemmas) {
    const working = lemmas; // mutated in place
    const pruned = [];
    const proven = new Set(working.filter(l => l.proof).map(l => l.id));
    for (let guard = 0; guard < 100; guard++) {
        const order = topologicalOrder(working);
        if (order) break;
        // Find a cycle: walk edges from any node until a repeat.
        const byId = new Map(working.map(l => [l.id, l]));
        const cycle = findCycleIds(working);
        if (!cycle) break;
        // Newest unproved member of the cycle (highest array index).
        let victim = null;
        for (let i = working.length - 1; i >= 0; i--) {
            if (cycle.includes(working[i].id) && !proven.has(working[i].id)) { victim = working[i]; break; }
        }
        if (!victim) break; // cycle of proved lemmas only: cannot repair by pruning
        const vIdx = working.indexOf(victim);
        working.splice(vIdx, 1);
        for (const l of working) {
            l.deps = (l.deps ?? []).filter(d => d !== victim.id);
        }
        pruned.push(victim.id);
    }
    return pruned;
}

function findCycleIds(lemmas) {
    const byId = new Map(lemmas.map(l => [l.id, l]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const stack = [];
    const dfs = (id) => {
        const st = color.get(id) ?? WHITE;
        if (st === GRAY) {
            // cycle: the gray stack segment from the first occurrence of id
            const start = stack.indexOf(id);
            return stack.slice(start);
        }
        if (st === BLACK) return null;
        color.set(id, GRAY);
        stack.push(id);
        const node = byId.get(id);
        for (const d of node?.deps ?? []) {
            const found = dfs(d);
            if (found) return found;
        }
        stack.pop();
        color.set(id, BLACK);
        return null;
    };
    for (const l of lemmas) {
        const found = dfs(l.id);
        if (found) return found;
    }
    return null;
}

export class BlueprintRefiner {
    constructor({ llm, backend, outDir = null, loopOptions = {}, maxRounds = 50000, lemmaStore = null, dataset = null, checkpoint = null } = {}) {
        if (!llm || !backend) {
            throw new Error('BlueprintRefiner requires a real llm client and a real backend');
        }
        this.llm = llm;
        this.backend = backend;
        this.outDir = outDir;
        this.loopOptions = { concurrency: 1, maxTacticsPerGoal: 8, maxGoalsPerLemma: 100, onEvent: () => {}, ...loopOptions };
        this.maxRounds = maxRounds;
        this.skeleton = new SkeletonGenerator({ llm, backend });
        this.lemmaStore = lemmaStore ?? null;
        this.dataset = dataset ?? null;
        this.checkpoint = checkpoint ?? (outDir ? new RunCheckpoint(outDir) : null);
        this.grpTrajectories = []; // per-lemma episodes across the run — the GRPO group (§6.2)
        // Campaign goal memory (§6): the cross-lemma goal-shape record — solved-by replays,
        // failed-tactic vetoes, undeclared-identifier vetoes. Shared by every per-lemma
        // TacticLoop this refiner spawns and persisted in the run checkpoint, so the memory
        // survives passes and a fresh stub attempt never re-proposes a known-dead tactic.
        this.goalMemory = new GoalMemory();
    }

    async refine(blueprint) {
        const working = JSON.parse(JSON.stringify(blueprint));
        const rounds = [];
        let hashChain = [];
        let guard = 0;
        let idleCount = 0;
        const stalledRetried = new Set(); // per-cycle deadlock-release retry budget (one per lemma)

        // Resume from checkpoint: mark proved lemmas, restore rounds, continue hash chain.
        const loaded = this.checkpoint?.load();
        if (loaded) {
            const { proved, stalled } = RunCheckpoint.applyResume(loaded);
            for (const [id, l] of proved) {
                const lemma = working.lemmas.find(w => w.id === id);
                if (lemma) { lemma.proof = l.proof; lemma.stalled = false; }
            }
            // Stalled lemmas stay stalled — they already exhausted their budget in a prior
            // cycle; re-attempting them wastes rounds that could go to other lemmas.
            for (const id of stalled) {
                const lemma = working.lemmas.find(w => w.id === id);
                if (lemma && !lemma.proof) lemma.stalled = true;
            }
            rounds.push(...(loaded.rounds ?? []));
            hashChain = (loaded.hashChain ?? []).map(e => ({ ...e }));
            console.log(`[refine] resumed ${proved.size} proven + ${stalled.size} stalled from checkpoint (${loaded.rounds?.length ?? 0} rounds, ${loaded.savedAt})`);
            // Restore the campaign goal memory (solved-by replays / failure vetoes survive the
            // resume boundary — a pass change must not re-learn the twopow_one lesson).
            if (loaded.goalMemory) {
                this.goalMemory = GoalMemory.deserialize(loaded.goalMemory);
                console.log(`[refine] restored goal memory: ${this.goalMemory.entries.size} goal shapes, ${this.goalMemory.unknownIdentifiers.size} undeclared identifiers`);
            }
            // Cycle repair (re-split regression): an old checkpoint can carry a dependency
            // cycle introduced by a pre-guard re-split. Prune the NEWEST unproved lemma in
            // each cycle (children are appended last, so recency = array position) until the
            // DAG is acyclic again. Proved lemmas are never pruned.
            const pruned = repairCycles(working.lemmas);
            if (pruned.length) {
                console.log(`[refine] pruned ${pruned.length} lemma(s) to repair a re-split cycle: ${pruned.map(id => id.slice(0, 10)).join(', ')}`);
                this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain, cycleRepair: pruned, goalMemory: this.goalMemory.serialize() });
            }
        }

        // Validate AFTER resume + cycle repair: a pre-guard checkpoint can carry a cycle that
        // the repair just healed; validating up-front would reject the whole mission before
        // the heal could run. The repaired working set must be valid to proceed.
        const audit = validateBlueprint(working);
        if (!audit.ok) {
            return { ok: false, error: 'invalid blueprint', errors: audit.errors, refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
        }

        // Frontier-parallel attempt lanes: the DAG's ready set is independent work — each lane
        // runs one lemma attempt (own session + LLM calls) concurrently; the merge below is a
        // single writer (working.lemmas / checkpoint / hash chain). One pool worker stays warm
        // for one-shot checks, so lanes = concurrency - 1.
        const lanes = Math.max(1, this.loopOptions.concurrency - 1);
        const retryBudget = Math.max(2, Math.min(4, this.loopOptions.maxTacticsPerGoal ?? 8));
        const inFlight = new Set();
        const retriedIds = new Set();

        while (guard < this.maxRounds) {
            const drift = checkDrift(working.lemmas);
            if (!drift.ok) {
                return { ok: false, error: 'drift detected', drifts: drift.drifts, refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const order = topologicalOrder(working.lemmas);
            if (!order) {
                // Self-heal: a re-split cycle that survived the guards gets pruned here (newest
                // unproved nodes only). If repair fails (proved-only cycle — impossible, since
                // proved lemmas were added acyclically), report the blocker honestly.
                const pruned = repairCycles(working.lemmas);
                if (pruned.length && topologicalOrder(working.lemmas)) {
                    console.log(`[refine] self-healed a dependency cycle mid-run: pruned ${pruned.length} lemma(s)`);
                    this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain, cycleRepair: pruned, goalMemory: this.goalMemory.serialize() });
                    continue;
                }
                return { ok: false, error: 'blueprint became cyclic (unrepairable)', refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const provenIds = new Set(working.lemmas.filter(l => l.proof).map(l => l.id));
            const byId = new Map(working.lemmas.map(l => [l.id, l]));
            const rank = new Map(order.map((id, i) => [id, i]));
            const readyPool = order.map(id => byId.get(id))
                .filter(l => l && !l.proof && !l.stalled && !inFlight.has(l.id)
                    && (l.deps ?? []).every(d => provenIds.has(d)));
            if (readyPool.length === 0) {
                const stillWorkable = working.lemmas.find(l => !l.proof && !l.stalled
                    && !inFlight.has(l.id)
                    && (l.deps ?? []).every(d => provenIds.has(d)));
                if (!stillWorkable) {
                    // Deadlock-release path: every non-stalled unproved lemma is dependency-
                    // blocked, and the only READY lemmas are stalled ones. A stalled lemma is
                    // the only path forward (its deps are proved; a fresh attempt may succeed).
                    // This is NOT the anti-waste case — that rule forbids re-attempting stalled
                    // lemmas while other work exists. The retry budget is ONE attempt per lemma
                    // per refine cycle; retries run with a reduced tactic budget and a deepened
                    // re-split (prior children fed back to the skeleton) so a failed retry still
                    // grows the DAG instead of repeating the same dead end.
                    const stalledReady = working.lemmas.filter(l => !l.proof && l.stalled
                        && !stalledRetried.has(l.id) && !inFlight.has(l.id)
                        && (l.deps ?? []).every(d => provenIds.has(d)));
                    if (stalledReady.length) {
                        const released = stalledReady.slice(0, lanes);
                        for (const l of released) {
                            l.stalled = false;
                            stalledRetried.add(l.id);
                            retriedIds.add(l.id);
                        }
                        console.log(`[refine] deadlock-release: re-attempting ${released.length} stalled lemma(s) of ${stalledReady.length} ready-stalled`);
                        continue; // next iteration dispatches them as a batch
                    }
                    this.stopReason = 'no-ready-lemma';
                    break;
                }
                // A lemma is ready but blocked on deps — idle; don't count as a real round.
                idleCount++;
                if (idleCount >= 3) {
                    this.stopReason = 'dependency-idle';
                    break;
                }
                continue;
            }
            idleCount = 0;

            // Batch pick: descendant-weighted (unblocking power) among ready lemmas, topological
            // order as tiebreak. Descendant counts are cheap at this scale and computed per
            // iteration so merges are always reflected.
            const descCache = new Map();
            const descOf = (id) => {
                if (descCache.has(id)) return descCache.get(id);
                const seen = new Set();
                const stack = [id];
                while (stack.length) {
                    const x = stack.pop();
                    for (const l of working.lemmas) {
                        if ((l.deps ?? []).includes(x) && !seen.has(l.id)) {
                            seen.add(l.id);
                            stack.push(l.id);
                        }
                    }
                }
                descCache.set(id, seen.size);
                return seen.size;
            };
            const budgetLeft = this.maxRounds - guard;
            const batch = readyPool
                .sort((a, b) => (descOf(b.id) - descOf(a.id)) || (rank.get(a.id) - rank.get(b.id)))
                .slice(0, Math.min(lanes, budgetLeft));
            for (const stub of batch) inFlight.add(stub.id);
            if (batch.length > 1) {
                console.log(`[refine] batch of ${batch.length} ready lemmas (frontier ${readyPool.length}): ${batch.map(s => s.id.slice(0, 8)).join(', ')}`);
            }

            // Parallel attempt phase: lanes run independently; a lane crash degrades to a
            // failed round (the DAG and checkpoint are never mutated by a lane directly).
            const results = await Promise.all(batch.map(stub =>
                this._attempt(stub, working, { retry: retriedIds.has(stub.id), retryBudget })
                    .then(r => ({ stub, r }))
                    .catch(err => ({ stub, r: { proved: false, resplit: false, added: 0, children: [], error: err?.message ?? String(err) } }))
            ));

            // Serial merge (single writer): children, cycle repair, rounds, hash chain,
            // checkpoint, stall bookkeeping, premise harvest.
            for (const { stub, r } of results) {
                inFlight.delete(stub.id);
                guard++;
                const before = working.lemmas.length;
                if (r.children?.length) {
                    const known = new Set(working.lemmas.map(l => l.id));
                    for (const child of r.children) {
                        if (!known.has(child.id)) {
                            working.lemmas.push(child);
                            known.add(child.id);
                        }
                    }
                }
                // Validate the MERGED set: a child's deps can close a cycle through the parent
                // or an existing lemma. repairCycles prunes the newest unproved nodes (exactly
                // the children just added) until the DAG is acyclic again.
                const mergedAudit = validateBlueprint({ theorem: working.lemmas[0]?.statement ?? '', lemmas: working });
                if (!mergedAudit.ok && /cycle/i.test(mergedAudit.errors.join(' '))) {
                    const pruned = repairCycles(working);
                    if (pruned.length) {
                        console.log(`[refine]   merged re-split created a cycle; pruned ${pruned.length} child lemma(s): ${pruned.map(id => id.slice(0, 10)).join(', ')}`);
                    }
                }
                const addedNow = Math.max(0, working.lemmas.length - before);
                console.log(`[refine] round ${guard}/${this.maxRounds} lemma ${stub.id.slice(0, 10)}… proved=${r.proved} resplit=${r.resplit} added=${addedNow} error=${r.error ?? '(none)'}`);
                rounds.push({ id: stub.id, ok: r.proved, resplit: r.resplit, added: addedNow, error: r.error ?? null });
                if (r.hashChainEntry) hashChain.push(r.hashChainEntry);
                const madeProgress = r.proved || addedNow > 0;
                // Checkpoint after every round — progress or not. A stalled lemma (no progress,
                // no new children) must still persist the round history + hash chain, or a crash
                // mid-run loses the stalls that the resume logic needs to skip.
                this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain, goalMemory: this.goalMemory.serialize() });
                if (!madeProgress) {
                    // A stalled lemma becomes retryable only when a DEPENDENCY was proved — not
                    // when any unrelated lemma progresses.
                    stub.stalled = true;
                } else if (r.proved) {
                    // Un-stall only the dependents of the just-proved lemma: they are the ones
                    // whose situation changed.
                    for (const l of working.lemmas) {
                        if (l.stalled && (l.deps ?? []).includes(stub.id)) {
                            delete l.stalled;
                        }
                    }
                    // Premise harvest (§5.2 live wiring): grow the corpus with mathlib names
                    // this proof actually used. Fire-and-forget — never blocks the merge loop.
                    if (this.loopOptions.premises?.length) {
                        this._harvestPremises(stub, r.proofScript).catch(() => {});
                    }
                }
            }
        }

        const proved = working.lemmas.filter(l => l.proof).map(l => l.id);
        const unproved = working.lemmas.filter(l => !l.proof).map(l => l.id);
        const ok = unproved.length === 0;

        if (this.outDir && ok) this._write(working);

        // GRPO record (§6.2): the run's episodes as one group — group-relative advantages are
        // meaningful over the run's lemmas, not within a single lemma. The loss needs policy
        // probabilities a trainer would supply; this system has no trainable policy, so it is
        // recorded as null with the reason. Computed, never applied.
        const advantages = groupAdvantages(this.grpTrajectories);
        const grpo = {
            episodes: this.grpTrajectories.length,
            solved: this.grpTrajectories.filter(t => t.solved).length,
            advantages: advantages.map(t => ({ lemmaId: t.lemmaId, solved: t.solved, advantage: t.advantage })),
            loss: null,
            lossReason: 'no trainable policy in this system — a gradient step is outside the project'
        };

        return {
            ok,
            refined: working,
            proved,
            unproved,
            rounds,
            hashChain,
            grpo,
            maxRoundsReached: guard >= this.maxRounds && unproved.length > 0,
            stopReason: this.stopReason ?? (guard >= this.maxRounds && unproved.length > 0 ? 'round-cap' : null),
            stored: {
                lemmas: this.lemmaStore?.size ?? 0,
                samples: this.dataset?.samples.length ?? 0
            }
        };
    }

    async _attempt(stub, working, opts = {}) {
        // A lane is a pure unit of work: it may mutate ITS OWN stub (proof/deps/stall live on
        // the stub object only this lane owns) but never pushes to working.lemmas — re-split
        // children are RETURNED and the serial merge in the loop applies them. This is the
        // concurrency contract of the frontier-parallel batch.
        // §5.7 Stage 2 — exact reuse: a previously-verified statement (same hash) in the store
        // reuses its stored proof with zero LLM spend — but NEVER with zero kernel spend. The
        // stored proof is re-verified against the CURRENT backend/toolchain before it is
        // accepted (retrieval never bypasses verification); a store entry that fails here is a
        // stale entry and the stub falls through to a fresh proof.
        const stmtHash = hashStatement(stub.statement);
        const reused = this.lemmaStore?.get(stmtHash);
        this.reuseRejectedThisPass ??= new Set();
        if (reused?.proofScript && !this.reuseRejectedThisPass.has(stmtHash)) {
            try {
                // Transitive reuse: inline the stored proof's dependency closure (its proof
                // references sibling lemmas, which must be declared for the fresh-env
                // verification to pass) — the compression back-reference that turns a known
                // lemma into a zero-LLM prove.
                const fullSource = buildReuseSource({
                    store: this.lemmaStore,
                    statement: stub.statement,
                    proofScript: reused.proofScript,
                    closureOf: stmtHash
                });
                // Warm-first: the warm env holds the mission's import block (plus the tactic
                // modules the pool was warmed with), so a same-statement reuse re-verifies in
                // seconds. A warm rejection is confirmed once on a fresh env (the rejection is
                // then memoized per pass — churned stubs must not re-pay the cold check every
                // round). Acceptance stays kernel-verified either way; the commit gate is the
                // final fresh authority for anything that gets committed.
                let reuseCheck = await this.backend.check(fullSource, { useWarmEnv: true });
                if (reuseCheck.status !== 'verified') {
                    reuseCheck = await this.backend.check(fullSource, { useWarmEnv: false });
                }
                if (reuseCheck.status !== 'verified') {
                    this.reuseRejectedThisPass.add(stmtHash);
                }
                if (reuseCheck.status === 'verified') {
                    stub.proof = reused.proofScript;
                    stub.reuseVerifiedAt = new Date().toISOString();
                    // §5.9: a store hit is a typed `reuse` patch — recorded with its fresh
                    // verification evidence, not a silent shortcut.
                    stub.patchStream = [new Patch({ node: stmtHash, op: 'reuse', replacement: reused.proofScript, scope: 'lemma', meta: { source: reused.statementHash ?? stmtHash, verification: 'verified', verifiedAt: stub.reuseVerifiedAt } })];
                    return { proved: true, resplit: false, added: 0, children: [], reused: true };
                }
                console.log(`[refine] reuse rejected by kernel: ${String(reuseCheck.error?.message ?? 'verification failed').slice(0, 160)}`);
            } catch (err) {
                console.log(`[refine] reuse path failed to assemble/verify source (${err?.message ?? err}); proving fresh`);
            }
        }

        const userOnEvent = this.loopOptions.onEvent;
        const lemmaEvents = [];
        const loop = new TacticLoop({
            backend: this.backend,
            llm: this.llm,
            ...this.loopOptions,
            // Retry lanes run a reduced tactic budget: the fresh attempt already spent the full
            // budget, and a retry that fails should re-split (deepened) rather than re-burn it.
            maxTacticsPerGoal: opts.retry ? opts.retryBudget : (this.loopOptions.maxTacticsPerGoal ?? 8),
            goalMemory: this.loopOptions.goalMemory ?? this.goalMemory,
            lemmaStore: this.lemmaStore ?? this.loopOptions.lemmaStore ?? null,
            dataset: this.dataset ?? this.loopOptions.dataset ?? null,
            onEvent: e => {
                lemmaEvents.push(e);
                this._capture(e, lemmaEvents, stub);
                userOnEvent?.(e);
            }
        });
        loop.addLemma(stub.statement);
        const outcome = await loop.proveAll();
        // GRPO episode collection (§6.2): every lemma attempt contributes its tactic
        // trajectories to the run's group — the group is the run, not the lemma.
        this.grpTrajectories.push(...trajectoriesFromEvents(loop.events()));

        if (outcome.ok) {
            const verified = loop.events().filter(e => e.type === 'lemma_verified').pop();
            stub.proof = verified?.proofScript ?? '';
            // §5.9: the typed mutation record — the lemma's patch stream is its transformation
            // history, stored on the stub so both the retrieval index entry and the digest carry it.
            stub.patchStream = patchStreamFromEvents(loop.events().filter(e => e.lemmaId === verified?.lemmaId));
            // Carry the loop's hash chain entry to the run-level chain.
            const chainEntry = outcome.hashChain?.length ? outcome.hashChain[outcome.hashChain.length - 1] : null;
            return { proved: true, resplit: false, added: 0, children: [], hashChainEntry: chainEntry, proofScript: stub.proof };
        }

        const failedEvt = loop.events().filter(e => e.type === 'lemma_failed').pop();
        const loopError = failedEvt?.error?.message ?? failedEvt?.error ?? 'tactic loop failed';

        // Backend/session failures (extractFailed) are NOT search exhaustion: the tactic loop
        // never ran, so there is nothing to re-split. The round reports the error and the
        // lemma stalls (deadlock-release retries it later). Re-splitting here would burn an
        // LLM decomposition on a statement the search never actually attempted.
        if (failedEvt?.extractFailed) {
            return { proved: false, resplit: false, added: 0, children: [], error: loopError };
        }

        // Re-split: decompose the failed stub into child stubs via the skeleton generator.
        // The stub statement itself is never edited; only child stubs are added (by the merge).
        // Retry lanes deepen: the stub's existing children are fed back so the decomposition is
        // structurally DIFFERENT instead of repeating the dead end.
        const priorChildren = (stub.deps ?? [])
            .map(d => working.lemmas.find(w => w.id === d)?.statement)
            .filter(Boolean);
        const sub = await this.skeleton.generate(stub.statement, opts.retry ? { priorChildren } : {});
        if (!sub.ok) {
            console.log(`[refine]   skeleton re-split failed: ${sub.error ?? 'unknown'}`);
            return { proved: false, resplit: false, added: 0, children: [], error: loopError };
        }

        const rootId = hashStatement(normalizeStub(stub.statement));
        const subRoot = sub.blueprint.lemmas.find(l => l.id === rootId);
        if (!subRoot) {
            console.log(`[refine]   skeleton root not found in re-split (rootId=${rootId.slice(0,10)}…)`);
            return { proved: false, resplit: false, added: 0, children: [] };
        }

        const children = sub.blueprint.lemmas.filter(child => child.id !== rootId);
        console.log(`[refine]   re-split produced ${sub.blueprint.lemmas.length} lemmas (${children.length} children for merge)`);
        // Only overwrite the stub's deps when the new decomposition actually references
        // children. An empty or duplicate decomposition (0 new children) must not wipe the
        // existing edges — the prior children remain the stub's valid subgoals.
        const newDeps = (subRoot.deps ?? []).filter(d => d !== stub.id);
        if (newDeps.length > 0) stub.deps = newDeps;
        return { proved: false, resplit: true, added: children.length, children };
    }

    // §5.2 live premise harvest: mathlib names a verified proof actually used are resolved via
    // `#check` on the warm worker and appended to the live premise corpus (in-memory for this
    // pass + persisted JSONL for the next pass). The corpus grows exactly where the campaign
    // works — the identifier-hallucination failure mode loses its vocabulary gap over time.
    async _harvestPremises(stub, proofScript) {
        if (!this.loopOptions.premises?.length || !this.backend?.check) return;
        const known = new Set(this.loopOptions.premises.map(p => p.name));
        const candidates = harvestableIdentifiers(proofScript, known).slice(0, 5);
        if (!candidates.length) return;
        const fresh = [];
        for (const name of candidates) {
            try {
                const res = await this.backend.check(`#check ${name}`, { useWarmEnv: true });
                if (res.status !== 'verified') continue;
                const info = (res.warnings ?? [])
                    .map(w => w.data ?? w)
                    .find(d => String(d).includes(name) && String(d).includes(':'));
                if (!info) continue;
                const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const m = String(info).match(new RegExp(`${esc}\\s*:\\s*(.+)`));
                const type = ((m ? m[1] : String(info)).split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
                if (!type) continue;
                fresh.push({ name, type });
                known.add(name);
            } catch {
                // warm #check failure — the name stays out of the corpus, nothing to do
            }
        }
        if (fresh.length) {
            this.loopOptions.premises.push(...fresh);
            if (this.outDir) {
                appendHarvestFile(path.join(this.outDir, 'premise-harvest.jsonl'), fresh);
            }
            console.log(`[premises] harvested ${fresh.length} mathlib premise(s) from proof of ${stub.id.slice(0, 10)}… (corpus now ${this.loopOptions.premises.length})`);
        }
    }

    _capture(event, lemmaEvents = [], stub = null) {
        if (!this.lemmaStore && !this.dataset) return;
        const { statement } = event;
        if (event.type === 'lemma_verified') {
            if (this.lemmaStore) {
                this.lemmaStore.put(hashStatement(statement), buildLemmaIndex({
                    statementHash: hashStatement(statement),
                    statement,
                    proofScript: event.proofScript,
                    deps: stub?.deps ?? [],
                    goalCount: event.goalCount ?? null,
                    ms: event.ms ?? null,
                    // §5.9: the typed transformation history. `lemma_verified` is the lemma's
                    // terminal event, so the accumulated array is complete at this point; the
                    // reuse fast-path sets stub.patchStream directly (no loop ran).
                    patchStream: (stub?.patchStream ?? patchStreamFromEvents(lemmaEvents))
                }));
            }
            if (this.dataset) {
                this.dataset.addSample(
                    { lemma: statement },
                    event.proofScript ?? '',
                    'verified',
                    lemmaTrajectory(lemmaEvents, event.lemmaId)
                );
            }
        } else if (event.type === 'lemma_failed' && this.dataset) {
            // The failed trajectory IS the sample's mineable content (§6.2): prior cycles'
            // failures become the predictor-mining source for later cycles.
            this.dataset.addSample(
                { lemma: statement },
                null,
                'failed',
                lemmaTrajectory(lemmaEvents, event.lemmaId)
            );
        } else if (event.type === 'tactic_applied' && this.dataset && (event.newGoalCount ?? 1) > 0) {
            // Progress samples: kernel-accepted tactic with subgoals — the accepted-but-not-
            // closed reward channel (§6.2). The closing tactic (0 subgoals) belongs to the
            // lemma's verified record, not to progress.
            this.dataset.addSample({ lemma: statement, goalType: event.goalType ?? null }, event.tactic, 'progress');
        }
    }

    _write(blueprint) {
        fs.mkdirSync(this.outDir, { recursive: true });
        fs.writeFileSync(path.join(this.outDir, 'refined.json'), JSON.stringify(blueprint, null, 2) + '\n');
    }
}
