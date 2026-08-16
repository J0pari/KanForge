import { BackendRepl } from './lean/backendRepl.js';
import { loadEnv } from './env.js';
import { LemmaStore } from './growth/lemmaStore.js';
import { ReuseEngine } from './agent/reuseEngine.js';
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
const provedConc = new Set();
for (const l of ck.lemmas) if (l.proof) {
    const m = String(l.statement).match(/:([\s\S]*?):=\s*by\s+sorry\s*$/);
    if (m) provedConc.add(m[1].replace(/\s+/g, ' ').trim());
}
const unproved = ck.lemmas.filter(l => !l.proof && !l.stalled);
let tried = 0, solved = 0;
for (const l of unproved) {
    const m = String(l.statement).match(/:([\s\S]*?):=\s*by\s+sorry\s*$/);
    if (!m) continue;
    if (provedConc.has(m[1].replace(/\s+/g, ' ').trim())) continue; // skip exact-match class
    if (tried >= 5) break;
    tried++;
    const goal = m[1].replace(/\s+/g, ' ').trim();
    const graph = {
        rootId: 'root',
        classes: new Map([['root', { state: 'OPEN' }]]),
        isRootSolved: () => graph.classes.get('root').state === 'SOLVED',
        currentGoal: () => ({ type: goal, context: [] }),
        setDirectProof: (id, p) => { graph.classes.get(id).directProof = p; }
    };
    const events = [];
    const engine = new ReuseEngine({ backend, store, rankLimit: 3, maxRankedChecks: 4 });
    const r = await engine.tryRoot({ statement: l.statement, lemmaId: l.id, graph, onReuse: e => events.push(e) });
    const reuseEvt = events.find(e => e.type === 'store_reuse');
    console.log((l.id ?? '').slice(0, 10) + ' | goal: ' + goal.slice(0, 60));
    console.log('   -> ' + (r ? 'PROVED via ' + (reuseEvt?.via ?? '?') + ' (' + (reuseEvt?.lemma ?? '') + ')' : 'not proved'));
    if (r) solved++;
}
console.log('integration result: ' + solved + '/' + tried + ' exact-miss stubs proved by ranked reuse');
await backend.shutdown(3000);
