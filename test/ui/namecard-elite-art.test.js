// 名片底图: an operator's own 默认 / 精二 立绘 (the owner's decision of 2026-11-16: 「名片为啥没办法选塔露拉」) and the 名片-only
// skins of 阿米娅's other forms — the `char:<charId>_1|2` ids (what an older server and an older page do with them), the
// picker's groups (one per operator, only pictures the art index has), the search, the default framing by kind, the
// 精二 动态立绘 of a 精二 card, and what playerCard sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { namecardOf, namecardSrc, namecardDynamic, namecardArtGroups, filterArtGroups, charCardId, defaultFrame, hasNamecard,
  NAMECARD_SKINS, NAMECARD_DEFAULT_Y } from '../../public/js/ui/namecards.js';
import { cardMessage, cardStore, setCardBackground } from '../../public/js/ui/playerCard.js';
import { validateC2S, CARD_LIMITS } from '../../shared/protocol.js';
import { CARD_ROSTER } from '../../shared/card-roster.js';
import { OPERATOR_SKINS, skinFor } from '../../shared/skins.js';
import { isCollabUrl } from '../../shared/collabAssets.js';

const M = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
const OXI = 'char_4247_oxi';
// the bg format every server since rel28 checks (shared/protocol.js isCardBg as of 63b4297d): a new kind of id must fit it
const OLD_BG = /^[a-z0-9][a-z0-9_:\-\/]*$/i;
const allTiles = (groups) => groups.flatMap((g) => g.tiles);

test('char ids: one 默认 and one 精二 per roster operator, unique, in the format older servers keep', () => {
  const ids = new Set();
  for (const r of CARD_ROSTER) {
    for (const e2 of [false, true]) {
      const id = charCardId(r.charId, e2);
      assert.equal(id, `char:${r.charId}_${e2 ? 2 : 1}`);
      const c = namecardOf(id);
      assert.deepEqual([c?.kind, c?.e2, c?.charId], ['char', e2, r.charId], id);
      assert.ok(!ids.has(id), `unique ${id}`); ids.add(id);
      assert.ok(OLD_BG.test(id) && id.length <= CARD_LIMITS.idLength && !id.includes('#'), id);
      assert.equal(validateC2S({ t: 'room.card', bg: id }), null, id);
    }
    // the id splits back into one operator: no roster charId itself ends in _<digit>
    assert.doesNotMatch(r.charId, /_\d+$/, r.charId);
  }
  for (const s of NAMECARD_SKINS) assert.ok(OLD_BG.test(`skin:${s.id}`) && validateC2S({ t: 'room.card', bg: `skin:${s.id}` }) === null, s.id);
  for (const bad of ['char:char_4247_oxi', 'char:char_4247_oxi_3', 'char:char_4247_oxi_0', 'char:char_nope_9_2', 'char:char_4247_oxi#2', 'char:']) {
    assert.equal(namecardOf(bad), null, bad);
    assert.equal(hasNamecard(bad), false, bad);
  }
  assert.equal(hasNamecard(charCardId(OXI, true)), true);
});

test('塔露拉 (no 时装): her 默认 and 精二 立绘, the 精二 one live; the picker shows the half-body art', () => {
  const g = namecardArtGroups(M).find((x) => x.charId === OXI);
  assert.deepEqual(g.tiles.map((x) => [x.id, x.label, x.dyn]), [[charCardId(OXI, false), '默认', false], [charCardId(OXI, true), '精英二', true]]);
  const e0 = namecardOf(charCardId(OXI, false)), e2 = namecardOf(charCardId(OXI, true));
  assert.equal(namecardSrc(e0, M), M.chars[OXI].illustration);
  assert.equal(namecardSrc(e2, M), M.chars[OXI].illustrationE2);
  assert.equal(namecardSrc(e0, M, true), M.chars[OXI].portrait);
  assert.equal(namecardSrc(e2, M, true), M.chars[OXI].portraitE2);
  assert.equal(namecardDynamic(e2, M), M.chars[OXI].dynamicE2, 'the 精二 card plays her 精二 动态立绘');
  assert.equal(namecardDynamic(e0, M), null, 'the 默认 one is still');
  // no static 精二 立绘: no picture, nothing live either
  const bare = { ...M, chars: { ...M.chars, [OXI]: { ...M.chars[OXI], illustrationE2: undefined } } };
  assert.equal(namecardSrc(e2, bare), null);
  assert.equal(namecardDynamic(e2, bare), null);
  // a collab picture never is one (a plate shows in every room)
  const collab = { ...M, chars: { ...M.chars, [OXI]: { ...M.chars[OXI], illustration: '/assets/collab/x/illustration.png' } } };
  assert.ok(isCollabUrl(collab.chars[OXI].illustration));
  assert.equal(namecardSrc(e0, collab), null);
});

test('the groups: one per operator in the 名片干员 order, only pictures the index has, no empty tile', () => {
  const groups = namecardArtGroups(M);
  // rarity, then name (ui/seatArt.js cardOperators' order)
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1], b = groups[i];
    assert.ok(a.rarity > b.rarity || (a.rarity === b.rarity && String(a.name).localeCompare(String(b.name), 'zh') <= 0), `${a.name} before ${b.name}`);
  }
  for (const g of groups) {
    assert.ok(g.tiles.length > 0, g.charId);
    for (const x of g.tiles) {
      const c = namecardOf(x.id);
      assert.ok(c && namecardSrc(c, M), `${x.id} has its picture`);
      assert.ok(namecardSrc(c, M, true), `${x.id} has its half-body art`);
    }
  }
  const ids = allTiles(groups).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'every tile once');
  // every roster operator's own pictures that the index has, every skin with an illustration (none collab)
  const want = CARD_ROSTER.flatMap((r) => [M.chars[r.charId]?.illustration && charCardId(r.charId, false), M.chars[r.charId]?.illustrationE2 && charCardId(r.charId, true)]).filter(Boolean);
  for (const id of want) assert.ok(ids.includes(id), id);
  const skins = OPERATOR_SKINS.filter((s) => M.skins?.[s.id]?.illustration && !isCollabUrl(M.skins[s.id].illustration)).map((s) => `skin:${s.id}`);
  for (const id of skins) assert.ok(ids.includes(id), id);
  assert.equal(ids.length, want.length + skins.length + NAMECARD_SKINS.filter((s) => M.namecardSkins?.[s.id]?.illustration).length);
  // 医疗阿米娅: no 默认 立绘 in the game (skin_table has only char_1037_amiya3#2) — no 默认 tile
  const amiya = groups.find((g) => g.charId === 'char_1037_amiya3');
  assert.ok(!amiya.tiles.some((x) => x.id === charCardId('char_1037_amiya3', false)));
  assert.ok(amiya.tiles.some((x) => x.id === charCardId('char_1037_amiya3', true)));
});

test('search: an operator\'s name shows its whole group; a skin, brand or form only its tiles', () => {
  const groups = namecardArtGroups(M);
  assert.deepEqual(filterArtGroups(groups, '塔露拉').map((g) => g.charId), [OXI]);
  assert.equal(filterArtGroups(groups, '  ').length, groups.length);
  const angel = filterArtGroups(groups, '野地秘行');
  assert.deepEqual(angel.map((g) => [g.charId, g.tiles.map((x) => x.id)]), [['char_103_angel', ['skin:char_103_angel_wild_1']]]);
  assert.ok(filterArtGroups(groups, '能天使')[0].tiles.length >= 3, '能天使: 默认, 精二 and her skins');
  assert.deepEqual(filterArtGroups(groups, 'zzzz-none'), []);
});

test('the default framing by kind: a skin\'s 24, a 默认 立绘 higher, a 精二 one like a skin', () => {
  assert.deepEqual(defaultFrame(namecardOf(charCardId(OXI, false))), { x: 50, y: NAMECARD_DEFAULT_Y.char, zoom: 100 });
  assert.deepEqual(defaultFrame(namecardOf(charCardId(OXI, true))), { x: 50, y: NAMECARD_DEFAULT_Y.charE2, zoom: 100 });
  assert.deepEqual(defaultFrame(namecardOf('skin:char_103_angel_wild_1')), { x: 50, y: 24, zoom: 100 });
  assert.ok(NAMECARD_DEFAULT_Y.char < NAMECARD_DEFAULT_Y.skin, 'a 默认 立绘 fills its canvas: the face is higher');
});

test('名片-only skins: 阿米娅\'s 术师 / 近卫 skins, never wearable, shown with their form in 医疗阿米娅\'s group', () => {
  assert.equal(NAMECARD_SKINS.length, 5);
  for (const s of NAMECARD_SKINS) {
    assert.ok(!OPERATOR_SKINS.some((o) => o.id === s.id), `${s.id} is not an appearance`);
    assert.equal(skinFor('char_1037_amiya3', s.id), null, 'no one wears it (the server refuses it as a look)');
    const c = namecardOf(`skin:${s.id}`);
    assert.deepEqual([c.kind, c.only, c.charId], ['skin', true, 'char_1037_amiya3']);
    assert.equal(namecardSrc(c, { ...M, skins: { [s.id]: { illustration: '/assets/skins/x/illustration.png' } }, namecardSkins: {} }), null,
      'its art is namecardSkins[id], never a skins entry');
  }
  // with their art in the index: in the group, each tile with its form; the medic's own looks say 医疗
  const art = Object.fromEntries(NAMECARD_SKINS.map((s) => [s.id, { illustration: `/assets/skins/${s.id}/illustration.png`, portrait: `/assets/skins/${s.id}/portrait.png`,
    ...(s.id === 'char_1001_amiya2_sale_16' ? { dynamic: { skel: `/assets/skins/${s.id}/dynamic/a.skel` } } : {}) }]));
  const m = { ...M, namecardSkins: art };
  const amiya = namecardArtGroups(m).find((g) => g.charId === 'char_1037_amiya3');
  const only = amiya.tiles.filter((x) => NAMECARD_SKINS.some((s) => `skin:${s.id}` === x.id));
  assert.deepEqual(only.map((x) => [x.id, x.form, x.dyn]), NAMECARD_SKINS.map((s) => [`skin:${s.id}`, s.form, s.id === 'char_1001_amiya2_sale_16']));
  assert.ok(amiya.tiles.filter((x) => !only.includes(x)).every((x) => x.form === '医疗'));
  assert.equal(namecardSrc(namecardOf('skin:char_1001_amiya2_sale_16'), m, true), '/assets/skins/char_1001_amiya2_sale_16/portrait.png');
  assert.equal(namecardDynamic(namecardOf('skin:char_1001_amiya2_sale_16'), m)?.skel, '/assets/skins/char_1001_amiya2_sale_16/dynamic/a.skel');
  // 阿米娅 finds the group with all of them; 近卫 their tiles
  assert.equal(filterArtGroups(namecardArtGroups(m), '阿米娅').find((g) => g.charId === 'char_1037_amiya3').tiles.length, amiya.tiles.length);
  assert.deepEqual(filterArtGroups([amiya], '近卫')[0].tiles.map((x) => x.id), ['skin:char_1001_amiya2_sale_16', 'skin:char_1001_amiya2_casc_1']);
});

test('playerCard: a char card is kept and sent; an id this build does not know is sent as none', () => {
  setCardBackground(charCardId(OXI, true));
  assert.equal(cardStore.get().bg, charCardId(OXI, true));
  assert.equal(cardMessage(cardStore.get()).bg, charCardId(OXI, true));
  assert.deepEqual((({ bg, bgX, bgY, bgZoom }) => [bg, bgX, bgY, bgZoom])(cardMessage({ bg: charCardId(OXI, false), bgY: 10 })), [charCardId(OXI, false), -1, 10, -1]);
  assert.equal(cardMessage({ bg: 'char:char_4247_oxi_9' }).bg, '', 'unknown: none');
  assert.equal(cardMessage({ bg: 'future:kind' }).bg, '');
  setCardBackground('future:kind');
  assert.equal(cardStore.get().bg, '', 'an unknown pick is none');
  setCardBackground('');
});
