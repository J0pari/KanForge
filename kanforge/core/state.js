// Tree ↔ script bijectivity (architecture.md §2.4).
// straighten: proof tree → Lean tactic script (+ provenance map)
// unstraighten: script → tree (faithful inverse of straighten)
// buildProofSource: pinned statement + script → full kernel-checkable source
// assertRoundTrip: bijectivity check, enforced in tests
//
// Canonical script layout (2-space step per nesting level):
//   by
//     constructor        (indent 2)
//     · rfl             (bullet at indent 2, content at indent 4)
//     · constructor     (bullet at indent 2)
//       · rfl           (inner bullet at indent 4)
//       · rfl           (indent 4)
//
// Lean requires sequential tactics in a block to align at the SAME column, and
// `·` bullets to sit at the column of the tactic that opened the goal block
// (bullet content steps two columns deeper). Single-child chains therefore do
// not deepen — each next tactic continues on a new line at the same column.
//
// Rule (§2.4): repairs edit the tree, then re-straighten; kernel successes un-straighten
// back. Never edit one representation only.

export function straighten(tree) {
    if (!tree) return { script: 'by\n  sorry', map: new Map() };
    const map = new Map();
    let counter = 0;

    // Render each tactic line at its column relative to the body: chains reuse
    // the parent's column, bullets sit at the opener's column with content two
    // columns deeper (recursing the same way).
    function renderLines(node, col) {
        const id = `node_${counter++}`;
        map.set(id, node);
        const lines = [[col, node.tactic]];
        if (!node.subproofs || node.subproofs.length === 0) {
            return lines;
        } else if (node.subproofs.length === 1) {
            return lines.concat(renderLines(node.subproofs[0], col));
        } else {
            for (const sp of node.subproofs) {
                const spLines = renderLines(sp, col + 2);
                const [first, ...rest] = spLines;
                lines.push([col, `· ${first[1]}`], ...rest);
            }
            return lines;
        }
    }

    const scriptBody = renderLines(tree, 0)
        .map(([col, text]) => `${' '.repeat(col)}${text}`)
        .join('\n');
    const script = `by\n  ${scriptBody.split('\n').join('\n  ')}`;
    return { script, map };
}

export function unstraighten(script) {
    const items = String(script ?? '')
        .split(/\r?\n/)
        .filter(l => l.trim() && l.trim() !== 'by')
        .map(l => {
            const indent = (l.match(/^ */) ?? [''])[0].length;
            const t = l.trim();
            const bullet = t.startsWith('·');
            return { indent, bullet, text: bullet ? t.slice(1).trim() : t };
        });
    if (items.length === 0) return { tactic: 'sorry', subproofs: [] };

    let pos = 0;

    function parseNode(indent) {
        if (pos >= items.length) return null;
        const item = items[pos];
        if (item.bullet || item.indent !== indent) return null;

        const node = { tactic: item.text, subproofs: [] };
        pos++;
        if (pos >= items.length) return node;

        const next = items[pos];
        if (next.bullet) {
            // Multi-branch: `·` bullets at the node's own column.
            while (pos < items.length && items[pos].bullet && items[pos].indent === indent) {
                const b = parseBullet(indent);
                if (b) node.subproofs.push(b);
            }
        } else if (next.indent === indent) {
            // Single-child chain continues at the same column.
            const child = parseNode(indent);
            if (child) node.subproofs.push(child);
        }
        return node;
    }

    function parseBullet(indent) {
        if (pos >= items.length) return null;
        const item = items[pos];
        if (!item.bullet || item.indent !== indent) return null;

        const node = { tactic: item.text, subproofs: [] };
        pos++;
        if (pos >= items.length) return node;

        const contentIndent = indent + 2;
        const next = items[pos];
        if (next.bullet) {
            // Nested multi-branch: bullets at the content column.
            if (next.indent === contentIndent) {
                while (pos < items.length && items[pos].bullet && items[pos].indent === contentIndent) {
                    const b = parseBullet(contentIndent);
                    if (b) node.subproofs.push(b);
                }
            }
        } else if (next.indent === contentIndent) {
            // Single-child chain inside the bullet.
            const child = parseNode(contentIndent);
            if (child) node.subproofs.push(child);
        }
        return node;
    }

    const root = parseNode(items[0].indent);
    return root ?? { tactic: 'sorry', subproofs: [] };
}

function treesEqual(a, b) {
    if (!a || !b) return false;
    if (a.tactic !== b.tactic) return false;
    if ((a.subproofs?.length ?? 0) !== (b.subproofs?.length ?? 0)) return false;
    return (a.subproofs ?? []).every((sp, i) => treesEqual(sp, b.subproofs[i]));
}

export function assertRoundTrip(tree) {
    const { script } = straighten(tree);
    const roundTripped = unstraighten(script);
    if (!treesEqual(roundTripped, tree)) {
        throw new Error(`round-trip bijectivity check failed:\n${script}\n${JSON.stringify(roundTripped)}\n!=\n${JSON.stringify(tree)}`);
    }
    return true;
}

// Compose the full kernel-checkable source: the pinned statement with its `sorry` stub
// replaced by the composed proof script. Verifying anything less than this is not a kernel
// check of the lemma (architecture.md §2.5 invariant 2).
export function buildProofSource(statement, script) {
    const text = String(statement ?? '').trim();
    if (!/:=\s*by\s+sorry\s*$/.test(text)) {
        throw new Error(`statement is not a ':= by sorry' stub: ${text}`);
    }
    return text.replace(/:=\s*by\s+sorry\s*$/, ':= ' + String(script).trim());
}

// Transitive reuse source (§2.8 compression back-reference): a stored proof almost never
// stands alone — it references its own dependency lemmas. Inlining only the stored lemma makes
// the combined source fail fresh-env verification (observed as the store_reuse_rejected
// churn), so this assembles the dependency CLOSURE (each dep's statement + proof, recursively,
// deepest first) and appends the target stub whose script references the inlined declarations
// by name. Cycle-guarded, count-capped, and collision-aware: an entry whose declaration name
// is already present is skipped (duplicate declarations would reject the whole source).
// The kernel re-verifies the assembled text, so a bad closure costs one check, never truth.
export function buildReuseSource({ store, statement, proofScript, closureOf = null, includeClosureRoot = false, maxInline = 24 } = {}) {
    const parts = [];
    const seen = new Set();
    const declaredNames = new Set();
    const imports = new Set();
    const targetName = (String(statement).match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*)/) ?? [])[1] ?? null;
    if (targetName) declaredNames.add(targetName);

    // A part's statement keeps its OWN import lines out of the combined body: the kernel
    // rejects `import` anywhere but the top of the source. Every part's imports are hoisted
    // into one union block at the top instead (deduped, in first-seen order).
    const splitImports = (src) => {
        const lines = String(src).split(/\r?\n/);
        const imps = lines.filter(l => /^\s*import\s+\S/.test(l));
        for (const i of imps) imports.add(i.trim());
        return lines.filter(l => !/^\s*import\s+\S/.test(l)).join('\n');
    };

    const inline = (hash, depth) => {
        if (!hash || seen.has(hash) || depth > 8 || parts.length >= maxInline) return;
        seen.add(hash);
        const entry = store?.get?.(hash);
        if (!entry?.statement || !entry?.proofScript) return;
        const name = (String(entry.statement).match(/(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*)/) ?? [])[1];
        for (const d of entry.dependencies ?? entry.deps ?? []) inline(d, depth + 1);
        if (name && declaredNames.has(name)) return;
        if (name) declaredNames.add(name);
        try {
            parts.push(splitImports(buildProofSource(entry.statement, entry.proofScript)));
        } catch {
            // malformed stored entry — the closure continues without it
        }
    };

    if (closureOf) {
        if (includeClosureRoot) {
            inline(closureOf, 0);
        } else {
            seen.add(closureOf);
            const entry = store?.get?.(closureOf);
            for (const d of entry?.dependencies ?? entry?.deps ?? []) inline(d, 1);
        }
    }
    parts.push(splitImports(buildProofSource(statement, proofScript)));
    return `${[...imports].join('\n')}${imports.size ? '\n\n' : ''}${parts.join('\n\n')}`;
}
