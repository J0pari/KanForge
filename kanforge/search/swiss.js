// Swiss-tournament best-of-n selection (OPC arXiv:2506.21621 §5.5, App. B).
// An improved selection strategy over search/bestofn.js (architecture.md §5):
// Instead of applying N tactic proposals in proposal order and taking the first kernel success,
// the candidates play a round-robin tournament: an LLM judge compares each pair and picks a
// winner (or a tie). Ratings are fit with the Bradley-Terry model (MLE) and candidates are
// applied in rating order. The Lean kernel stays the ground truth — a ranked candidate that
// fails is simply skipped, so the ranking only affects the order in which verifications run.
//
// OPC reports Rank (Swiss) improves best-of-n accuracy by 17% over the discrete/continuous
// baselines (26% -> 43% vs 26% -> 36%) on its 134-problem best-of-n subset.

import { sanitizeTacticText } from '../agent/llm.js';

// Fit Bradley-Terry ratings over the outcomes of a round-robin tournament.
//
//   outcomes: [{ a, b, result }] where a, b are 0-based competitor indices (a < b) and result
//             is 'a' (a beats b), 'b' (b beats a), or 'equal' (a tie counts as half a win each).
//   n:        number of competitors.
//
// P(i beats j) = 1 / (1 + exp(r_j - r_i)) with r = ln(p); p is fit by MLE using the standard
// minorization-maximization iteration p_i <- w_i / sum_j n_ij/(p_i + p_j), normalized to sum 1.
export function bradleyTerryRank(outcomes, n, opts = {}) {
    const { maxIter = 10_000, tol = 1e-12 } = opts;
    const games = Array.from({ length: n }, () => new Array(n).fill(0));
    const points = new Array(n).fill(0);
    for (const o of outcomes) {
        const { a, b, result } = o;
        if (a < 0 || b < 0 || a >= n || b >= n || a === b) continue;
        games[a][b] += 1;
        games[b][a] += 1;
        if (result === 'a') points[a] += 1;
        else if (result === 'b') points[b] += 1;
        else { points[a] += 0.5; points[b] += 0.5; }
    }
    let p = new Array(n).fill(1 / n);
    for (let iter = 0; iter < maxIter; iter++) {
        const next = new Array(n);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                if (i === j || games[i][j] === 0) continue;
                sum += games[i][j] / (p[i] + p[j]);
            }
            next[i] = sum > 0 ? points[i] / sum : 0;
        }
        const total = next.reduce((x, y) => x + y, 0) || 1;
        let maxDelta = 0;
        for (let i = 0; i < n; i++) {
            next[i] = next[i] / total;
            maxDelta = Math.max(maxDelta, Math.abs(next[i] - p[i]));
        }
        p = next;
        if (maxDelta < tol) break;
    }
    return p;
}

// Swiss pairing: every candidate competes against every other (OPC App. B describes the
// tournament as "a round-robin tournament where each proof competes against every other",
// hence O(n^2) comparisons). The judge returns 'a' | 'b' | 'equal' | null (null = no game).
export function swissSchedule(n) {
    const pairs = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) pairs.push([i, j]);
    }
    return pairs;
}

// Run the tournament and return candidates sorted by descending Bradley-Terry rating.
// judge(tacticA, tacticB) -> Promise<'a' | 'b' | 'equal' | null>.
export async function swissRank(candidates, judge, opts = {}) {
    const n = candidates.length;
    const outcomes = [];
    for (const [i, j] of swissSchedule(n)) {
        let result;
        try {
            result = await judge(candidates[i], candidates[j]);
        } catch {
            result = null;
        }
        if (result === 'a' || result === 'b' || result === 'equal') {
            outcomes.push({ a: i, b: j, result });
        }
    }
    const ratings = bradleyTerryRank(outcomes, n, opts);
    return candidates
        .map((candidate, i) => ({ candidate, rating: ratings[i] }))
        .sort((x, y) => y.rating - x.rating);
}

// Pure: the pairwise-judge prompt for one goal and two candidate tactics.
export function buildJudgePrompt(goal, tacticA, tacticB) {
    return [
        'Judge which of two tactic proposals for the same Lean goal is more promising.',
        '',
        `Goal:`,
        `    ${String(goal.type).trim()}`,
        '',
        `Tactic A:`,
        `    ${String(tacticA).trim()}`,
        '',
        `Tactic B:`,
        `    ${String(tacticB).trim()}`,
        '',
        'Decide which tactic is more likely to make progress toward solving the goal.',
        'Respond with exactly one line: A, B, or EQUAL.'
    ].join('\n');
}

// Pure: map the judge's free-text answer to the ternary outcome ('a' | 'b' | 'equal' | null).
// Markdown fences/backticks around the verdict token are stripped before the ternary match.
export function parseJudgeVerdict(text) {
    const cleaned = String(text ?? '').replace(/```(?:lean)?/gi, '').replace(/`/g, '').trim();
    const first = cleaned.split(/\s+/)[0]?.toUpperCase();
    if (first === 'A') return 'a';
    if (first === 'B') return 'b';
    if (first === 'EQUAL' || first === 'TIE') return 'equal';
    return null;
}

// The default judge: drives the opencode LLM through agent/llm.js and parses its verdict.
export function buildPairwiseJudge(goal, { llm, maxTokens = 200 } = {}) {
    if (!llm) throw new Error('buildPairwiseJudge requires an llm client');
    return async (tacticA, tacticB) => {
        const response = await llm.complete([
            { role: 'system', content: 'You are a Lean tactic judge. Return only A, B, or EQUAL.' },
            { role: 'user', content: buildJudgePrompt(goal, tacticA, tacticB) }
        ], { maxTokens });
        return parseJudgeVerdict(response.text);
    };
}

// Sample N tactic proposals, rank them by Swiss tournament (OPC App. B), then apply them in
// rating order until one succeeds. Returns the first kernel-verified candidate plus the full
// ranking; a failed ranked candidate is skipped, never re-applied.
export async function bestOfNWithSwiss(goal, backend, llm, opts = {}) {
    const N = opts.N ?? 8;
    const unique = new Set();
    for (let i = 0; i < N; i++) {
        const response = await llm.complete([
            { role: 'user', content: `Goal: ${goal.type}\nPropose tactic:` }
        ]);
        const tactic = sanitizeTacticText(response.text);
        if (tactic) unique.add(tactic);
    }
    const candidates = [...unique];
    if (candidates.length === 0) return { ok: false, ranking: [] };
    const judge = opts.judge ?? buildPairwiseJudge(goal, { llm, ...opts });
    const ranking = await swissRank(candidates, judge, opts);
    for (const { candidate } of ranking) {
        const result = await backend.applyTactic(goal, candidate);
        if (result.status === 'ok') return { ok: true, tactic: candidate, result, ranking };
    }
    return { ok: false, ranking };
}
