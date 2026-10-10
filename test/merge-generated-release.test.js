import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RELEASE_SNAPSHOTS, mergeJsonSnapshots, changedPaths, mergedAssetTotals, mergeReleaseSnapshots, gitBlobHash } from '../tools/merge-generated-release.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { parseArgs } from '../tools/fetch-assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'release-snapshot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function snapshots(dir) {
  const opts = {};
  for (const [kind, source] of Object.entries(RELEASE_SNAPSHOTS)) {
    const path = join(dir, kind); await mkdir(path); opts[`${kind}Dir`] = path;
    for (const name of Object.keys(source.blobs)) {
      const bytes = execFileSync('git', ['-C', ROOT, 'show', `${source.commit}:data/${name}`], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(gitBlobHash(bytes), source.blobs[name]);
      await writeFile(join(path, name), bytes);
    }
  }
  return opts;
}

test('strict three-way merge preserves disjoint changes, deletions and object order without mutating inputs', () => {
  const base = { z: 1, nested: { unchanged: 2, deleted: 3 }, array: [1, 2] };
  const fork = { z: 1, nested: { unchanged: 2 }, array: [1, 2], new: { fork: true } };
  const official = { z: 2, nested: { unchanged: 2, deleted: 3 }, array: [1, 2, 3], new: { official: true } };
  const before = JSON.stringify([base, fork, official]);
  assert.deepEqual(mergeJsonSnapshots(base, fork, official), {
    z: 2, nested: { unchanged: 2 }, array: [1, 2, 3], new: { fork: true, official: true },
  });
  assert.equal(JSON.stringify([base, fork, official]), before);
  assert.deepEqual(changedPaths(base, fork), ['nested.deleted', 'new']);
});

test('different leaf values, conflicting arrays and edit/delete fail with exact paths', () => {
  assert.throws(() => mergeJsonSnapshots({ x: 1 }, { x: 2 }, { x: 3 }), /divergent.*x/);
  assert.throws(() => mergeJsonSnapshots({ x: [1] }, { x: [1, 2] }, { x: [1, 3] }), /divergent.*x/);
  assert.throws(() => mergeJsonSnapshots({ x: { y: 1 } }, {}, { x: { y: 2 } }), /divergent.*x/);
  assert.deepEqual(mergeJsonSnapshots({ x: 1 }, { x: 2 }, { x: 2 }), { x: 2 });
});

test('snapshot byte accounting requires exact reference counts, no removal and disjoint additions', () => {
  const value = (paths, bytes) => ({ refs: paths.map(path => `/assets/${path}`), stats: { files: paths.length, bytes } });
  const base = value(['a', 'b'], 3), fork = value(['a', 'b', 'f'], 6), official = value(['a', 'b', 'o'], 7);
  const merged = value(['a', 'b', 'f', 'o'], 10);
  assert.equal(mergedAssetTotals(base, fork, official, merged).bytes, 10);
  assert.equal(mergedAssetTotals(base, fork, official, merged).files, 4);
  assert.throws(() => mergedAssetTotals(base, value(['a', 'f'], 6), official, merged), /unchanged base/);
  assert.throws(() => mergedAssetTotals(base, fork, value(['a', 'b', 'f'], 7), merged), /disjoint/);
  assert.throws(() => mergedAssetTotals(base, { ...fork, stats: { files: 99, bytes: 6 } }, official, merged), /totals/);
});

test('merged asset flags retain both strict completeness reporting and multilingual argument tracking', () => {
  const opts = parseArgs(['--strict', '--voice-lang=jp', '--voice-langs=en']);
  assert.equal(opts.strict, true);
  assert.deepEqual(opts.voiceLangs, ['cn', 'jp', 'en']);
  assert.equal(opts.voiceLang, 'jp');
});

test('exact pinned blobs generate only assets/config/provenance, synchronize CN/JP and reproduce deterministically', async t => {
  const dir = await directory(t), opts = await snapshots(dir);
  const first = join(dir, 'first'), second = join(dir, 'second');
  const report = await mergeReleaseSnapshots({ ...opts, outDir: first });
  const again = await mergeReleaseSnapshots({ ...opts, outDir: second });
  assert.deepEqual(report, again);
  assert.deepEqual((await readdir(first)).sort(), ['assets.json', 'config.json', 'provenance.json']);
  for (const name of ['assets.json', 'config.json']) {
    const bytes = await readFile(join(first, name));
    assert.deepEqual(bytes, await readFile(join(second, name)));
    assert.equal(sha256(bytes), report.output[name].sha256);
  }
  assert.equal(report.forkConfig.length, 33);
  assert.deepEqual(report.officialConfig, ['timers.bandTurn']);
  assert.deepEqual(report.totals, { files: 15980, bytes: 2249797957, baseFiles: 10643, forkAdded: 5024, officialAdded: 313,
    byteAccounting: 'authoritative snapshot totals: fork + official - base; not an on-disk completeness check' });
  const assets = JSON.parse(await readFile(join(first, 'assets.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(first, 'config.json'), 'utf8'));
  const official = JSON.parse(await readFile(join(opts.officialDir, 'assets.json'), 'utf8'));
  const fork = JSON.parse(await readFile(join(opts.forkDir, 'assets.json'), 'utf8'));
  const body = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['version', 'hash', 'generator', 'stats', 'skins'].includes(key)));
  const mergedOfficial = JSON.parse(JSON.stringify(body(assets))); delete mergedOfficial.audio.voiceByLang;
  assert.deepEqual(mergedOfficial, body(official), 'official body is preserved apart from the explicit fork extensions');
  assert.deepEqual(assets.skins, fork.skins);
  assert.equal(Object.keys(assets.skins).length, 271);
  assert.deepEqual(assets.audio.voiceByLang.cn, assets.audio.voice);
  assert.deepEqual(assets.audio.voiceByLang.jp, assets.audio.voiceJp);
  assert.deepEqual(assets.audio.voiceByLang.en, fork.audio.voiceByLang.en);
  assert.equal(Object.keys(assets.audio.voiceByLang.cn).length, 192);
  assert.equal(Object.keys(assets.audio.voiceByLang.jp).length, 192);
  assert.equal(Object.keys(assets.audio.voiceByLang.en).length, Object.keys(fork.audio.voiceByLang.en).length);
  assert.equal(Object.keys(assets.audio.voiceByLang.en).length, 182, 'retain the exact installed fork EN corpus, not guessed parity with CN');
  const hashBody = Object.fromEntries(Object.entries(assets).filter(([key]) => !['version', 'hash', 'generator', 'stats'].includes(key)));
  assert.equal(assets.hash, contentHash(hashBody));
  assert.equal(config.timers.bandTurn, 50);
  const forkConfig = JSON.parse(await readFile(join(opts.forkDir, 'config.json'), 'utf8'));
  assert.deepEqual(changedPaths(forkConfig, config), ['timers.bandTurn']);
  for (const [kind, source] of Object.entries(RELEASE_SNAPSHOTS)) {
    assert.equal(report.sources[kind].commit, source.commit);
    for (const name of Object.keys(source.blobs)) assert.equal(report.sources[kind].files[name].sha256, sha256(await readFile(join(opts[`${kind}Dir`], name))));
  }
  await assert.rejects(mergeReleaseSnapshots({ ...opts, outDir: first }), /EEXIST/);
});

test('snapshot mode dispatches before ordinary table/cache generation and refuses modified source blobs', async t => {
  const dir = await directory(t), opts = await snapshots(dir);
  const output = join(dir, 'cli');
  const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-data.mjs'), '--merge-release-snapshots',
    '--base-snapshot', opts.baseDir, '--fork-snapshot', opts.forkDir, '--official-snapshot', opts.officialDir, '--out', output],
  { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /15980 referenced files \(313 official additions\)/);
  await writeFile(join(opts.forkDir, 'config.json'), '{}');
  const denied = join(dir, 'denied');
  await assert.rejects(mergeReleaseSnapshots({ ...opts, outDir: denied }), /not the pinned Git blob: fork\/config.json/);
  assert.equal((await readdir(dir)).includes('denied'), false, 'failed input validation writes no output');
});
