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
import { buildProofSource } from '../core/state.js';
import { buildLemmaIndex } from '../growth/lemmaStore.js';
import { Patch, patchStreamFromEvents } from '../core/patch.js';
import { RunCheckpoint } from '../core/checkpoint.js';
import { lemmaTrajectory } from '../optimization/causal.js';
import { trajectoriesFromEvents, groupAdvantages } from '../optimization/grpo.js';

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
            // Cycle repair (re-split regression): an old checkpoint can carry a dependency
            // cycle introduced by a pre-guard re-split. Prune the NEWEST unproved lemma in
            // each cycle (children are appended last, so recency = array position) until the
            // DAG is acyclic again. Proved lemmas are never pruned.
            const pruned = repairCycles(working.lemmas);
            if (pruned.length) {
                console.log(`[refine] pruned ${pruned.length} lemma(s) to repair a re-split cycle: ${pruned.map(id => id.slice(0, 10)).join(', ')}`);
                this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain, cycleRepair: pruned });
            }
        }

        // Validate AFTER resume + cycle repair: a pre-guard checkpoint can carry a cycle that
        // the repair just healed; validating up-front would reject the whole mission before
        // the heal could run. The repaired working set must be valid to proceed.
        const audit = validateBlueprint(working);
        if (!audit.ok) {
            return { ok: false, error: 'invalid blueprint', errors: audit.errors, refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
        }

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
                    this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain, cycleRepair: pruned });
                    continue;
                }
                return { ok: false, error: 'blueprint became cyclic (unrepairable)', refined: working, proved: [], unproved: working.lemmas.filter(l => !l.proof).map(l => l.id), rounds };
            }

            const provenIds = new Set(working.lemmas.filter(l => l.proof).map(l => l.id));
            const next = order.map(id => working.lemmas.find(l => l.id === id))
                .find(l => !l.proof && !l.stalled && (l.deps ?? []).every(d => provenIds.has(d)));
            if (!next) {
                const stillWorkable = working.lemmas.find(l => !l.proof && !l.stalled
                    && (l.deps ?? []).every(d => provenIds.has(d)));
                if (!stillWorkable) {
                    // Deadlock-release path: every non-stalled unproved lemma is dependency-
                    // blocked, and the only READY lemmas are stalled ones. A stalled lemma is
                    // the only path forward (its deps are proved; a fresh attempt may succeed).
                    // This is NOT the anti-waste case — that rule forbids re-attempting stalled
                    // lemmas while other work exists. The retry budget is ONE attempt per lemma
                    // per refine cycle; a failed attempt re-stalls it and further cycles decide
                    // again.
                    const stalledReady = working.lemmas.find(l => !l.proof && l.stalled
                        && !stalledRetried.has(l.id)
                        && (l.deps ?? []).every(d => provenIds.has(d)));
                    if (stalledReady) {
                        stalledReady.stalled = false;
                        stalledRetried.add(stalledReady.id);
                        continue; // next iteration picks it as `next`
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

            const before = working.lemmas.length;
            const round = await this._attempt(next, working);
            guard++;
            console.log(`[refine] round ${guard}/${this.maxRounds} lemma ${next.id.slice(0, 10)}… proved=${round.proved} resplit=${round.resplit} added=${round.added} error=${round.error ?? '(none)'}`);
            rounds.push({ id: next.id, ok: round.proved, resplit: round.resplit, added: round.added, error: round.error ?? null });
            if (round.hashChainEntry) hashChain.push(round.hashChainEntry);
            // The warm worker survives the loop's endLemma (leased worker is separate — killed
            // and replaced by workerPerProblem). No re-warm needed — the warm env is intact.
            const madeProgress = round.proved || working.lemmas.length > before;
            // Checkpoint after every round — progress or not. A stalled lemma (no progress,
            // no new children) must still persist the round history + hash chain, or a crash
            // mid-run loses the stalls that the resume logic needs to skip.
            this.checkpoint?.save({ lemmas: working.lemmas, rounds, hashChain });
            if (!madeProgress) {
                // A stalled lemma becomes retryable only when a DEPENDENCY was proved — not when
                // any unrelated lemma progresses. Marked stalled here; un-stalled below only for
                // lemmas whose deps were just proved.
                next.stalled = true;
                continue;
            }
            if (round.proved) {
                // Un-stall only the dependents of the just-proved lemma: they are the ones whose
                // situation changed. Global clearing wasted budget re-attempting unrelated
                // stalled lemmas (observed: 6 lemmas re-attempted across resume cycles).
                for (const l of working.lemmas) {
                    if (l.stalled && (l.deps ?? []).includes(next.id)) {
                        delete l.stalled;
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

    async _attempt(stub, working) {
        // §5.7 Stage 2 — exact reuse: a previously-verified statement (same hash) in the store
        // reuses its stored proof with zero LLM spend — but NEVER with zero kernel spend. The
        // stored proof is re-verified against the CURRENT backend/toolchain before it is
        // accepted (retrieval never bypasses verification); a store entry that fails here is a
        // stale entry and the stub falls through to a fresh proof.
        const stmtHash = hashStatement(stub.statement);
        const reused = this.lemmaStore?.get(stmtHash);
        if (reused?.proofScript) {
            try {
                const fullSource = buildProofSource(stub.statement, reused.proofScript);
                const reuseCheck = await this.backend.check(fullSource, { useWarmEnv: false });
                if (reuseCheck.status === 'verified') {
                    stub.proof = reused.proofScript;
                    stub.reuseVerifiedAt = new Date().toISOString();
                    // §5.9: a store hit is a typed `reuse` patch — recorded with its fresh
                    // verification evidence, not a silent shortcut.
                    stub.patchStream = [new Patch({ node: stmtHash, op: 'reuse', replacement: reused.proofScript, scope: 'lemma', meta: { source: reused.statementHash ?? stmtHash, verification: 'verified', verifiedAt: stub.reuseVerifiedAt } })];
                    return { proved: true, resplit: false, added: 0, reused: true };
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
            lemmaStore: this.lemmaStore ?? this.loopOptions.lemmaStore ?? null,
            dataset: this.dataset ?? this.loopOptions.dataset ?? null,
            onEvent: e => {
                this._currentStub = stub;
                lemmaEvents.push(e);
                this._capture(e, lemmaEvents);
                this._currentStub = null;
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
            return { proved: true, resplit: false, added: 0, hashChainEntry: chainEntry };
        }

        const failedEvt = loop.events().filter(e => e.type === 'lemma_failed').pop();
        const loopError = failedEvt?.error?.message ?? failedEvt?.error ?? 'tactic loop failed';

        // Re-split: decompose the failed stub into child stubs via the skeleton generator.
        // The stub statement itself is never edited; only child stubs are added.
        const sub = await this.skeleton.generate(stub.statement);
        if (!sub.ok) {
            console.log(`[refine]   skeleton re-split failed: ${sub.error ?? 'unknown'}`);
            return { proved: false, resplit: false, added: 0, error: loopError };
        }

        const rootId = hashStatement(normalizeStub(stub.statement));
        const subRoot = sub.blueprint.lemmas.find(l => l.id === rootId);
        if (!subRoot) {
            console.log(`[refine]   skeleton root not found in re-split (rootId=${rootId.slice(0,10)}…)`);
            return { proved: false, resplit: false, added: 0 };
        }

        const known = new Set(working.lemmas.map(l => l.id));
        let added = 0;
        for (const child of sub.blueprint.lemmas) {
            if (child.id === rootId) continue;
            if (!known.has(child.id)) {
                working.lemmas.push(child);
                added++;
            }
        }
        // Validate the MERGED set: a child's deps can close a cycle through the parent or an
        // existing lemma. repairCycles prunes the newest unproved nodes (exactly the children
        // just added) until the DAG is acyclic again — the re-split never corrupts the graph.
        const mergedAudit = validateBlueprint({ theorem: working.lemmas[0]?.statement ?? '', lemmas: working });
        if (!mergedAudit.ok && /cycle/i.test(mergedAudit.errors.join(' '))) {
            const pruned = repairCycles(working);
            if (pruned.length) {
                console.log(`[refine]   re-split would have created a cycle; pruned ${pruned.length} child lemma(s): ${pruned.map(id => id.slice(0, 10)).join(', ')}`);
                added = Math.max(0, added - pruned.length);
            }
        }
        console.log(`[refine]   re-split produced ${sub.blueprint.lemmas.length} lemmas, ${added} new`);
        stub.deps = (subRoot.deps ?? []).filter(d => d !== stub.id);
        return { proved: false, resplit: true, added };
    }

    _capture(event, lemmaEvents = []) {
        if (!this.lemmaStore && !this.dataset) return;
        const { statement } = event;
        if (event.type === 'lemma_verified') {
            if (this.lemmaStore) {
                const stub = this._currentStub;
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
