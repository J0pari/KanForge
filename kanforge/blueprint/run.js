// Blueprint CLI: theorem → skeleton (typechecked, pinned, audited) → refine (bottom-up fill,
// re-split) → refined blueprint + effectiveStore/TrainingDataset capture.
//
// CLI: node blueprint/run.js '<theorem>' [--out-dir=<dir>] [--max-rounds=<n>]
//      [--max-tactics=<n>] [--max-goals=<n>] [--concurrency=<n>] [--statement-file=<path>]
//      [--recipe=...] [--use-swiss] [--swiss-n=<n>] [--repulsion]
//
// --statement-file: read the theorem from a file instead of argv — unicode Lean statements are
// mangled by some shells' argv encoding (observed: Windows PowerShell corrupts ∀ ∧ → ≠), so the
// file form is the robust path for corpus statements.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SkeletonGenerator } from './skeleton.js';
import { BlueprintRefiner } from './refine.js';
import { LemmaStore } from '../growth/lemmaStore.js';
import { TrainingDataset } from '../growth/dataset.js';
import { assembleDevelopmentDigest, writeDevelopmentDigest } from '../digest/development.js';
import { writeLemmaArtifacts } from '../growth/commit.js';
import { hashStatement } from '../lean/pin.js';
import { RunCheckpoint } from '../core/checkpoint.js';
import { compilePredictorsFromDataset } from '../optimization/causal.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';
import { PREMS_STEP_1 } from '../bench/premisesCorpus.js';
import { mergePremiseCorpora, premisesFromLemmas, loadHarvestFile } from '../search/livePremises.js';
import { assembleProvenance } from '../core/provenance.js';
import { computePassKpis } from '../optimization/kpis.js';
import * as reg from '../config/registry.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runBlueprintTheorem({ backend, llm, theorem, outDir = null, loopOptions = {}, maxRounds = 50000, provenance = null, lemmaStore = null, dataset = null } = {}) {
    if (!backend || !llm) throw new Error('runBlueprintTheorem requires a real backend and a real llm client');
    if (!theorem || typeof theorem !== 'string') throw new Error('runBlueprintTheorem requires a theorem statement');

    const workDir = outDir ?? path.join(PACKAGE_ROOT, 'runs', `blueprint_${Date.now()}`);
    const passStartMs = Date.now();
    // Snapshot for the pass telemetry: how many lemmas were already proved when this pass
    // started (from the checkpoint, if any).
    const preCkpt = new RunCheckpoint(workDir);
    const provedBeforeCount = (preCkpt.load()?.lemmas ?? []).filter(l => l.proof).length;
    // GLOBAL accumulated knowledge (§2.8): the lemma store and training dataset are shared
    // across ALL problems — a lemma proved for problem A is reusable for problem B. Everything
    // else (checkpoint, blueprint, events, digest) is scoped to this problem's workDir.
    // Tests inject isolated stores (mock-verified lemmas must never pollute the live globals).
    const effectiveStore = lemmaStore ?? new LemmaStore({ dir: path.join(PACKAGE_ROOT, '..', 'runs', 'lemma-store') });
    const effectiveDataset = dataset ?? new TrainingDataset({ dir: path.join(PACKAGE_ROOT, '..', 'runs', 'training-dataset') });

    // Temporal held-out predictor mining (§6.2): compile failure predictors from the GLOBAL
    // dataset at run start. Every sample in it was appended by a prior run or prior cycle, so
    // the reject gate cannot be contaminated by this cycle's outcomes. The compiled matcher is
    // subject to the §6 support/confidence gates; without enough prior data it is inert.
    const heldOutPredictors = compilePredictorsFromDataset(effectiveDataset.samples);
    if (heldOutPredictors.count > 0) {
        console.log(`[blueprint] predictors mined from prior data: ${heldOutPredictors.count} active (${heldOutPredictors.inert} inert)`);
    }
    if (heldOutPredictors.count > 0) loopOptions.predictors = heldOutPredictors;

    // Incremental event log: every loop event (goal_selected, tactic_proposed, tactic_failed,
    // etc.) is appended to events.jsonl as it happens, so a crashed run leaves the full
    // proposal/outcome trail on disk for diagnosis. This is the loop's telemetry made
    // inspectable — the event store holds it in memory, the file persists it.
    const eventLogFile = path.join(workDir, 'events.jsonl');
    fs.mkdirSync(workDir, { recursive: true });
    const userOnEvent = loopOptions.onEvent ?? null;
    const passEvents = []; // in-memory pass slice — the KPI computation reads it, the file persists it
    loopOptions.onEvent = e => {
        fs.appendFileSync(eventLogFile, JSON.stringify(e) + '\n');
        passEvents.push(e);
        userOnEvent?.(e);
    };
    console.log(`[blueprint] event log -> ${eventLogFile}`);

    // Resume: if a previous run wrote a checkpoint (the skeleton passed), reload the blueprint
    // and skip the skeleton call. The refiner auto-loads from the checkpoint on refine().
    let generated;
    const ckpt = new RunCheckpoint(workDir);
    const resumeData = ckpt.load();
    if (resumeData && resumeData.lemmas?.length) {
        const theoremLemma = resumeData.lemmas.find(l => l.statement === theorem || l.pinnedHash === hashStatement(theorem));
        if (theoremLemma) {
            generated = { ok: true, blueprint: { theorem, lemmas: resumeData.lemmas.map(l => ({ id: l.id, statement: l.statement, deps: l.deps ?? [], pinnedHash: l.pinnedHash ?? l.id })) }, warnings: [] };
            console.log(`[blueprint] resuming from checkpoint: ${resumeData.rounds?.length ?? 0} rounds, ${resumeData.lemmas.length} lemmas`);
        }
    }
    if (!generated && fs.existsSync(path.join(workDir, 'blueprint.json'))) {
        // Skeleton completed previously but no checkpoint was written (crash before refine
        // round 1). Resume from the persisted blueprint — no re-skeleton.
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(workDir, 'blueprint.json'), 'utf8'));
            if (saved.lemmas?.length) {
                generated = { ok: true, blueprint: saved, warnings: [] };
                console.log(`[blueprint] resuming from blueprint.json: ${saved.lemmas.length} lemmas (no checkpoint — refine resumes fresh)`);
            }
        } catch { /* corrupt blueprint.json — fall through to fresh skeleton */ }
    }
    if (!generated) {
        const skeleton = new SkeletonGenerator({ llm, backend, outDir: workDir });
        generated = await skeleton.generate(theorem);
        if (!generated.ok) {
            return { ok: false, stage: 'skeleton', error: generated.error, errors: generated.errors ?? [], workDir, stored: { lemmas: 0, samples: 0 } };
        }
    }

    // §5.2 live premise corpus: the retrieval engine (search/premises.js) is wired through
    // TacticLoop -> SearchEngine -> proposal prompts; this is the corpus source for the LIVE
    // path — curated kernel-verified base + mission-proved lemmas (statement-name+type) + the
    // global lemma store (cross-problem transfer) + the #check harvest accumulated by prior
    // passes. The corpus grows every pass; a pass without --premises leaves it null (inert).
    if (loopOptions.premisesEnabled && !loopOptions.premises?.length) {
        const missionProved = (resumeData?.lemmas ?? []).filter(l => l.proof);
        const storeEntries = effectiveStore.list().map(e => ({ statement: e.statement, proof: e.proofScript ?? 'x' }));
        const corpus = mergePremiseCorpora([
            PREMS_STEP_1,
            premisesFromLemmas(missionProved),
            premisesFromLemmas(storeEntries),
            loadHarvestFile(path.join(workDir, 'premise-harvest.jsonl'))
        ]);
        if (corpus.length) {
            loopOptions.premises = corpus;
            console.log(`[blueprint] live premise corpus: ${corpus.length} premises (curated base + mission-proved + global store + harvest)`);
        }
    }

    const refiner = new BlueprintRefiner({
        llm,
        backend,
        outDir: workDir,
        loopOptions,
        maxRounds,
        lemmaStore: effectiveStore,
        dataset: effectiveDataset
    });
    const refined = await refiner.refine(generated.blueprint);

    // Pass telemetry (machine-readable, one JSON line per pass): the ablation layer consumes
    // this series — config, cost, and outcome per pass — for component recommendations and the
    // amortized-cost curve. Lean by design: counts + config only, the full stream stays in
    // events.jsonl. Carries the MANDATORY provenance block (§5.7) and the verification-
    // throughput KPIs (optimization/kpis.js) — a pass row is self-auditable on its own.
    const passSummary = {
        passAt: new Date().toISOString(),
        wallMs: Date.now() - passStartMs,
        config: { recipe: loopOptions.searchRecipe ?? null, maxTacticsPerGoal: loopOptions.maxTacticsPerGoal ?? null, menu: loopOptions.menu ?? null, exemplars: loopOptions.exemplars ?? null, predictors: loopOptions.predictors?.count ?? null, searchStructure: loopOptions.searchStructure ?? null, safeLadder: loopOptions.safeLadder ?? null, campaignMemory: loopOptions.campaignMemory ?? null, repair: loopOptions.repair ?? null },
        provenance,
        ...computePassKpis({ events: passEvents, rounds: refined.rounds, backendInfos: typeof backend.getInfos === 'function' ? backend.getInfos() : null }),
        proved: refined.proved.length,
        unproved: refined.unproved.length,
        roundsRun: refined.rounds.length,
        resplits: refined.rounds.filter(r => r.resplit).length,
        kernelRejects: refined.rounds.filter(r => /guardrails rejected|KERNEL_REJECTED/.test(r.error ?? '')).length,
        stopReason: refined.stopReason ?? null,
        maxRoundsReached: refined.maxRoundsReached ?? false,
        lemmas: refined.refined.lemmas.length,
        provedBefore: provedBeforeCount
    };
    fs.appendFileSync(path.join(workDir, 'passes.ndjson'), JSON.stringify(passSummary) + '\n');
    // Per-pass KPI series — the verification-throughput curve (§5.7 KPIs): every pass appends
    // one line so cost-per-verified-theorem trends are readable without replaying events.
    fs.appendFileSync(path.join(workDir, 'kpis.ndjson'), JSON.stringify(passSummary.passKpis) + '\n');

    if (!refined.ok) {
        // DoD (§7.4, build_order "Definition of done (a live pipeline test)"): the digest +
        // artifacts are the completion record. An incomplete mission gets a STATUS record, not
        // a digest that would masquerade as a finished result.
        const status = {
            state: 'incomplete',
            proved: refined.proved.length,
            unproved: refined.unproved.length,
            stopReason: refined.stopReason ?? null,
            rounds: refined.rounds.length,
            savedAt: new Date().toISOString(),
            workDir
        };
        fs.writeFileSync(path.join(workDir, 'mission-status.json'), JSON.stringify(status, null, 2));
        // Remove any stale digest from an earlier campaign state so the workdir never shows a
        // finished-looking digest for an unfinished mission.
        for (const f of ['development.json', 'development.md', 'development.html']) {
            const p = path.join(workDir, f);
            if (fs.existsSync(p)) fs.rmSync(p);
        }
        return {
            ok: false,
            stage: 'refine',
            refined,
            blueprint: generated.blueprint,
            warnings: generated.warnings ?? [],
            workDir,
            status
        };
    }

    // DoD tail (§7.4): assemble + write the development digest (writeup + audit + hash chain),
    // and write every verified lemma's artifacts (statement + proof + audit) into the problem
    // workdir. The digest's hash chain is the publication record — files, not git narration.
    const digest = assembleDevelopmentDigest({
        theorem,
        refined,
        statementHash: hashStatement(theorem),
        assumptions: generated.warnings ?? [],
        provenance
    });
    const digestPaths = writeDevelopmentDigest(digest, workDir);

    const artifacts = [];
    for (const l of refined.refined.lemmas) {
        if (!l.proof) continue;
        const artifactDir = writeLemmaArtifacts({
            workDir,
            lemmaId: l.id,
            statementHash: hashStatement(l.statement),
            statement: l.statement,
            proofScript: l.proof
        });
        artifacts.push({ lemmaId: l.id, dir: artifactDir });
    }

    return {
        ok: refined.ok,
        stage: 'refine',
        refined,
        blueprint: generated.blueprint,
        warnings: generated.warnings ?? [],
        workDir,
        digest: {
            hashChainHash: digest.hashChainHash,
            paths: digestPaths,
            artifacts
        }
    };
}

export function printBlueprintSummary(r) {
    if (!r.ok) {
        const reason = r.refined?.stopReason ?? null;
        const unproved = r.refined?.unproved?.length ?? '?';
        const maxRounds = r.refined?.maxRoundsReached === true;
        const headline = reason === 'no-ready-lemma'
            ? `===== MISSION INCOMPLETE (no ready lemma: ${unproved} unproved, all ready work stalled or dependency-blocked) =====`
            : reason === 'dependency-idle'
                ? `===== MISSION INCOMPLETE (dependency idle: ${unproved} unproved, nothing dispatchable) =====`
                : maxRounds
                    ? `===== MISSION INCOMPLETE (round cap reached; resume with --problem=<id> to continue) =====`
                    : `===== BLUEPRINT FAILED (${r.stage ?? 'unknown stage'}) =====`;
        console.log(`\n${headline}`);
        if (r.error) console.log(`error: ${r.error}`);
        for (const e of r.errors ?? []) console.log(`  - ${e}`);
        console.log(`workDir: ${r.workDir}`);
        return;
    }
    console.log('\n===== BLUEPRINT REFINED =====');
    for (const l of r.refined.refined.lemmas) {
        const ok = l.proof ? 'PROVED' : 'OPEN  ';
        const proofHead = l.proof ? l.proof.split('\n').slice(0, 2).join(' | ') : '(unproved)';
        console.log(`${ok} ${l.id.slice(0, 12)}… ${l.statement}`);
        console.log(`      ${proofHead}`);
    }
    console.log(`Proved: ${r.refined.proved.length}/${r.refined.refined.lemmas.length}, rounds: ${r.refined.rounds.length}, stored: lemmas=${r.refined.stored.lemmas} samples=${r.refined.stored.samples}`);
    console.log(`workDir: ${r.workDir}`);
    if (r.digest) {
        console.log(`digest: development.md / development.html / development.json`);
        if (r.digest.hashChainHash) console.log(`chain-head: ${r.digest.hashChainHash}`);
        for (const a of r.digest.artifacts ?? []) console.log(`artifact ${a.lemmaId.slice(0, 12)}… ${a.dir}`);
    }
    for (const w of r.warnings ?? []) console.log(`warn: ${w}`);
}

async function main() {
    const { createBackend } = await import('../lean/backend.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const { applyRecommendations, loadRecommendedDefaults } = await import('../config/registry.js');
    const ENV = loadEnv();

    // Recommended defaults (registry output surface): the ablation graph writes
    // runs/defaults.json; the live path consumes it. CLI flags always override.
    const defaultsFile = path.join(PACKAGE_ROOT, '..', 'runs', 'defaults.json');
    applyRecommendations(loadRecommendedDefaults(defaultsFile));

    const args = process.argv.slice(2);
    const problemId = argValue(args, '--problem=');
    const fresh = args.includes('--fresh');
    if (args.includes('--list')) {
        const runsRoot = path.join(PACKAGE_ROOT, '..', 'runs');
        console.log('problem | rounds | proved | lemmas | last-save');
        for (const d of fs.readdirSync(runsRoot, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('blueprint_')) continue;
            try {
                const ck = JSON.parse(fs.readFileSync(path.join(runsRoot, d.name, 'checkpoint.json'), 'utf8'));
                console.log(`${d.name} | ${ck.rounds?.length ?? 0} | ${ck.lemmas?.filter(l=>l.proof).length ?? 0} | ${ck.lemmas?.length ?? 0} | ${ck.savedAt ?? '?'}`);
            } catch {
                console.log(`${d.name} | (no checkpoint)`);
            }
        }
        process.exit(0);
    }
    const theoremFile = argValue(args, '--statement-file=');
    const theorem = theoremFile ? fs.readFileSync(theoremFile, 'utf8').trim() : args.find(a => !a.startsWith('--'));
    if (!theorem) {
        console.error('usage: node blueprint/run.js --problem=<id> --statement-file=<path> [--fresh] [--max-rounds=<n>] [--max-tactics=<n>] [--max-goals=<n>] [--concurrency=<n>] [--recipe=...] [--repulsion] [--menu] [--exemplars] [--premises] [--ttrl] [--monitor] [--no-repair] [--check-timeout=<ms>] | --list');
        console.error('  --problem: resumes runs/<id>/checkpoint.json when it exists (never overwrites); --fresh starts over by archiving the old dir.');
        console.error('  component toggles default to the registry recommendations in runs/defaults.json (ablation output); flags override.');
        process.exit(2);
    }
    const outDir = argValue(args, '--out-dir=') ?? (problemId ? path.join(PACKAGE_ROOT, '..', 'runs', problemId) : null);
    if (fresh && outDir) {
        const backup = `${outDir}.archive.${Date.now()}`;
        if (fs.existsSync(outDir)) {
            fs.renameSync(outDir, backup);
            console.log(`[${new Date().toTimeString().slice(0,8)}] [blueprint] archived existing work -> ${backup}`);
        }
    }
    const maxRounds = Number(argValue(args, '--max-rounds=') ?? 50000);
    const maxTactics = Number(argValue(args, '--max-tactics=') ?? Number(reg.effectiveValue('maxTacticsPerGoal')));
    const maxGoals = Number(argValue(args, '--max-goals=') ?? Number(reg.effectiveValue('maxGoalsPerLemma')));
    const concurrency = Number(argValue(args, '--concurrency=') ?? 2);
    const recipe = argValue(args, '--recipe=') ?? reg.effectiveValue('recipe');
    const useSwiss = args.includes('--use-swiss');
    const swissN = Number(argValue(args, '--swiss-n=') ?? 8);
    const repulsion = args.includes('--repulsion') || reg.effectiveValue('repulsion');
    const menu = args.includes('--menu') || reg.effectiveValue('tacticMenu');
    const exemplars = args.includes('--exemplars') || reg.effectiveValue('exemplars');
    const ttrl = args.includes('--ttrl') || reg.effectiveValue('ttrl');
    const monitor = args.includes('--monitor') || reg.effectiveValue('monitor');
    const premises = args.includes('--premises') || reg.effectiveValue('premises');
    const repair = !args.includes('--no-repair') && reg.effectiveValue('repair');
    // searchStructure / safeLadder / campaignMemory are registry components (§5.12): the
    // ablation writes their recommendations to runs/defaults.json and the live path consumes
    // them here — a measured searchStructure change propagates to every structure consumer.
    const searchStructure = argValue(args, '--search-structure=') ?? reg.effectiveValue('searchStructure');
    const safeLadder = !args.includes('--no-safe-ladder') && reg.effectiveValue('safeLadder');
    const campaignMemory = !args.includes('--no-campaign-memory') && reg.effectiveValue('campaignMemory');
    const rankedReuse = !args.includes('--no-ranked-reuse') && reg.effectiveValue('rankedReuse');
    const reuseRankLimit = Number(reg.effectiveValue('reuseRankLimit'));
    const reuseRankedChecks = Number(reg.effectiveValue('reuseRankedChecks'));
    // Cold mathlib imports on a fresh worker can take 3-4 minutes (measured on the Finite.Basic
    // chain); 60s is a warm-worker budget only. Default from the registry (ablation-measurable);
    // covers the cold case with margin.
    const checkTimeoutMs = Number(argValue(args, '--check-timeout=') ?? Number(reg.effectiveValue('checkTimeoutMs')));

    // The repl pool must survive the COLD mathlib import of the target's statement (the
    // autoformalizer harness uses 180s for the same reason); 60s is a warm-worker budget only.
    const pool = createBackend({ type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN, leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency: Math.max(2, concurrency), timeoutMs: checkTimeoutMs, workerPerProblem: true });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    // Provenance block (§5.7, core/provenance.js): the MANDATORY benchmark block — provider/model/
    // runtime, toolchain, mathlib+repl revs, kanforge commit, the effective component settings the
    // run actually used, its budget, and the seed. Carried by the digest AND the per-pass
    // telemetry (passes.ndjson), so any benchmark row can be tied back to the exact stack.
    const provenance = {
        ...assembleProvenance({
            provider: llmConfig.provider,
            model: llmConfig.model,
            toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
            leanProject: ENV.KANFORGE_LEAN_PROJECT,
            packageRoot: PACKAGE_ROOT,
            components: {
                recipe, maxTacticsPerGoal: maxTactics, maxGoalsPerLemma: maxGoals,
                maxLlmCalls: Number(reg.effectiveValue('maxLlmCalls')),
                repulsion, premises, tacticMenu: menu, predictors: reg.effectiveValue('predictors'),
                exemplars, ttrl, monitor, repair, searchStructure, safeLadder, campaignMemory,
                rankedReuse, reuseRankLimit, reuseRankedChecks,
                checkTimeoutMs, concurrency
            },
            budget: { maxTacticsPerGoal: maxTactics, maxGoalsPerLemma: maxGoals, maxRounds, concurrency, checkTimeoutMs },
            seed: 'none' // no seeded randomness in the live loop (predictor exploration is unseeded)
        }),
        leanProject: ENV.KANFORGE_LEAN_PROJECT ?? null,
        promptVersion: null // prompts are inline in agent/prompts.js; a version constant is §5.8 backlog
    };
    console.log(`[blueprint] model: ${llmConfig.provider}/${llmConfig.model} (KANFORGE_LLM_MODEL)`);

    try {
        // Warm the pool with the target's imports BEFORE refining: the cold mathlib import is
        // paid once here, and every lemma session continues from the warm env (the same
        // statement-mode chaining the autoformalizer uses) — no re-import per lemma.
        if (pool.warm) {
            console.log(`[blueprint] warming pool with target imports (cold mathlib import — one-time)`);
            const warmStart = Date.now();
            let warmOk = false;
            // Warm with the target's imports PLUS the re-split stub tactic modules: the warm env
            // then covers both the mission imports and the tactic universe child stubs rely on,
            // so warm-path checks (reuse re-verification, repair, skeleton typechecks) don't fall
            // back to cold env rebuilds.
            const warmStatement = `${STUB_TACTIC_MODULES.map(m => `import ${m}`).join('\n')}\n\n${theorem}`;
            // The cold import of module chains is nondeterministic: fresh .olean loads can be
            // 35s or >180s depending on OS file cache. Retry with escalating timeout so a
            // transient slow start doesn't force every subsequent check to pay cold-import.
            for (const timeout of [checkTimeoutMs, checkTimeoutMs * 2]) {
                try {
                    await pool.warm(warmStatement, { timeoutMs: timeout });
                    warmOk = true;
                    break;
                } catch (err) {
                    console.warn(`[blueprint] warm attempt at ${timeout/1000}s failed after ${((Date.now()-warmStart)/1000).toFixed(1)}s: ${err?.message ?? err}`);
                }
            }
            if (warmOk) {
                console.log(`[blueprint] warm completed in ${((Date.now()-warmStart)/1000).toFixed(1)}s`);
            }
        }
        const r = await runBlueprintTheorem({
            backend: pool,
            llm,
            theorem,
            outDir,
            loopOptions: { concurrency, maxTacticsPerGoal: maxTactics, maxGoalsPerLemma: maxGoals, searchRecipe: recipe ?? undefined, useSwiss, swissN, repulsion, menu, exemplars, ttrl, monitor, repair, searchStructure, safeLadder, campaignMemory, rankedReuse, reuseRankLimit, reuseRankedChecks, premisesEnabled: premises },
            maxRounds,
            provenance
        });
        printBlueprintSummary(r);
        if (!r.ok) process.exit(1);
    } finally {
        await pool.shutdown(3000);
    }
}

function argValue(args, prefix) {
    const hit = args.find(a => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('blueprint/run.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
