// Every 动态立绘's official camera frame and its baked backdrop layers (2026-11-16): tools/assets/dynamic-backdrops.mjs
// applies the registry tools/assets/dynamic-backdrops.json to a manifest body; tools/prepare-dynamic-backdrops.mjs
// rewrites data/assets.json (hash, stats) in place; tools/prepare-operator-dynamic-e2.mjs keeps the 精二 part on a re-run;
// the committed registry and data/assets.json agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDynamicBackdrops, loadDynamicBackdrops, validBackdrop, backdropDir } from '../tools/assets/dynamic-backdrops.mjs';
import { rewriteManifest } from '../tools/prepare-dynamic-backdrops.mjs';
import { rewriteManifest as rewriteE2 } from '../tools/prepare-operator-dynamic-e2.mjs';
import { applyDynamicE2, loadDynamicE2Registry } from '../tools/assets/dynamic-e2.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { isCollabUrl } from '../shared/collabAssets.js';

const rect = (x, y, w, h) => ({ x, y, width: w, height: h });
const F = rect(-1000, -300, 2000, 2000);
const file = (name, bytes) => ({ name, bytes, sha256: '0'.repeat(64), width: 2000, height: 2000 });
const REG = { version: 1,
  skins: { s_1: { frame: F, background: file('bg.webp', 7), foreground: file('fg.webp', 3) }, p_1: { frame: F, prts: 'kept' },
    r_1: { frame: F, background: file('bg.webp', 5), prts: 'replaced', replaces: [{ name: 'bg.png', bytes: 11 }] }, bad_1: { frame: rect(0, 0, 0, 0) } },
  chars: { char_c: { frame: F, background: file('bg.webp', 4) } } };
const dyn = (o = {}) => ({ skel: '/x.skel', atlas: '/x.atlas', textures: ['/x.webp'], bounds: rect(-900, -100, 1800, 1700), ...o });
const body = () => ({
  skins: { s_1: { dynamic: dyn() }, p_1: { dynamic: dyn({ background: '/assets/skins/p_1/dynamic/bg.png' }) },
    r_1: { dynamic: dyn({ background: '/assets/skins/r_1/dynamic/bg.png' }) }, bad_1: { dynamic: dyn() }, n_1: { name: 'no dynamic' } },
  chars: { char_c: { dynamicE2: dyn() }, char_d: { avatar: '/a' } } });

test('frames and layers onto skins[id].dynamic and chars[id].dynamicE2; a PRTS layer kept unless replaced; the input is not changed', () => {
  const input = body(); const before = JSON.stringify(input);
  const { body: out, files, records } = applyDynamicBackdrops(input, { registry: REG });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(out.skins.s_1.dynamic, { ...dyn(), frame: F, background: '/assets/skins/s_1/dynamic/bg.webp', foreground: '/assets/skins/s_1/dynamic/fg.webp' });
  assert.equal(out.skins.p_1.dynamic.background, '/assets/skins/p_1/dynamic/bg.png', 'PRTS kept');
  assert.deepEqual(out.skins.p_1.dynamic.frame, F);
  assert.equal(out.skins.r_1.dynamic.background, '/assets/skins/r_1/dynamic/bg.webp', 'PRTS replaced');
  assert.equal(out.skins.bad_1.dynamic.frame, undefined, 'an invalid entry changes nothing');
  assert.deepEqual(out.chars.char_c.dynamicE2, { ...dyn(), frame: F, background: '/assets/char/dynamic/char_c_2/bg.webp' });
  assert.equal(out.chars.char_d.dynamicE2, undefined);
  assert.equal(records, 4);
  assert.deepEqual([...files.keys()].sort(), ['char/dynamic/char_c_2/bg.webp', 'skins/r_1/dynamic/bg.webp', 'skins/s_1/dynamic/bg.webp', 'skins/s_1/dynamic/fg.webp']);
  assert.deepEqual(applyDynamicBackdrops(input, { registry: REG, kinds: ['chars'] }).body.skins, input.skins, 'kinds: only those');
  assert.equal(backdropDir('skins', 'a_1'), 'skins/a_1/dynamic'); assert.equal(backdropDir('chars', 'char_x'), 'char/dynamic/char_x_2');
});

test('a layer is named only while its file is on disk with its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dynbd-'));
  try {
    mkdirSync(join(dir, 'skins/s_1/dynamic'), { recursive: true });
    writeFileSync(join(dir, 'skins/s_1/dynamic/bg.webp'), Buffer.alloc(6));
    let d = applyDynamicBackdrops(body(), { registry: REG, assetRoot: dir }).body.skins.s_1.dynamic;
    assert.deepEqual([d.frame, d.background, d.foreground], [F, undefined, undefined], 'the frame always; a file of another size, a missing one: not named');
    writeFileSync(join(dir, 'skins/s_1/dynamic/bg.webp'), Buffer.alloc(7));
    d = applyDynamicBackdrops(body(), { registry: REG, assetRoot: dir }).body.skins.s_1.dynamic;
    assert.equal(d.background, '/assets/skins/s_1/dynamic/bg.webp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteManifest: stats move by the layers newly named and those replaced, the hash follows the body, a re-run changes nothing', () => {
  const m = { version: 1, hash: 'x', generator: 'g', stats: { files: 100, bytes: 1000 }, ...body() };
  const once = rewriteManifest(m, { registry: REG, assetRoot: null });
  assert.equal(once.stats.files, 100 + 4 - 1, 's_1 bg + fg, r_1 bg, char_c bg new; r_1\'s PRTS bg.png no longer named');
  assert.equal(once.stats.bytes, 1000 + 7 + 3 + 5 + 4 - 11);
  const { version, hash, generator, stats, ...rest } = once;
  assert.equal(hash, contentHash(rest)); assert.equal(generator, 'g');
  assert.deepEqual(rewriteManifest(once, { registry: REG, assetRoot: null }), once);
});

const assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
const reg = loadDynamicBackdrops();

test('the registry: a frame for every 动态立绘 with a client bundle; data/assets.json is the registry applied', () => {
  for (const [kind, field] of [['skins', 'dynamic'], ['chars', 'dynamicE2']]) {
    const have = Object.entries(assets[kind]).filter(([, r]) => r[field]).map(([id]) => id);
    assert.deepEqual(Object.keys(reg[kind]).sort(), have.filter((id) => !['char_2023_ling_nian_12', 'char_2027_wang'].includes(id)).sort(), `${kind}: all but the two without a client bundle`);
    for (const [id, R] of Object.entries(reg[kind])) {
      assert.ok(validBackdrop(R), id);
      assert.match(R.dynIllustId, /^dyn_illust_char_/, id);
      for (const k of ['background', 'foreground']) if (R[k]) assert.match(R[k].name, /^(bg|fg)\.webp$/, `${id}: ${k}`);
    }
  }
  const { version, hash, generator, stats, ...b } = assets;
  const again = applyDynamicBackdrops(b, { registry: reg }).body;
  assert.deepEqual(again.skins, assets.skins, 'skins: the manifest is the registry\'s');
  assert.deepEqual(again.chars, assets.chars, '精二: the manifest is the registry\'s');
  for (const [kind, field] of [['skins', 'dynamic'], ['chars', 'dynamicE2']]) {
    for (const r of Object.values(assets[kind])) for (const k of ['background', 'foreground']) if (r[field]?.[k]) assert.ok(!isCollabUrl(r[field][k]), 'no collab layer in the normal pack');
  }
});

test('the 精二 tool keeps the frames and layers: its re-run over data/assets.json changes nothing', () => {
  assert.deepEqual(rewriteE2(assets, { registry: loadDynamicE2Registry(), assetRoot: null }), assets);
  const { version, hash, generator, stats, ...b } = assets;
  const e2 = applyDynamicE2(b, { registry: loadDynamicE2Registry() }).body;
  assert.ok(Object.values(e2.chars).every((c) => !c.dynamicE2?.frame), 'applyDynamicE2 alone: the 精二 registry\'s fields only');
});

test('the bake: PRTS\'s 9 composites kept (a reason each), every other layer the bake\'s own WebP in its record\'s folder', () => {
  const kept = Object.entries(reg.skins).filter(([, R]) => R.prts === 'kept').map(([id]) => id).sort();
  assert.deepEqual(kept, ['char_1012_skadi2_boc_4', 'char_1014_nearl2_epoque_17', 'char_1023_ghost2_boc_6', 'char_113_cqbw_epoque_7', 'char_2015_dusk_nian_7',
    'char_250_phatom_sale_4', 'char_350_surtr_summer_9', 'char_4055_bgsnow_wild_7', 'char_472_pasngr_epoque_17']);
  for (const id of kept) {
    const R = reg.skins[id], d = assets.skins[id].dynamic;
    assert.ok(!R.background && !R.foreground && /^PRTS kept: /.test(R.note), id);
    assert.match(d.background, new RegExp(`^/assets/skins/${id}/dynamic/bg\\.png$`), `${id}: PRTS's background still named`);
  }
  let layers = 0;
  for (const [kind, field] of [['skins', 'dynamic'], ['chars', 'dynamicE2']]) {
    for (const [id, R] of Object.entries(reg[kind])) {
      for (const k of ['background', 'foreground']) {
        if (!R[k]) continue;
        layers++;
        assert.equal(assets[kind][id][field][k], `/assets/${backdropDir(kind, id)}/${R[k].name}`);
        assert.ok(R[k].width === R[k].height && Math.abs(R[k].width - R.frame.width) <= 1, `${id}: ${k} is the frame's square at 1 px per unit`);
      }
    }
  }
  assert.equal(layers, 131, '78 backgrounds and 53 foregrounds baked');
});
