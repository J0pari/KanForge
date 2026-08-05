// Swiss-tournament best-of-n selection (OPC arXiv:2506.21621 §5.5, App. B) — node:test form.
// Covers the pure Bradley-Terry fit, verdict parsing, round-robin ranking, and the
// kernel-grounded application order in bestOfNWithSwiss.

import test from 'node:test';
import assert from 'node:assert';
import {
    bradleyTerryRank,
    swissSchedule,
    swissRank,
    buildJudgePrompt,
    parseJudgeVerdict,
    bestOfNWithSwiss
} from '../search/swiss.js';

test('bradleyTerryRank: transitive dominance orders ratings A > B > C', () => {
    // C needs a non-degenerate record (a tie vs D) or the MLE collapses it to rating 0 —
    // beating a winless opponent is uninformative in the Bradley-Terry model.
    // result 'a' means the a-indexed competitor wins, so B(1) beating C(2) is 'a'.
    const outcomes = [
        { a: 0, b: 1, result: 'a' },
        { a: 0, b: 2, result: 'a' },
        { a: 1, b: 2, result: 'a' },
        { a: 0, b: 3, result: 'equal' },
        { a: 1, b: 3, result: 'equal' },
        { a: 2, b: 3, result: 'equal' }
    ];
    const [ra, rb, rc, rd] = bradleyTerryRank(outcomes, 4);
    assert.ok(ra > rb);
    assert.ok(rb > rc);
    assert.ok(rc > 0);
    assert.ok(Math.abs(ra + rb + rc + rd - 1) < 1e-9);
});

test('bradleyTerryRank: all ties give equal ratings', () => {
    const outcomes = [
        { a: 0, b: 1, result: 'equal' },
        { a: 0, b: 2, result: 'equal' },
        { a: 1, b: 2, result: 'equal' }
    ];
    const ratings = bradleyTerryRank(outcomes, 3);
    assert.ok(ratings.every(r => Math.abs(r - 1 / 3) < 1e-6));
});

test('bradleyTerryRank: unbeaten competitor rates highest with a non-trivial spread', () => {
    // A beats everyone; everyone else beats no one. A must dominate, and the model must
    // assign A a probability of beating any opponent near 1 (per 1/(1 + exp(r_j - r_i))).
    const outcomes = [
        { a: 0, b: 1, result: 'a' },
        { a: 0, b: 2, result: 'a' },
        { a: 0, b: 3, result: 'a' },
        { a: 1, b: 2, result: 'equal' },
        { a: 1, b: 3, result: 'equal' },
        { a: 2, b: 3, result: 'equal' }
    ];
    const ratings = bradleyTerryRank(outcomes, 4);
    assert.ok(ratings[0] > 0.99);
});

test('bradleyTerryRank: ignores malformed outcomes and out-of-range indices', () => {
    const outcomes = [
        { a: 0, b: 1, result: 'a' },
        { a: 0, b: 1, result: 'bogus' },
        { a: 0, b: 99, result: 'a' },
        { a: 5, b: 0, result: 'a' },
        { a: 1, b: 1, result: 'a' }
    ];
    const [ra, rb] = bradleyTerryRank(outcomes, 2);
    assert.ok(ra > rb);
});

test('swissSchedule: every unordered pair appears exactly once (O(n^2) comparisons)', () => {
    const pairs = swissSchedule(4);
    assert.strictEqual(pairs.length, 6); // C(4,2)
    assert.deepStrictEqual(new Set(pairs.map(p => p.join(','))).size, 6);
    const pairs3 = swissSchedule(3);
    assert.strictEqual(pairs3.length, 3);
});

test('swissRank: ranks candidates by the judge preference', async () => {
    const candidates = ['omega', 'intro h', 'rw [add_comm]'];
    const judge = async (a, b) => a === 'omega' ? 'a' : b === 'omega' ? 'b' : 'equal';
    const ranking = await swissRank(candidates, judge);
    assert.strictEqual(ranking[0].candidate, 'omega');
    assert.strictEqual(ranking.length, 3);
    // Ties among the two non-preferred candidates resolve to equal ratings.
    assert.ok(Math.abs(ranking[1].rating - ranking[2].rating) < 1e-6);
});

test('swissRank: a judge throwing or returning null skips the game without breaking the fit', async () => {
    const candidates = ['omega', 'intro h', 'rcases h'];
    const judge = async (a, b) => {
        if (a === 'omega' && b === 'intro h') throw new Error('judge unavailable');
        if (a === 'omega' && b === 'rcases h') return 'a';
        return null;
    };
    const ranking = await swissRank(candidates, judge);
    assert.strictEqual(ranking[0].candidate, 'omega');
    assert.strictEqual(ranking.length, 3);
});

test('parseJudgeVerdict: accepts the ternary vocabulary and rejects noise', () => {
    assert.strictEqual(parseJudgeVerdict('A'), 'a');
    assert.strictEqual(parseJudgeVerdict('A because it makes progress'), 'a');
    assert.strictEqual(parseJudgeVerdict('B'), 'b');
    assert.strictEqual(parseJudgeVerdict('EQUAL'), 'equal');
    assert.strictEqual(parseJudgeVerdict('TIE'), 'equal');
    assert.strictEqual(parseJudgeVerdict(''), null);
    assert.strictEqual(parseJudgeVerdict('maybe'), null);
    assert.strictEqual(parseJudgeVerdict(null), null);
});

test('parseJudgeVerdict: strips markdown around the verdict token', () => {
    assert.strictEqual(parseJudgeVerdict('`A`'), 'a');
    assert.strictEqual(parseJudgeVerdict('```\nB\n```'), 'b');
    assert.strictEqual(parseJudgeVerdict('`EQUAL` (tie)'), 'equal');
});

test('buildJudgePrompt: shows both tactics and demands a single-line verdict', () => {
    const prompt = buildJudgePrompt({ type: 'P → Q', context: [] }, 'intro h', 'exact h');
    assert.ok(prompt.includes('P → Q'));
    assert.ok(prompt.includes('intro h'));
    assert.ok(prompt.includes('exact h'));
    assert.ok(prompt.includes('A, B, or EQUAL'));
});

class MockLLM {
    constructor(texts) {
        this.texts = texts;
        this.i = 0;
    }
    async complete() {
        return { text: this.texts[this.i++ % this.texts.length] };
    }
}

class MockTacticBackend {
    constructor(working) {
        this.working = new Set(working);
        this.applied = [];
    }
    async applyTactic(goal, tactic) {
        this.applied.push(tactic);
        if (this.working.has(tactic)) return { status: 'ok', newGoals: [] };
        return { status: 'error', newGoals: [], error: { message: `failed: ${tactic}` } };
    }
}

test('bestOfNWithSwiss: applies in judge order but returns the first kernel-success', async () => {
    // The judge ranks 'garbage' first; the kernel rejects it, so the loop must fall through
    // to the next candidate in rating order and return 'intro h' (the first that verifies).
    const goal = { type: 'P → Q', context: [] };
    const llm = new MockLLM(['garbage', 'intro h', 'omega']);
    const backend = new MockTacticBackend(['intro h']);
    const judge = async (a, b) => a === 'garbage' ? 'a' : b === 'garbage' ? 'b' : 'equal';

    const outcome = await bestOfNWithSwiss(goal, backend, llm, { N: 3, judge });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.tactic, 'intro h');
    assert.strictEqual(backend.applied[0], 'garbage'); // judged-best tried first
    assert.strictEqual(backend.applied[1], 'intro h'); // then next in rating order
    assert.deepStrictEqual(outcome.ranking[0].candidate, 'garbage');
});

test('bestOfNWithSwiss: deduplicates identical proposals before the tournament', async () => {
    const goal = { type: 'P → Q', context: [] };
    const llm = new MockLLM(['omega', 'omega', 'omega']);
    const backend = new MockTacticBackend(['omega']);
    const judge = async (a, b) => 'equal';

    const outcome = await bestOfNWithSwiss(goal, backend, llm, { N: 3, judge });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.tactic, 'omega');
    assert.strictEqual(outcome.ranking.length, 1); // one unique candidate -> no games
    assert.deepStrictEqual(backend.applied, ['omega']);
});

test('bestOfNWithSwiss: reports failure (with ranking) when no candidate verifies', async () => {
    const goal = { type: 'P → Q', context: [] };
    const llm = new MockLLM(['intro h', 'omega']);
    const backend = new MockTacticBackend([]);
    const judge = async (a, b) => 'equal';

    const outcome = await bestOfNWithSwiss(goal, backend, llm, { N: 2, judge });

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.ranking.length, 2);
    assert.deepStrictEqual(backend.applied, ['intro h', 'omega']);
});

test('bestOfNWithSwiss: no proposals yields an empty failure without touching the backend', async () => {
    const goal = { type: 'P → Q', context: [] };
    const llm = new MockLLM(['   ', '']);
    const backend = new MockTacticBackend([]);
    const judge = async (a, b) => 'equal';

    const outcome = await bestOfNWithSwiss(goal, backend, llm, { N: 2, judge });

    assert.strictEqual(outcome.ok, false);
    assert.deepStrictEqual(outcome.ranking, []);
    assert.deepStrictEqual(backend.applied, []);
});
