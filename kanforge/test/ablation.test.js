// Ablation harness + repulsion tests (build_order.md §5.1/§5.2).
// - RepulsionSampler: diversity-aware proposal (dedup + "do not repeat" steering).
// - MCGS / BestFirstSearch repulsion option: refuses duplicate tactic re-checks.
// - runAblation: recipes x problems under a shared budget; report with per-recipe and
//   per-problem detail; the comparisons the phase gates demand ("compare, then decide").

import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { RepulsionSampler, computeRepulsionPenalty } from '../search/repulsion.js';
import { MCGS } from '../search/mcgs.js';
import { BestFirstSearch } from '../search/bfs.js';
import { RECIPES, runAblation, renderMarkdown, wilsonInterval, buildAblationGraph, summarizeAblationGraph } from '../bench/ablation.js';
import { validateSmokeSet } from '../bench/smoke.js';
import { MATHLIB_PROBLEMS } from '../bench/mathlibSmoke.js';
import { GoalEGraph } from '../core/egraph.js';

// Deterministic llm: cycles a per-goal-type tactic pool (found by substring match on the prompt
// text), answers swiss judge prompts with the first candidate, and logs every prompt it saw.
class GoalAwareLLM {
    constructor(pools) {
        this.pools = pools;
        this.calls = 0;
        this.prompts = [];
    }

    async complete(prompt) {
        this.calls++;
        const text = extractText(prompt);
        this.prompts.push(text);
        if (/Judge which/.test(text)) return { text: 'A' };
        for (const [type, pool] of this.pools) {
            if (mentionsGoalType(text, type)) {
                return { text: pool[(this.calls - 1) % pool.length] };
            }
        }
        return { text: 'rfl' };
    }
}

// Match the goal type only where the prompt anchors it after "Goal:", never as a bare substring
// (a bare "p" would also match "Propose"/"tactic"). Covers both prompt shapes used here:
//   driveLemma:  "Goal: <type>\nPropose tactic:"
//   buildTacticPrompt: "Goal:\n  <type>..."
function mentionsGoalType(text, type) {
    return text.includes(`Goal: ${type}`) || text.includes(`Goal:\n  ${type}`) || text.includes(`Goal:  ${type}`);
}

// Deterministic backend: a rule table of { type, accept, subgoals } per goal type.
class ScriptedBackend {
    constructor(roots, rules) {
        this.roots = roots;
        this.rules = rules;
        this.applyCalls = [];
        this.extractCalls = 0;
        this.endLemmaCalls = [];
    }

    async extractGoals(statement) {
        const type = this.roots.get(statement);
        return type ? [{ type, context: [], sessionKey: `k_${this.extractCalls++}` }] : null;
    }

    endLemma(key) {
        this.endLemmaCalls.push(key);
    }

    async applyTactic(goal, tactic) {
        this.applyCalls.push({ type: goal.type, tactic });
        const rule = this.rules.find(r => r.type === goal.type);
        if (rule && rule.accept.includes(tactic)) {
            const subgoals = (rule.subgoals ?? []).map(s => ({ type: s, context: [] }));
            return { status: 'ok', newGoals: subgoals };
        }
        return { status: 'error', newGoals: [], error: { message: `rejected: ${tactic}` } };
    }
}

function extractText(prompt) {
    if (typeof prompt === 'string') return prompt;
    if (Array.isArray(prompt)) {
        const last = prompt.findLast(p => p.role === 'user');
        return String(last?.content ?? '');
    }
    return String(prompt?.user ?? '');
}

// Three problems: two provable by the pools below, one whose correct tactic is never proposed.
const P_LT = 'example (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry';
const P_CONJ = 'example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by sorry';
const P_OPEN = 'example (x : Nat) : x = 0 := by sorry';

const PROBLEMS = [
    { id: 'p_lt', tier: 1, family: 'omega', statement: P_LT },
    { id: 'p_conj', tier: 2, family: 'constructor', statement: P_CONJ },
    { id: 'p_open', tier: 4, family: 'exact', statement: P_OPEN }
];

function makeWorld() {
    const roots = new Map([[P_LT, 'a < c'], [P_CONJ, 'p ∧ q'], [P_OPEN, 'x = 0']]);
    const rules = [
        { type: 'a < c', accept: ['omega'] },
        { type: 'p ∧ q', accept: ['constructor'], subgoals: ['p', 'q'] },
        { type: 'p', accept: ['exact hp'] },
        { type: 'q', accept: ['exact hq'] },
        { type: 'x = 0', accept: ['native_decide'] }
    ];
    const pools = new Map([
        ['a < c', ['intro h', 'omega', 'rfl']],
        ['p ∧ q', ['constructor', 'omega']],
        ['p', ['exact hp']],
        ['q', ['exact hq']],
        ['x = 0', ['omega', 'rfl']]
    ]);
    return { backend: new ScriptedBackend(roots, rules), llm: new GoalAwareLLM(pools) };
}

test('computeRepulsionPenalty accumulates on duplicate active tactics', () => {
    assert.strictEqual(computeRepulsionPenalty('omega', []), 0);
    assert.strictEqual(computeRepulsionPenalty('omega', ['intro h']), 0);
    assert.strictEqual(computeRepulsionPenalty('omega', ['omega', 'omega']), 1.0);
});

test('RepulsionSampler returns the first tactic not already tried', async () => {
    const { llm } = makeWorld();
    const sampler = new RepulsionSampler({ llm });
    const first = await sampler.propose('Goal: a < c\nPropose tactic:', { tried: [] });
    assert.strictEqual(first, 'intro h');
    const second = await sampler.propose('Goal: a < c\nPropose tactic:', { tried: ['intro h'] });
    assert.strictEqual(second, 'omega');
});

test('RepulsionSampler echoes tried tactics into the prompt', async () => {
    const { llm } = makeWorld();
    const sampler = new RepulsionSampler({ llm });
    await sampler.propose('Goal: a < c\nPropose tactic:', { tried: ['intro h', 'rfl'] });
    const prompt = llm.prompts.at(-1);
    assert.match(prompt, /do not repeat/i);
    assert.ok(prompt.includes('intro h'));
    assert.ok(prompt.includes('rfl'));
});

test('RepulsionSampler returns null once draws stop producing fresh tactics', async () => {
    const llm = { calls: 0, async complete() { this.calls++; return { text: 'exact h' }; } };
    const sampler = new RepulsionSampler({ llm, maxTries: 4 });
    const t = await sampler.propose('Goal: p\nPropose tactic:', { tried: ['exact h'] });
    assert.strictEqual(t, null);
    assert.strictEqual(llm.calls, 4);
});

test('MCGS repulsion skips duplicate tactic re-checks', async () => {
    const { backend } = makeWorld();
    const repeatingLLM = { calls: 0, async complete() { this.calls++; return { text: 'rfl' }; } };

    const egraphPlain = new GoalEGraph();
    egraphPlain.addGoal({ type: 'a < c', context: [] });
    egraphPlain.setRoot({ type: 'a < c', context: [] });
    const plainStart = backend.applyCalls.length;
    await new MCGS({ backend, llm: repeatingLLM, maxTacticsPerGoal: 4, repulsion: false })
        .search(egraphPlain, { rollouts: 1 });
    const plainChecks = backend.applyCalls.length - plainStart;

    const egraphRep = new GoalEGraph();
    egraphRep.addGoal({ type: 'a < c', context: [] });
    egraphRep.setRoot({ type: 'a < c', context: [] });
    const repStart = backend.applyCalls.length;
    await new MCGS({ backend, llm: repeatingLLM, maxTacticsPerGoal: 4, repulsion: true })
        .search(egraphRep, { rollouts: 1 });
    const repChecks = backend.applyCalls.length - repStart;

    assert.ok(repChecks < plainChecks, `expected repulsion to cut duplicate kernel checks (${repChecks} < ${plainChecks})`);
    assert.strictEqual(repChecks, 1, 'repulsion should verify the duplicate tactic exactly once');
});

test('BestFirstSearch repulsion skips duplicate tactic re-checks', async () => {
    const { backend } = makeWorld();
    const repeatingLLM = { calls: 0, async complete() { this.calls++; return { text: 'rfl' }; } };

    const egraphPlain = new GoalEGraph();
    egraphPlain.addGoal({ type: 'a < c', context: [] });
    egraphPlain.setRoot({ type: 'a < c', context: [] });
    const plainStart = backend.applyCalls.length;
    await new BestFirstSearch({ backend, llm: repeatingLLM, maxTacticsPerGoal: 4, repulsion: false })
        .search(egraphPlain, { maxExpansions: 1 });
    const plainChecks = backend.applyCalls.length - plainStart;

    const egraphRep = new GoalEGraph();
    egraphRep.addGoal({ type: 'a < c', context: [] });
    egraphRep.setRoot({ type: 'a < c', context: [] });
    const repStart = backend.applyCalls.length;
    await new BestFirstSearch({ backend, llm: repeatingLLM, maxTacticsPerGoal: 4, repulsion: true })
        .search(egraphRep, { maxExpansions: 1 });
    const repChecks = backend.applyCalls.length - repStart;

    assert.ok(repChecks < plainChecks, `expected repulsion to cut duplicate kernel checks (${repChecks} < ${plainChecks})`);
    assert.strictEqual(repChecks, 1, 'repulsion should verify the duplicate tactic exactly once');
});

test('runAblation solves the provable problems, fails the open one, respects the budget', async () => {
    const { backend, llm } = makeWorld();
    const report = await runAblation({ backend, llm, problems: PROBLEMS, recipes: RECIPES, N: 8, maxLlmCalls: 100 });

    assert.strictEqual(report.perRecipe.length, RECIPES.length);
    for (const s of report.perRecipe) {
        assert.strictEqual(s.solved, 2, `${s.recipe} should solve p_lt + p_conj`);
        assert.strictEqual(s.total, 3);
        assert.strictEqual(s.passRate, 2 / 3);
    }
    for (const d of report.detail) {
        assert.ok(d.llmCalls <= 100, `${d.recipe}/${d.id} exceeded the budget`);
        if (d.id === 'p_open') assert.strictEqual(d.solved, false);
        if (d.id === 'p_lt' || d.id === 'p_conj') assert.strictEqual(d.solved, true);
    }
});

test('swiss costs more LLM calls than bestofn on the same problem (judge overhead)', async () => {
    const { backend, llm } = makeWorld();
    const report = await runAblation({ backend, llm, problems: PROBLEMS, recipes: ['bestofn', 'swiss'], N: 8, maxLlmCalls: 100 });
    const row = (recipe, id) => report.detail.find(d => d.recipe === recipe && d.id === id);
    assert.ok(row('swiss', 'p_lt').llmCalls > row('bestofn', 'p_lt').llmCalls);
});

test('runAblation writes report.json and report.md when outDir is set', async () => {
    const { backend, llm } = makeWorld();
    const outDir = `${process.cwd()}/bench/ablation/test_report_${Date.now()}`;
    const report = await runAblation({ backend, llm, problems: PROBLEMS, recipes: ['bestofn', 'mcgs'], N: 8, maxLlmCalls: 100, outDir });
    try {
        assert.ok(existsSync(`${outDir}/report.json`));
        assert.ok(existsSync(`${outDir}/report.md`));
        const json = JSON.parse(readFileSync(`${outDir}/report.json`, 'utf8'));
        assert.strictEqual(json.perRecipe.length, 2);
        assert.ok(json.detail.length >= 2 * PROBLEMS.length);
        const md = readFileSync(`${outDir}/report.md`, 'utf8');
        assert.match(md, /Pass rate vs\. budget/);
        assert.ok(report.perRecipe.length === 2);
    } finally {
        rmSync(outDir, { recursive: true, force: true });
    }
});

test('runAblation rejects an unknown recipe', async () => {
    const { backend, llm } = makeWorld();
    await assert.rejects(
        runAblation({ backend, llm, problems: PROBLEMS, recipes: ['magic'] }),
        /unknown recipe/
    );
});

test('runAblation releases every proof session after each problem (no worker leak)', async () => {
    const { backend, llm } = makeWorld();
    const report = await runAblation({ backend, llm, problems: PROBLEMS, recipes: ['bestofn', 'swiss', 'mcgs'], N: 4, maxLlmCalls: 100 });
    // Every problem (per recipe) opened a session and must have released it.
    assert.strictEqual(backend.endLemmaCalls.length, 3 * PROBLEMS.length);
    const keys = backend.endLemmaCalls;
    assert.strictEqual(new Set(keys).size, keys.length, 'each session key released exactly once');
    for (const d of report.detail) {
        if (d.id === 'p_open') assert.strictEqual(d.solved, false);
        else assert.strictEqual(d.solved, true, `${d.recipe}/${d.id} should solve in the mock world`);
    }
});

test('runAblation survives a driver crash on one problem and still reports all rows', async () => {
    const { backend, llm } = makeWorld();
    // Object.create keeps the prototype methods (extractGoals/endLemma) while overriding
    // applyTactic to throw for one goal type — a `{ ...backend }` spread would lose them.
    const crashing = Object.create(backend);
    crashing.applyTactic = async (goal, tactic) => {
        if (goal.type === 'p ∧ q') throw new Error('lean repl session timeout after 180000ms');
        return backend.applyTactic(goal, tactic);
    };
    const report = await runAblation({ backend: crashing, llm, problems: PROBLEMS, recipes: ['bestofn', 'mcgs'], N: 4, maxLlmCalls: 100 });
    assert.strictEqual(report.detail.length, 2 * PROBLEMS.length, 'every row present despite the crash');
    const conj = report.detail.filter(d => d.id === 'p_conj');
    assert.ok(conj.every(d => d.solved === false), 'crashed problem recorded as failed');
    assert.ok(conj.every(d => /driver crashed/.test(d.error ?? '')));
    const lt = report.detail.find(d => d.id === 'p_lt' && d.recipe === 'mcgs');
    assert.strictEqual(lt.solved, true, 'sibling problems still solve after the crash row');
});

test('runAblation plumbs menu and premises configs into the report', async () => {
    const { backend, llm } = makeWorld();
    const report = await runAblation({
        backend, llm, problems: PROBLEMS, recipes: ['bestofn', 'mcgs'], N: 4, maxLlmCalls: 100,
        menu: true,
        premises: { retriever: new (await import('../search/premises.js')).PremiseRetriever([]), locked: true, topK: 5, corpusName: 'test' }
    });
    assert.strictEqual(report.config.menu, true);
    assert.strictEqual(report.config.premises.locked, true);
    assert.strictEqual(report.config.premises.corpusName, 'test');
    assert.strictEqual(report.detail.length, 2 * PROBLEMS.length);
    assert.strictEqual(report.perRecipe.find(r => r.recipe === 'bestofn').solved, 2, 'wrappers must not break the mock solve');
});

test('runAblation row timeout prevents a wedged repl from hanging the run', async () => {
    const { llm } = makeWorld();
    // extractGoals never resolves — a wedged repl would freeze a bare await forever.
    const hangBackend = {
        async extractGoals() { return new Promise(() => {}); },
        async applyTactic() { return new Promise(() => {}); },
        endLemma() {},
        async verifyProof() { return { status: 'verified' }; },
        pin() { return {}; }
    };
    const t0 = Date.now();
    const report = await runAblation({ backend: hangBackend, llm, problems: PROBLEMS, recipes: ['bestofn'], N: 4, maxLlmCalls: 100, rowTimeoutMs: 200 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(report.detail.length, PROBLEMS.length);
    assert.ok(report.detail.every(d => d.solved === false));
    assert.ok(report.detail.every(d => /timed out/.test(d.error ?? '')), 'row must be recorded as timed out');
    assert.ok(elapsed < 5_000, 'the run must return without waiting for the wedged repl');
});

test('renderMarkdown produces a table anchored to the acceptance criteria', () => {
    const md = renderMarkdown({
        generatedAt: new Date().toISOString(),
        config: { recipes: ['bestofn', 'swiss'], N: 8, maxLlmCalls: 100, problemCount: 3 },
        perRecipe: [
            { recipe: 'bestofn', solved: 1, total: 3, passRate: 1 / 3, llmCalls: 10, tacticCalls: 4, meanLlmCallsPerSolved: 10 },
            { recipe: 'swiss', solved: 2, total: 3, passRate: 2 / 3, llmCalls: 30, tacticCalls: 6, meanLlmCallsPerSolved: 15 }
        ],
        perProblem: [{ id: 'p_lt', tier: 1, solvedBy: ['swiss'] }],
        pairwise: [
            { base: 'bestofn', recipe: 'swiss', passDelta: 1 / 3, meanLlmCalls: 15 }
        ],
        detail: []
    });
    assert.match(md, /Pass rate vs\. budget/);
    assert.match(md, /MCGS ≥ best-of-N at equal budget/);
    assert.match(md, /swiss/);
});

test('MATHLIB_PROBLEMS set is well-formed (stub shape, imports, known families)', () => {
    assert.doesNotThrow(() => validateSmokeSet(MATHLIB_PROBLEMS));
    assert.ok(MATHLIB_PROBLEMS.length >= 10, 'mathlib set should cover the tactic families');

    const known = ['ring', 'linarith', 'norm_num', 'decide', 'positivity', 'simp', 'field_simp', 'tauto', 'rw'];
    for (const p of MATHLIB_PROBLEMS) {
        assert.ok(p.statement.startsWith('import Mathlib.'), `${p.id} must import a Mathlib module`);
        assert.ok(known.includes(p.family), `${p.id} family '${p.family}' not in ${known.join('/')}`);
        assert.match(p.statement, /:= by sorry\s*$/, `${p.id} must be a by-sorry stub`);
    }
    // Mathlib-only content: no problem is provable from core Lean alone — each family needs the
    // named Mathlib tactic or a Mathlib predicate (Real, Nat.Prime).
    const ids = new Set(MATHLIB_PROBLEMS.map(p => p.id));
    assert.ok(ids.size === MATHLIB_PROBLEMS.length, 'ids must be unique');
});


test('wilsonInterval returns null for fewer than 2 problems and a sane interval otherwise', () => {
    assert.strictEqual(wilsonInterval(1, 1), null);
    const [lo, hi] = wilsonInterval(3, 5);
    assert.ok(lo >= 0 && lo <= hi && hi <= 1);
    const [lo5, hi5] = wilsonInterval(5, 5);
    assert.strictEqual(hi5, 1);
    assert.ok(lo5 < 1);
});

test('ablation graph enumerates the full factorial and computes main effects + interactions', () => {
    // Build the graph over menu+premises (no external config needed for the 'on' nodes when the
    // graph builder is given a premiseConfig). Verify: 2^2 = 4 nodes, base mask '00' first.
    const premiseConfig = { retriever: null, locked: false, topK: 5, corpusName: 'test' };
    const nodes = buildAblationGraph(['menu', 'premises'], { premiseConfig });
    assert.strictEqual(nodes.length, 4);
    assert.deepStrictEqual(nodes[0].components, { menu: false, premises: false });
    assert.strictEqual(nodes[0].mask, '00');
    assert.strictEqual(nodes[3].mask, '11');

    // Simulate per-node results with a measurable interaction: menu helps only when premises are
    // on (pass rates: 00=0.2, 10=0.2, 01=0.4, 11=0.8).
    const rates = { '00': 0.2, '10': 0.2, '01': 0.4, '11': 0.8 };
    const results = nodes.map(n => ({
        mask: n.mask,
        components: n.components,
        recipes: n.recipes,
        report: {
            config: { N: 4, maxLlmCalls: 60, provenance: { toolchain: 't', leanProject: 'p', model: 'm', provider: 'o', corpus: 'core' } },
            perRecipe: [{
                recipe: n.recipes[0], solved: Math.round(rates[n.mask] * 5), total: 5,
                passRate: rates[n.mask], passRateCI: wilsonInterval(Math.round(rates[n.mask] * 5), 5),
                llmCalls: 10, tacticCalls: 8, skipped: 0, wallMs: 100, solvedLlmCalls: 1,
                meanLlmCallsPerSolved: 1, problems: []
            }]
        }
    }));
    const summary = summarizeAblationGraph(results, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
    assert.strictEqual(summary.config.kind, 'ablation-graph');
    assert.strictEqual(summary.nodes.length, 4);
    // menu main effect = (0.2+0.8)/2 - (0.2+0.4)/2 = 0.2
    assert.ok(Math.abs(summary.mainEffects.menu - 0.2) < 1e-9);
    // premises main effect = (0.4+0.8)/2 - (0.2+0.2)/2 = 0.4
    assert.ok(Math.abs(summary.mainEffects.premises - 0.4) < 1e-9);
    // interaction menu x premises = 0.8 - 0.2 - 0.4 + 0.2 = 0.4 (menu helps only with premises on)
    assert.ok(Math.abs(summary.interactions['menu x premises'] - 0.4) < 1e-9);
    assert.strictEqual(summary.audit.allOk, true, JSON.stringify(summary.audit.violations));
});

test('ablation graph rejects unknown components loudly', () => {
    assert.throws(() => buildAblationGraph(['menu', 'nonsense'], {}), /unknown ablation component/);
});
