import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainInstalledSkins, skinResourceFiles, skinManifestMetadata, skinCatalogueSource, prepareSkins } from '../tools/prepare-operator-skins.mjs';
import { scanSource } from '../tools/i18n.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { normalizeSkelPaths, parseSkel } from '../tools/assets/skel.mjs';
import { OPERATOR_SKINS } from '../shared/skins.js';

const id = OPERATOR_SKINS[0].id, charId = OPERATOR_SKINS[0].charId;
const rec = { charId, avatar: `/assets/skins/${id}/avatar.png`, portrait: `/assets/skins/${id}/portrait.png`, illustration: `/assets/skins/${id}/illustration.png`,
  spine: Object.fromEntries(['front', 'back'].map(side => [side, { skel: `/assets/skins/${id}/${side}/model.skel`, atlas: `/assets/skins/${id}/${side}/model.atlas`, textures: [`/assets/skins/${id}/${side}/page.png`], anims: { idle: 'Idle' } }])) };

test('ordinary asset rebuild retains complete admitted skin groups and references them for prune accounting', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-manifest-'));
  try {
    const files = skinResourceFiles({ [id]: rec }); assert.equal(files.size, 9);
    for (const path of files) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), Buffer.from([1, 2, 3])); }
    const current = { skins: { [id]: rec, unknown: rec } };
    const retained = retainInstalledSkins(current, root);
    assert.deepEqual(Object.keys(retained.skins), [id]); assert.deepEqual(retained.files, files);
    const manifest = skinManifestMetadata({ version: 1, hash: 'old', generator: 'test', stats: { chars: 209 }, chars: {}, skins: retained.skins }, root);
    assert.equal(manifest.stats.files, 9); assert.equal(manifest.stats.bytes, 27); assert.equal(manifest.stats.chars, 209); assert.equal(manifest.stats.skins, 1);
    assert.equal(manifest.hash, contentHash({ chars: {}, skins: retained.skins }));
    rmSync(join(root, `skins/${id}/front/page.png`));
    assert.deepEqual(retainInstalledSkins(current, root).skins, {}, 'a partial skin is never emitted as broken URLs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('skin retention refuses cross-operator bindings and resource paths outside the admitted skin directory', () => {
  assert.deepEqual(retainInstalledSkins({ skins: { [id]: { ...rec, charId: 'char_002_amiya' } } }, tmpdir()).skins, {});
  assert.deepEqual(retainInstalledSkins({ skins: { [id]: { ...rec, avatar: '/assets/skins/../base.png' } } }, tmpdir()).skins, {});
});

test('display skeleton normalization removes editor roots only and is idempotent', () => {
  const str = s => Buffer.concat([Buffer.from([Buffer.byteLength(s) + 1]), Buffer.from(s)]);
  const head = Buffer.concat([str('hash'), str('3.8.99'), Buffer.alloc(16), Buffer.from([1]), Buffer.alloc(4)]);
  const body = Buffer.from([0, 7, 19, 255, 11]);
  const raw = Buffer.concat([head, str('/home/example/editor/images/'), str('C:\\Users\\example\\audio\\'), body]);
  const view = normalizeSkelPaths(raw);
  assert.deepEqual(view.removed, ['imagesPath', 'audioPath']);
  assert.deepEqual(Buffer.from(view.bytes), Buffer.concat([head, Buffer.from([1, 1]), body]));
  assert.deepEqual(Buffer.from(view.bytes.subarray(view.displayHeaderEnd)), body);
  assert.deepEqual(normalizeSkelPaths(view.bytes).removed, []);
  assert.deepEqual(normalizeSkelPaths(view.bytes).bytes, view.bytes);
  const noEditor = Buffer.concat([str('hash'), str('3.8.99'), Buffer.alloc(16), Buffer.from([0]), body]);
  assert.deepEqual(Buffer.from(normalizeSkelPaths(noEditor).bytes), noEditor);
  assert.throws(() => normalizeSkelPaths(Buffer.concat([str('hash'), str('3.5.35')])), /Only Spine 3.8/);
  assert.throws(() => normalizeSkelPaths(Uint8Array.of(127)));
});
for (const side of ['front', 'back']) {
  const path = new URL(`../public/assets/skins/char_479_sleach_summer_11/${side}/char_479_sleach_summer_11.skel`, import.meta.url);
  test(`installed normalized ${side} keeps every original skeleton/animation body byte and parsed result`, { skip: !existsSync(path) && 'install ignored skin artwork first' }, () => {
    const raw = readFileSync(path), view = normalizeSkelPaths(raw);
    const display = readFileSync(new URL(path.href.replace(/\.skel$/, '.display.skel')));
    assert.deepEqual(display, Buffer.from(view.bytes));
    assert.deepEqual(parseSkel(Uint8Array.from(raw)), parseSkel(view.bytes));
    assert.deepEqual(raw.subarray(view.sourceHeaderEnd), display.subarray(view.displayHeaderEnd));
  });
}

test('generated appearance UI names are translatable while exact Wiki title metadata stays unchanged', async () => {
  const source = skinCatalogueSource(OPERATOR_SKINS);
  const { msgids, literals } = await scanSource(source, 'shared/skin-catalogue.js');
  assert.deepEqual(literals.filter(l => !l.reason), []);
  const marked = new Set(msgids.map(m => m.msgid));
  for (const skin of OPERATOR_SKINS) {
    assert.ok(marked.has(skin.name)); assert.ok(marked.has(skin.brand));
  }
  const json = source.slice(source.indexOf('Object.freeze(') + 'Object.freeze('.length, source.lastIndexOf('.map(Object.freeze)'))
    .replace(/N_\(("(?:\\.|[^"\\])*")\)/g, '$1').replace(/ \/\/ i18n-ignore:[^\n]*/g, '');
  assert.deepEqual(JSON.parse(json), OPERATOR_SKINS, 'localization never rewrites IDs, the Wiki index or exact character names');
});

test('source refusal halts a bounded import, does not retry or admit unavailable metadata', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-skin-blocked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'assets.json');
  writeFileSync(manifestPath, JSON.stringify({ chars: { [charId]: {} }, stats: {} }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('Forbidden', { status: 403 }); });
  const catalogue = Array.from({ length: 6 }, () => ({ ...OPERATOR_SKINS[0] }));
  const result = await prepareSkins({ sourceDir: join(root, 'source'), fetchSources: true, catalogue, manifestPath, assetRoot: join(root, 'art') });
  assert.equal(result.sourceBlocked, true); assert.equal(result.skins, 0); assert.equal(result.unprocessed, 4);
  assert.equal(calls, 2, 'only the two already-admitted concurrent jobs run; no source hopping or retries');
});
