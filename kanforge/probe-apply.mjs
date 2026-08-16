import { BackendRepl } from './lean/backendRepl.js';
import { loadEnv } from './env.js';
import { LemmaStore } from './growth/lemmaStore.js';
import { hashStatement } from './lean/pin.js';

const ENV = loadEnv();
const backend = new BackendRepl({
    replBin: ENV.KANFORGE_REPL_BIN,
    toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
    leanProject: ENV.KANFORGE_LEAN_PROJECT,
    concurrency: 2,
    timeoutMs: 300000
});
const store = new LemmaStore({ dir: './runs/lemma-store' });

const GOAL_STMT = 'import Mathlib.Algebra.Group.Even\nimport Mathlib.Data.Nat.Prime.Defs\nimport Mathlib.Data.Set.Finite.Basic\n\ntheorem even_two_pow_two_pow_probe : ∀ k : Nat, Even (2 ^ (2 ^ (k + 1))) := by sorry';

const goals = await backend.extractGoals(GOAL_STMT);
console.log('root goal:', goals[0].type.slice(0, 60));

const cand = store.list().find(e => e.lemmaName === 'twopow_even_exp' && e.proofScript && !String(e.proofScript).includes('sorry'));
console.log('candidate:', cand?.lemmaName, '| proof:', cand?.proofScript?.split('\n').join(' ').slice(0, 80));

if (cand) {
    const r1 = await backend.applyTactic(goals[0], 'exact twopow_even_exp');
    console.log('exact <name>:', r1.status, r1.error?.message?.slice(0, 80) ?? ('subgoals=' + r1.newGoals.length));
    const r2 = await backend.applyTactic(goals[0], 'apply twopow_even_exp');
    console.log('apply <name>:', r2.status, r2.error?.message?.slice(0, 80) ?? ('subgoals=' + r2.newGoals.length));
}
backend.endLemma(goals[0].sessionKey);
await backend.shutdown(3000);
