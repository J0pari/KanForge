// SkeletonGenerator — deterministic structural seed (architecture audit S2).
// No planning essay: the seed unfolds the theorem's own syntax (conjunctions, iff
// directions, quantifier bodies, set-membership definitions). Every child is kernel-checked
// and falsification-gated; growth beyond the seed comes from the search engine.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SkeletonGenerator,
    normalizeStub,
    syntacticSplit,
    typeOf,
    theoremNameOf,
    stripStubBody
} from '../blueprint/skeleton.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';
import { stripImports } from '../agent/roles/autoformalizer.js';
import { validateBlueprint } from '../blueprint/dag.js';
import { hashStatement } from '../lean/pin.js';
import { resolveModule } from '../lean/moduleResolver.js';
import { MATHLIB_PRESENT } from './mathlibEnv.js';

const THM = 'theorem add_comm_thm (a b : Nat) : a + b = b + a := by sorry';

const TACTIC_IMPORTS = MATHLIB_PRESENT
    ? STUB_TACTIC_MODULES.map(resolveModule).filter(Boolean)
    : STUB_TACTIC_MODULES;
const stubOf = s => TACTIC_IMPORTS.map(m => `import ${m}`).join('\n') + '\n\n' + normalizeStub(s);

class MockCheckBackend {
    constructor({ bad = [], badSubstrings = [] } = {}) {
        this.bad = new Set(bad);
        this.badSubstrings = badSubstrings;
        this.checks = [];
    }
    async check(statement) {
        this.checks.push(statement);
        if (this.bad.has(statement) || this.badSubstrings.some(s => statement.includes(s))) {
            return { status: 'error', error: { message: 'syntax error' } };
        }
        return { status: 'verified', goals: [] };
    }
    pin() {
        return { toolchain: 'mock', normVersion: 1 };
    }
}

test('stripStubBody removes any body and returns the declaration', () => {
    assert.strictEqual(stripStubBody('theorem a : True := by sorry'), 'theorem a : True');
    assert.strictEqual(stripStubBody('theorem a : True := by\n  trivial'), 'theorem a : True');
});

test('typeOf skips binder colons and returns the proposition with binders', () => {
    assert.strictEqual(typeOf('theorem a (n : Nat) : n = n := by sorry').type, 'n = n');
    assert.strictEqual(typeOf('theorem a (n : Nat) : n = n := by sorry').binders, '(n : Nat)');
    assert.strictEqual(typeOf('theorem a : P ∧ Q := by sorry').type, 'P ∧ Q');
});

test('theoremNameOf reads the declaration name', () => {
    assert.strictEqual(theoremNameOf('theorem add_comm_thm (a b : Nat) : a + b = b + a := by sorry'), 'add_comm_thm');
});

test('syntacticSplit: top-level iff produces both directions', () => {
    const { children, rootDeps } = syntacticSplit('theorem thm : P ↔ Q := by sorry');
    assert.strictEqual(children.length, 2);
    assert.ok(children.some(c => c.statement === 'theorem thm_mp : P → Q := by sorry'));
    assert.ok(children.some(c => c.statement === 'theorem thm_mpr : Q → P := by sorry'));
    assert.deepStrictEqual([...rootDeps].sort(), ['thm_mp', 'thm_mpr']);
});

test('syntacticSplit: top-level conjunction splits into conjuncts', () => {
    const { children, rootDeps } = syntacticSplit('theorem thm : P ∧ Q ∧ R := by sorry');
    assert.strictEqual(children.length, 3);
    assert.deepStrictEqual(rootDeps, ['thm_conj0', 'thm_conj1', 'thm_conj2']);
});

test('syntacticSplit: universal binder is lifted to the body child', () => {
    const { children, rootDeps } = syntacticSplit('theorem thm : ∀ n : Nat, 0 ≤ n := by sorry');
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].statement, 'theorem thm_body (n : Nat) : 0 ≤ n := by sorry');
    assert.deepStrictEqual(rootDeps, ['thm_body']);
});

test('syntacticSplit: untyped binder is refused (no guessing)', () => {
    const { children } = syntacticSplit('theorem thm : ∀ n, n = n := by sorry');
    assert.strictEqual(children.length, 0);
});

test('syntacticSplit: Set.Infinite seed unfolds the membership of the set expression', () => {
    const stmt = 'theorem thm : Set.Infinite <| {n : Nat | Even n} \\ {x : Nat | x = 1} := by sorry';
    const { children, rootDeps } = syntacticSplit(stmt);
    // difference unfolding + setOf unfolding for each side
    assert.ok(children.length >= 3, `expected >= 3 children, got ${children.length}`);
    assert.ok(children.some(c => c.statement.includes('∈ ({n : Nat | Even n} \\ {x : Nat | x = 1}) ↔')));
    assert.ok(children.some(c => c.statement.includes('Even x')));
    assert.ok(children.some(c => c.statement.includes('x = 1')));
    assert.strictEqual(rootDeps.length, children.length);
});

test('syntacticSplit: declaration binders are lifted into every child', () => {
    const { children } = syntacticSplit('theorem thm (a b : Nat) (h : a < b) : P ∧ Q := by sorry');
    assert.strictEqual(children.length, 2);
    assert.strictEqual(children[0].statement, 'theorem thm_conj0 (a b : Nat) (h : a < b) : P := by sorry');
    assert.strictEqual(children[1].statement, 'theorem thm_conj1 (a b : Nat) (h : a < b) : Q := by sorry');
});

test('generate produces a valid, pinned, acyclic blueprint from the seed only', async () => {
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ backend });
    const result = await gen.generate('theorem thm : P ↔ Q := by sorry');
    assert.strictEqual(result.ok, true);
    const { blueprint } = result;
    assert.strictEqual(blueprint.theorem, normalizeStub('theorem thm : P ↔ Q := by sorry'));
    assert.strictEqual(blueprint.lemmas.length, 3); // root + two directions
    const root = blueprint.lemmas.find(l => l.statement === blueprint.theorem);
    assert.ok(root);
    assert.strictEqual(root.deps.length, 2);
    for (const l of blueprint.lemmas) {
        assert.strictEqual(l.id, hashStatement(l.statement));
        assert.strictEqual(l.pinnedHash, l.id);
    }
    assert.strictEqual(validateBlueprint(blueprint).ok, true);
});

test('generate: a statement with no mechanical split yields a root-only blueprint', async () => {
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blueprint.lemmas.length, 1);
    assert.deepStrictEqual(result.blueprint.lemmas[0].deps, []);
});

test('non-typechecking child is dropped with a warning, blueprint stays valid', async () => {
    // The seed's iff split produces `P → Q`-shaped children; make the mock reject the Q side.
    const backend = new MockCheckBackend({ badSubstrings: ['Q → P'] });
    const gen = new SkeletonGenerator({ backend });
    const result = await gen.generate('theorem thm : P ↔ Q := by sorry');
    assert.strictEqual(result.ok, true);
    const statements = result.blueprint.lemmas.map(l => l.statement);
    assert.ok(!statements.some(s => s.includes('Q → P')));
    assert.ok(statements.some(s => s.includes('P → Q')));
    assert.ok(result.warnings.some(w => w.includes('thm_mpr')));
});

test('non-typechecking theorem is fatal', async () => {
    const backend = new MockCheckBackend({ bad: [normalizeStub(THM)] });
    const gen = new SkeletonGenerator({ backend });
    const result = await gen.generate(THM);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('theorem does not typecheck'));
});

test('outDir emits blueprint.json and blueprint.md', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-skeleton-'));
    try {
        const backend = new MockCheckBackend();
        const gen = new SkeletonGenerator({ backend, outDir });
        const result = await gen.generate('theorem thm : P ↔ Q := by sorry');
        assert.strictEqual(result.ok, true);

        const jsonPath = path.join(outDir, 'blueprint.json');
        const mdPath = path.join(outDir, 'blueprint.md');
        assert.ok(fs.existsSync(jsonPath));
        assert.ok(fs.existsSync(mdPath));
        const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        assert.strictEqual(onDisk.lemmas.length, 3);
        assert.ok(fs.readFileSync(mdPath, 'utf8').includes('# Blueprint'));
        assert.strictEqual(validateBlueprint(onDisk).ok, true);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});

test('generate never calls the llm (no planning essay)', async () => {
    let calls = 0;
    const llm = {
        async complete() {
            calls++;
            throw new Error('the seed must not call the LLM');
        }
    };
    const backend = new MockCheckBackend();
    const gen = new SkeletonGenerator({ llm, backend });
    const result = await gen.generate('theorem thm : P ↔ Q := by sorry');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls, 0);
});

test('normalizeStub appends the by-sorry stub form once and rewrites lemma → theorem', () => {
    assert.strictEqual(normalizeStub('theorem a : True'), 'theorem a : True := by sorry');
    assert.strictEqual(normalizeStub('theorem a : True := by sorry'), 'theorem a : True := by sorry');
    assert.strictEqual(normalizeStub('theorem a : True := by\n  sorry'), 'theorem a : True := by sorry');
    assert.strictEqual(normalizeStub('lemma a : True'), 'theorem a : True := by sorry');
});

test('normalizeStub strips a bare trailing := (empty body) without double-stubbing', () => {
    assert.strictEqual(normalizeStub('theorem t (N : Nat) : 0 < 2 ^ N := '), 'theorem t (N : Nat) : 0 < 2 ^ N := by sorry');
    assert.strictEqual(normalizeStub('lemma t (N : Nat) : 0 < 2 ^ N := '), 'theorem t (N : Nat) : 0 < 2 ^ N := by sorry');
});
