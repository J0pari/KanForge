// Blueprint CLI: theorem → skeleton (typechecked, pinned, audited) → refine (bottom-up fill,
// re-split) → refined blueprint + LemmaStore/TrainingDataset capture.
//
// CLI: node blueprint/run.js '<theorem>' [--out-dir=<dir>] [--max-rounds=<n>]
//      [--max-tactics=<n>] [--concurrency=<n>]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkeletonGenerator } from './skeleton.js';
import { BlueprintRefiner } from './refine.js';
import { LemmaStore } from '../growth/lemmaStore.js';
import { TrainingDataset } from '../growth/dataset.js';
import { assembleDevelopmentDigest, writeDevelopmentDigest } from '../digest/development.js';
import { commitLemma, commitDevelopment, writeLemmaArtifacts } from '../growth/commit.js';
import { hashStatement } from '../lean/pin.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runBlueprintTheorem({ backend, llm, theorem, outDir = null, loopOptions = {}, maxRounds = 200, repoDir = null, provenance = null } = {}) {
    if (!backend || !llm) throw new Error('runBlueprintTheorem requires a real backend and a real llm client');
    if (!theorem || typeof theorem !== 'string') throw new Error('runBlueprintTheorem requires a theorem statement');

    const workDir = outDir ?? path.join(PACKAGE_ROOT, 'runs', `blueprint_${Date.now()}`);
    const lemmaStore = new LemmaStore({ dir: path.join(workDir, 'lemma-store') });
    const dataset = new TrainingDataset({ dir: path.join(workDir, 'training-dataset') });

    const skeleton = new SkeletonGenerator({ llm, backend, outDir: workDir });
    const generated = await skeleton.generate(theorem);
    if (!generated.ok) {
        return { ok: false, stage: 'skeleton', error: generated.error, errors: generated.errors ?? [], workDir, stored: { lemmas: 0, samples: 0 } };
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
    const theorem = args.find(a => !a.startsWith('--'));
    if (!theorem) {
        console.error('usage: node blueprint/run.js "<theorem>" [--out-dir=<dir>] [--max-rounds=<n>] [--max-tactics=<n>] [--concurrency=<n>] [--repo-dir=<dir>]');
        process.exit(2);
    }
    const outDir = argValue(args, '--out-dir=');
    const maxRounds = Number(argValue(args, '--max-rounds=') ?? 200);
    const maxTactics = Number(argValue(args, '--max-tactics=') ?? 8);
    const concurrency = Number(argValue(args, '--concurrency=') ?? 1);
    const repoDir = argValue(args, '--repo-dir=');

    const pool = createBackend({ type: 'repl', replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN, leanProject: ENV.KANFORGE_LEAN_PROJECT, concurrency, timeoutMs: 60_000 });
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
        const r = await runBlueprintTheorem({
            backend: pool,
            llm,
            theorem,
            outDir,
            loopOptions: { concurrency, maxTacticsPerGoal: maxTactics },
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
