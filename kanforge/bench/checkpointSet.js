// Checkpoint-derived problem set for the ablation harness: the mission's own READY unproved
// lemmas (deps proved, not stalled), extracted from a run checkpoint. Measuring recipes and
// components on the mission's live frontier is what makes ablation DIRECTLY drive the next
// campaign pass: the recommended recipe/toggles land in runs/defaults.json, which
// blueprint/run.js consumes at startup. Cap the set so a sweep stays bounded; the sample is
// the lowest-topological ready lemmas (the ones the next pass would attempt first).
import fs from 'node:fs';
import path from 'node:path';

export function loadCheckpointProblems(checkpointDir, { cap = 10 } = {}) {
    const ckptPath = path.join(checkpointDir, 'checkpoint.json');
    if (!fs.existsSync(ckptPath)) {
        throw new Error(`checkpoint not found: ${ckptPath}`);
    }
    const ckpt = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
    const lemmas = ckpt.lemmas ?? [];
    const proved = new Set(lemmas.filter(l => l.proof).map(l => l.id));
    const ready = lemmas.filter(l => !l.proof && !l.stalled && (l.deps ?? []).every(d => proved.has(d)));
    // Fall back to stalled-ready lemmas (the deadlock-release retry set) when the ready set is
    // exhausted — those are exactly what the next pass would retry.
    const stalledReady = lemmas.filter(l => !l.proof && l.stalled && (l.deps ?? []).every(d => proved.has(d)));
    const chosen = [...ready, ...stalledReady].slice(0, cap);
    return chosen.map((l, i) => ({
        id: `ckpt_${l.id.slice(0, 10)}`,
        tier: 'mission',
        statement: l.statement
    }));
}
