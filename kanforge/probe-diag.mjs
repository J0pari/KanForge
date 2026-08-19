import fs from 'node:fs';
import { loadEnv } from './env.js';
import { loadLLMConfig, createLLM } from './agent/llm.js';
import { createBackend } from './lean/backend.js';
import { stripImports } from './agent/roles/autoformalizer.js';

const E = loadEnv();
const llm = createLLM({ ...loadLLMConfig(E), retries: 0 });
const backend = createBackend({ type: 'repl', replBin: E.KANFORGE_REPL_BIN, toolchain: E.KANFORGE_LEAN_TOOLCHAIN, leanProject: E.KANFORGE_LEAN_PROJECT, concurrency: 1, timeoutMs: 300000 });

const statement = fs.readFileSync('runs/erdos10-variant-two-pows/statement.txt', 'utf8');
const candidates = [];
for (const n of [1, 2, 3, 4, 5]) {
    candidates.push(`the number ${n} is an element of the set`);
    candidates.push(`the number ${n} is not an element of the set`);
}

const system = 'You are a Lean 4 formalization verifier. Given a formal statement and asserted instances, produce Lean `example` statements that verify each instance holds under the proposition.\n' +
    'Return ONLY a JSON object, no prose, no markdown fences:\n' +
    '{"examples": ["example ... : <instance proposition> := by <tactics>", ...]}\n' +
    'Rules:\n' +
    '- One example per asserted instance, same length.\n' +
    '- Do NOT assume the theorem; each example must be an independent kernel-checked claim.\n' +
    '- For membership of a SMALL concrete number in a set expression, unfold the set membership first:\n' +
    '  `example : (3 : Nat) \\u2209 ({n : Nat | P n} \\ S) := by rw [Set.mem_diff]; push_neg; ...` then use norm_num / omega / decide on the concrete arithmetic.\n' +
    '- The membership decidability may fail for unbounded existentials; prove non-membership by contradiction with norm_num/omega bounds.\n' +
    '- Use the SAME imports as the statement.';
const user = `Statement:\n${statement}\n\nAsserted instances:\n${candidates.join('\n')}`;
fs.appendFileSync('probe-diag.log', 'llm call\n');
const resp = await llm.complete([{ role: 'system', content: system }, { role: 'user', content: user }]);
fs.appendFileSync('probe-diag.log', 'RESP:\n' + (resp?.text ?? 'NULL') + '\n---\n');
process.exit(0);
