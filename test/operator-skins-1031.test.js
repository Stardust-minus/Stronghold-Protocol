// The skins released on 2026-10-31 (client 2.7.91; the owner's report of 2026-11-02 named 凛御银灰 and 薇薇安娜): every
// other official skin of the operators in this game was already in the catalogue — the audit of 2026-11-02 matched
// skin_table (08ba2aea), PRTS's per-operator model lists and shared/skin-catalogue.js at 311 skins. Imported like the
// rel22 batch (tools/prepare-operator-skins.mjs --model-source metadata), public material under /assets/skins/<id>/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { OPERATOR_SKINS, skinFor } from '../shared/skins.js';
import { skinAnimRoles } from '../tools/prepare-operator-skins.mjs';
import { parseSkel } from '../tools/assets/skel.mjs';

const assets = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
const NEW = Object.freeze({
  char_1045_svash2_sale_20: { charId: 'char_1045_svash2', officialId: 'char_1045_svash2@sale#20', name: '雪覆伦城', brand: '忒斯特收藏', charName: '凛御银灰', wikiIndex: 1, dynamic: true },
  char_4098_vvana_epoque_59: { charId: 'char_4098_vvana', officialId: 'char_4098_vvana@epoque#59', name: '还愿礼', brand: '时代', charName: '薇薇安娜', wikiIndex: 2, dynamic: true },
  char_4039_horn_epoque_59: { charId: 'char_4039_horn', officialId: 'char_4039_horn@epoque#59', name: '锋光初现', brand: '时代', charName: '号角', wikiIndex: 2, dynamic: false },
  char_4162_cathy_kitchen_5: { charId: 'char_4162_cathy', officialId: 'char_4162_cathy@kitchen#5', name: '暖冬教室', brand: '罗德厨房', charName: '凯瑟琳', wikiIndex: 1, dynamic: false },
});
const urlsOf = (rec) => [rec.avatar, rec.portrait, rec.illustration,
  ...['front', 'back'].flatMap((side) => [rec.spine[side].skel, rec.spine[side].atlas, ...rec.spine[side].textures])];

test('the catalogue holds the 2026-10-31 skins, bound to their operators', () => {
  for (const [id, want] of Object.entries(NEW)) {
    const s = skinFor(want.charId, id);
    assert.ok(s, id);
    const { dynamic, ...row } = want;
    assert.deepEqual({ ...s }, { id, ...row });
  }
  assert.equal(new Set(OPERATOR_SKINS.map((s) => s.id)).size, OPERATOR_SKINS.length, 'no id twice');
  assert.equal(new Set(OPERATOR_SKINS.map((s) => s.officialId)).size, OPERATOR_SKINS.length, 'no official skin twice');
});

test('their records are complete public material: avatar, half-body, full art, front and back models', () => {
  for (const [id, want] of Object.entries(NEW)) {
    const rec = assets.skins[id];
    assert.ok(rec, id);
    assert.equal(rec.charId, want.charId);
    assert.equal(rec.name, want.name);
    for (const url of urlsOf(rec)) assert.ok(url.startsWith(`/assets/skins/${id}/`), url);
    assert.equal(rec.backUnavailable, undefined);
    assert.equal(rec.dynamicDeclared, want.dynamic, `${id}: the official dynamic illustration is declared`);
    assert.equal(!!rec.dynamic, want.dynamic, `${id}: and shipped (rel26, from the client: test/ui/dynamic-illustration.test.js)`);
    for (const side of ['front', 'back']) {
      const m = rec.spine[side];
      assert.ok(!('hits' in m), 'skin hit timing is never a simulator input');
      assert.deepEqual(m.anims, skinAnimRoles(want.charId, Object.keys(m.animations), m.animations), `${id} ${side}: the import's roles`);
    }
  }
  assert.equal(assets.stats.skins, Object.keys(assets.skins).length);
});

test('installed 2026-10-31 skins: every file on disk, Spine 3.8 skeletons', { skip: !existsSync(new URL('../public/assets/skins/char_1045_svash2_sale_20/avatar.png', import.meta.url)) && 'install the skins first' }, () => {
  for (const [id] of Object.entries(NEW)) {
    const rec = assets.skins[id];
    for (const url of urlsOf(rec)) assert.ok(statSync(new URL(`../public${url}`, import.meta.url)).size > 0, url);
    for (const side of ['front', 'back']) {
      const parsed = parseSkel(Uint8Array.from(readFileSync(new URL(`../public${rec.spine[side].skel}`, import.meta.url))));
      assert.ok(parsed.version.startsWith('3.8.'), `${id} ${side}`);
      assert.deepEqual([...parsed.animations].sort(), Object.keys(rec.spine[side].animations).sort());
    }
  }
});
