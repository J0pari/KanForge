// P1 gate (build_order.md): the minimal loop — PullGraph + scheduler + backendRepl + one LLM
// adapter — proves a real lemma through the real kernel and emits a traced event.
// Gated on the real repl binary (KANFORGE_REPL_BIN) AND the opencode CLI; it skips, never fakes,
// when either test-infra binary is missing.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BackendRepl } from '../lean/backendRepl.js';
import { MinimalLoop } from '../agent/loop.js';
import { loadLLMConfig, createLLM, resolveOpenCodeInvocation } from '../agent/llm.js';
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

describe('P1 minimal loop over real repl + real LLM', {
    skip: (!REPL_BIN && 'repl binary not found (set KANFORGE_REPL_BIN)') ||
        (!opencodeBin && 'opencode CLI not found (npm i -g opencode-ai or set KANFORGE_LLM_OPENCODE_BIN)')
}, () => {
    test('first-lemma time-to-verify: goal intake -> kernel VERIFIED with a traced event, counters 0', async () => {
        const pool = new BackendRepl({
            replBin: REPL_BIN,
            toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
            concurrency: 1,
            timeoutMs: 60_000
        });
        pools.push(pool);

        const loop = new MinimalLoop({
            backend: pool,
            llm: createLLM({ ...llmConfig, retries: 3 }), // transient CLI timeouts are retried; hard failures surface
            concurrency: 1,
            attemptsPerLemma: 8, // pass@8 gate metric
            timeoutMs: 300_000,  // backstop only: the pool bounds each kernel check
            maxTokens: 512,
            onEvent: e => console.log(`[loop] ${JSON.stringify(e)}`)
        });

        const id = loop.addLemma('example (a b : Nat) : a + b = b + a := by sorry');
        const t0 = Date.now();
        const out = await loop.proveAll();
        const dt = Date.now() - t0;

        assert.equal(out.ok, true, `minimal loop must verify the lemma; failures: ${[...out.failures.keys()]}`);
        const verified = loop.events().find(e => e.type === 'lemma_verified');
        assert.ok(verified, 'a lemma_verified traced event must be emitted');
        assert.ok(verified.proof.length > 0, 'the emitted proof must be non-empty');
        assert.equal(loop.graph.nodes.get(id).value.proof, verified.proof, 'the verified proof must be recorded on the graph node');

        const infos = pool.getInfos();
        assert.equal(infos.restarts, 0, 'a clean loop run must not restart workers');
        assert.equal(infos.hangs, 0);
        assert.equal(infos.parseErrors, 0);

        console.log(`[loop] first-lemma time-to-verify: ${dt}ms, proof="${verified.proof}", llmCalls=${loop.llmCalls}, verifyCalls=${loop.verifyCalls}`);
    });
});
