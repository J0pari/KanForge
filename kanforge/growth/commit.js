// Commit-per-lemma growth (architecture.md §1, build_order.md §2.3, §7.4).
// Each verified lemma (and the whole-development summary) is committed to a scratch repo with
// the statement hash in the message, so `git log` is the publication record and the hasher audit
// reproduces the chain. Uses the system git; the repo is initialized lazily on first commit.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function formatLemmaCommitMessage(lemmaId, statementHash) {
    return `feat(proof): prove lemma ${lemmaId} [stmt:${statementHash}]`;
}

function ensureRepo(repoDir) {
    fs.mkdirSync(repoDir, { recursive: true });
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
        execFileSync('git', ['init', '-q', repoDir], { stdio: 'pipe' });
    }
}

function git(repoDir, args) {
    return execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
}

// Ensure a commit author identity exists (no assumption about global git config).
function ensureIdentity(repoDir) {
    try {
        git(repoDir, ['config', 'user.name']);
    } catch {
        git(repoDir, ['config', 'user.name', 'KanForge']);
    }
    try {
        git(repoDir, ['config', 'user.email']);
    } catch {
        git(repoDir, ['config', 'user.email', 'kanforge@localhost']);
    }
}

// Write the per-lemma artifacts (statement, proof, audit pack) into the scratch repo's tree.
// Returns the directory written. The audit pack carries the full theorem text, so the `.lean`
// files are thin pointers plus the assembled proof script.
export function writeLemmaArtifacts({ repoDir, lemmaId, statementHash, statement, proofScript, auditPack = null }) {
    const dir = path.join(repoDir, 'lemmas', lemmaId.slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'statement.lean'), `-- statement ${statementHash}\n${statement}\n`);
    fs.writeFileSync(path.join(dir, 'proof.lean'), proofScript + '\n');
    if (auditPack) fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(auditPack, null, 2));
    return dir;
}

// Commit a single verified lemma. Returns the commit hash, or null if nothing was committed
// (already committed / no changes staged).
export function commitLemma({ lemmaId, statementHash, repoDir }) {
    if (!repoDir) return null;
    ensureRepo(repoDir);
    ensureIdentity(repoDir);
    git(repoDir, ['add', '.']);
    const message = formatLemmaCommitMessage(lemmaId, statementHash);
    try {
        git(repoDir, ['commit', '-q', '-m', message]);
    } catch {
        return null;
    }
    return git(repoDir, ['rev-parse', 'HEAD']);
}

// Commit a whole-development summary (blueprint + audit chain) as the closing publication record.
export function commitDevelopment({ developmentId, statementHash, repoDir }) {
    if (!repoDir) return null;
    ensureRepo(repoDir);
    ensureIdentity(repoDir);
    git(repoDir, ['add', '.']);
    const message = `feat(development): refine ${developmentId} [stmt:${statementHash}]`;
    try {
        git(repoDir, ['commit', '-q', '-m', message]);
    } catch {
        return null;
    }
    return git(repoDir, ['rev-parse', 'HEAD']);
}
