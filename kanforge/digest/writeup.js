// Proof writeups with KaTeX (architecture.md §1, §7).
// Renders per-lemma cards + assumption account + dependency graph.

export function renderMarkdownWriteup(lemmaId, statement, proofScript, { deps = [], events = [], metrics = {} } = {}) {
    const depList = deps.length > 0
        ? deps.map(d => `- \`${d}\``).join('\n')
        : '- (none)';

    const eventSummary = events.length > 0
        ? `Total events: ${events.length}\nTactics proposed: ${events.filter(e => e.type === 'tactic_proposed').length}\nTactics applied: ${events.filter(e => e.type === 'tactic_applied').length}\nGoals solved: ${events.filter(e => e.type === 'goal_solved').length}`
        : '(no events)';

    return `# Proof Writeup: ${lemmaId}

## Statement
\`\`\`lean
${statement}
\`\`\`

## Proof
\`\`\`lean
${proofScript}
\`\`\`

## Dependencies
${depList}

## Metrics
- Tactics per lemma: ${metrics.tacticsPerLemma ?? 'N/A'}
- Tactic success rate: ${metrics.tacticSuccessRate ?? 'N/A'}

## Event Summary
${eventSummary}
`;
}

export function renderHtmlWriteup(markdown) {
    // Simple markdown to HTML conversion
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Proof Writeup</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        pre { background: #f4f4f4; padding: 16px; border-radius: 4px; overflow-x: auto; }
        code { font-family: 'Courier New', monospace; }
        h1 { color: #333; }
        h2 { color: #666; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
    </style>
</head>
<body>
${markdown
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/```lean\n([\s\S]*?)```/g, '<pre><code class="language-lean">$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
}
</body>
</html>`;
}
