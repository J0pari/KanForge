// Content-addressed lemma store (architecture.md §1, build_order.md §2.3 / §6.4).
// On-disk persistence keyed by statement hash. Each lemma is one JSON file
// (<dir>/lemmas/<hash>.json), written atomically (tmp + rename) so a crash never
// leaves a half-written entry. Reads are corruption-tolerant: a broken file is
// recorded in `corrupt` and skipped, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs');

function writeJsonAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
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
