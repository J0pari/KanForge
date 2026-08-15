// Live premise corpus (search/premises.js is the retrieval engine; this module is the CORPUS
// SOURCE for the live refine path — the seam that was unwired between the curated ablation
// corpora and the production loop). A premise is `{ name, type }` (the PremiseRetriever
// contract). Sources, merged by name:
//   1. Curated kernel-verified base (bench/premisesCorpus.js) — the step-tier set.
//   2. Every lemma PROVED in this mission's checkpoint (parse name + type from the stub).
//   3. Every lemma in the global lemma store (cross-problem transfer).
//   4. The harvest file: mathlib names referenced by verified proofs, resolved via `#check`
//      (appended as {name, type} JSONL; grows the corpus exactly where the campaign works).
import fs from 'node:fs';
import path from 'node:path';
import { extractIdentifiers } from './premises.js';

// Tactic names and keywords that are never premise candidates. Namespaced identifiers
// (containing '.') bypass the stopword filter — a dotted name is a declaration reference.
const TACTIC_STOPWORDS = new Set([
    'rw', 'rwa', 'simpa', 'simp', 'exact', 'apply', 'refine', 'intro', 'intros', 'rintro',
    'rintros', 'rcases', 'cases', 'induction', 'constructor', 'left', 'right', 'assumption',
    'contradiction', 'by_contra', 'omega', 'rfl', 'decide', 'native_decide', 'ring', 'ring_nf',
    'linarith', 'nlinarith', 'norm_num', 'norm_num1', 'positivity', 'field_simp', 'tauto',
    'abel', 'have', 'let', 'fun', 'show', 'calc', 'subst', 'obtain', 'generalize', 'dsimp',
    'change', 'conv', 'split', 'trivial', 'exfalso', 'repeat', 'try', 'first', 'done', 'skip',
    'fail', 'trace', 'haveI', 'letI', 'aesop', 'gcongr', 'congr', 'unfold', 'push_neg',
    'interval_cases', 'fin_cases', 'mono', 'with', 'using', 'at', 'in', 'by', 'else', 'then',
    'rename_i', 'specialize', 'set', 'omega', 'ext', 'constructor', 'casesm', 'rfl_simp'
]);

// `theorem/lemma <name> [binder telescopes] : <type> := by sorry` (imports may precede)
// -> { name, type }.
export function premiseFromStatement(statement) {
    const text = String(statement ?? '');
    const decl = text.match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.']*)\s*(\([^)]*\)\s*)*:\s*([\s\S]*?):=\s*by\s+sorry\s*$/);
    if (!decl) return null;
    const type = decl[3].replace(/\s+/g, ' ').trim();
    if (!type) return null;
    return { name: decl[1], type };
}

// Identifier names in a proof script that are premise candidates: dotted names always; bare
// names only when they look like declarations (longer snake_case), minus the tactic stopwords.
export function harvestableIdentifiers(proofScript, knownNames = new Set()) {
    const seen = new Set();
    const out = [];
    for (const id of extractIdentifiers(proofScript)) {
        if (seen.has(id) || knownNames.has(id)) continue;
        seen.add(id);
        const isDotted = id.includes('.');
        const plausible = isDotted || (id.length >= 6 && id.includes('_'));
        if (!plausible) continue;
        if (!isDotted && TACTIC_STOPWORDS.has(id)) continue;
        // Strip dotted suffixes of known names: `Nat.mul_comm` is known => `mul_comm` is not new.
        const dottedKnown = knownNames.has(id.split('.').pop() ?? '');
        if (dottedKnown && !isDotted) continue;
        out.push(id);
    }
    return out;
}

// Merge premise lists, deduping by name (first insertion wins — curated/base order matters).
export function mergePremiseCorpora(lists = []) {
    const byName = new Map();
    for (const list of lists) {
        for (const p of list ?? []) {
            if (!p || !p.name || byName.has(p.name)) continue;
            byName.set(p.name, { name: p.name, type: String(p.type ?? '') });
        }
    }
    return [...byName.values()];
}

export function premisesFromLemmas(lemmas = []) {
    const out = [];
    for (const l of lemmas ?? []) {
        if (!l?.proof) continue;
        const p = premiseFromStatement(l.statement);
        if (p) out.push(p);
    }
    return out;
}

export function loadHarvestFile(file) {
    if (!file || !fs.existsSync(file)) return [];
    const out = [];
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!raw.trim()) continue;
        try {
            const p = JSON.parse(raw);
            if (p?.name) out.push({ name: p.name, type: String(p.type ?? '') });
        } catch {
            // skip malformed line — the harvest is an accumulator, not a gate
        }
    }
    return out;
}

export function appendHarvestFile(file, entries) {
    if (!file || !entries?.length) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, entries.map(e => JSON.stringify(e) + '\n').join(''), 'utf8');
    } catch (err) {
        console.log(`[premises] harvest append failed: ${err?.message ?? err}`);
    }
}
