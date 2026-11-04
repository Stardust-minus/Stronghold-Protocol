// HD static art (rel30): tools/assets/illustrations.mjs applies the registry tools/assets/char-illustrations.json to a
// manifest body; tools/prepare-operator-illustrations.mjs rewrites a manifest (hash, stats) in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyIllustrations, boxFraction, loadIllustrationRegistry, HD_FIELDS } from '../tools/assets/illustrations.mjs';
import { rewriteManifest } from '../tools/prepare-operator-illustrations.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';

const look = (o = {}) => ({ box: [100, 50, 300, 600], illustration: { size: [2048, 2048], bytes: 7 }, hd: { size: [300, 600], bytes: 3 }, ...o });
const REG = { chars: { c: { e1: look(), e2: look({ box: [0, -10, 250, 500], hd: { size: [250, 500], bytes: 2 }, scene: true }) } },
  skins: { s: look({ scene: true }), t: look() } };
const body = () => ({ chars: { c: { avatar: '/a', portrait: '/p1', portraitE2: '/p2' }, d: { portrait: '/d1' } },
  skins: { s: { charId: 'c', portrait: '/sp', illustration: '/si' }, t: { charId: 'c', portrait: '/tp', illustration: '/ti' } } });

test('fields per look, fractions of the 立绘, skins keep their own illustration; the input is not changed', () => {
  const input = body(); const before = JSON.stringify(input);
  const { body: out, files, bytes, looks } = applyIllustrations(input, { registry: REG });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(out.chars.c.portraitBox, boxFraction([100, 50, 300, 600], [2048, 2048]));
  assert.equal(out.chars.c.illustration, '/assets/char/illustration/c_1.png');
  assert.equal(out.chars.c.portraitHDE2, '/assets/char/portrait_hd/c_2.png');
  assert.deepEqual(out.chars.c.portraitBoxE2.slice(0, 2), [0, -10 / 2048].map((v) => Math.round(v * 1e6) / 1e6));
  assert.equal(out.chars.d.illustration, undefined, 'no registry entry: as before');
  assert.equal(out.chars.c.portraitSceneE2, true); assert.equal(out.chars.c.portraitScene, undefined, 'the 精一 look has no scene');
  assert.equal(out.skins.s.illustration, '/si'); assert.equal(out.skins.s.portraitScene, true);
  assert.equal(out.skins.t.portraitScene, undefined);
  assert.equal(looks, 4); assert.equal(files.size, 6); assert.equal(bytes, 7 + 3 + 7 + 2 + 3 + 3);
  const w = out.chars.c.portraitBox[2] * 2048, h = out.chars.c.portraitBox[3] * 2048;
  assert.ok(Math.abs(h - 2 * w) < 0.01, '1:2 (fractions rounded to 1e-6)');
});

test('a look whose crop would be coarser than its portrait gets its 立绘 and box but no portraitHD', () => {
  const { hd, ...noHd } = look();
  const out = applyIllustrations({ chars: { c: { portrait: '/p1' } }, skins: { s: { portrait: '/sp', illustration: '/si' } } },
    { registry: { chars: { c: { e1: { ...noHd, scene: true } } }, skins: { s: { ...noHd, scene: true } } } });
  assert.equal(out.body.chars.c.portraitScene, true, 'a scene look without portraitHD still says so (the framer must not show the scene)');
  assert.ok(out.body.chars.c.illustration); assert.ok(out.body.chars.c.portraitBox); assert.equal(out.body.chars.c.portraitHD, undefined);
  assert.ok(out.body.skins.s.portraitBox); assert.equal(out.body.skins.s.portraitHD, undefined); assert.equal(out.body.skins.s.portraitScene, true);
  assert.equal(out.files.size, 1); assert.equal(out.bytes, 7);
});

test('a look without its portrait, or a weak registry record, gets nothing; files are checked by size on disk', () => {
  const noE2 = applyIllustrations({ chars: { c: { portrait: '/p1' } } }, { registry: REG }).body;
  assert.equal(noE2.chars.c.illustrationE2, undefined); assert.ok(noE2.chars.c.illustration);
  const bad = applyIllustrations(body(), { registry: { chars: { c: { e1: look({ box: [0, 0, 10, 11] }) } } } }).body;
  assert.equal(bad.chars.c.illustration, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'hdart-'));
  try {
    mkdirSync(join(dir, 'char/illustration'), { recursive: true }); mkdirSync(join(dir, 'char/portrait_hd'), { recursive: true });
    writeFileSync(join(dir, 'char/illustration/c_1.png'), Buffer.alloc(7)); writeFileSync(join(dir, 'char/portrait_hd/c_1.png'), Buffer.alloc(3));
    const out = applyIllustrations(body(), { registry: REG, assetRoot: dir }).body;
    assert.ok(out.chars.c.portraitHD); assert.equal(out.chars.c.portraitHDE2, undefined, 'E2 files missing');
    assert.equal(out.skins.s.portraitHD, undefined, 'skin crop missing');
    writeFileSync(join(dir, 'char/portrait_hd/c_1.png'), Buffer.alloc(4));
    assert.equal(applyIllustrations(body(), { registry: REG, assetRoot: dir }).body.chars.c.portraitHD, undefined, 'size differs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idempotent: a re-run strips stale fields first; the collab prefix', () => {
  const once = applyIllustrations(body(), { registry: REG }).body;
  assert.deepEqual(applyIllustrations(once, { registry: REG }).body, once);
  const cleared = applyIllustrations(once, { registry: { chars: {}, skins: {} } }).body;
  for (const k of HD_FIELDS) { assert.equal(Object.hasOwn(cleared.chars.c, k), false, k); if (k !== 'illustration') assert.equal(Object.hasOwn(cleared.skins.s, k), false, k); }
  assert.equal(cleared.skins.s.illustration, '/si');
  const col = applyIllustrations({ chars: { c: { portrait: '/assets/collab/char/portrait/c_1.png' } } }, { registry: REG, prefix: 'collab/' }).body;
  assert.equal(col.chars.c.illustration, '/assets/collab/char/illustration/c_1.png');
});

test('the manifest rewrite: hash over the body, stats moved by the new files, a re-run is stable', () => {
  const m = { version: 1, hash: 'x', generator: 'g', stats: { files: 10, bytes: 100, chars: 2 }, ...body() };
  const r1 = rewriteManifest(m, { registry: REG, assetRoot: null, prefix: '' });
  const { version, hash, generator, stats, ...rest } = r1;
  assert.equal(hash, contentHash(rest)); assert.equal(generator, 'g');
  assert.equal(stats.files, 16); assert.equal(stats.bytes, 125); assert.equal(stats.chars, 2);
  assert.deepEqual(rewriteManifest(r1, { registry: REG, assetRoot: null, prefix: '' }), r1);
});

test('the committed registry loads; every look it names is 1:2 with a crop of its box size', () => {
  const reg = loadIllustrationRegistry();
  for (const [id, r] of Object.entries(reg.chars || {})) for (const L of Object.values(r)) {
    assert.equal(L.box[3], 2 * L.box[2], id);
    if (L.hd) { assert.deepEqual(L.hd.size, [L.box[2], L.box[3]], id); assert.ok(L.box[2] >= 180, `${id}: a portraitHD coarser than the portrait`); }
  }
  for (const [id, L] of Object.entries(reg.skins || {})) {
    assert.equal(L.box[3], 2 * L.box[2], id);
    if (L.hd) { assert.deepEqual(L.hd.size, [L.box[2], L.box[3]], id); assert.ok(L.box[2] >= 180, id); }
  }
});
