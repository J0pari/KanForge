// Gate (build_order.md §1.2): the loop, over the REAL repl + the real opencode CLI, must pass the
// 20-problem smoke set at pass@8 >= 1, flexing MORE than one tactic family (not omega-only), on
// genuinely non-trivial/non-tautological goals, with clean pool counters. Skips, never fakes, when
// a test-infra binary (the repl or the opencode CLI) is missing.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BackendRepl } from '../lean/backendRepl.js';
import { loadLLMConfig, createLLM, resolveOpenCodeInvocation } from '../agent/llm.js';
import { runSmokeSet, printSmokeSummary } from '../bench/run.js';
import { ENV } from './loadEnv.js';

function findReplBin() {
    const fromEnv = ENV.KANFORGE_REPL_BIN;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    return null;
}

const REPL_BIN = findReplBin();
// Invalid provider config is a loud failure (no silent skip): a typo'd KANFORGE_LLM_PROVIDER
// must be fixed, not masked by the gate.
const llmConfig = loadLLMConfig(ENV);
// The opencode CLI is a test-infra dependency (like the repl binary): skip the gate if it is
// absent; a broken config stays a loud failure. No LLM cost, no quota logic — any real failure
// during the run surfaces as a real test failure.
let opencodeBin = null;
try { opencodeBin = resolveOpenCodeInvocation(llmConfig).command; } catch { /* skipped below */ }

const pools = [];
after(async () => {
    for (const p of pools) {
        try { await p.shutdown(2000); } catch { /* already down */ }
    }
});

describe('loop over real repl + real LLM: 20-problem smoke gate', {
    skip: (!REPL_BIN && 'repl binary not found (set KANFORGE_REPL_BIN)') ||
        (!opencodeBin && 'opencode CLI not found (npm i -g opencode-ai or set KANFORGE_LLM_OPENCODE_BIN)')
}, () => {
    test('pass@8 >= 1/20 with >= 2 tactic families flexed, counters 0', async () => {
        const pool = new BackendRepl({
            replBin: REPL_BIN,
            toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
            concurrency: 2,
            timeoutMs: 60_000
        });
        pools.push(pool);

        let attemptCount = 0;
        let solvedCount = 0;
        const s = await runSmokeSet({
            backend: pool,
            llm: createLLM({ ...llmConfig, retries: 3 }), // transient CLI timeouts are retried; hard failures surface
            concurrency: 2,
            attemptsPerLemma: 8, // pass@8 gate metric
            timeoutMs: 300_000,  // backstop only; the pool bounds each kernel check
            maxTokens: 512,
            // Compact progress lines so a long gate run can be monitored live; the summary
            // table below remains the report.
            onEvent: (e) => {
                if (e.type === 'lemma_attempt') {
                    attemptCount++;
                    console.log(`[bench] attempt ${attemptCount} node=${e.nodeId.slice(0, 8)}`);
                } else if (e.type === 'lemma_verified') {
                    solvedCount++;
                    console.log(`[bench] verified node=${e.nodeId.slice(0, 8)} proof="${e.proof}" (${solvedCount} solved so far)`);
                } else if (e.type === 'lemma_failed') {
                    console.log(`[bench] FAILED node=${e.nodeId.slice(0, 8)} after ${e.attempts} attempts: ${String(e.lastError ?? '').slice(0, 80)}`);
                }
            }
        });
        printSmokeSummary(s);

        assert.ok(s.total === 20, 'the full 20-problem set must be attempted');
        assert.ok(s.solved >= 1, `gate: pass@8 >= 1 required, got ${s.solved}/${s.total}`);
        assert.ok(s.distinctFamilies >= 2,
            `gate: the loop must flex >1 tactic family, got ${s.families.join(', ') || '(none)'}`);
        assert.ok(s.tier2Plus >= 1,
            'gate: proof success must reach non-tautological goals beyond omega-only arithmetic (tier >= 2)');

        const poolInfo = pool.getInfos();
        assert.equal(poolInfo.restarts, 0, 'a clean loop run must not restart workers');
        assert.equal(poolInfo.hangs, 0);
        assert.equal(poolInfo.parseErrors, 0);
    });
});
