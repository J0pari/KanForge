// Per-lemma artifact writer (architecture.md §1, build_order.md §2.3, §7.4).
// Every verified lemma's publication record is a DIRECTORY of files in the problem workdir —
// statement.lean (pinned statement), proof.lean (assembled proof script), audit.json (audit
// pack) — plus its entry in the development digest's hash chain. The digest and hash chain are
// the audit trail; nothing is narrated over an external VCS.

import fs from 'node:fs';
import path from 'node:path';

// Write the per-lemma artifacts into the problem workdir. Returns the directory written.
export function writeLemmaArtifacts({ workDir, lemmaId, statementHash, statement, proofScript, auditPack = null }) {
    const dir = path.join(workDir, 'lemmas', lemmaId.slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'statement.lean'), `-- statement ${statementHash}\n${statement}\n`);
    fs.writeFileSync(path.join(dir, 'proof.lean'), proofScript + '\n');
    if (auditPack) fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(auditPack, null, 2));
    return dir;
}
