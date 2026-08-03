// Audit pack assembly (architecture.md §7).
// The publication unit: theorem + statement pin + assumption account + dependency graph +
// critical path + causal trace (hash-chained) + guardrail report + checkpoints + writeup.

import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdownWriteup, renderHtmlWriteup } from './writeup.js';

export function assembleAuditPack({ theorem, statementHash, proofScript, assumptions = [], deps = [], events = [], metrics = {}, guardrailReport = {}, checkpoints = [] }) {
    return {
        theorem,
        statementHash,
        proofScript,
        assumptions,
        deps,
        events,
        metrics,
        guardrailReport,
        checkpoints,
        timestamp: new Date().toISOString()
    };
}

export function writeAuditPack(pack, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    // JSON audit pack
    const jsonPath = path.join(outputDir, 'audit.json');
    fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2));

    // Markdown writeup
    const mdPath = path.join(outputDir, 'proof.md');
    const markdown = renderMarkdownWriteup(pack.statementHash, pack.theorem, pack.proofScript, {
        deps: pack.deps,
        events: pack.events,
        metrics: pack.metrics
    });
    fs.writeFileSync(mdPath, markdown);

    // HTML writeup
    const htmlPath = path.join(outputDir, 'proof.html');
    const html = renderHtmlWriteup(markdown);
    fs.writeFileSync(htmlPath, html);

    return { jsonPath, mdPath, htmlPath };
}
