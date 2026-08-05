// SkeletonGenerator (build_order.md §4.1): LLM decomposition → typechecked, pinned,
// DAG-audited blueprint with blueprint.json + blueprint.md.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkeletonGenerator, normalizeStub } from '../blueprint/skeleton.js';
import { validateBlueprint } from '../blueprint/dag.js';
import { hashStatement } from '../lean/pin.js';

const THM = 'theorem add_comm_thm (a b : Nat) : a + b = b + a := by sorry';
const H1 = 'theorem add_comm (a b : Nat) : a + b = b + a := by sorry';
const H2 = 'theorem zero_comm : 0 + 0 = 0 := by sorry';

class ScriptedLLM {
    constructor(responses) {
        this.responses = responses;
        this.calls = 0;
    }
    async complete() {
        const text = this.responses[Math.min(this.calls, this.responses.length - 1)];
        this.calls++;
        return { text };
    }
}

class MockCheckBackend {
    constructor({ bad = [] } = {}) {
        this.bad = new Set(bad);
        this.checks = [];
    }
    async check(statement) {
        this.checks.push(statement);
        if (this.bad.has(statement)) {
            return { status: 'error', error: { message: 'syntax error' } };
        }
        return { status: 'verified', goals: [] };
    }
    pin() {
        return { toolchain: 'mock', normVersion: 1 };
    }
}

const decomposition = JSON.stringify({
    lemmas: [
        { name: 'add_comm', statement: H1, deps: [] },
        { name: 'zero_comm', statement: H2, deps: [] }
    ],
    rootDeps: ['add_comm', 'zero_comm']
});

test('generate produces a valid, pinned, acyclic blueprint', async () => {
    const llm = new ScriptedLLM([decomposition]);
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend });

    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    const { blueprint } = result;

    assert.strictEqual(blueprint.theorem, normalizeStub(THM));
    assert.strictEqual(blueprint.lemmas.length, 3);
    const root = blueprint.lemmas.find(l => l.statement === normalizeStub(THM));
    assert.ok(root);
    assert.deepStrictEqual([...root.deps].sort(), [hashStatement(H1), hashStatement(H2)].sort());
    for (const l of blueprint.lemmas) {
        assert.strictEqual(l.id, hashStatement(l.statement));
        assert.strictEqual(l.pinnedHash, l.id);
    }
    assert.strictEqual(validateBlueprint(blueprint).ok, true);
    assert.strictEqual(llm.calls, 1);
});

test('fenced JSON response is parsed', async () => {
    const llm = new ScriptedLLM(['```json\n' + decomposition + '\n```']);
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blueprint.lemmas.length, 3);
});

test('non-typechecking helper is dropped with a warning, blueprint stays valid', async () => {
    const llm = new ScriptedLLM([JSON.stringify({
        lemmas: [
            { name: 'broken', statement: 'lemma broken : does not parse := by sorry', deps: [] },
            { name: 'good', statement: H2, deps: [] }
        ],
        rootDeps: ['good']
    })]);
    const brokenStmt = normalizeStub('lemma broken : does not parse');
    const backend = new MockCheckBackend({ bad: [brokenStmt] });
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    const statements = result.blueprint.lemmas.map(l => l.statement);
    assert.ok(!statements.some(s => s.includes('broken')));
    assert.ok(statements.some(s => s.includes('zero_comm')));
    assert.ok(result.warnings.some(w => w.includes('broken')));
});

test('unknown dependency is dropped with a warning, DAG stays acyclic', async () => {
    const llm = new ScriptedLLM([JSON.stringify({
        lemmas: [
            { name: 'add_comm', statement: H1, deps: ['ghost'] }
        ],
        rootDeps: ['add_comm']
    })]);
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    const root = result.blueprint.lemmas.find(l => l.statement === normalizeStub(THM));
    assert.deepStrictEqual(root.deps, [hashStatement(H1)]);
    const helper = result.blueprint.lemmas.find(l => l.statement === H1);
    assert.deepStrictEqual(helper.deps, []);
    assert.ok(result.warnings.some(w => w.includes('ghost')));
});

test('retries after a garbage response and succeeds', async () => {
    const llm = new ScriptedLLM(['not json at all', decomposition]);
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(llm.calls, 2);
});

test('garbage across all attempts reports failure', async () => {
    const llm = new ScriptedLLM(['not json', 'still not json', 'nope']);
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend, maxRetries: 1 });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('attempts'));
    assert.strictEqual(llm.calls, 2);
});

test('non-typechecking theorem is fatal', async () => {
    const llm = new ScriptedLLM([decomposition]);
    const backend = new MockCheckBackend({ bad: [normalizeStub(THM)] });
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('theorem does not typecheck'));
});

test('outDir emits blueprint.json and blueprint.md', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-skeleton-'));
    try {
        const llm = new ScriptedLLM([decomposition]);
        const backend = new MockCheckBackend();
        const gen = new SkeletonGenerator({ llm, backend, outDir });
        const result = await gen.generate(THM);
        assert.strictEqual(result.ok, true);

        const jsonPath = path.join(outDir, 'blueprint.json');
        const mdPath = path.join(outDir, 'blueprint.md');
        assert.ok(fs.existsSync(jsonPath));
        assert.ok(fs.existsSync(mdPath));
        const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        assert.strictEqual(onDisk.lemmas.length, 3);
        assert.ok(fs.readFileSync(mdPath, 'utf8').includes('# Blueprint'));

        // A reloaded generator reading only the on-disk file re-validates clean.
        assert.strictEqual(validateBlueprint(onDisk).ok, true);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});

test('normalizeStub appends the by-sorry stub form once and rewrites lemma → theorem', () => {
    assert.strictEqual(normalizeStub('theorem a : True'), 'theorem a : True := by sorry');
    assert.strictEqual(normalizeStub('theorem a : True := by sorry'), 'theorem a : True := by sorry');
    assert.strictEqual(normalizeStub('theorem a : True := by\n  sorry'), 'theorem a : True := by sorry');
    // Lean 4 has no `lemma` command; it is normalized to `theorem` so stubs typecheck.
    assert.strictEqual(normalizeStub('lemma a : True'), 'theorem a : True := by sorry');
});
