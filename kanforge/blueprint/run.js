// Blueprint CLI: theorem → skeleton (typechecked, pinned, audited) → refine (bottom-up fill,
// re-split) → refined blueprint + LemmaStore/TrainingDataset capture.
//
// CLI: node blueprint/run.js '<theorem>' [--out-dir=<dir>] [--max-rounds=<n>]
//      [--max-tactics=<n>] [--max-goals=<n>] [--concurrency=<n>] [--statement-file=<path>]
//      [--recipe=...] [--use-swiss] [--swiss-n=<n>] [--repulsion] [--repo-dir=<dir>]
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
import { commitLemma, commitDevelopment, writeLemmaArtifacts } from '../growth/commit.js';
import { hashStatement } from '../lean/pin.js';
import { RunCheckpoint } from '../core/checkpoint.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runBlueprintTheorem({ backend, llm, theorem, outDir = null, loopOptions = {}, maxRounds = 200, repoDir = null, provenance = null } = {}) {
    if (!backend || !llm) throw new Error('runBlueprintTheorem requires a real backend and a real llm client');
    if (!theorem || typeof theorem !== 'string') throw new Error('runBlueprintTheorem requires a theorem statement');

    const workDir = outDir ?? path.join(PACKAGE_ROOT, 'runs', `blueprint_${Date.now()}`);
    // GLOBAL accumulated knowledge (§2.8): the lemma store and training dataset are shared
    // across ALL problems — a lemma proved for problem A is reusable for problem B. Everything
    // else (checkpoint, blueprint, events, digest) is scoped to this problem's workDir.
    const lemmaStore = new LemmaStore({ dir: path.join(PACKAGE_ROOT, '..', 'runs', 'lemma-store') });
    const dataset = new TrainingDataset({ dir: path.join(PACKAGE_ROOT, '..', 'runs', 'training-dataset') });

    // Incremental event log: every loop event (goal_selected, tactic_proposed, tactic_failed,
    // etc.) is appended to events.jsonl as it happens, so a crashed run leaves the full
    // proposal/outcome trail on disk for diagnosis. This is the loop's telemetry made
    // inspectable — the event store holds it in memory, the file persists it.
    const eventLogFile = path.join(workDir, 'events.jsonl');
    fs.mkdirSync(workDir, { recursive: true });
    const userOnEvent = loopOptions.onEvent ?? null;
    loopOptions.onEvent = e => {
        fs.appendFileSync(eventLogFile, JSON.stringify(e) + '\n');
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

    const refiner = new BlueprintRefiner({
        llm,
        backend,
        outDir: workDir,
        loopOptions,
        maxRounds,
        lemmaStore,
        dataset
    });
    const refined = await refiner.refine(generated.blueprint);

    // DoD tail (§7.4): assemble + write the development digest (writeup + audit + hash chain),
    // and commit every verified lemma to the scratch repo (P2.3) when repoDir is given.
    const digest = assembleDevelopmentDigest({
        theorem,
        refined,
        statementHash: hashStatement(theorem),
        assumptions: generated.warnings ?? [],
        provenance
    });
    const digestPaths = writeDevelopmentDigest(digest, workDir);

    const commits = [];
    if (repoDir) {
        for (const l of refined.refined.lemmas) {
            if (!l.proof) continue;
            writeLemmaArtifacts({
                repoDir,
                lemmaId: l.id,
                statementHash: hashStatement(l.statement),
                statement: l.statement,
                proofScript: l.proof
            });
            const c = commitLemma({ lemmaId: l.id, statementHash: hashStatement(l.statement), repoDir });
            if (c) commits.push({ lemmaId: l.id, commit: c });
        }
        // The closing development commit captures the digest; write it into the repo first.
        writeDevelopmentDigest(digest, repoDir);
        const devCommit = commitDevelopment({ developmentId: digest.statementHash, statementHash: digest.statementHash, repoDir });
        if (devCommit) commits.push({ lemmaId: 'development', commit: devCommit });
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
            commits
        }
    };
}

export function printBlueprintSummary(r) {
    if (!r.ok) {
        console.log(`\n===== BLUEPRINT FAILED ($stage) =====`, r.stage);
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
        for (const c of r.digest.commits ?? []) console.log(`commit ${c.lemmaId.slice(0, 12)}… ${c.commit}`);
    }
    for (const w of r.warnings ?? []) console.log(`warn: ${w}`);
}

async function main() {
    const { createBackend } = await import('../lean/backend.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

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
        console.error('usage: node blueprint/run.js --problem=<id> --statement-file=<path> [--fresh] [--max-rounds=<n>] [--max-tactics=<n>] [--max-goals=<n>] [--concurrency=<n>] [--recipe=...] [--check-timeout=<ms>] | --list');
        console.error('  --problem: resumes runs/<id>/checkpoint.json when it exists (never overwrites); --fresh starts over by archiving the old dir.');
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
    const maxRounds = Number(argValue(args, '--max-rounds=') ?? 200);
    const maxTactics = Number(argValue(args, '--max-tactics=') ?? 8);
    const maxGoals = Number(argValue(args, '--max-goals=') ?? 100);
    const concurrency = Number(argValue(args, '--concurrency=') ?? 1);
    const repoDir = argValue(args, '--repo-dir=');
    const recipe = argValue(args, '--recipe=') ?? null;
    const useSwiss = args.includes('--use-swiss');
    const swissN = Number(argValue(args, '--swiss-n=') ?? 8);
    const repulsion = args.includes('--repulsion');
    // Cold mathlib imports on a fresh worker can take 3-4 minutes (measured on the Finite.Basic
    // chain); 60s is a warm-worker budget only. Default 240s covers the cold case with margin.
    const checkTimeoutMs = Number(argValue(args, '--check-timeout=') ?? 240_000);

    // The repl pool must survive the COLD mathlib import of the target's statement (the
    // autoformalizer harness uses 180s for the same reason); 60s is a warm-worker budget only.
    const pool = createBackend({ type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN, leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency, timeoutMs: checkTimeoutMs, workerPerProblem: true });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    // Provenance block (architecture.md §5.7): every development report records the model that
    // produced it, so a result is attributable and reproducible. The active model is the value of
    // KANFORGE_LLM_MODEL at run time — flagging it here means a switched model is never ambiguous
    // in the digest.
    const provenance = {
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN ?? null,
        leanProject: ENV.KANFORGE_LEAN_PROJECT ?? null,
        provider: llmConfig.provider ?? null,
        model: llmConfig.model ?? null,
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
            // The cold import of module chains is nondeterministic: fresh .olean loads can be
            // 35s or >180s depending on OS file cache. Retry with escalating timeout so a
            // transient slow start doesn't force every subsequent check to pay cold-import.
            for (const timeout of [checkTimeoutMs, checkTimeoutMs * 2]) {
                try {
                    await pool.warm(theorem, { timeoutMs: timeout });
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
            loopOptions: { concurrency, maxTacticsPerGoal: maxTactics, maxGoalsPerLemma: maxGoals, searchRecipe: recipe ?? undefined, useSwiss, swissN, repulsion },
            maxRounds,
            repoDir,
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
