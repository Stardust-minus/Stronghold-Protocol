import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { OPERATOR_SKINS, skinFor, skinIdFor, isSkinChoices, cleanSkinChoices } from '../shared/skins.js';
import { parseStoredSkins, toStoredSkins, serializeSkins, parseSkinImport, setSkinChoice } from '../public/js/ui/skinsModel.js';
import { appearanceEntry, ownAppearance } from '../public/js/ui/skinAssets.js';
import { chessAvatarUrl, chessPortraitUrl } from '../public/js/ui/assetUrls.js';
import { avatarUrl, portraitUrl, spineEntry, hasBackSpine, unitPictureUrl, unitSfxUrl } from '../public/js/assets.js';
import { renderInfo } from '../public/js/render/app/info.js';
import { installSkinsSync } from '../public/js/ui/loadoutSync.js';
import { createStore } from '../public/js/store.js';
import { ownerBoard } from '../public/js/ui/watchBonds.js';
import { damageAppearance } from '../public/js/ui/damageBoard.js';

const charId = 'char_103_angel', id = OPERATOR_SKINS[0].id;
const entry = suffix => ({ skel: `/assets/${suffix}.skel`, atlas: `/assets/${suffix}.atlas`, anims: { idle: 'Idle', die: suffix.includes('back') ? null : 'Die' } });
const m = { chars: { [charId]: { avatar: '/assets/base.png', avatarE2: '/assets/e2.png', portrait: '/assets/p1.png', portraitE2: '/assets/p2.png', spine: { front: entry('base'), back: entry('base-back') } } },
  skins: { [id]: { charId, avatar: '/assets/skin.png', portrait: '/assets/skin-portrait.png', spine: { front: entry('skin'), back: entry('skin-back') } } },
  audio: { sfx: { units: { [charId]: { attack: '/media/base.mp3' } } } } };
const c = { charId, assets: { avatar: charId, portrait: `${charId}_1`, spine: charId } };

test('appearance admission binds each skin to its operator, rejects prototypes and arbitrary paths', () => {
  assert(skinFor(charId, id));
  for (const value of [null, [], { char_002_amiya: id }, { [charId]: 'https://example.com/a' }, JSON.parse('{"__proto__":"x"}'), { [charId]: null }]) assert.equal(isSkinChoices(value), false);
  assert(isSkinChoices({}));
  assert.deepEqual(cleanSkinChoices({ [charId]: id, other: id }), { [charId]: id });
});
test('appearance storage and portable export preserve choices, never gameplay fields', () => {
  const choices = { [charId]: id };
  assert.deepEqual(parseStoredSkins(toStoredSkins(choices)), choices);
  assert.deepEqual(parseSkinImport(serializeSkins(choices)), { ok: true, choices, dropped: 0 });
  assert.deepEqual(parseStoredSkins({ v: 99, choices }), {});
  assert.deepEqual(setSkinChoice(choices, charId, null), {});
  assert.equal(setSkinChoice(choices, 'other', id), choices);
  assert.deepEqual(Object.keys(JSON.parse(serializeSkins(choices))).sort(), ['choices', 'kind', 'v']);
});
test('appearance import rejects wrong/new envelopes and wholly stale imports without clearing choices', () => {
  for (const raw of ['{', '', 'null', '[]', JSON.stringify({ kind: 'stronghold.loadout', v: 1, choices: {} }), JSON.stringify({ kind: 'stronghold.skins', v: 2, choices: {} }), JSON.stringify({ kind: 'stronghold.skins', v: 1, choices: { missing: id } })]) assert.equal(parseSkinImport(raw).ok, false);
  assert.equal(parseSkinImport(serializeSkins({})).ok, true, 'explicit empty configuration restores defaults');
});
test('UI and render URL APIs resolve the admitted skin and preserve E2 default fallbacks', () => {
  const chosen = ownAppearance(c, { skins: { [charId]: id } });
  assert.equal(chosen.charId, charId); assert.equal(chosen.assets, c.assets); assert.equal(c.skinId, undefined);
  assert.equal(chessAvatarUrl(m, chosen), '/assets/skin.png');
  assert.equal(chessPortraitUrl(m, chosen), '/assets/skin-portrait.png');
  assert.equal(avatarUrl(m, `${charId}_2`, { skinId: id }), '/assets/skin.png');
  assert.equal(portraitUrl(m, `${charId}_2`, { skinId: 'missing' }), '/assets/p2.png');
  assert.equal(unitPictureUrl(m, charId, { skinId: id }), '/assets/skin.png');
  assert.equal(appearanceEntry(m, 'other', id), null);
  assert.equal(ownAppearance(c, { skins: {} }), c);
});
test('skin Spine entries have stable cache identity, independent front/back and default-model fallback', () => {
  const front = spineEntry(m, charId, { skinId: id });
  const back = spineEntry(m, charId, { skinId: id, back: true });
  assert.equal(front, spineEntry(m, charId, { skinId: id }));
  assert.equal(front.skel, '/assets/skin.skel'); assert.equal(back.skel, '/assets/skin-back.skel');
  assert.equal(front.fallback, m.chars[charId].spine.front);
  assert.equal(back.fallback, m.chars[charId].spine.back);
  assert(hasBackSpine(m, charId, { skinId: id }));
  assert.equal(spineEntry(m, charId, { skinId: 'missing' }), m.chars[charId].spine.front);
});
test('battle rendering preserves original audio identity, admits only own UnitInfo appearance', () => {
  const info = renderInfo({ id: 1, kind: 'op', side: 'ally', spine: charId, avatar: charId, skinId: id });
  assert.equal(info.spine, charId); assert.equal(info.skinId, id);
  assert.equal(unitSfxUrl(m, info.spine, 'attack'), '/media/base.mp3');
  assert.equal(renderInfo({ id: 2, kind: 'enemy', side: 'enemy', spine: charId, skinId: id }).skinId, undefined);
  assert.equal(renderInfo({ id: 3, kind: 'op', side: 'ally', spine: 'char_002_amiya', skinId: id }).skinId, undefined);
});
test('same operator on two owners resolves independent appearances without altering shared assets', () => {
  const a = ownAppearance(c, { skins: { [charId]: id } }), b = ownAppearance(c, { skins: {} });
  assert.notEqual(a, b); assert.equal(b, c);
  assert.equal(chessAvatarUrl(m, a), '/assets/skin.png'); assert.equal(chessAvatarUrl(m, b), '/assets/base.png');
  assert.equal(skinIdFor({ [charId]: id }, 'char_002_amiya'), null);
});
test('front-only appearance keeps its own model for UP instead of borrowing the default Back', () => {
  const manifest = { ...m, skins: { [id]: { ...m.skins[id], spine: { front: m.skins[id].spine.front } } } };
  assert.equal(hasBackSpine(manifest, charId, { skinId: id }), false);
  assert.equal(spineEntry(manifest, charId, { skinId: id, back: true }).skel, '/assets/skin.skel');
});
test('bond members and damage portraits resolve only the visible unit owner, never another player\'s choices', () => {
  const units = [
    { id: 1, uid: 1, ownerId: 'A', kind: 'op', side: 'ally', defId: 'chess_exu', spine: charId, avatar: charId, skinId: id },
    { id: 2, uid: 1, ownerId: 'B', kind: 'op', side: 'ally', defId: 'chess_exu', spine: charId, avatar: charId, skinId: OPERATOR_SKINS[1].id },
  ];
  const view = ownerBoard({ units }, 'A');
  assert.deepEqual(view.board.map(p => p.skinId), [id]); assert.equal(view.skins, undefined);
  assert.equal(damageAppearance(c, { defId: 'chess_exu', uid: 1 }, 'A', units).skinId, id);
  assert.equal(damageAppearance(c, { defId: 'chess_exu', uid: 1 }, 'B', units).skinId, OPERATOR_SKINS[1].id);
  assert.equal(damageAppearance(c, { defId: 'chess_exu', uid: 1 }, 'unknown', units), c);
});
test('skin sync uses its own message and state, resends on welcome and keeps locked match semantics', async () => {
  const target = createStore({ skins: { [charId]: id }, skinSync: 'idle', entries: { untouched: { skill: 2 } }, open: true });
  const handlers = new Map(), requests = [];
  const net = { status: 'online', on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); }, async request(type, payload) { requests.push({ type, payload }); } };
  const sync = installSkinsSync({ net, target, timers: { setTimeout() { return 1; }, clearTimeout() {} } });
  try {
    await sync.flush(); assert.equal(target.get().skinSync, 'synced');
    assert.deepEqual(requests[0], { type: 'room.skins', payload: { choices: { [charId]: id } } });
    handlers.get('welcome')(); await sync.flush(); assert.equal(requests.length, 2);
    target.set({ skins: {} });
    net.request = async () => { throw { code: 'WRONG_PHASE' }; };
    await sync.flush(); assert.equal(target.get().skinSync, 'locked');
    assert.deepEqual(target.get().entries, { untouched: { skill: 2 } });
  } finally { sync.dispose(); }
});
test('installed catalogue has complete files, does not change the default operator assets', { skip: !existsSync(new URL(`../public/assets/skins/${id}/avatar.png`, import.meta.url)) && 'install ignored skin artwork first' }, () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url)));
  assert.equal(Object.keys(manifest.chars).length, 209);
  for (const skin of OPERATOR_SKINS) {
    const rec = manifest.skins[skin.id]; assert.equal(rec.charId, skin.charId);
    for (const url of [rec.avatar, rec.portrait, rec.illustration, ...['front', 'back'].filter(side => rec.spine[side]).flatMap(side => [rec.spine[side].skel, rec.spine[side].atlas, ...rec.spine[side].textures])]) {
      assert.match(url, /^\/assets\/skins\//);
      const file = statSync(new URL(`../public${url}`, import.meta.url)); assert(file.isFile() && file.size > 0);
    }
    assert(!('hits' in rec.spine.front), 'skin hit timing is never a simulator input');
  }
});
