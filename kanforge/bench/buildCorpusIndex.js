// Corpus manifest builder (build_order.md §7.0).
// Joins the teorth/erdosproblems database (status/OEIS/tags) with the
// google-deepmind/formal-conjectures Lean formalizations into
// corpus/index/corpus.json — the machine-readable intake gate artifact.
// Sources are PRIMARY (human-curated, human-formalized); the agent only joins them.
//
// Usage: node bench/buildCorpusIndex.js  → writes corpus/index/corpus.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(ROOT, '..', 'corpus');
const DB = path.join(CORPUS, 'sources', 'erdosproblems-db', 'data', 'problems.yaml');
const LEAN_DIR = path.join(CORPUS, 'sources', 'formal-conjectures', 'FormalConjectures', 'ErdosProblems');

function parseProblemsYaml(text) {
    const entries = [];
    const blocks = text.split(/\n- number: "/).slice(1);
    for (const block of blocks) {
        const num = block.slice(0, block.indexOf('"'));
        const rest = block.slice(block.indexOf('"') + 1);
        const get = (key) => {
            const m = rest.match(new RegExp(`${key}:\\s*"([^"]*)"`));
            return m ? m[1] : null;
        };
        const stateOf = (key) => {
            const m = rest.match(new RegExp(`${key}:\\s*\\n\\s*state: "([^"]*)"`));
            return m ? m[1] : null;
        };
        entries.push({
            number: num,
            prize: get('prize'),
            status: stateOf('informal_status'),
            formalized: stateOf('formalized'),
            oeis: (rest.match(/oeis: \[([^\]]*)\]/) ?? [])[1]?.split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) ?? [],
            tags: (rest.match(/tags: \[([^\]]*)\]/) ?? [])[1]?.split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) ?? []
        });
    }
    return entries;
}

function leanFiles() {
    const out = new Map();
    if (!fs.existsSync(LEAN_DIR)) return out;
    for (const f of fs.readdirSync(LEAN_DIR)) {
        const m = f.match(/^(\d+)\.lean$/);
        if (m) out.set(m[1], f);
    }
    return out;
}

const problems = parseProblemsYaml(fs.readFileSync(DB, 'utf8'));
const lean = leanFiles();

const missions = problems
    .filter(p => p.status === 'open' && p.formalized === 'yes' && lean.has(p.number))
    .map(p => ({
        id: `erdos-${p.number}`,
        source: 'erdosproblems.com',
        status: 'open',
        formalization: {
            lean: lean.get(p.number),
            source: 'google-deepmind/formal-conjectures'
        },
        prize: p.prize,
        oeis: p.oeis,
        tags: p.tags,
        statement: `https://www.erdosproblems.com/${p.number}`,
        latex: `https://www.erdosproblems.com/latex/${p.number}`
    }))
    .sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));

const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'bench/buildCorpusIndex.js',
    gate: 'build_order.md §7.0 — human-curated intake',
    sources: [
        {
            id: 'erdosproblems-db',
            url: 'https://github.com/teorth/erdosproblems',
            license: 'Apache-2.0',
            note: 'status/OEIS/tags database of erdosproblems.com'
        },
        {
            id: 'formal-conjectures',
            url: 'https://github.com/google-deepmind/formal-conjectures',
            license: 'Apache-2.0',
            note: 'Lean formalizations of Erdős problems (verbatim docstrings, sorry bodies)'
        }
    ],
    stats: {
        totalProblems: problems.length,
        open: problems.filter(p => p.status === 'open').length,
        openFormalized: missions.length
    },
    missions
};

const outDir = path.join(CORPUS, 'index');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(manifest, null, 2));
console.log(`corpus.json: ${missions.length} open+formalized mission candidates from ${problems.length} problems`);
