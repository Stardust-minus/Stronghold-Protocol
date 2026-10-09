import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { skinBattleModels, validateSkinPng } from '../tools/assets/skin-battle-source.mjs';
import { prepareSkins } from '../tools/prepare-operator-skins.mjs';

const skin = { id: 'char_311_mudrok_ambienceSynesthesia_2', charId: 'char_311_mudrok', officialId: 'char_311_mudrok@ambienceSynesthesia#2', name: '黑曜石', brand: '音律联觉', wikiIndex: 1, charName: '泥岩' };
const meta = (models = { 正面: { file: `char_311_mudrok_ambiencesynesthesia_2/front/${skin.id}` }, 背面: { file: `char_311_mudrok_ambiencesynesthesia_2/back/${skin.id}` } }) => ({ prefix: `https://torappu.prts.wiki/assets/char_spine/${skin.charId}/`, skin: { [skin.name]: models } });
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (tag, bytes) => {
  const data = Buffer.concat([Buffer.from(tag), bytes]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(data)); return Buffer.concat([size, data, crc]);
};
function png(raw = Buffer.from([0, 255, 0, 0, 255])) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('metadata source retains exact case-sensitive basename independently of the directory alias', () => {
  const result = skinBattleModels(skin, meta());
  assert.equal(result.kind, 'front-and-back');
  assert.equal(result.models.front.remote, `${meta().prefix}char_311_mudrok_ambiencesynesthesia_2/front/`);
  assert.equal(result.models.front.stem, skin.id);
  assert.equal(result.models.back.file, `char_311_mudrok_ambiencesynesthesia_2/back/${skin.id}`);
});
test('a declared Front-only model does not invent Back', () => {
  const result = skinBattleModels(skin, meta({ 正面: meta().skin[skin.name].正面 }));
  assert.equal(result.kind, 'front-only'); assert.deepEqual(Object.keys(result.models), ['front']);
});
test('one explicit battle model uses its real spine folder without claiming independent Front and Back', () => {
  const result = skinBattleModels(skin, meta({ 战斗: { file: `char_311_mudrok_ambiencesynesthesia_2/spine/${skin.id}` } }));
  assert.equal(result.kind, 'unified'); assert.equal(result.models.front.label, '战斗');
  assert.equal(result.models.front.remote, `${meta().prefix}char_311_mudrok_ambiencesynesthesia_2/spine/`); assert.equal(result.models.back, undefined);
});
for (const [name, change] of [
  ['wrong source host', m => { m.prefix = m.prefix.replace('torappu.prts.wiki', 'example.test'); }],
  ['cross-character prefix', m => { m.prefix = m.prefix.replace('char_311_mudrok/', 'char_103_angel/'); }],
  ['query-bearing prefix', m => { m.prefix += '?token=not-a-credential'; }],
  ['wrong skin name', m => { m.skin = { 其他: m.skin[skin.name] }; }],
  ['cross-skin directory', m => { m.skin[skin.name].正面.file = `char_311_mudrok_other_1/front/${skin.id}`; }],
  ['lowercased basename', m => { m.skin[skin.name].正面.file = m.skin[skin.name].正面.file.toLowerCase(); }],
  ['path traversal', m => { m.skin[skin.name].正面.file = `../front/${skin.id}`; }],
  ['encoded separator', m => { m.skin[skin.name].正面.file = `char_311_mudrok_ambiencesynesthesia_2%2ffront/${skin.id}`; }],
  ['wrong facing folder', m => { m.skin[skin.name].正面.file = `char_311_mudrok_ambiencesynesthesia_2/back/${skin.id}`; }],
  ['unsupported subskin', m => { m.skin[skin.name].正面.skin = 'alternate'; }],
  ['ambiguous unified and Front', m => { m.skin[skin.name].战斗 = { file: `char_311_mudrok_ambiencesynesthesia_2/spine/${skin.id}` }; }],
  ['Back without Front', m => { delete m.skin[skin.name].正面; }],
]) test(`metadata source refuses ${name}`, () => { const input = meta(); change(input); assert.throws(() => skinBattleModels(skin, input)); });
test('official ID and character identity must agree even when model paths look plausible', () => {
  assert.throws(() => skinBattleModels({ ...skin, officialId: 'char_311_mudrok@other#1' }, meta()));
  assert.throws(() => skinBattleModels({ ...skin, charId: 'char_103_angel' }, meta()));
  const prototype = meta(); prototype.skin = Object.create(prototype.skin); assert.throws(() => skinBattleModels(skin, prototype));
});
test('PNG validation includes every chunk CRC, complete pixels and final IEND', () => {
  const valid = png(); assert.deepEqual(validateSkinPng(valid), { width: 1, height: 1 });
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 13] ^= 1;
  assert.throws(() => validateSkinPng(corrupt)); assert.throws(() => validateSkinPng(valid.subarray(0, -12)), /Incomplete PNG/);
  assert.throws(() => validateSkinPng(Buffer.concat([valid, Buffer.from([0])])), /PNG end/);
  assert.throws(() => validateSkinPng(png(Buffer.from([0, 1]))), /pixel stream/);
  assert.throws(() => validateSkinPng(png(Buffer.from([5, 255, 0, 0, 255]))), /PNG filter/);
});
test('metadata import rejects duplicate jobs before concurrent work begins', async () => {
  await assert.rejects(prepareSkins({ sourceDir: '/not-used', modelSource: 'metadata', catalogue: [skin, skin] }), /bounded skin import/);
});
test('metadata source refusal preserves the old manifest instead of publishing partial readiness', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-blocked-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'assets.json'), prior = JSON.stringify({ chars: { [skin.charId]: {} }, audio: { voiceByLang: { cn: { exact: 'old' } } }, stats: {} }); writeFileSync(path, prior);
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('Refused', { status: 429 }); });
  await assert.rejects(prepareSkins({ sourceDir: join(root, 'sources'), modelSource: 'metadata', fetchSources: true, catalogue: [skin], manifestPath: path, assetRoot: join(root, 'assets') }), /source-blocked/);
  assert.equal(calls, 1); assert.equal(readFileSync(path, 'utf8'), prior);
});
test('an incomplete offline metadata import refuses publication instead of silently admitting a subset', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-incomplete-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'assets.json'), prior = JSON.stringify({ chars: { [skin.charId]: {} }, audio: { voice: { exact: 'cn' } }, stats: {} }); writeFileSync(path, prior);
  await assert.rejects(prepareSkins({ sourceDir: join(root, 'sources'), modelSource: 'metadata', catalogue: [skin], manifestPath: path, assetRoot: join(root, 'assets') }), /incomplete metadata/);
  assert.equal(readFileSync(path, 'utf8'), prior);
});
test('offline source files through a symlink cannot escape the isolated source directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-link-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'assets.json'), source = join(root, 'sources'), external = join(root, 'outside');
  const prior = JSON.stringify({ chars: { [skin.charId]: {} }, stats: {} }); writeFileSync(manifestPath, prior); mkdirSync(source); mkdirSync(external);
  writeFileSync(join(external, 'model-meta.json'), JSON.stringify(meta())); symlinkSync(external, join(source, skin.id), 'dir');
  await assert.rejects(prepareSkins({ sourceDir: source, modelSource: 'metadata', catalogue: [skin], manifestPath, assetRoot: join(root, 'assets') }), /incomplete metadata/);
  assert.equal(readFileSync(manifestPath, 'utf8'), prior);
});
test('manifest compare-and-swap refuses another writer during source loading', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-cas-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'assets.json'), prior = { chars: { [skin.charId]: {} }, stats: {} }, changed = JSON.stringify({ ...prior, changedByOtherWriter: true }); writeFileSync(path, JSON.stringify(prior));
  t.mock.method(globalThis, 'fetch', async () => { writeFileSync(path, changed); return new Response('Not found', { status: 404 }); });
  await assert.rejects(prepareSkins({ sourceDir: join(root, 'sources'), catalogue: [skin], fetchSources: true, manifestPath: path, assetRoot: join(root, 'assets') }), /baseline changed/);
  assert.equal(readFileSync(path, 'utf8'), changed);
});
test('metadata import never replaces an already admitted skin record or asks for its source again', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-preserve-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'assets.json'), record = { charId: skin.charId, name: skin.name, spine: { front: { exact: 'unchanged' } }, dynamic: { legacy: true } };
  const before = { chars: { [skin.charId]: {} }, skins: { [skin.id]: record }, audio: { voiceByLang: { cn: { exact: 'old' }, jp: { exact: 'old-jp' }, en: { exact: 'old-en' } } }, stats: {} };
  writeFileSync(manifestPath, JSON.stringify(before)); t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch an installed skin'); });
  const result = await prepareSkins({ sourceDir: join(root, 'sources'), modelSource: 'metadata', fetchSources: true, catalogue: [skin], manifestPath, assetRoot: join(root, 'assets') });
  const after = JSON.parse(readFileSync(manifestPath)); assert.equal(result.preserved, 1); assert.equal(result.skins, 0); assert.deepEqual(after.skins, before.skins); assert.deepEqual(after.audio, before.audio);
});

const sampleRoot = new URL('../.cache/stardust/exu2-skin-research-20261008-3bmj9cm4/sources/battle-r0/', import.meta.url);
for (const conflicting of [false, true]) test(conflicting ? 'different installed artwork refuses import without overwrite or partial manifest publication' : 'complete metadata import parses actual Spine bytes, preserves audio and marks a unified source', { skip: !existsSync(new URL('front/char_1041_angel2_iteration_6.skel', sampleRoot)) && 'install the isolated researched skin sample first' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-meta-full-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'sources'), assetRoot = join(root, 'assets'), manifestPath = join(root, 'assets.json');
  const current = { id: 'char_1041_angel2_iteration_6', charId: 'char_1041_angel2', officialId: 'char_1041_angel2@iteration#6', name: '寻翼之歌', brand: '时代', wikiIndex: 1, charName: '新约能天使' };
  const folder = join(source, current.id); mkdirSync(join(folder, 'front'), { recursive: true });
  writeFileSync(join(folder, 'model-meta.json'), JSON.stringify({ prefix: `https://torappu.prts.wiki/assets/char_spine/${current.charId}/`, skin: { [current.name]: { 战斗: { file: `${current.id}/spine/${current.id}` } } } }));
  const picture = png(), sha1 = createHash('sha1').update(picture).digest('hex');
  const pages = Object.fromEntries(['头像', '半身像', '立绘'].map((label, index) => [index, { title: `文件:${label} ${current.charName} skin1.png`, imageinfo: [{ url: 'https://media.prts.wiki/picture.png', size: picture.length, sha1 }] }]));
  writeFileSync(join(folder, 'imageinfo.json'), JSON.stringify({ query: { pages } }));
  for (const field of ['avatar', 'portrait', 'illustration']) writeFileSync(join(folder, field + '.png'), picture);
  for (const extension of ['atlas', 'skel', 'png']) writeFileSync(join(folder, 'front', current.id + '.' + extension), readFileSync(new URL(`front/${current.id}.${extension}`, sampleRoot)));
  const audio = { voice: { same: 'cn' }, voiceByLang: { cn: { same: 'cn' }, jp: { same: 'jp' }, en: { same: 'en' } } };
  const prior = JSON.stringify({ chars: { [current.charId]: {} }, audio, stats: {} }); writeFileSync(manifestPath, prior);
  if (conflicting) {
    const avatar = join(assetRoot, 'skins', current.id, 'avatar.png'); mkdirSync(join(avatar, '..'), { recursive: true }); writeFileSync(avatar, Buffer.from([1, 2, 3]));
    await assert.rejects(prepareSkins({ sourceDir: source, modelSource: 'metadata', catalogue: [current], manifestPath, assetRoot }), /incomplete metadata/);
    assert.deepEqual(readFileSync(avatar), Buffer.from([1, 2, 3])); assert.equal(readFileSync(manifestPath, 'utf8'), prior); return;
  }
  const result = await prepareSkins({ sourceDir: source, modelSource: 'metadata', catalogue: [current], manifestPath, assetRoot });
  assert.equal(result.skins, 1); assert.equal(result.failures, 0);
  const manifest = JSON.parse(readFileSync(manifestPath)); assert.deepEqual(manifest.audio, audio);
  assert.equal(manifest.skins[current.id].battleModelKind, 'unified'); assert.equal(manifest.skins[current.id].backUnavailable, true); assert.equal(manifest.skins[current.id].spine.back, undefined);
  const report = JSON.parse(readFileSync(result.reportPath)); assert.equal(report.models[0].version, '3.8.99'); assert.equal(report.models[0].skeletonBodyPreserved, true); assert.deepEqual(report.models[0].missingRegions, []);
  assert.equal(statSync(join(assetRoot, manifest.skins[current.id].spine.front.skel.slice('/assets/'.length))).nlink, 1);
});
