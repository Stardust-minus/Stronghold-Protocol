import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const script = fileURLToPath(new URL('../set-password.mjs', import.meta.url));
const wrapper = "process.umask(0o077); await import((await import('node:url')).pathToFileURL(process.argv[1]).href)";
const run = (path, password) => spawnSync(process.execPath, ['--input-type=module', '-e', wrapper, script, path], { input: password + '\n', encoding: 'utf8' });

test('rotation preserves group readability even under umask 077 and rotates signing key', { skip: process.getuid?.() !== 0 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'ark-gate-rotation-'));
  try {
    const path = join(folder, 'gate.json');
    let result = run(path, 'test-password-for-first-config');
    assert.equal(result.status, 0, result.stderr);
    let state = statSync(path);
    assert.equal(state.mode & 0o777, 0o440);
    assert.equal(state.uid, 0); assert.equal(state.gid, 1000);
    const first = JSON.parse(readFileSync(path));
    result = run(path, 'test-password-for-second-config');
    assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(readFileSync(path));
    assert.notEqual(first.signingKey, second.signingKey);
    assert.notEqual(first.hash, second.hash);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /test-password/);
    state = statSync(path); assert.equal(state.mode & 0o777, 0o440);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('credential tool refuses a private directory owned by another user', { skip: process.getuid?.() !== 0 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'ark-gate-owner-'));
  try {
    chownSync(folder, 65534, 65534);
    const result = run(join(folder, 'gate.json'), 'test-password-for-owner-check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root-owned directory/);
  } finally { chownSync(folder, 0, 0); rmSync(folder, { recursive: true, force: true }); }
});
