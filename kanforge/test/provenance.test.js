// core/provenance.js — the mandatory benchmark provenance block (§5.7).
import test from 'node:test';
import assert from 'node:assert';
import {
    assembleProvenance,
    missingProvenanceKeys,
    MANDATORY_PROVENANCE_KEYS,
    lakeDeps,
    gitHead
} from '../core/provenance.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('assembleProvenance emits every mandatory key, unknown values recorded as unknown:<reason>', () => {
    const block = assembleProvenance({});
    for (const k of MANDATORY_PROVENANCE_KEYS) {
        assert.ok(block[k] != null && block[k] !== '', `key ${k} must be present and non-empty`);
    }
    assert.match(block.llmProvider, /^unknown:/);
    assert.match(block.leanToolchain, /^unknown:/);
    assert.match(block.kanforgeCommit, /^unknown:|^[0-9a-f]{40}$/);
    assert.strictEqual(block.seed, 'none');
});

test('assembleProvenance carries the configured fields verbatim', () => {
    const block = assembleProvenance({
        provider: 'opencode',
        model: 'deepseek/deepseek-v4-flash',
        toolchain: 'leanprover/lean4:v4.33.0-rc1',
        components: { recipe: 'loop' },
        budget: { N: 8, maxLlmCalls: 400 },
        seed: 42
    });
    assert.strictEqual(block.llmProvider, 'opencode');
    assert.strictEqual(block.model, 'deepseek/deepseek-v4-flash');
    assert.strictEqual(block.leanToolchain, 'leanprover/lean4:v4.33.0-rc1');
    assert.deepStrictEqual(block.components, { recipe: 'loop' });
    assert.deepStrictEqual(block.budget, { N: 8, maxLlmCalls: 400 });
    assert.strictEqual(block.seed, 42);
});

test('lakeDeps reads mathlib and repl revisions from a manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-prov-'));
    try {
        fs.writeFileSync(path.join(dir, 'lake-manifest.json'), JSON.stringify({
            version: '1.2.0',
            packages: [
                { name: 'mathlib', rev: 'mathlib-rev-abc' },
                { name: 'repl', rev: 'repl-rev-def' }
            ]
        }));
        assert.deepStrictEqual(lakeDeps(dir), { mathlib: 'mathlib-rev-abc', repl: 'repl-rev-def' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepStrictEqual(lakeDeps(null), { mathlib: null, repl: null });
    assert.deepStrictEqual(lakeDeps(path.join(dir, 'missing')), { mathlib: null, repl: null });
});

test('gitHead resolves the enclosing repository from a subdirectory, null outside one', () => {
    const head = gitHead(process.cwd());
    assert.ok(head, 'this package lives in a git checkout — head must resolve');
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.strictEqual(gitHead(os.tmpdir()), null);
});

test('missingProvenanceKeys reports exactly the missing mandatory keys', () => {
    assert.deepStrictEqual(missingProvenanceKeys(null), ['entire block']);
    assert.deepStrictEqual(missingProvenanceKeys({}), [...MANDATORY_PROVENANCE_KEYS]);
    const full = assembleProvenance({});
    assert.deepStrictEqual(missingProvenanceKeys(full), []);
    const missingModel = { ...full, model: '' };
    assert.deepStrictEqual(missingProvenanceKeys(missingModel), ['model']);
});
