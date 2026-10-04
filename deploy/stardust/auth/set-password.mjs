import { readFileSync, writeFileSync, lstatSync, existsSync, renameSync, unlinkSync, chownSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeSecrets, validateSecrets } from './server.mjs';

if (process.getuid?.() !== 0) throw new Error('Run this credential tool as root');
if (process.argv.length !== 3) throw new Error('Usage: node set-password.mjs /path/to/gate.json (password on stdin)');
const target = resolve(process.argv[2]);
const parent = lstatSync(dirname(target));
if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o077) !== 0) throw new Error('Secret directory must be a private root-owned directory');
if (existsSync(target)) {
  const state = lstatSync(target);
  if (!state.isFile() || state.isSymbolicLink() || state.uid !== 0) throw new Error('Refusing to replace an unexpected secret file');
  validateSecrets(JSON.parse(readFileSync(target, 'utf8')));
}
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const value = await makeSecrets(password);
const temp = join(dirname(target), `.gate-${randomBytes(8).toString('hex')}.tmp`);
try {
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o440, flag: 'wx' });
  chownSync(temp, 0, 1000);
  chmodSync(temp, 0o440);
  renameSync(temp, target);
} finally {
  if (existsSync(temp)) unlinkSync(temp);
}
console.log('Verifier and signing key replaced. Recreate only the auth container to apply.');
