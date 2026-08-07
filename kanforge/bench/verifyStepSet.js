// Multi-step tier verification harness (build_order.md §5.4). Proves each §5.4 problem is a
// HONEST benchmark against the real kernel, in the loop's own order of operations:
//
//   1. stubTypechecks — the `:= by sorry` statement types under the kernel (check).
//   2. chainProves     — the golden `chain` replays through the SAME egraph/open[0] discipline
//                        the ablation drivers use (extractGoals + applyTactic).
//   3. assembledVerifies — the chain assembled into `:= by ...` re-verifies in the kernel
//                        (verifyProof): extract -> propose -> apply -> assemble.
//   4. negativesFail   — no trivial closer (rfl/simp/omega/decide/assumption) proves the stub,
//                        so the tier really demands a multi-step chain.
//
// Any deviation fails the problem and the run exits non-zero, so a tier problem can never be
// "solvable by simp" or "impossible for its own chain" silently.
//
// CLI: node bench/verifyStepSet.js [--set=step] [--problems=or_elim,or_comm] [--out=<dir>]

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoalEGraph } from '../core/egraph.js';
import { STEP_PROBLEMS } from './stepSmoke.js';
import { validateSmokeSet } from './smoke.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Trivial closers the tier must NOT admit. Each is assembled into a full `:= by <tactic>` source
// and kernel-checked: if it verifies, the problem is a one-liner and the tier is dishonest.
export const DEFAULT_NEGATIVES = ['rfl', 'simp', 'omega', 'decide', 'assumption'];

// Assemble a `:= by sorry` stub with a tactic script. Works for both `:= by sorry` and
// `:= by\n  sorry` stub shapes, preserving any leading imports.
export function assembleProofSource(statement, tactics) {
    const list = Array.isArray(tactics) ? tactics : [tactics];
    const text = list.map(t => String(t).trim()).filter(Boolean).join('\n');
    const body = text === ''
        ? '  sorry'
        : text.split(/\n/).map(l => `  ${l.trim()}`).join('\n');
    return String(statement).replace(/:=\s*by\s+sorry\s*$/, `:= by\n${body}`);
}

// Replay a tactic chain through the exact mechanics the ablation drivers use: root goal from
// extractGoals, then each step applied to the FIRST open goal class (frontier order, head first).
// Returns { solved, error, trace: [{ step, tactic, status, newGoals }] } and always releases the
// proof session.
export async function replayChain(backend, statement, chain) {
    const rootGoals = await backend.extractGoals(statement);
    if (!rootGoals?.length) {
        return { solved: false, error: 'no root goal (statement failed to typecheck)', trace: [] };
    }
    const egraph = new GoalEGraph();
    egraph.addGoal(rootGoals[0]);
    egraph.setRoot(rootGoals[0]);
    const sessionKey = rootGoals[0].sessionKey;
    const trace = [];
    try {
        for (let step = 0; step < chain.length && !egraph.isRootSolved(); step++) {
            const open = egraph.getOpenGoals();
            if (open.length === 0) break;
            const goalClass = open[0];
            const goal = egraph.currentGoal(goalClass.id);
            const result = await backend.applyTactic(goal, chain[step]);
            trace.push({ step: step + 1, tactic: chain[step], status: result.status, newGoals: result.newGoals.length });
            if (result.status !== 'ok') {
                return { solved: false, error: `chain step ${step + 1} '${chain[step]}' failed: ${result.error?.message ?? 'tactic error'}`, trace };
            }
            egraph.applyTactic(goalClass.id, chain[step], result.newGoals);
        }
        const solved = egraph.isRootSolved();
        return {
            solved,
            error: solved ? null : `chain exhausted with ${egraph.getOpenGoals().length} goal(s) remaining`,
            trace
        };
    } finally {
        backend.endLemma(sessionKey);
    }
}

// Full-paces verification of a problem set. Each row reports every check; the aggregate `ok` is
// true only when every problem passes every check.
export async function verifyStepSet(backend, problems = STEP_PROBLEMS, { negatives = DEFAULT_NEGATIVES, onProblem = null } = {}) {
    validateSmokeSet(problems);
    const rows = [];
    for (const p of problems) {
        const t0 = Date.now();
        const row = { id: p.id, tier: p.tier, family: p.family, chainSteps: p.chain?.length ?? 0, ms: 0 };
        const checks = {};
        try {
            // 1. The stub must typecheck (check() reports 'verified' for a sorry stub).
            const stub = await backend.check(p.statement);
            checks.stubTypechecks = stub.status === 'verified';
            checks.stubError = stub.status !== 'verified' ? stub.error?.message ?? 'failed to typecheck' : null;

            // 2. The golden chain must solve the goal through the real search mechanics.
            const replay = await replayChain(backend, p.statement, p.chain);
            checks.chainProves = replay.solved;
            checks.chainError = replay.solved ? null : replay.error;
            checks.trace = replay.trace;

            // 3. The assembled proof source must re-verify in the kernel.
            if (replay.solved) {
                const asm = assembleProofSource(p.statement, p.chain);
                const v = await backend.verifyProof(asm);
                checks.assembledVerifies = v.status === 'verified';
                checks.assembledError = v.status !== 'verified' ? v.error?.message ?? 'unproven goals remain' : null;
            } else {
                checks.assembledVerifies = false;
                checks.assembledError = 'skipped: chain did not solve';
            }

            // 4. No trivial closer may prove the stub.
            const negResults = {};
            for (const neg of negatives) {
                const res = await backend.check(assembleProofSource(p.statement, [neg]));
                const closed = res.status === 'verified';
                negResults[neg] = {
                    closed,
                    detail: closed ? 'closed the goal (tier is dishonest)' : (res.error?.message ?? 'did not close')
                };
            }
            checks.negatives = negResults;
            checks.negativesHeld = !Object.values(negResults).some(n => n.closed);
        } catch (err) {
            checks.error = err?.message ?? String(err);
        }
        row.ms = Date.now() - t0;
        row.checks = checks;
        row.ok = !checks.error
            && checks.stubTypechecks === true
            && checks.chainProves === true
            && checks.assembledVerifies === true
            && checks.negativesHeld === true;
        rows.push(row);
        onProblem?.(row);
    }
    const passed = rows.filter(r => r.ok).length;
    return {
        generatedAt: new Date().toISOString(),
        config: { problemCount: problems.length, negatives },
        perProblem: rows,
        passed,
        total: problems.length,
        ok: passed === problems.length
    };
}

export function renderMarkdown(report) {
    const lines = [];
    lines.push('# Multi-step tier verification (build_order.md §5.4)');
    lines.push('');
    lines.push(`- Generated: ${report.generatedAt}`);
    lines.push(`- Problems: ${report.total} (${report.passed} passed)`);
    lines.push(`- Trivial closers must fail: ${report.config.negatives.join(', ')}`);
    lines.push('');
    lines.push('| problem | tier | family | steps | stub | chain | assembled | no trivial closer |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of report.perProblem) {
        const c = r.checks;
        lines.push(`| ${r.id} | ${r.tier} | ${r.family} | ${r.chainSteps} | ${c.stubTypechecks ? 'ok' : 'FAIL'} | ${c.chainProves ? 'ok' : 'FAIL'} | ${c.assembledVerifies ? 'ok' : 'FAIL'} | ${c.negativesHeld ? 'ok' : 'FAIL'} |`);
    }
    lines.push('');
    lines.push(`> Every stub must typecheck, its golden chain must replay through the ablation drivers'`);
    lines.push('> egraph/open[0] discipline AND re-verify once assembled, and none of');
    lines.push(`> ${report.config.negatives.join(', ')} may close it.`);
    return lines.join('\n');
}

function writeReport(outDir, report) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report));
}

function appendRow(outDir, row) {
    if (!outDir) return;
    try {
        mkdirSync(outDir, { recursive: true });
        appendFileSync(path.join(outDir, 'rows.ndjson'), `${JSON.stringify(row)}\n`);
    } catch (err) {
        console.error(`[verifyStepSet] failed to write progress row: ${err.message}`);
    }
}

async function main() {
    const { BackendRepl } = await import('../lean/backendRepl.js');
    const { loadEnv } = await import('../env.js');
    const ENV = loadEnv();

    const setArg = process.argv.find(a => a.startsWith('--set='));
    const problemsArg = process.argv.find(a => a.startsWith('--problems='));
    const outArg = process.argv.find(a => a.startsWith('--out='));
    const set = setArg ? setArg.split('=')[1] : 'step';
    if (set !== 'step') {
        console.error('unknown problem set; only --set=step has golden chains to verify');
        process.exit(2);
    }
    const ids = problemsArg ? problemsArg.split('=')[1].split(',') : [];
    const problems = ids.length ? STEP_PROBLEMS.filter(p => ids.includes(p.id)) : STEP_PROBLEMS;
    if (ids.length && problems.length !== ids.length) {
        const known = STEP_PROBLEMS.map(p => p.id).join(', ');
        console.error(`unknown problem id; known ids: ${known}`);
        process.exit(2);
    }
    const outDir = outArg ? outArg.split('=')[1] : path.join(__dirname, 'ablation', `verifyStep_${Date.now()}`);

    const pool = new BackendRepl({
        replBin: ENV.KANFORGE_REPL_BIN,
        toolchain: ENV.KANFORGE_LEAN_TOOLCHAIN,
        leanProject: ENV.KANFORGE_LEAN_PROJECT,
        concurrency: 2,
        timeoutMs: 60_000
    });
    try {
        const report = await verifyStepSet(pool, problems, {
            onProblem: row => {
                console.log(`[verifyStepSet] ${row.id} ${row.ok ? 'PASS' : 'FAIL'} (stub=${row.checks.stubTypechecks} chain=${row.checks.chainProves} asm=${row.checks.assembledVerifies} neg=${row.checks.negativesHeld}) ms=${row.ms}`);
                appendRow(outDir, row);
            }
        });
        console.log(`\nVerification complete: ${report.passed}/${report.total} problems pass -> ${outDir}`);
        console.log(renderMarkdown(report));
        process.exitCode = report.ok ? 0 : 1;
    } finally {
        await pool.shutdown(3000);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/verifyStepSet.js')) {
    main().catch(e => { console.error(e); process.exit(1); });
}
