// Tree ↔ script bijectivity (architecture.md §2.4).
// straighten: proof tree → Lean tactic script (+ provenance map)
// unstraighten: script → tree (faithful inverse of straighten)
// buildProofSource: pinned statement + script → full kernel-checkable source
// assertRoundTrip: bijectivity check, enforced in tests
//
// Canonical script layout (script coordinates, 2-space step per depth level):
//   by
//     intro h          (indent 2)
//       omega          (indent 4)
//
// Rule (§2.4): repairs edit the tree, then re-straighten; kernel successes un-straighten
// back. Never edit one representation only.

export function straighten(tree) {
    if (!tree) return { script: 'by\n  sorry', map: new Map() };
    const map = new Map();
    let counter = 0;

    function render(node, indent = 2) {
        const id = `node_${counter++}`;
        map.set(id, node);
        const spaces = ' '.repeat(indent);
        if (!node.subproofs || node.subproofs.length === 0) {
            return `${node.tactic}`;
        } else if (node.subproofs.length === 1) {
            const sub = render(node.subproofs[0], indent + 2);
            return `${node.tactic}\n${spaces}${sub}`;
        } else {
            const subs = node.subproofs.map(sp => {
                const r = render(sp, indent + 2);
                return `${spaces}· ${r}`;
            }).join('\n');
            return `${node.tactic}\n${subs}`;
        }
    }

    const scriptBody = render(tree, 2);
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

    function parseNode(expectedIndent) {
        if (pos >= items.length) return null;
        const currentIndent = items[pos].indent;
        if (currentIndent < expectedIndent) return null;

        const node = { tactic: items[pos].text, subproofs: [] };
        pos++;

        // Children live at currentIndent + 2
        const childIndent = currentIndent + 2;
        if (pos < items.length && items[pos].indent === childIndent) {
            if (items[pos].bullet) {
                // Multi-branch bullet group
                while (pos < items.length && items[pos].indent === childIndent && items[pos].bullet) {
                    const bulletNode = parseBullet(childIndent);
                    if (bulletNode) node.subproofs.push(bulletNode);
                }
            } else {
                // Single child chain
                const childNode = parseNode(childIndent);
                if (childNode) node.subproofs.push(childNode);
            }
        }
        return node;
    }

    function parseBullet(bulletIndent) {
        if (pos >= items.length || items[pos].indent !== bulletIndent || !items[pos].bullet) return null;
        const node = { tactic: items[pos].text, subproofs: [] };
        pos++;

        // Bullet's children live at bulletIndent + 2
        const childIndent = bulletIndent + 2;
        if (pos < items.length && items[pos].indent === childIndent) {
            if (items[pos].bullet) {
                while (pos < items.length && items[pos].indent === childIndent && items[pos].bullet) {
                    const b = parseBullet(childIndent);
                    if (b) node.subproofs.push(b);
                }
            } else {
                const childNode = parseNode(childIndent);
                if (childNode) node.subproofs.push(childNode);
            }
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
