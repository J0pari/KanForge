// Verified-attempts → training dataset (architecture.md §1, build_order.md §6.4).
// Samples are appended to an append-only JSONL file (monotonic growth), never rewritten.
// Every sample gets a deterministic held-out split from its state hash, so the same goal
// always lands in the same split and later samples cannot retro-contaminate the train set.
// The problem corpus records self-generated problems (from the target list) so the
// contamination check can report overlap against benchmark splits per release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashStatement } from '../lean/pin.js';

const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs');

function hashBucket(state, split) {
    const h = parseInt(hashStatement(typeof state === 'string' ? state : JSON.stringify(state)).slice(0, 8), 16);
    return (h % 100) < Math.round(split * 100) ? 'train' : 'held-out';
}

export class TrainingDataset {
    constructor({ dir = null, split = 0.9 } = {}) {
        this.dir = dir ?? path.join(DATA_ROOT, 'training-dataset');
        this.split = split;
        this.samples = [];
        this.problems = [];
        this.corrupt = [];
        this._load();
    }

    addSample(state, tactic, outcome) {
        const sample = {
            id: `s${this.samples.length}`,
            state,
            tactic,
            outcome,
            timestamp: Date.now(),
            split: hashBucket(state, this.split)
        };
        this.samples.push(sample);
        this._append('samples.jsonl', sample);
        return sample;
    }

    recordProblem(statement, { source = null, generatedBy = null } = {}) {
        const problem = {
            id: `p${this.problems.length}`,
            statement,
            statementHash: hashStatement(statement),
            source,
            generatedBy,
            timestamp: Date.now()
        };
        this.problems.push(problem);
        this._append('problems.jsonl', problem);
        return problem;
    }

    exportJson() {
        return JSON.stringify({ meta: { split: this.split, sampleCount: this.samples.length, problemCount: this.problems.length }, samples: this.samples, problems: this.problems }, null, 2);
    }

    trainSplit() {
        return this.samples.filter(s => s.split === 'train');
    }

    heldOutSplit() {
        return this.samples.filter(s => s.split === 'held-out');
    }

    // benchmarkSets: { name: [statement, ...], ... }. Overlap is on normalized statement
    // text (statement hashes), so benchmark problems that were also generated into the
    // corpus (directly or via a verified attempt) are reported.
    contaminationCheck(benchmarkSets) {
        const overlaps = [];
        for (const [setName, statements] of Object.entries(benchmarkSets ?? {})) {
            const benchHashes = new Set(statements.map(s => hashStatement(s)));
            for (const p of this.problems) {
                if (benchHashes.has(p.statementHash)) {
                    overlaps.push({ set: setName, statement: p.statement, problemId: p.id });
                }
            }
        }
        return { clean: overlaps.length === 0, overlaps };
    }

    getCorrupt() {
        return [...this.corrupt];
    }

    _append(file, record) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(path.join(this.dir, file), JSON.stringify(record) + '\n');
    }

    _load() {
        this.samples = [];
        this.problems = [];
        this.corrupt = [];
        for (const [file, target] of [['samples.jsonl', 'samples'], ['problems.jsonl', 'problems']]) {
            const p = path.join(this.dir, file);
            if (!fs.existsSync(p)) continue;
            let line = 0;
            for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
                if (!raw.trim()) continue;
                line++;
                try {
                    this[target].push(JSON.parse(raw));
                } catch (err) {
                    this.corrupt.push({ file, line, error: err?.message ?? String(err) });
                }
            }
        }
    }
}
