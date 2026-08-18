import fs from 'node:fs';

const p = './agent/roles/autoformalizer.js';
const t = fs.readFileSync(p, 'utf8');

// 1. Insert set-literal extraction (brace-counting, no regex escapes) after extractTestInstancesFromFc.
const anchor = '// Instance strings for the ledger/probe step from extracted membership facts.';
const literalFn = [
    '// Extract the set literal from a `Set.Infinite { ... }` statement by brace counting.',
    'export function extractSetLiteral(statement) {',
    '    const text = String(statement ?? "");',
    '    const k = text.indexOf("Set.Infinite");',
    '    if (k === -1) return null;',
    '    const open = text.indexOf("{", k);',
    '    if (open === -1) return null;',
    '    let depth = 0;',
    '    for (let i = open; i < text.length; i++) {',
    '        const ch = text[i];',
    '        if (ch === "{") depth++;',
    '        else if (ch === "}") { depth--; if (depth === 0) return text.slice(open, i + 1); }',
    '    }',
    '    return null;',
    '}',
    ''
].join('\n');
if (!t.includes(anchor)) throw new Error('anchor not found');
const t1 = t.split(anchor).join(literalFn + anchor);

// 2. Insert the autoInstances step into formalize: after _verifyStatement passes and the
//    caller provided no instances, kernel-decide membership of small numbers against the set
//    literal. Every verdict (member or not) is a kernel fact, so the ledger is evidence.
const marker = '            const probes = await this._verifyProbes(statement, instances);';
const autoBlock = [
    '            let ledgerInstances = instances;',
    '            let autoProbeResults = [];',
    '            if (!ledgerInstances?.length) {',
    '                const setLit = extractSetLiteral(statement);',
    '                if (setLit) {',
    '                    const imports = statement.split("\\n").filter(l => /^\\s*import\\s+\\S/.test(l)).join("\\n");',
    '                    for (const n of [1, 2, 3, 4, 5]) {',
    '                        const inSrc = `${imports}${imports ? "\\n\\n" : ""}example : (${n} : Nat) \\u2208 ${setLit} := by decide`;',
    '                        const notSrc = `${imports}${imports ? "\\n\\n" : ""}example : (${n} : Nat) \\u2209 ${setLit} := by decide`;',
    '                        try {',
    '                            const inChk = await this.backend.check(inSrc, { timeoutMs: this.checkTimeoutMs, useWarmEnv: false });',
    '                            if (inChk.status === "verified") { autoProbeResults.push({ instance: `the number ${n} is an element of the set`, verified: true }); continue; }',
    '                            const notChk = await this.backend.check(notSrc, { timeoutMs: this.checkTimeoutMs, useWarmEnv: false });',
    '                            if (notChk.status === "verified") autoProbeResults.push({ instance: `the number ${n} is not an element of the set`, verified: true });',
    '                        } catch { /* undecidable or infra failure: skip this candidate */ }',
    '                    }',
    '                }',
    '                ledgerInstances = autoProbeResults.map(r => r.instance);',
    '            }',
    '            const probes = await this._verifyProbes(statement, ledgerInstances);',
    ''
].join('\n');
if (!t1.includes(marker)) throw new Error('probes marker not found');
const t2 = t1.split(marker).join(autoBlock);

// 3. The shortlist entry must carry the auto probes even when the LLM probe step saw no
//    caller instances: merge autoProbeResults into the entry's probes when present.
const entryMarker = 'probes: probes.results, attempts: attempt';
const entryFix = 'probes: autoProbeResults.length ? autoProbeResults : probes.results, attempts: attempt';
if (!t2.includes(entryMarker)) throw new Error('entry marker not found');
const t3 = t2.split(entryMarker).join(entryFix);

fs.writeFileSync(p, t3, 'utf8');
console.log('autoformalizer patched');
