// Which 动态立绘 pages are premultiplied (2026-11-06, the dashes on 归溟幽灵鲨's face): the manifest has to say so per skin. Flip
// a straight one and it falls apart; leave a premultiplied one as straight and its edges go dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { PREMULTIPLIED_DYNAMIC } from '../tools/prepare-operator-skins.mjs';

const assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
const dynamic = Object.entries(assets.skins).filter(([, skin]) => skin.dynamic);
const EDGE = new Set([...readFileSync(new URL('../tools/fix-dynamic-edges.py', import.meta.url), 'utf8').matchAll(/'(char_\w+)': 'dyn_illust_/g)].map((m) => m[1]));

test('exactly the measured 动态立绘 are premultiplied, every other one stays straight', () => {
  assert.equal(dynamic.length, 71);
  assert.equal(PREMULTIPLIED_DYNAMIC.size, 15);
  assert.deepEqual(dynamic.filter(([, skin]) => skin.dynamic.pma === true).map(([id]) => id).sort(), [...PREMULTIPLIED_DYNAMIC].sort());
  for (const [id, skin] of dynamic) assert.equal(typeof skin.dynamic.pma, 'boolean', id);
});

test('the skins with repaired pages name only the repaired files, the others none', () => {
  assert.equal(EDGE.size, 11);
  for (const id of EDGE) assert.ok(PREMULTIPLIED_DYNAMIC.has(id), id);
  for (const [id, { dynamic: d }] of dynamic) {
    const names = [d.atlas, ...d.textures];
    if (EDGE.has(id)) assert.ok(d.atlas.endsWith('.edge.atlas') && d.textures.length && d.textures.every((u) => /\.edge\.(png|webp)$/.test(u)), id);
    else assert.ok(names.every((u) => !u.includes('.edge.')), id);
    // the loader takes a differently named atlas as is, and finds the pages beside it
    assert.ok(names.every((u) => u.startsWith(`/assets/skins/${id}/dynamic/`)), id);
  }
});

test('the manifest hash is over the edited body', () => {
  const { version, hash, generator, stats, ...body } = assets;
  assert.equal(hash, contentHash(body));
  assert.ok(version && generator && stats);
});
