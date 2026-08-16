import { BackendRepl } from './lean/backendRepl.js';
import { loadEnv } from './env.js';
import { LemmaStore } from './growth/lemmaStore.js';
import { ReuseEngine } from './agent/reuseEngine.js';
import { createGoalStateGraph } from './core/goalStateGraph.js';

const ENV = loadEnv();
const backend = new BackendRepl({
    replBin: ENV.KANFORGE_REPL_BIN,
    toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
    leanProject: ENV.KANFORGE_LEAN_PROJECT,
    concurrency: 2,
    timeoutMs: 300000
});
const store = new LemmaStore({ dir: './runs/lemma-store' });

// The probe goal from the earlier failure: Even (2^(2^(k+1))) with twopow_even_exp retrieved.
const STMT = 'import Mathlib.Algebra.Group.Even\nimport Mathlib.Data.Nat.Prime.Defs\nimport Mathlib.Data.Set.Finite.Basic\n\ntheorem even_two_pow_two_pow_probe : ∀ k : Nat, Even (2 ^ (2 ^ (k + 1))) := by sorry';
const goals = await backend.extractGoals(STMT);
const graph = await createGoalStateGraph('transposition', {});
graph.setRoot(goals[0]);

const events = [];
const engine = new ReuseEngine({ backend, store, rankLimit: 3, maxRankedChecks: 4, maxTransferOps: 4 });
const r = await engine.tryRoot({ statement: STMT, lemmaId: 'probe', graph, onReuse: e => events.push(e) });
console.log('tryRoot result:', r ? 'SOLVED via ' + r.lemma : 'not solved');
for (const e of events.filter(e => e.type === 'store_reuse_transfer')) {
    console.log('  transfer op:', e.via, JSON.stringify(e.tactic), 'ok=', e.ok, 'newGoals=', e.newGoals);
}
console.log('root solved in graph:', graph.isRootSolved());
backend.endLemma(goals[0].sessionKey);
await backend.shutdown(3000);
