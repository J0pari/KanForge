// Campaign pass-telemetry consumer: turns a run directory's machine-readable artifacts into
// the per-pass consumable the ablation layer reads for component recommendations and the
// amortized-cost curve:
//   - passes.ndjson       — one JSON line per launch (config, cost, outcome; blueprint/run.js)
//   - campaign*.log       — the [refine]/[loop] line grammar (rounds, re-splits, kernel
//                           rejections, cycle prunes, goal-memory restores)
//   - checkpoint.json     — the current DAG state (lemmas, proved, stalled, rounds)
//   - events.jsonl        — event-type histogram + undeclared-identifier taxonomy
// Lean by design: counts + config only; the full stream stays in events.jsonl.
import fs from 'node:fs';
import path from 'node:path';

// Parse ONE campaign log body into a compact pass record.
export function parseCampaignLog(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = {
        rounds: 0,
        proved: 0,
        resplits: 0,
        resplitAdded0: 0,
        kernelRejects: 0,
        prunedCycles: 0,
        selfHeals: 0,
        restoredMemory: null,
        slowChecks: 0,
        wallMs: null
    };
    const stamps = [];
    for (const line of lines) {
        const m = /\[(\d{2}:\d{2}:\d{2})\]/.exec(line);
        if (m) stamps.push(m[1]);
        if (/\[refine\] round .* proved=true/.test(line)) out.proved++;
        if (/\[refine\] round .* resplit=true/.test(line)) {
            out.resplits++;
            if (/ added=0 /.test(line)) out.resplitAdded0++;
        }
        if (/\[loop\] KERNEL_REJECTED/.test(line)) out.kernelRejects++;
        if (/\[refine\] (pruned \d+ lemma|self-healed a dependency cycle)/.test(line)) {
            if (/self-healed/.test(line)) out.selfHeals++; else out.prunedCycles++;
        }
        const gm = /\[refine\] restored goal memory: (\d+) goal shapes, (\d+) undeclared identifiers/.exec(line);
        if (gm) out.restoredMemory = { shapes: Number(gm[1]), unknownIdentifiers: Number(gm[2]) };
        if (/\[repl-pool\].*completed in \d{3,}\.\ds/.test(line)) out.slowChecks++;
    }
    out.rounds = lines.filter(l => /\[refine\] round \d+\//.test(l)).length;
    if (stamps.length >= 2) {
        const toSec = s => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
        const span = toSec(stamps[stamps.length - 1]) - toSec(stamps[0]);
        out.wallMs = (span < 0 ? span + 24 * 3600 : span) * 1000;
    }
    return out;
}

// Event-stream taxonomy: type histogram + the undeclared identifiers the kernel rejected
// (the campaign's hallucinated-name pathology, ranked).
export function eventTaxonomy(eventLines) {
    const counts = {};
    const unknownIdentifiers = {};
    let parsed = 0;
    for (const raw of eventLines) {
        let e;
        try { e = JSON.parse(raw); } catch { continue; }
        parsed++;
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        if (e.type === 'kernel_unknown_identifier' && e.identifier) {
            unknownIdentifiers[e.identifier] = (unknownIdentifiers[e.identifier] ?? 0) + 1;
        }
    }
    return {
        parsed,
        counts,
        unknownIdentifiers: Object.entries(unknownIdentifiers)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([name, n]) => ({ name, n }))
    };
}

// Load every pass artifact in a run directory. Never throws on a missing artifact — an
// interrupted pass simply has fewer sources (each returns null and is reported).
export function loadPassMetrics(runDir) {
    const read = (name) => {
        const p = path.join(runDir, name);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    };
    const checkpoint = (() => {
        try {
            const raw = read('checkpoint.json');
            if (!raw) return null;
            const c = JSON.parse(raw);
            return {
                savedAt: c.savedAt ?? null,
                lemmas: c.lemmas?.length ?? 0,
                proved: c.lemmas?.filter(l => l.proof).length ?? 0,
                stalled: c.lemmas?.filter(l => l.stalled).length ?? 0,
                rounds: c.rounds?.length ?? 0,
                goalMemory: c.goalMemory
                    ? { shapes: c.goalMemory.entries?.length ?? 0, unknownIdentifiers: c.goalMemory.unknownIdentifiers?.length ?? 0 }
                    : null
            };
        } catch { return null; }
    })();
    const passes = (() => {
        const raw = read('passes.ndjson');
        if (!raw) return [];
        return raw.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    })();
    const campaigns = [];
    for (const f of fs.existsSync(runDir) ? fs.readdirSync(runDir).sort() : []) {
        if (!/^campaign.*\.log$/.test(f)) continue;
        campaigns.push({ file: f, ...parseCampaignLog(read(f)) });
    }
    const taxonomy = eventTaxonomy(read('events.jsonl') ? read('events.jsonl').split(/\r?\n/).filter(Boolean) : []);
    // The series: cumulative proved per campaign pass (checkpoint is the latest only; the
    // per-pass deltas come from each campaign log's proved count).
    const series = campaigns.map(c => ({
        file: c.file,
        rounds: c.rounds,
        provedInPass: c.proved,
        resplits: c.resplits,
        kernelRejects: c.kernelRejects,
        prunedCycles: c.prunedCycles,
        selfHeals: c.selfHeals,
        wallMs: c.wallMs
    }));
    return { runDir, checkpoint, passes, campaigns, series, taxonomy };
}

// Human-readable digest (markdown-ish) for the CLI/ablation surface.
export function renderPassMetrics(pm) {
    const lines = [];
    lines.push(`# Pass metrics: ${pm.runDir}`);
    lines.push('');
    const ck = pm.checkpoint;
    lines.push(`- Checkpoint: ${ck ? `${ck.lemmas} lemmas, ${ck.proved} proved, ${ck.stalled} stalled, ${ck.rounds} rounds${ck.goalMemory ? `, goal memory: ${ck.goalMemory.shapes} shapes / ${ck.goalMemory.unknownIdentifiers} undeclared ids` : ''}` : '(none)'}`);
    lines.push('');
    lines.push('## Campaign passes');
    lines.push('');
    lines.push('| pass | rounds | proved | re-splits | kernel rejects | pruned | wall |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const c of pm.campaigns) {
        const wall = c.wallMs == null ? '—' : `${(c.wallMs / 60000).toFixed(1)}m`;
        lines.push(`| ${c.file} | ${c.rounds} | ${c.proved} | ${c.resplits} | ${c.kernelRejects} | ${c.prunedCycles} | ${wall} |`);
    }
    lines.push('');
    lines.push('## Event taxonomy');
    lines.push('');
    lines.push(`- Parsed events: ${pm.taxonomy.parsed}`);
    lines.push(`- Event types: ${Object.entries(pm.taxonomy.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (pm.taxonomy.unknownIdentifiers.length) {
        lines.push(`- Kernel-undeclared identifiers: ${pm.taxonomy.unknownIdentifiers.map(i => `${i.name} x${i.n}`).join(', ')}`);
    }
    return lines.join('\n');
}
