// 名片-only skins (2026-11-16, the owner: 阿米娅's 术师 / 近卫 skins on the 名片 only): tools/assets/namecard-skins.mjs applies the
// registry tools/assets/namecard-skins.json to a manifest body as `namecardSkins`; tools/prepare-namecard-skins.mjs rewrites
// data/assets.json (hash, stats) in place; the registry matches the client's skin_table ids, data/assets.json names each
// of them, and none of them is an appearance anyone wears (shared/skin-catalogue.js) or a `skins` record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyNamecardSkins, loadNamecardSkinRegistry, validEntry, namecardSkinDir } from '../tools/assets/namecard-skins.mjs';
import { rewriteManifest } from '../tools/prepare-namecard-skins.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { OPERATOR_SKINS } from '../shared/skins.js';
import { NAMECARD_SKINS } from '../public/js/ui/namecards.js';

const H = 'a'.repeat(64);
const rect = (x, y, w, h) => ({ x, y, width: w, height: h });
const file = (name, bytes) => ({ name, bytes, sha256: H });
const entry = (o = {}) => ({ illustration: { ...file('illustration.png', 7), size: [2048, 2048] }, portrait: file('portrait.png', 3), portraitBox: [0.4, 0.3, 0.1, 0.2], ...o });
const dyn = (o = {}) => ({ skel: file('dynamic/d.skel', 5), atlas: file('dynamic/d.atlas', 2), textures: [file('dynamic/d.webp', 9)], pma: false, idle: 'Idle',
  animations: { Default: 0, Idle: 8 }, bounds: rect(-1000, 15, 2000, 1700), frames: { avatar: rect(40, 1200, 130, 130), portrait: rect(50, 1100, 125, 250) }, ...o });
const REG = { version: 1, skins: { a_x_1: entry(), b_y_2: entry({ dynamic: dyn() }), c_z_3: entry({ dynamic: dyn({ idle: 'Nope' }) }), d_w_4: entry({ portrait: null }) } };

test('a record per complete entry in the skins\' shape; the section is rebuilt; the input is not changed', () => {
  const input = { skins: { s: {} }, namecardSkins: { stale_1: { illustration: '/x' } } }; const before = JSON.stringify(input);
  const { body: out, files, bytes, looks } = applyNamecardSkins(input, { registry: REG });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(out.skins, { s: {} }, 'the skins are not touched');
  assert.deepEqual(Object.keys(out.namecardSkins), ['a_x_1', 'b_y_2'], 'an idle clip not among its clips, a missing portrait: no record; a stale one goes');
  assert.deepEqual(out.namecardSkins.a_x_1, { illustration: '/assets/skins/a_x_1/illustration.png', illustrationSize: [2048, 2048],
    portrait: '/assets/skins/a_x_1/portrait.png', portraitBox: [0.4, 0.3, 0.1, 0.2] });
  assert.deepEqual(out.namecardSkins.b_y_2.dynamic, { skel: '/assets/skins/b_y_2/dynamic/d.skel', atlas: '/assets/skins/b_y_2/dynamic/d.atlas',
    textures: ['/assets/skins/b_y_2/dynamic/d.webp'], pma: false, anims: { idle: 'Idle' }, animations: { Default: 0, Idle: 8 },
    bounds: rect(-1000, 15, 2000, 1700), frames: { avatar: rect(40, 1200, 130, 130), portrait: rect(50, 1100, 125, 250) } });
  assert.equal(looks, 2); assert.equal(files.size, 2 + 5); assert.equal(bytes, 10 + 26);
  assert.equal(namecardSkinDir('char_1001_amiya2_sale_16'), 'skins/char_1001_amiya2_sale_16');
  assert.equal(applyNamecardSkins({ chars: {} }, { registry: { version: 1, skins: {} } }).body.namecardSkins, undefined, 'none: no section');
  assert.equal(validEntry({ ...entry(), key: 'a/../b' }), false);
});

test('files are checked by size on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncskins-'));
  const reg = { version: 1, skins: { a_x_1: entry() } };
  try {
    mkdirSync(join(dir, 'skins/a_x_1'), { recursive: true });
    writeFileSync(join(dir, 'skins/a_x_1/illustration.png'), Buffer.alloc(7));
    assert.equal(applyNamecardSkins({}, { registry: reg, assetRoot: dir }).body.namecardSkins, undefined, 'the half-body art missing');
    writeFileSync(join(dir, 'skins/a_x_1/portrait.png'), Buffer.alloc(4));
    assert.equal(applyNamecardSkins({}, { registry: reg, assetRoot: dir }).body.namecardSkins, undefined, 'of another size');
    writeFileSync(join(dir, 'skins/a_x_1/portrait.png'), Buffer.alloc(3));
    assert.ok(applyNamecardSkins({}, { registry: reg, assetRoot: dir }).body.namecardSkins.a_x_1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteManifest: stats move by the named files, the hash follows the body, a re-run changes nothing', () => {
  const m = { version: 1, hash: 'x', generator: 'g', stats: { files: 100, bytes: 1000 }, chars: {} };
  const once = rewriteManifest(m, { registry: REG, assetRoot: null });
  assert.equal(once.stats.files, 107); assert.equal(once.stats.bytes, 1036);
  const { version, hash, generator, stats, ...rest } = once;
  assert.equal(hash, contentHash(rest)); assert.equal(generator, 'g');
  assert.deepEqual(rewriteManifest(once, { registry: REG, assetRoot: null }), once);
});

test('the registry: 阿米娅\'s five skins of other forms, complete; data/assets.json names each; none is worn', () => {
  const reg = loadNamecardSkinRegistry();
  const want = { char_002_amiya_winter_1: 'char_002_amiya@winter#1', char_002_amiya_epoque_4: 'char_002_amiya@epoque#4', char_002_amiya_test_1: 'char_002_amiya@test#1',
    char_1001_amiya2_sale_16: 'char_1001_amiya2@sale#16', char_1001_amiya2_casc_1: 'char_1001_amiya2@casc#1' };
  assert.deepEqual(Object.fromEntries(Object.entries(reg.skins).map(([k, R]) => [k, R.officialId])), want);
  for (const [k, R] of Object.entries(reg.skins)) {
    assert.ok(validEntry({ ...R, key: k }), k);
    assert.equal(k, R.officialId.replace(/[@#]/g, '_'), `${k}: the official id with @ / # as _`);
    assert.equal(R.form, R.tmplId === 'char_1001_amiya2' ? 'guard' : 'caster', k);
  }
  assert.ok(reg.skins.char_1001_amiya2_sale_16.dynamic, '于万千宇宙之中 has its 动态立绘');
  assert.deepEqual(NAMECARD_SKINS.map((s) => [s.id, s.officialId]), Object.entries(want), 'the picker offers exactly these');
  const assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(assets.namecardSkins).sort(), Object.keys(want).sort());
  const again = applyNamecardSkins((({ version, hash, generator, stats, ...b }) => b)(assets), { registry: reg }).body;
  assert.deepEqual(again.namecardSkins, assets.namecardSkins, 'the manifest is the registry\'s');
  for (const k of Object.keys(want)) {
    assert.ok(!OPERATOR_SKINS.some((s) => s.id === k), `${k}: not an appearance`);
    assert.ok(!Object.hasOwn(assets.skins, k), `${k}: not a skins record`);
  }
});
