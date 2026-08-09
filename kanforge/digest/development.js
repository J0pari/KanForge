// Development digest (architecture.md §7, build_order.md §7.4).
// The publication unit for a whole blueprint: theorem + per-lemma proof tree + assumption
// ledger + hash chain + writeup (md/html). Assembles from the refiner's result and writes the
// full digest into the run directory. Per-lemma commit + audit packs come from growth/commit.js
// and digest/auditPack.js respectively.

import fs from 'node:fs';
import path from 'node:path';
import { hashStatement } from '../lean/pin.js';
import { hashChainEntry } from '../core/hasher.js';

// Assemble the development-level publication record.
//   refined: { ok, refined: { lemmas: [{ id, statement, deps, pinnedHash, proof }] }, proved, unproved, rounds, stored }
export function assembleDevelopmentDigest({ theorem, refined, statementHash = null, assumptions = [] }) {
    const lemmas = refined.refined.lemmas;
    const proved = refined.proved;
    const unproved = refined.unproved;

    // Run-level hash chain over the verified lemmas in DAG order (topological order of the
    // refined list): sha256(prevHash || statementHash || proofHash || 'verified').
    const chain = [];
    let prevHash = null;
    for (const l of lemmas) {
        if (!l.proof) continue;
        const sHash = hashStatement(l.statement);
        const pHash = hashStatement(l.proof);
        const entry = {
            prevHash,
            statementHash: sHash,
            proofHash: pHash,
            outcome: 'verified',
            hash: hashChainEntry(prevHash, sHash, pHash, 'verified')
        };
        chain.push(entry);
        prevHash = entry.hash;
    }

    return {
        theorem,
        statementHash: statementHash ?? hashStatement(theorem),
        lemmas: lemmas.map(l => ({
            id: l.id,
            statement: l.statement,
            deps: l.deps,
            pinnedHash: l.pinnedHash,
            proof: l.proof ?? null
        })),
        proved,
        unproved,
        assumptions,
        rounds: refined.rounds,
        stored: refined.stored,
        hashChain: chain,
        hashChainHash: chain.length ? chain[chain.length - 1].hash : null,
        timestamp: new Date().toISOString()
    };
}

export function renderDevelopmentWriteup(digest) {
    const lines = [];
    lines.push('# Proof Development');
    lines.push('');
    lines.push('## Theorem');
    lines.push('');
    lines.push('```lean');
    lines.push(digest.theorem);
    lines.push('```');
    lines.push('');
    lines.push(`- Statement hash: \`${digest.statementHash}\``);
    lines.push(`- Proved: ${digest.proved.length}/${digest.lemmas.length}`);
    lines.push(`- Unproved: ${digest.unproved.length}`);
    lines.push('');
    lines.push('## Assumption ledger');
    lines.push('');
    if (digest.assumptions.length) {
        for (const a of digest.assumptions) lines.push(`- ${a}`);
    } else {
        lines.push('- (none recorded)');
    }
    lines.push('');
    lines.push('## Lemmas');
    lines.push('');
    for (const l of digest.lemmas) {
        const status = l.proof ? 'PROVED' : 'OPEN';
        lines.push(`### ${status} \`${l.id.slice(0, 12)}…\``);
        lines.push('');
        lines.push('```lean');
        lines.push(l.statement);
        lines.push('```');
        lines.push('');
        lines.push(`- Deps: ${l.deps.map(d => `\`${d.slice(0, 12)}…\``).join(', ') || '(none)'}`);
        if (l.proof) {
            lines.push('- Proof:');
            lines.push('');
            lines.push('```lean');
            lines.push(l.proof);
            lines.push('```');
        }
        lines.push('');
    }
    lines.push('## Hash chain');
    lines.push('');
    lines.push('```');
    for (const e of digest.hashChain) {
        lines.push(`${e.outcome} ${e.statementHash.slice(0, 12)}… ${e.hash.slice(0, 16)}…`);
    }
    lines.push('```');
    if (digest.hashChainHash) lines.push(`\nChain head: \`${digest.hashChainHash}\``);
    return lines.join('\n');
}

export function renderDevelopmentHtml(markdown) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Proof Development</title>
    <style>
        body { font-family: sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
        pre { background: #f4f4f4; padding: 16px; border-radius: 4px; overflow-x: auto; }
        code { font-family: 'Courier New', monospace; }
        h1 { color: #333; } h2 { color: #555; border-bottom: 1px solid #ddd; padding-bottom: 6px; } h3 { color: #666; }
    </style>
</head>
<body>
${markdown
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/```lean\n([\s\S]*?)```/g, '<pre><code class="language-lean">$1</code></pre>')
    .replace(/```\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
}
</body>
</html>`;
}

// Write the full digest (audit.json + proof.md + proof.html) into outputDir. Returns paths.
export function writeDevelopmentDigest(digest, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, 'development.json');
    fs.writeFileSync(jsonPath, JSON.stringify(digest, null, 2) + '\n');
    const markdown = renderDevelopmentWriteup(digest);
    const mdPath = path.join(outputDir, 'development.md');
    fs.writeFileSync(mdPath, markdown);
    const htmlPath = path.join(outputDir, 'development.html');
    fs.writeFileSync(htmlPath, renderDevelopmentHtml(markdown));
    return { jsonPath, mdPath, htmlPath };
}
