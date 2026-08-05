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

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export async function runBlueprintTheorem({ backend, llm, theorem, outDir = null, loopOptions = {}, maxRounds = 200 } = {}) {
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
    return {
        ok: refined.ok,
        stage: 'refine',
        refined,
        blueprint: generated.blueprint,
        warnings: generated.warnings ?? [],
        workDir
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
    for (const w of r.warnings ?? []) console.log(`warn: ${w}`);
}

async function main() {
    const { BackendRepl } = await import('../lean/backendRepl.js');
    const { loadLLMConfig, createLLM } = await import('../agent/llm.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

    const args = process.argv.slice(2);
    const theorem = args.find(a => !a.startsWith('--'));
    if (!theorem) {
        console.error('usage: node blueprint/run.js "<theorem>" [--out-dir=<dir>] [--max-rounds=<n>] [--max-tactics=<n>] [--concurrency=<n>]');
        process.exit(2);
    }
    const outDir = argValue(args, '--out-dir=');
    const maxRounds = Number(argValue(args, '--max-rounds=') ?? 200);
    const maxTactics = Number(argValue(args, '--max-tactics=') ?? 8);
    const concurrency = Number(argValue(args, '--concurrency=') ?? 1);

    const pool = new BackendRepl({ replBin: ENV.KANFORGE_REPL_BIN, toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN, concurrency, timeoutMs: 60_000 });
    const llmConfig = loadLLMConfig(ENV);
    const llm = createLLM({ ...llmConfig, retries: 3 });

    try {
        const r = await runBlueprintTheorem({
            backend: pool,
            llm,
            theorem,
            outDir,
            loopOptions: { concurrency, maxTacticsPerGoal: maxTactics },
            maxRounds
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
