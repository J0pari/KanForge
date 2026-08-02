import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBackend, LEAN_BACKEND_TYPES } from '../lean/backend.js';
import { BackendCli, resolveLeanBin } from '../lean/backendCli.js';
import { parseLeanMessages, leanErrorFromMessages } from '../lean/backendRepl.js';
import { hashStatement, makePin, checkPin } from '../lean/pin.js';

// Real-binary detection: the CLI suite drives the real `lean` from the pinned toolchain.
function leanAvailable() {
    try {
        const r = spawnSync(resolveLeanBin(process.env.KANFORGE_LEAN_BIN ?? 'lean'), ['--version'], { timeout: 10_000, encoding: 'utf8' });
        return r.status === 0;
    } catch {
        return false;
    }
}

const HAS_LEAN = leanAvailable();

test('factory: real backends only (repl | cli), unknown rejected', () => {
    assert.deepEqual(LEAN_BACKEND_TYPES, ['repl', 'cli']);
    assert.equal(createBackend({ type: 'cli' }).type, 'cli');
    assert.throws(() => createBackend({ type: 'mock' }), /unknown lean backend type/);
    assert.throws(() => createBackend({ type: 'lean4web' }), /unknown lean backend type/);
    assert.throws(() => createBackend({ type: 'nope' }), /unknown lean backend type/);
});

test(
    'cli backend: real lean verifies a statement, rejects a false one, cleans up temp files',
    { skip: !HAS_LEAN && 'real lean binary not found on PATH (KANFORGE_LEAN_BIN / elan)' },
    async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanforge-cli-'));
        const cli = new BackendCli({ tmpDir });
        try {
            assert.equal((await cli.check('example : 1 + 1 = 2 := by rfl')).status, 'verified');

            const err = await cli.check('example : False := by trivial');
            assert.equal(err.status, 'error');
            assert.ok(/error/i.test(err.error.message), `expected a lean diagnostic, got: ${err.error.message}`);

            assert.equal(fs.readdirSync(cli.tmpDir).length, 0, 'temp files cleaned up');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
);

test('parseLeanMessages: real repl Message shape (pos/endPos/severity/data)', () => {
    const messages = [
        { pos: { line: 1, column: 0 }, endPos: { line: 1, column: 5 }, severity: 'error', data: 'type mismatch' },
        { pos: { line: 2, column: 0 }, endPos: { line: 2, column: 4 }, severity: 'warning', data: 'declaration uses sorry' },
        { pos: { line: 3, column: 0 }, endPos: { line: 3, column: 2 }, severity: 'info', data: 'hello' }
    ];
    const { errors, warnings } = parseLeanMessages(messages);
    assert.equal(errors.length, 1);
    assert.equal(warnings.length, 2);

    const err = leanErrorFromMessages(messages);
    assert.deepEqual(err.span, { line: 1, col: 0, endLine: 1, endCol: 5 });
    assert.equal(err.message, 'type mismatch');
    assert.deepEqual(err.detail, ['type mismatch']);
});

test('leanErrorFromMessages: repl hard-error shape {message}', () => {
    const err = leanErrorFromMessages([]);
    assert.equal(err.message, 'lean error');
    assert.equal(err.span, undefined);
});

test('pin: normalization is whitespace-insensitive; WEAKENED vs DRIFT', () => {
    assert.equal(hashStatement('a\n  b'), hashStatement(' a b '));
    assert.notEqual(hashStatement('a b'), hashStatement('a c'));

    const ctx = { toolchain: 'leanprover/lean4:v4.33.0-rc1', mathlibHash: 'abc', leanVersion: 'v4.33.0-rc1' };
    const pin = makePin('example : True := by trivial', ctx);
    assert.equal(checkPin(pin, { ...ctx, statementHash: hashStatement('example : True := by trivial') }).ok, true);

    // WEAKENED: same context, statement mutated
    const weakened = checkPin(pin, { ...ctx, statementHash: hashStatement('example : True := by change True') });
    assert.equal(weakened.ok, false);
    assert.equal(weakened.drift, false);

    // DRIFT: toolchain changed
    const drift = checkPin(pin, { ...ctx, toolchain: 'leanprover/lean4:v4.34.0', statementHash: pin.statementHash });
    assert.equal(drift.ok, false);
    assert.equal(drift.drift, true);

    // DRIFT: normVersion changed
    const driftNorm = checkPin(pin, { ...ctx, normVersion: 2, statementHash: pin.statementHash });
    assert.equal(driftNorm.drift, true);
});
