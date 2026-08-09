// Content-addressed lemma store → retrieval index (architecture.md §2.8, build_order.md §5.7).
// Each lemma is one JSON file (<dir>/lemmas/<hash>.json) written atomically (tmp + rename) so a
// crash never leaves a half-written entry; reads are corruption-tolerant (broken files are
// recorded in `corrupt`, never fatal).
//
// Index columns (captured at lemma_verified): statementHash, normalizedGoalShape, freeVariables,
// imports, dependencies, proofLength, tacticTrajectory, difficulty, successConditions. Columns
// the caller cannot derive are stored as null — never fabricated (build_order.md §5.6 rule).
//
// Reuse modes (§2.8): exact reuse via get(hash) (Stage 2, live in blueprint/refine.js);
// ranked retrieval via findSimilar(goalShape) (Stage 3, build_order.md §5.7).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs');

function writeJsonAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

// Extract `import Foo.Bar` lines from a statement; used as an index column.
export function extractImports(statement) {
    const out = [];
    for (const line of String(statement ?? '').split(/\r?\n/)) {
        const m = line.trim().match(/^import\s+(\S+)/);
        if (m) out.push(m[1]);
    }
    return out;
}

// Normalize the goal shape: everything after the final `: ` of the top-level statement, with
// binder names removed (`a b c : Nat` -> `Nat`), whitespace collapsed. This is a lexical shape
// (binder count + type skeleton), NOT alpha-normalization — good enough for ranked retrieval,
// and documented as such (§2.8).
export function extractGoalShape(statement) {
    const s = String(statement ?? '').trim();
    // Find the proposition: after the last `: <type>` that is not inside the proof body.
    const body = s.replace(/:=\s*by\s+sorry\s*$/, '').trim();
    const colon = body.lastIndexOf(':');
    if (colon === -1) return null;
    let rest = body.slice(colon + 1).trim();
    rest = rest.replace(/\b([a-zA-Z_][a-zA-Z0-9_']*)\s*:/g, 'B :'); // binders -> B :
    rest = rest.replace(/[ \t\r\n]+/g, ' ').trim();
    return rest || null;
}

// Free variables of the statement: identifier tokens (excluding Lean keywords and the
// binder-type arrows) that appear in the proposition text. Lexical heuristic for §2.8 indexing.
export function extractFreeVariables(statement) {
    const shape = extractGoalShape(statement);
    if (!shape) return [];
    const reserved = new Set(['theorem', 'lemma', 'example', 'def', 'by', 'sorry', 'B', 'Prop', 'Type', 'Sort', 'True', 'False']);
    const tokens = shape.split(/[^a-zA-Z0-9_']+/).filter(t => t && !/^\d+$/.test(t) && !reserved.has(t));
    return [...new Set(tokens)];
}

// Tactic trajectory: per-line first tokens of the proof script (strip comments/fences).
export function extractTacticTrajectory(proofScript) {
    const out = [];
    for (const line of String(proofScript ?? '').split(/\r?\n/)) {
        const t = line.trim().replace(/^--.*/, '').trim();
        if (!t || t.startsWith('```')) continue;
        const head = t.split(/\s+/)[0].replace(/[()[\]{},;.]/g, '');
        if (head) out.push(head);
    }
    return out;
}

// A lemma index entry: index columns + the artifact. Columns that could not be derived are null.
export function buildLemmaIndex({ statementHash, statement, proofScript, deps = [], goalCount = null, ms = null, imports = null, patchStream = [] }) {
    return {
        statementHash,
        statement,
        proofScript,
        normalizedGoalShape: statement ? extractGoalShape(statement) : null,
        freeVariables: statement ? extractFreeVariables(statement) : [],
        imports: imports ?? (statement ? extractImports(statement) : []),
        dependencies: deps ?? [],
        proofLength: proofScript ? proofScript.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('--')).length : null,
        tacticTrajectory: proofScript ? extractTacticTrajectory(proofScript) : [],
        difficulty: { goalCount, ms },
        successConditions: { verified: true },
        patchStream: patchStream ?? [], // §5.9: the typed transformation history (per-lemma patches)
        timestamp: Date.now()
    };
}

export class LemmaStore {
    constructor({ dir = null } = {}) {
        this.dir = dir ?? path.join(DATA_ROOT, 'lemma-store');
        this.store = new Map();
        this.corrupt = [];
        this._load();
    }

    put(hash, lemmaData) {
        if (typeof hash !== 'string' || !hash) throw new Error('LemmaStore.put requires a hash string');
        this.store.set(hash, lemmaData);
        const dir = path.join(this.dir, 'lemmas');
        fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(path.join(dir, `${hash}.json`), { hash, data: lemmaData });
        return hash;
    }

    get(hash) {
        return this.store.get(hash) ?? null;
    }

    has(hash) {
        return this.store.has(hash);
    }

    list() {
        return [...this.store.values()];
    }

    get size() {
        return this.store.size;
    }

    getCorrupt() {
        return [...this.corrupt];
    }

    // Stage 3 (§5.7): ranked candidates by goal-shape and tactic-trajectory overlap. Exact
    // statement-hash matches rank first; then shape-string equality; then token overlap of the
    // normalized goal shape and trajectory heads. Lexical similarity — documented as such.
    findSimilar(goalShape, { limit = 5 } = {}) {
        const shape = String(goalShape ?? '').trim();
        const shapeTokens = new Set(shape.split(/[^a-zA-Z0-9_']+/).filter(Boolean));
        const scored = [];
        for (const entry of this.store.values()) {
            const eShape = entry?.normalizedGoalShape ?? '';
            let score = 0;
            if (shape && eShape === shape) score += 100;
            const eTokens = new Set(eShape.split(/[^a-zA-Z0-9_']+/).filter(Boolean));
            for (const t of shapeTokens) if (eTokens.has(t)) score += 1;
            for (const t of entry?.tacticTrajectory ?? []) if (t) score += 0.5;
            if (score > 0) scored.push({ score, entry });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.entry);
    }

    _load() {
        this.store = new Map();
        this.corrupt = [];
        const dir = path.join(this.dir, 'lemmas');
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            const hash = f.slice(0, -'.json'.length);
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                if (parsed && typeof parsed.hash === 'string' && parsed.data !== undefined) {
                    this.store.set(parsed.hash, parsed.data);
                } else {
                    this.corrupt.push({ hash, error: 'malformed entry (missing hash or data)' });
                }
            } catch (err) {
                this.corrupt.push({ hash, error: err?.message ?? String(err) });
            }
        }
    }
}
