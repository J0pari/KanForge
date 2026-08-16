import { BackendRepl } from './lean/backendRepl.js';
import { loadEnv } from './env.js';
import { LemmaStore } from './growth/lemmaStore.js';
import { buildReuseSource } from './core/state.js';
import { hashStatement } from './lean/pin.js';
import fs from 'node:fs';

const ENV = loadEnv();
const backend = new BackendRepl({
    replBin: ENV.KANFORGE_REPL_BIN,
    toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
    leanProject: ENV.KANFORGE_LEAN_PROJECT,
    concurrency: 2,
    timeoutMs: 300000
});
const store = new LemmaStore({ dir: './runs/lemma-store' });
const ck = JSON.parse(fs.readFileSync('./runs/erdos10_v6/checkpoint.json', 'utf8'));
const stub = ck.lemmas.find(x => x.id.startsWith('6404faafaa'));
console.log('stub:', stub.statement.split('\n').pop());

const goal = 'a + 1 = Nat.succ a';
const exact = store.findByGoal(goal);
console.log('findByGoal:', exact?.lemmaName ?? 'null');
const ranked = store.rankByGoal(goal, [], { limit: 3 });
console.log('ranked:', ranked.map(r => r.lemmaName + '(' + r.score.toFixed(1) + ')').join(', '));

for (const [i, cand] of [exact, ...ranked].filter(Boolean).slice(0, 3).entries()) {
    const storedHash = hashStatement(cand.statement);
    const variants = [
        ['closure+exact', buildReuseSource({ store, statement: stub.statement, proofScript: `by exact ${cand.lemmaName}`, closureOf: storedHash, includeClosureRoot: true })],
        ['deps+body', buildReuseSource({ store, statement: stub.statement, proofScript: cand.proofScript, closureOf: storedHash })],
        ['exact-only', buildReuseSource({ store, statement: stub.statement, proofScript: `by exact ${cand.lemmaName}` })],
        ['body-only', buildReuseSource({ store, statement: stub.statement, proofScript: cand.proofScript })]
    ];
    for (const [label, src] of variants) {
        const r = await backend.check(src, { useWarmEnv: false, timeoutMs: 300000 });
        console.log(`cand${i} ${cand.lemmaName} [${label}]: ${r.status}` + (r.error ? ' | ' + String(r.error.message ?? r.error).slice(0, 110) : ''));
        if (r.status !== 'verified') {
            // print the offending region: the last declaration of the source
            const lines = src.split('\n');
            console.log('   last 4 lines: ' + lines.slice(-4).join(' // ').slice(0, 220));
        }
        if (r.status === 'verified') break;
    }
}
await backend.shutdown(3000);
