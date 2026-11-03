// The collab operators' skins (the owner's report of 2026-11-02, 「联动干员应该有一些皮肤」): the official skin_table holds
// five — 灰烬「游侠」, 艾拉「密室」, 玛露西尔「泰拉冒险」, 丰川祥子「旋律的主人」, 结城理「见证荣光」 (麒麟R夜刀 and 焰狐龙梓兰
// have none). They sit in the shared catalogue like every skin (shared/skin-catalogue.js: room.skins accepts them for
// their own operator only), but their art is the collab pack's (data/assets-collab.json `skins`, /assets/collab/skins/…):
// only a page in a room with 联动干员 on lays that pack (shared/collabAssets.js mergeCollabManifest) and resolves them,
// and a name card never shows one (public/js/ui/namecards.js: a plate shows in every room the player joins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { OPERATOR_SKINS, skinsFor, skinFor, isSkinChoices } from '../shared/skins.js';
import { COLLAB_ASSET_PREFIX, isCollabUrl, collabManifestProblems, mergeCollabManifest, manifestUrls } from '../shared/collabAssets.js';
import { collabPackProblems } from '../tools/collab-assets.mjs';
import { skinAnimRoles } from '../tools/prepare-operator-skins.mjs';
import { normalizeSkelPaths, parseSkel } from '../tools/assets/skel.mjs';
import { appearanceEntry } from '../public/js/ui/skinAssets.js';
import { namecardOf, namecardSrc } from '../public/js/ui/namecards.js';

const json = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const assets = json('data/assets.json');
const collab = json('data/assets-collab.json');
const backups = json('data/backups.json');
const COLLAB = new Set(backups.diy.excluded);
// brand: the collab work's name (the owner's decision of 2026-11-02; 艾拉's official group reads 「彩虹六号：围攻/II」 — the
// second R6 collab — and is shown as the work's name like 灰烬's)
const SKINS = Object.freeze({
  char_456_ash_rainbow6_1: ['char_456_ash', 'char_456_ash@rainbow6#1', '游侠', '彩虹六号：围攻'],
  char_4123_ela_rainbow6_2: ['char_4123_ela', 'char_4123_ela@rainbow6#2', '密室', '彩虹六号：围攻'],
  char_4141_marcil_dungeon_1: ['char_4141_marcil', 'char_4141_marcil@dungeon#1', '泰拉冒险', '迷宫饭'],
  char_4182_oblvns_avemujica_1: ['char_4182_oblvns', 'char_4182_oblvns@avemujica#1', '旋律的主人', 'Ave Mujica'],
  char_4217_makoto_p3r_1: ['char_4217_makoto', 'char_4217_makoto@p3r#1', '见证荣光', '女神异闻录３ Reload'],
});
const collabSkins = OPERATOR_SKINS.filter((s) => COLLAB.has(s.charId));
const urlsOf = (rec) => [rec.avatar, rec.portrait, rec.illustration,
  ...['front', 'back'].filter((side) => rec.spine?.[side]).flatMap((side) => [rec.spine[side].skel, rec.spine[side].atlas, ...rec.spine[side].textures])];
const installed = existsSync(new URL('../public/assets/collab/skins/char_456_ash_rainbow6_1/avatar.png', import.meta.url));

test('the catalogue holds the five official collab skins, each bound to its collab operator', () => {
  assert.deepEqual(collabSkins.map((s) => s.id).sort(), Object.keys(SKINS).sort());
  for (const [id, [charId, officialId, name, brand]] of Object.entries(SKINS)) {
    const s = skinFor(charId, id);
    assert.ok(s, id);
    assert.equal(s.officialId, officialId);
    assert.equal(s.name, name);
    assert.equal(s.brand, brand, `${id}: the collab work's name`);
    assert.equal(collab.skins[id].brand, brand, `${id}: the pack's record too`);
    assert.ok(COLLAB.has(charId), `${charId} is a collab 6★ (diy.excluded)`);
    assert.deepEqual(skinsFor(charId).map((x) => x.id), [id], `${charId}: its only skin`);
  }
  for (const id of ['char_1029_yato2', 'char_1048_orchd2']) assert.deepEqual(skinsFor(id), [], `${id}: no official skin`);
});

test('room.skins takes a collab skin for its own operator only', () => {
  assert.equal(isSkinChoices({ char_456_ash: 'char_456_ash_rainbow6_1' }), true);
  assert.equal(isSkinChoices({ char_4123_ela: 'char_456_ash_rainbow6_1' }), false, 'never another operator\'s skin');
  assert.equal(isSkinChoices({ char_1029_yato2: 'char_456_ash_rainbow6_1' }), false);
});

test('their art is the collab pack\'s: data/assets-collab.json `skins` under /assets/collab/skins/<id>/, none in data/assets.json', () => {
  assert.deepEqual(collabManifestProblems(collab), []);
  assert.deepEqual(collabPackProblems({ collab, assets, backups, publicDir: '', files: false }), []);
  assert.deepEqual(Object.keys(collab.skins).sort(), Object.keys(SKINS).sort());
  for (const [id, rec] of Object.entries(collab.skins)) {
    assert.equal(rec.charId, SKINS[id][0]);
    assert.equal(rec.name, SKINS[id][2]);
    assert.equal(assets.skins[id], undefined, `${id}: not in the normal pack`);
    assert.ok(rec.avatar && rec.portrait && rec.illustration && rec.spine?.front && rec.spine?.back, `${id}: complete (avatar, half, full art, front and back)`);
    assert.equal(rec.backUnavailable, undefined);
    for (const url of urlsOf(rec)) assert.ok(url.startsWith(`${COLLAB_ASSET_PREFIX}skins/${id}/`), url);
    assert.ok(!('hits' in rec.spine.front) && !('hits' in rec.spine.back), 'skin hit timing is never a simulator input');
  }
  for (const url of manifestUrls(assets)) assert.ok(!url.startsWith('/assets/collab/'), url);
  // every catalogue skin is installed in exactly one of the two manifests
  for (const s of OPERATOR_SKINS) {
    const where = [assets.skins?.[s.id] && 'normal', collab.skins?.[s.id] && 'collab'].filter(Boolean);
    assert.deepEqual(where, [COLLAB.has(s.charId) ? 'collab' : 'normal'], s.id);
  }
  const { version, kind, prefix, hash, generator, stats, ...sections } = collab;
  assert.equal(stats.files, new Set(manifestUrls(sections)).size, 'stats.files: the sections\' URLs (tools/collab-assets.mjs buildCollabManifest)');
});

test('a skin plays the clips of its operator\'s own model (the same roles, both sides)', () => {
  for (const [id, rec] of Object.entries(collab.skins)) {
    const own = collab.chars[rec.charId].spine;
    for (const side of ['front', 'back']) {
      assert.deepEqual(rec.spine[side].anims, own[side].anims, `${id} ${side}`);
      const names = Object.keys(rec.spine[side].animations);
      assert.deepEqual(skinAnimRoles(rec.charId, names, rec.spine[side].animations), rec.spine[side].anims, `${id} ${side}: the import's roles`);
    }
  }
});

test('only a page with the pack laid resolves them; the normal manifest alone shows the default look', () => {
  const merged = mergeCollabManifest(assets, collab);
  for (const [id, [charId]] of Object.entries(SKINS)) {
    assert.equal(appearanceEntry(assets, charId, id), null, `${id}: no collab room, no art`);
    const e = appearanceEntry(merged, charId, id);
    assert.ok(e?.spine?.front && e.spine.back, id);
    assert.ok(isCollabUrl(e.spine.front.skel));
    assert.equal(appearanceEntry(merged, 'char_4123_ela', 'char_456_ash_rainbow6_1'), null);
  }
  // add-only: no normal skin changes
  for (const id of Object.keys(assets.skins)) assert.equal(merged.skins[id], assets.skins[id]);
});

test('a collab skin is never a name card, even on a page with the pack laid', () => {
  const merged = mergeCollabManifest(assets, collab);
  for (const id of Object.keys(SKINS)) {
    const card = namecardOf(`skin:${id}`);
    assert.equal(namecardSrc(card, merged), null, id);
    assert.equal(namecardSrc(card, merged, true), null, `${id} (picker tile)`);
  }
  const normal = OPERATOR_SKINS.find((s) => !COLLAB.has(s.charId) && assets.skins[s.id]?.illustration);
  assert.equal(namecardSrc(namecardOf(`skin:${normal.id}`), merged), assets.skins[normal.id].illustration, 'a normal skin still is');
});

test('installed collab skins: every file on disk, display skeletons keep every original body byte', { skip: !installed && 'install the collab pack\'s skins first' }, () => {
  for (const [id, rec] of Object.entries(collab.skins)) {
    for (const url of urlsOf(rec)) {
      const st = statSync(new URL(`../public${url}`, import.meta.url));
      assert.ok(st.isFile() && st.size > 0, url);
    }
    for (const side of ['front', 'back']) {
      const skel = new URL(`../public${rec.spine[side].skel}`, import.meta.url);
      const parsed = parseSkel(Uint8Array.from(readFileSync(skel)));
      assert.ok(parsed.version.startsWith('3.8.'), `${id} ${side}: Spine 3.8`);
      assert.deepEqual(Object.keys(rec.spine[side].animations).sort(), [...parsed.animations].sort(), `${id} ${side}: the manifest's clips are the skeleton's`);
      if (rec.spine[side].skel.endsWith('.display.skel')) {
        const view = normalizeSkelPaths(readFileSync(skel));
        assert.deepEqual(view.removed, [], `${id} ${side}: already normalized`);
      }
    }
  }
});
