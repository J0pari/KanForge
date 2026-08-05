// Blueprint DAG validation (build_order.md §4.1: "DAG acyclicity + dependency coverage audited").
import test from 'node:test';
import assert from 'node:assert';
import { validateBlueprint, findCycle, topologicalOrder, dependentsIndex } from '../blueprint/dag.js';
import { hashStatement } from '../lean/pin.js';

function lemma(id, statement, deps = []) {
    return { id, statement, deps, pinnedHash: hashStatement(statement) };
}

function blueprint(theorem, lemmas) {
    return { theorem, lemmas };
}

test('valid acyclic blueprint passes validation', () => {
    const bp = blueprint(
        'theorem thm : True ∧ True := by sorry',
        [
            lemma('l1', 'lemma l1 : True := by sorry'),
            lemma('l2', 'lemma l2 : True := by sorry'),
            lemma('l3', 'lemma l3 : True ∧ True := by sorry', ['l1', 'l2'])
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.errors, []);
});

test('dependency cycle is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            lemma('a', 'lemma a : True := by sorry', ['b']),
            lemma('b', 'lemma b : True := by sorry', ['a'])
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('cycle')));
});

test('unknown dependency is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            lemma('a', 'lemma a : True := by sorry', ['nope'])
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('unknown lemma nope')));
});

test('self-dependency is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            lemma('a', 'lemma a : True := by sorry', ['a'])
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('depends on itself')));
});

test('pin mismatch is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            { id: 'a', statement: 'lemma a : True := by sorry', deps: [], pinnedHash: 'deadbeef' }
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('pinnedHash mismatch')));
});

test('missing pin is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            { id: 'a', statement: 'lemma a : True := by sorry', deps: [] }
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('pinnedHash must be present')));
});

test('duplicate lemma id is rejected', () => {
    const bp = blueprint(
        'theorem thm : True := by sorry',
        [
            lemma('a', 'lemma a : True := by sorry'),
            lemma('a', 'lemma b : True := by sorry')
        ]
    );
    const result = validateBlueprint(bp);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('duplicate lemma id a')));
});

test('empty lemma list is rejected', () => {
    const result = validateBlueprint({ theorem: 'theorem thm : True := by sorry', lemmas: [] });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('non-empty')));
});

test('topologicalOrder puts every lemma after its deps', () => {
    const lemmas = [
        lemma('root', 'lemma root : True ∧ True := by sorry', ['left', 'right']),
        lemma('left', 'lemma left : True := by sorry'),
        lemma('right', 'lemma right : True := by sorry', ['left'])
    ];
    const order = topologicalOrder(lemmas);
    assert.ok(order);
    assert.strictEqual(order.length, 3);
    const pos = Object.fromEntries(order.map((id, i) => [id, i]));
    assert.ok(pos.left < pos.right);
    assert.ok(pos.left < pos.root);
    assert.ok(pos.right < pos.root);
});

test('topologicalOrder returns null on a cycle', () => {
    const lemmas = [
        lemma('a', 'lemma a : True := by sorry', ['b']),
        lemma('b', 'lemma b : True := by sorry', ['a'])
    ];
    assert.strictEqual(topologicalOrder(lemmas), null);
});

test('findCycle reports the exact cycle', () => {
    const lemmas = [
        lemma('a', 'lemma a : True := by sorry', ['b']),
        lemma('b', 'lemma b : True := by sorry', ['c']),
        lemma('c', 'lemma c : True := by sorry', ['a'])
    ];
    const cycle = findCycle(lemmas);
    assert.ok(cycle);
    assert.strictEqual(cycle.length, 4);
    assert.strictEqual(cycle[0], cycle[cycle.length - 1]);
});

test('dependentsIndex maps dep -> dependents', () => {
    const lemmas = [
        lemma('a', 'lemma a : True := by sorry'),
        lemma('b', 'lemma b : True := by sorry', ['a']),
        lemma('c', 'lemma c : True := by sorry', ['a'])
    ];
    const idx = dependentsIndex(lemmas);
    assert.deepStrictEqual([...idx.get('a')].sort(), ['b', 'c']);
    assert.deepStrictEqual([...idx.get('b')], []);
    assert.deepStrictEqual([...idx.get('c')], []);
});
