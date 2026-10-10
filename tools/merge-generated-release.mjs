#!/usr/bin/env node
// Bounded 0.2.2 → 0.2.3 migration when the historical official table cache is unavailable.
// Snapshot directories are JSON data, never executable inputs. Normal generators remain unchanged.
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { contentHash, MANIFEST_VERSION } from './assets/manifest.mjs';
import { countStats } from './fetch-assets.mjs';

export const RELEASE_SNAPSHOTS = Object.freeze({
  base: { commit: '62eb113419123d9a3a63606107bbf85230c5dd2f', blobs: {
    'assets.json': '56a687028904f1e36f21c9ee5b8e72d759fa4bad', 'config.json': '3a7cba750a01ff5ccea92deb9c8cd01eed90f64d',
  } },
  fork: { commit: '2526d1bfe01eb1705272695a85bb116f03c238a3', blobs: {
    'assets.json': '437056327dcb374a464cb11376974e93be742159', 'config.json': 'e02bbc7058ac796e382c8b8e536a1f3e03602eb2',
  } },
  official: { commit: '1db8e51023ae6abaec9370beb81a513d5c4d0b01', blobs: {
    'assets.json': '75c965182900fc53d5ce1b44d64b33435feb3aa3', 'config.json': 'e346b64bbd3d5fd5971570a03c6b9f37c07b4b07',
  } },
});
const MISSING = Symbol('missing');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => value === MISSING ? MISSING : JSON.parse(JSON.stringify(value));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Arrays and scalar values are leaves. Divergent edits, including edit/delete, fail closed. */
export function mergeJsonSnapshots(base, fork, official) {
  const conflicts = [];
  const walk = (b, f, o, path) => {
    if (isDeepStrictEqual(f, o)) return copy(f);
    if (isDeepStrictEqual(b, f)) return copy(o);
    if (isDeepStrictEqual(b, o)) return copy(f);
    if ((b === MISSING || object(b)) && object(f) && object(o)) {
      const keys = [...new Set([...Object.keys(b === MISSING ? {} : b), ...Object.keys(f), ...Object.keys(o)])];
      const value = x => k => Object.hasOwn(x, k) ? x[k] : MISSING;
      const entries = [];
      for (const key of keys) {
        const result = walk(value(b === MISSING ? {} : b)(key), value(f)(key), value(o)(key), path ? `${path}.${key}` : key);
        if (result !== MISSING) entries.push([key, result]);
      }
      return Object.fromEntries(entries);
    }
    conflicts.push(path || '(root)');
    return MISSING;
  };
  const merged = walk(base, fork, official, '');
  if (conflicts.length) throw new Error(`divergent generated-data edits: ${conflicts.join(', ')}`);
  return merged;
}

/** Whole-object additions are one delta; existing-object edits recurse without changing key order. */
export function changedPaths(base, next, path = '') {
  if (isDeepStrictEqual(base, next)) return [];
  if (!object(base) || !object(next)) return [path];
  return [...new Set([...Object.keys(base), ...Object.keys(next)])].flatMap(key => {
    const p = path ? `${path}.${key}` : key;
    return Object.hasOwn(base, key) && Object.hasOwn(next, key) ? changedPaths(base[key], next[key], p) : [p];
  });
}

/** Same unique /assets accounting used by skinManifestMetadata; fonts do not count as art files. */
export function assetFiles(value, files = new Set()) {
  if (typeof value === 'string' && value.startsWith('/assets/')) files.add(value.slice('/assets/'.length));
  else if (value && typeof value === 'object') for (const child of Object.values(value)) assetFiles(child, files);
  return files;
}

/** Trusted snapshot totals are additive only for this proven, non-removing, disjoint release delta. */
export function mergedAssetTotals(base, fork, official, merged) {
  const [b, f, o, m] = [base, fork, official, merged].map(value => assetFiles(value));
  for (const [value, files] of [[base, b], [fork, f], [official, o]]) {
    if (value.stats?.files !== files.size || !Number.isSafeInteger(value.stats?.bytes) || value.stats.bytes < 0) {
      throw new Error('snapshot asset totals do not match their manifest references');
    }
  }
  if ([...b].some(path => !f.has(path) || !o.has(path)) || [...f].some(path => o.has(path) && !b.has(path))) {
    throw new Error('asset byte totals require unchanged base references and disjoint additions');
  }
  const union = new Set([...f, ...o]);
  if (m.size !== union.size || [...m].some(path => !union.has(path))) throw new Error('merged asset references differ from the snapshot union');
  const bytes = fork.stats.bytes + official.stats.bytes - base.stats.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid combined snapshot byte total');
  return { files: m.size, bytes, baseFiles: b.size, forkAdded: f.size - b.size, officialAdded: o.size - b.size,
    byteAccounting: 'authoritative snapshot totals: fork + official - base; not an on-disk completeness check' };
}

/** Release-specific preconditions and the producer's CN/JP canonical-tree compatibility aliases. */
export function mergeReleaseValues(base, fork, official) {
  const forkConfig = changedPaths(base.config, fork.config);
  const officialConfig = changedPaths(base.config, official.config);
  if (forkConfig.length !== 33 || forkConfig.some(path => !/^(bossHpScale\.|modes\.[^.]+\.bossHpScale\.)/.test(path))) {
    throw new Error('unexpected fork config delta outside the reviewed boss-HP profile');
  }
  if (!isDeepStrictEqual(officialConfig, ['timers.bandTurn']) || official.config.timers.bandTurn !== 50) {
    throw new Error('unexpected official config delta outside bandTurn=50');
  }
  const forkAssets = changedPaths(base.assets, fork.assets);
  const expected = ['audio.voiceByLang', 'hash', 'skins', 'stats.bytes', 'stats.files', 'stats.skins'];
  if (!isDeepStrictEqual(forkAssets.slice().sort(), expected.slice().sort())) throw new Error('unexpected fork asset delta');
  if (base.assets.audio.voiceByLang || official.assets.audio.voiceByLang ||
      !isDeepStrictEqual(fork.assets.audio.voiceByLang?.cn, base.assets.audio.voice) ||
      !isDeepStrictEqual(fork.assets.audio.voiceByLang?.jp, base.assets.audio.voiceJp) ||
      !isDeepStrictEqual(Object.keys(fork.assets.audio.voiceByLang).sort(), ['cn', 'en', 'jp']) ||
      Object.keys(fork.assets.skins).length !== 271) throw new Error('fork skin/voice baseline does not match the reviewed aliases');
  const body = manifest => Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'hash' && key !== 'stats'));
  const assets = mergeJsonSnapshots(body(base.assets), body(fork.assets), body(official.assets));
  // Proven aliases, not guessed voice tables: the official new CN/JP slots feed their canonical trees too.
  assets.audio.voiceByLang.cn = mergeJsonSnapshots(base.assets.audio.voice, fork.assets.audio.voiceByLang.cn, official.assets.audio.voice);
  assets.audio.voiceByLang.jp = mergeJsonSnapshots(base.assets.audio.voiceJp, fork.assets.audio.voiceByLang.jp, official.assets.audio.voiceJp);
  if (!isDeepStrictEqual(assets.audio.voice, assets.audio.voiceByLang.cn) || !isDeepStrictEqual(assets.audio.voiceJp, assets.audio.voiceByLang.jp)) {
    throw new Error('merged voice compatibility aliases diverged');
  }
  if (assets.version !== MANIFEST_VERSION) throw new Error('unsupported asset manifest schema');
  const totals = mergedAssetTotals(base.assets, fork.assets, official.assets, assets);
  // Reuse the ordinary producer's body counters; the historical blobs, not absent artwork, supply byte totals.
  const stats = { ...countStats(assets, totals.bytes, totals.files), skins: Object.keys(assets.skins).length };
  for (const snapshot of [base.assets, fork.assets, official.assets]) {
    const calculated = countStats(snapshot, snapshot.stats.bytes, snapshot.stats.files);
    if (Object.entries(calculated).some(([key, value]) => snapshot.stats[key] !== value)) throw new Error('snapshot producer counters disagree');
  }
  const { version, ...assetBody } = assets;
  delete assetBody.generator;
  const manifest = { version, hash: contentHash(assetBody), generator: 'tools/merge-generated-release.mjs', stats, ...assetBody };
  return { assets: manifest, config: mergeJsonSnapshots(base.config, fork.config, official.config),
    proof: { forkConfig, officialConfig, forkAssets, officialAssets: changedPaths(base.assets, official.assets), totals,
      voiceRule: 'verified fork CN/JP canonical trees equal base legacy trees; apply official deltas to both aliases; EN unchanged' } };
}

async function readSnapshot(dir, kind) {
  const path = resolve(dir);
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error(`snapshot directory is not a real directory: ${kind}`);
  const values = {}, provenance = { commit: RELEASE_SNAPSHOTS[kind].commit, files: {} };
  for (const [name, expectedBlob] of Object.entries(RELEASE_SNAPSHOTS[kind].blobs)) {
    const file = join(path, name), info = await lstat(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error(`invalid snapshot file: ${kind}/${name}`);
    const bytes = await readFile(file), blob = gitBlobHash(bytes);
    if (blob !== expectedBlob) throw new Error(`snapshot is not the pinned Git blob: ${kind}/${name}`);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!object(value)) throw new Error(`snapshot JSON is not an object: ${kind}/${name}`);
    values[name.slice(0, -5)] = value;
    provenance.files[name] = { repositoryPath: `data/${name}`, gitBlob: blob, sha256: sha256(bytes), bytes: bytes.length };
  }
  return { values, provenance };
}

export async function mergeReleaseSnapshots({ baseDir, forkDir, officialDir, outDir }) {
  const snapshots = {};
  for (const [kind, dir] of Object.entries({ base: baseDir, fork: forkDir, official: officialDir })) snapshots[kind] = await readSnapshot(dir, kind);
  const result = mergeReleaseValues(snapshots.base.values, snapshots.fork.values, snapshots.official.values);
  const out = resolve(outDir), parent = dirname(out);
  if (await realpath(parent) !== parent) throw new Error('output parent must not be a symlink');
  // Exclusive creation: never overwrite a repository, source snapshot or existing output directory.
  await mkdir(out);
  const output = {};
  for (const name of ['assets', 'config']) {
    const bytes = Buffer.from(JSON.stringify(result[name]) + (name === 'assets' ? '\n' : ''));
    await writeFile(join(out, `${name}.json`), bytes, { flag: 'wx' });
    output[`${name}.json`] = { sha256: sha256(bytes), gitBlob: gitBlobHash(bytes), bytes: bytes.length };
  }
  const report = { generator: 'tools/merge-generated-release.mjs', reason: 'historical official table cache unavailable; exact committed release snapshots only',
    sources: Object.fromEntries(Object.entries(snapshots).map(([kind, value]) => [kind, value.provenance])),
    output, ...result.proof };
  await writeFile(join(out, 'provenance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

export async function mergeReleaseFromArgs(argv) {
  const names = { '--base-snapshot': 'baseDir', '--fork-snapshot': 'forkDir', '--official-snapshot': 'officialDir', '--out': 'outDir' };
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--merge-release-snapshots') continue;
    const index = argv[i].indexOf('='), name = index < 0 ? argv[i] : argv[i].slice(0, index);
    if (!Object.hasOwn(names, name) || Object.hasOwn(opts, names[name])) throw new Error(`unknown or repeated snapshot option ${name}`);
    const value = index < 0 ? argv[++i] : argv[i].slice(index + 1);
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a path`);
    opts[names[name]] = value;
  }
  if (Object.keys(opts).length !== Object.keys(names).length) throw new Error('snapshot merge requires --base-snapshot, --fork-snapshot, --official-snapshot and --out (new directory)');
  const report = await mergeReleaseSnapshots(opts);
  console.log(`snapshot merge: assets/config generated; ${report.totals.files} referenced files (${report.totals.officialAdded} official additions); provenance.json records exact inputs`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mergeReleaseFromArgs(process.argv.slice(2)).catch(error => { console.error(`snapshot merge failed: ${error.message}`); process.exitCode = 1; });
}
