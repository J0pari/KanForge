// Development digest + per-lemma commit (build_order.md §2.3, §7.4).
// The DoD tail: every blueprint completion writes the development writeup + audit + hash chain
// and commits per-lemma to a scratch repo.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assembleDevelopmentDigest, writeDevelopmentDigest, renderDevelopmentWriteup } from '../digest/development.js';
import { commitLemma, commitDevelopment, writeLemmaArtifacts, formatLemmaCommitMessage } from '../growth/commit.js';
import { hashStatement } from '../lean/pin.js';
import { verifyHashChain } from '../core/hasher.js';

function makeRefined(lemmas) {
    return {
        ok: true,
        refined: { lemmas },
        proved: lemmas.filter(l => l.proof).map(l => l.id),
        unproved: lemmas.filter(l => !l.proof).map(l => l.id),
        rounds: [],
        stored: { lemmas: 2, samples: 4 }
    };
}

function mkLemma(name, proof) {
    const statement = `lemma ${name} : True := by sorry`;
    return { id: hashStatement(statement), statement, deps: [], pinnedHash: hashStatement(statement), proof: proof ?? null };
}

test('development digest emits a valid hash chain over verified lemmas', () => {
    const l1 = mkLemma('l1', 'trivial');
    const l2 = mkLemma('l2', 'rfl');
    const refined = makeRefined([l1, l2]);
    const digest = assembleDevelopmentDigest({ theorem: 'theorem t : True := by sorry', refined });

    assert.strictEqual(digest.proved.length, 2);
    assert.strictEqual(digest.hashChain.length, 2);
    const ok = verifyHashChain(digest.hashChain);
    assert.strictEqual(ok.ok, true);
    // chain-head equals the last entry's hash
    assert.strictEqual(digest.hashChainHash, digest.hashChain[1].hash);
});

test('development digest skips unproved lemmas in the chain', () => {
    const open = mkLemma('open', null);
    const proven = mkLemma('proven', 'rfl');
    const digest = assembleDevelopmentDigest({ theorem: 'theorem t : True := by sorry', refined: makeRefined([open, proven]) });
    assert.strictEqual(digest.unproved.length, 1);
    assert.strictEqual(digest.hashChain.length, 1);
});

test('writeDevelopmentDigest writes md/html/json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
    const digest = assembleDevelopmentDigest({
        theorem: 'theorem t : True := by sorry',
        refined: makeRefined([mkLemma('l1', 'rfl')]),
        assumptions: ['assumption ledger entry']
    });
    const paths = writeDevelopmentDigest(digest, dir);
    assert.ok(fs.existsSync(paths.jsonPath));
    assert.ok(fs.existsSync(paths.mdPath));
    assert.ok(fs.existsSync(paths.htmlPath));
    const md = fs.readFileSync(paths.mdPath, 'utf8');
    assert.ok(md.includes('assumption ledger entry'));
    assert.ok(md.includes('Chain head'));
});

test('development digest records model provenance in JSON + writeup (architecture.md §5.7)', () => {
    const l1 = mkLemma('l1', 'rfl');
    const refined = makeRefined([l1]);
    const digest = assembleDevelopmentDigest({
        theorem: 'theorem t : True := by sorry',
        refined,
        provenance: { provider: 'opencode', model: 'deepseek-v4-flash', toolchain: 'leanprover/lean4:v4.33.0-rc1' }
    });
    assert.strictEqual(digest.provenance.model, 'deepseek-v4-flash');
    assert.strictEqual(digest.provenance.provider, 'opencode');
    const md = renderDevelopmentWriteup(digest);
    assert.ok(md.includes('## Provenance'));
    assert.ok(md.includes('model: deepseek-v4-flash'));
});

test('development digest carries the §5.9 patch stream as transformation history', () => {
    const l1 = mkLemma('l1', 'rfl');
    l1.patchStream = [
        { op: 'tactic', node: 'g1', replacement: 'rfl', scope: 'goal', meta: { attempt: 1, via: 'proposal' } },
        { op: 'lemma', node: l1.id, scope: 'lemma' }
    ];
    const digest = assembleDevelopmentDigest({ theorem: 'theorem t : True := by sorry', refined: makeRefined([l1]) });
    assert.strictEqual(digest.lemmas[0].patchStream.length, 2);
    const md = renderDevelopmentWriteup(digest);
    assert.ok(md.includes('Patch stream (2)'));
    assert.ok(md.includes('tactic'));
    assert.ok(md.includes('rfl'));
});

test('commitLemma writes artifacts and commits with the statement hash in the message', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    const stmt = 'lemma l1 : True := by sorry';
    const id = hashStatement(stmt);
    writeLemmaArtifacts({ repoDir, lemmaId: id, statementHash: id, statement: stmt, proofScript: 'rfl' });
    const commit = commitLemma({ lemmaId: id, statementHash: id, repoDir });
    assert.ok(commit);
    // second commit of an unchanged tree is a no-op (nothing staged)
    const again = commitLemma({ lemmaId: id, statementHash: id, repoDir });
    assert.strictEqual(again, null);

    const log = execFileSync('git', ['log', '--format=%s'], { cwd: repoDir }).toString();
    assert.ok(log.includes(formatLemmaCommitMessage(id, id).slice(0, 20)));
    assert.ok(log.includes(id));
});

test('commitDevelopment writes the closing development commit', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-dev-'));
    // The dev commit captures the digest, so write it into the repo first (as runBlueprintTheorem does).
    const digest = assembleDevelopmentDigest({
        theorem: 'theorem t : True := by sorry',
        refined: makeRefined([mkLemma('l1', 'rfl')])
    });
    writeDevelopmentDigest(digest, repoDir);
    const devCommit = commitDevelopment({ developmentId: 'dev1', statementHash: 'abc', repoDir });
    assert.ok(devCommit);
});
