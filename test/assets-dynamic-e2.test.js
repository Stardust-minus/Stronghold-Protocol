// The operators' own 精二 动态立绘 (2026-11-16): tools/assets/dynamic-e2.mjs applies the registry
// tools/assets/char-dynamic-e2.json to a manifest body; tools/prepare-operator-dynamic-e2.mjs rewrites data/assets.json
// (hash, stats) in place; the committed registry matches the client's list and data/assets.json names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDynamicE2, loadDynamicE2Registry, validEntry, dynamicE2Dir } from '../tools/assets/dynamic-e2.mjs';
import { rewriteManifest } from '../tools/prepare-operator-dynamic-e2.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';

const rect = (x, y, w, h) => ({ x, y, width: w, height: h });
const entry = (o = {}) => ({ skel: { name: 'd.skel', bytes: 5 }, atlas: { name: 'd.atlas', bytes: 2 }, textures: [{ name: 'd.webp', bytes: 9 }],
  pma: false, idle: 'Idle', animations: { Idle: 4, Special: 8 }, bounds: rect(-900, -100, 1800, 1700),
  frames: { avatar: rect(-80, 900, 200, 200), portrait: rect(-90, 760, 180, 360) }, ...o });
const REG = { version: 1, chars: { c: entry(), d: entry({ pma: true }), e: entry({ idle: 'Nope' }) } };
const body = () => ({ chars: { c: { avatar: '/a', avatarE2: '/a2', portraitE2: '/p2' }, d: { avatar: '/da' }, e: { avatarE2: '/e2' },
  f: { avatarE2: '/f2', dynamicE2: { skel: '/stale.skel' } } } });

test('a record per operator with its 精二 pictures, in a skin dynamic\'s shape; stale ones dropped; the input is not changed', () => {
  const input = body(); const before = JSON.stringify(input);
  const { body: out, files, bytes, looks } = applyDynamicE2(input, { registry: REG });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(out.chars.c.dynamicE2, { skel: '/assets/char/dynamic/c_2/d.skel', atlas: '/assets/char/dynamic/c_2/d.atlas',
    textures: ['/assets/char/dynamic/c_2/d.webp'], pma: false, anims: { idle: 'Idle' }, animations: { Idle: 4, Special: 8 },
    bounds: rect(-900, -100, 1800, 1700), frames: { avatar: rect(-80, 900, 200, 200), portrait: rect(-90, 760, 180, 360) } });
  assert.deepEqual(Object.keys(out.chars.c.dynamicE2), ['skel', 'atlas', 'textures', 'pma', 'anims', 'animations', 'bounds', 'frames']);
  assert.equal(out.chars.d.dynamicE2, undefined, 'no 精二 pictures: nothing to play over');
  assert.equal(out.chars.e.dynamicE2, undefined, 'an idle clip that is not one of its clips');
  assert.equal(out.chars.f.dynamicE2, undefined, 'not in the registry: a stale record goes');
  assert.equal(looks, 1); assert.equal(files.size, 3); assert.equal(bytes, 16);
  assert.equal(dynamicE2Dir('char_4247_oxi'), 'char/dynamic/char_4247_oxi_2');
});

test('files are checked by size on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dyne2-'));
  try {
    mkdirSync(join(dir, 'char/dynamic/c_2'), { recursive: true });
    writeFileSync(join(dir, 'char/dynamic/c_2/d.skel'), Buffer.alloc(5)); writeFileSync(join(dir, 'char/dynamic/c_2/d.atlas'), Buffer.alloc(2));
    assert.equal(applyDynamicE2(body(), { registry: REG, assetRoot: dir }).body.chars.c.dynamicE2, undefined, 'a page missing');
    writeFileSync(join(dir, 'char/dynamic/c_2/d.webp'), Buffer.alloc(8));
    assert.equal(applyDynamicE2(body(), { registry: REG, assetRoot: dir }).body.chars.c.dynamicE2, undefined, 'a page of another size');
    writeFileSync(join(dir, 'char/dynamic/c_2/d.webp'), Buffer.alloc(9));
    assert.ok(applyDynamicE2(body(), { registry: REG, assetRoot: dir }).body.chars.c.dynamicE2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteManifest: stats move by the named files, the hash follows the body, a re-run changes nothing', () => {
  const m = { version: 1, hash: 'x', generator: 'g', stats: { files: 100, bytes: 1000 }, ...body() };
  const once = rewriteManifest(m, { registry: REG, assetRoot: null });
  assert.equal(once.stats.files, 100 - 1 + 3, 'f\'s stale record named one file (not in the registry: 0 bytes), c\'s three are new'); assert.equal(once.stats.bytes, 1016);
  const { version, hash, generator, stats, ...rest } = once;
  assert.equal(hash, contentHash(rest)); assert.equal(generator, 'g');
  assert.deepEqual(rewriteManifest(once, { registry: REG, assetRoot: null }), once);
});

// the client's list (skin_table charSkins[<charId>#2].dynIllustId, data 79.2.0 / hot update 26-11-06): 27 operators
const CLIENT = ['char_1012_skadi2', 'char_1013_chen2', 'char_1014_nearl2', 'char_1015_aglna2', 'char_1016_agoat2', 'char_1023_ghost2', 'char_1026_gvial2',
  'char_1028_texas2', 'char_1035_wisdel', 'char_1038_whitw2', 'char_1041_angel2', 'char_1044_hsgma2', 'char_1045_svash2', 'char_1052_kalts2', 'char_113_cqbw',
  'char_2014_nian', 'char_2015_dusk', 'char_2023_ling', 'char_2024_chyue', 'char_2025_shu', 'char_2026_yu', 'char_2027_wang', 'char_245_cello',
  'char_249_mlyss', 'char_391_rosmon', 'char_4058_pepe', 'char_4247_oxi'];

test('the registry: every 精二 动态立绘 of the client, complete; data/assets.json names each of them', () => {
  const reg = loadDynamicE2Registry();
  assert.deepEqual(Object.keys(reg.chars).sort(), [...CLIENT].sort());
  for (const [id, R] of Object.entries(reg.chars)) {
    assert.ok(validEntry(R), id);
    assert.ok(Object.keys(R.animations).some((n) => /^idle$/i.test(n)), `${id}: a looping Idle`);
  }
  const assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
  const named = Object.entries(assets.chars).filter(([, c]) => c.dynamicE2).map(([id]) => id).sort();
  assert.deepEqual(named, [...CLIENT].sort());
  const again = applyDynamicE2((({ version, hash, generator, stats, ...b }) => b)(assets), { registry: reg }).body;
  for (const id of CLIENT) assert.deepEqual(again.chars[id].dynamicE2, assets.chars[id].dynamicE2, `${id}: the manifest is the registry's`);
  const collab = JSON.parse(readFileSync(new URL('../data/assets-collab.json', import.meta.url), 'utf8'));
  for (const id of CLIENT) assert.ok(!Object.hasOwn(collab.chars || {}, id), `${id}: not a collab operator (the files go to the normal pack)`);
});
