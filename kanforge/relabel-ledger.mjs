import fs from 'node:fs';
import { alignPartialExamples } from './agent/roles/probeAlign.js';

// The single ingestion entry (corpus/shortlist/manual.json) holds the kernel-verified probe
// examples produced by validateFormalization. This re-derives each probe's instance label from
// its example text with the SAME deterministic alignment the mechanism uses, and rewrites the
// mission ledger from the entry — no new facts, no second ingestion: the examples and their
// verified status are unchanged, only the labels are corrected.
const entry = JSON.parse(fs.readFileSync('corpus/shortlist/manual.json', 'utf8'));
const examples = (entry.probes ?? []).map(p => p.example).filter(Boolean);
const aligned = alignPartialExamples(examples, []);
const byExample = new Map(aligned.filter(a => a.instance).map(a => [a.example, a.instance]));

const probesPath = 'runs/erdos10-variant-two-pows/probes.json';
const ledger = JSON.parse(fs.readFileSync(probesPath, 'utf8'));
let changed = 0;
for (const p of ledger.probes) {
    const example = (entry.probes ?? []).find(e => e.instance === p.instance)?.example;
    if (example && byExample.has(example)) {
        const label = byExample.get(example);
        if (label !== p.instance) {
            console.log(`relabel: "${p.instance}" -> "${label}"`);
            p.instance = label;
            changed++;
        }
    }
}
ledger.generatedAt = new Date().toISOString();
fs.writeFileSync(probesPath, JSON.stringify(ledger, null, 2), 'utf8');
console.log(`ledger rewritten with ${changed} corrected label(s); ${ledger.probes.length} verified probes`);
