// 预选盟约 and AI 指定策略 on the client (ui/bondPlan.js, screens/bandDraft.js reservedBands): the plannable lists mirror
// the server's GameData.plannableBondIds() / subPlannableBondIds(), the change window mirrors Match.bondPlanOpen() (the
// whole match, rel34), a plan reads as 主盟约 + 副盟约, the picker marks 盟约禁用 on the mode's static bonds and the match's
// drawn set D (as the strategy draft now does — gameLogic matchOffBonds), the shop marks my plan and the plans of the
// teammates in my chess pool on the cards' bond chips (rel35 #152: which teammate is not shown; each has a switch in 设置,
// on by default), the in-match notice names the change, and a strategy the host reserved for an AI reads as
// taken until that AI picks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DATA } from '../match/harness.js';
import { GameData } from '../../server/match/gamedata.js';
import {
  plannableBonds, subPlannableBonds, bondPlanOpen, bondPlanHolders, playerPlan, planIds, planLine, planNoticeText, planOffMarks,
  poolMateIds, shopPlanMarks, cardPlanMarks, PLAN_SUB_MAX,
} from '../../public/js/ui/bondPlan.js';
import { matchOffBonds, modeOffBonds, bandOffBonds, DEFAULT_SETTINGS, sanitizeSettings } from '../../public/js/ui/gameLogic.js';
import { reservedBands } from '../../public/js/screens/bandDraft.js';

const BONDS = Object.values(DATA.bonds);
const nameOf = (id) => DATA.bonds[id]?.name || id;

test('the plannable bonds are the server\'s: the main one among the core bonds, the secondary ones among every bond with a member', () => {
  const ids = plannableBonds(BONDS).map((b) => b.bondId);
  const subIds = subPlannableBonds(BONDS).map((b) => b.bondId);
  for (const modeId of ['mode_single_normal', 'mode_multi_normal', 'mode_multi_funny', 'mode_multi_abyss']) {
    const gd = new GameData(DATA, modeId);
    assert.deepEqual(ids, [...gd.plannableBondIds()], modeId);
    assert.deepEqual(subIds, [...gd.subPlannableBondIds()], modeId);
  }
  assert.equal(ids.length, 8);
  assert.ok(ids.includes('lateranoShip') && !ids.includes('preciShip'));
  assert.equal(subIds.length, 22);
  assert.ok(subIds.includes('preciShip') && subIds.includes('yanShip') && !subIds.includes('suntShip'));
  assert.equal(PLAN_SUB_MAX, 4);
  assert.deepEqual(plannableBonds(null), []);
  assert.deepEqual(subPlannableBonds(undefined), []);
});

test('the plan can change from 确认本局信息 until the match ends, as on the server', () => {
  for (const phase of Object.values(PHASE)) {
    for (const round of [0, 1, 2, 5]) assert.equal(bondPlanOpen({ phase, round }), phase !== PHASE.LOBBY && phase !== PHASE.RESULT, `${phase} R${round}`);
  }
  assert.equal(bondPlanOpen(null), false);
  assert.equal(bondPlanOpen({}), false);
});

test('a player\'s plan: the main bond and the secondary ones (never the main one twice), the main one first', () => {
  assert.deepEqual(playerPlan({ bondPlan: 'yanShip', bondPlanSub: ['preciShip', 'yanShip', 'preciShip', 7, ''] }), { main: 'yanShip', sub: ['preciShip'] });
  assert.deepEqual(playerPlan({ bondPlan: null }), { main: null, sub: [] }, 'a page older than the secondary bonds: no key');
  assert.deepEqual(playerPlan(null), { main: null, sub: [] });
  assert.deepEqual(planIds({ bondPlan: 'egirShip', bondPlanSub: ['soloShip', 'kjeragShip'] }), ['egirShip', 'soloShip', 'kjeragShip']);
  assert.deepEqual(planIds({ bondPlanSub: ['soloShip'] }), ['soloShip']);
  assert.equal(planLine({ main: 'yanShip', sub: ['preciShip', 'swiftShip'] }, nameOf), '主 炎 · 副 精准、迅捷');
  assert.equal(planLine({ main: null, sub: ['preciShip'] }, nameOf), '副 精准');
  assert.equal(planLine({ main: 'yanShip', sub: [] }, nameOf), '主 炎');
  assert.equal(planLine({ main: null, sub: [] }, nameOf), '');
});

test('the in-match notice: who changed the plan to what, or cleared it', () => {
  assert.equal(planNoticeText({ kind: 'bondPlan', playerId: 'p2', name: 'B', bondId: 'yanShip', subIds: ['preciShip', 'swiftShip'] }, nameOf),
    'B 更改了预选盟约：主 炎 · 副 精准、迅捷');
  assert.equal(planNoticeText({ kind: 'bondPlan', playerId: 'p2', name: 'B', bondId: null, subIds: ['soloShip'] }, nameOf), 'B 更改了预选盟约：副 独行');
  assert.equal(planNoticeText({ kind: 'bondPlan', playerId: 'p2', name: 'B', bondId: null, subIds: [] }, nameOf), 'B 清空了预选盟约');
  assert.equal(planNoticeText({ kind: 'bondPlan', playerId: 'p2', bondId: null, subIds: [] }, nameOf), '博士 清空了预选盟约');
});

test('other players\' plans by bond (main and secondary), never the viewer\'s', () => {
  const players = [
    { playerId: 'me', name: 'A', bondPlan: 'yanShip', bondPlanSub: ['preciShip'] }, { playerId: 'p2', name: 'B', bondPlan: 'yanShip' },
    { playerId: 'p3', name: 'C', bondPlan: 'egirShip', bondPlanSub: ['preciShip', 'yanShip'] }, { playerId: 'p4', name: 'D', bondPlan: null },
  ];
  assert.deepEqual([...bondPlanHolders(players, 'me')], [['yanShip', ['B', 'C']], ['egirShip', ['C']], ['preciShip', ['C']]]);
});

test('盟约禁用 in the picker: the mode\'s static bonds (never activate) and the match\'s drawn set D (with its banned members)', () => {
  const funny = DATA.config.modes.mode_multi_funny;
  const normal = DATA.config.modes.mode_multi_normal;
  // a NORMAL match drew 炎 萨尔贡 叙拉古 + 4 add-ons; the ones whose every bond is drawn are banned
  const drawn = ['yanShip', 'sargonShip', 'siracusaShip', 'preciShip', 'swiftShip', 'steadShip', 'deputShip'];
  const off = new Set([...drawn]);
  const bannedChess = Object.values(DATA.chess).filter((c) => !c.hidden && Array.isArray(c.bonds) && c.bonds.length && c.bonds.every((b) => off.has(b))).map((c) => c.chessId);
  const pub = { modeId: 'mode_multi_normal', drawnDisabledBonds: drawn, disabledBonds: drawn, bannedChess };
  const marks = planOffMarks(pub, normal, BONDS);
  assert.deepEqual([...marks.keys()].sort(), [...drawn].sort());
  for (const id of drawn) assert.equal(marks.get(id).state, 'drawn', id);
  const yan = DATA.bonds.yanShip.visibleMembers.filter((id) => bannedChess.includes(id)).length;
  assert.ok(yan > 0);
  assert.equal(marks.get('yanShip').banned, yan);
  // 标准: the static ten, plus its drawn add-on
  const fpub = { modeId: 'mode_multi_funny', drawnDisabledBonds: ['indomShip'], disabledBonds: ['indomShip', ...funny.inactiveBondIds], bannedChess: [] };
  const fm = planOffMarks(fpub, funny, BONDS);
  for (const id of funny.inactiveBondIds) assert.equal(fm.get(id)?.state, 'off', id);
  assert.equal(fm.get('indomShip').state, 'drawn');
  assert.equal(fm.size, funny.inactiveBondIds.length + 1);
  assert.equal(planOffMarks({}, null, BONDS).size, 0);

  // the strategy draft: a strategy whose home bond is in D reads 「X盟约禁用」 too (matchOffBonds); the static list alone did not
  const bands = DATA.bands;
  assert.deepEqual(bandOffBonds(bands.band_duyaoy, modeOffBonds(normal)), [], '杜遥夜 (炎) before rel34');
  assert.deepEqual(bandOffBonds(bands.band_duyaoy, matchOffBonds(pub, normal)), ['yanShip']);
  assert.deepEqual(bandOffBonds(bands.band_pepe, matchOffBonds(pub, normal)), ['sargonShip']);
  assert.deepEqual(bandOffBonds(bands.band_harold, matchOffBonds(pub, normal)), []);
  assert.deepEqual(bandOffBonds(bands.band_paganini, matchOffBonds(fpub, funny)), ['lateranoShip'], '标准 still marks its static ones');
  assert.deepEqual([...matchOffBonds(fpub, funny)].sort(), ['indomShip', ...funny.inactiveBondIds].sort());
  assert.deepEqual([...matchOffBonds(null, null)], []);
});

test('the shop marks my main and secondary bonds and the alive teammates of my chess pool', () => {
  const me = { playerId: 'me', name: 'A', alive: true, bondPlan: 'yanShip', bondPlanSub: ['preciShip'] };
  const b = { playerId: 'p2', name: 'B', alive: true, bondPlan: 'yanShip', bondPlanSub: ['soloShip'] };
  const c = { playerId: 'p3', name: 'C', alive: true, bondPlan: 'egirShip' };
  const dead = { playerId: 'p4', name: 'D', alive: false, bondPlan: 'yanShip' };
  const ai = { playerId: 'ai_0', name: 'AI', isBot: true, alive: true, bondPlan: null };
  const pub = { players: [me, b, c, dead, ai] };
  const plan = shopPlanMarks(pub, 'me');
  assert.equal(plan.main, 'yanShip');
  assert.deepEqual([...plan.sub], ['preciShip']);
  assert.deepEqual([...plan.mates.keys()], ['yanShip', 'soloShip', 'egirShip'], 'an eliminated teammate is left out');
  assert.deepEqual(plan.mates.get('yanShip').map((p) => p.playerId), ['p2']);

  // per bond chip: mine (main / secondary) and whether a teammate planned it — no players (the owner on #152)
  const main = cardPlanMarks(['yanShip', 'soloShip'], plan);
  assert.equal(main.level, 'main');
  assert.deepEqual(['yanShip', 'soloShip'].map(main.of), ['main', null]);
  assert.deepEqual([...main.mates], ['yanShip', 'soloShip'], 'both chips: a teammate planned each');
  const sub = cardPlanMarks(['preciShip', 'egirShip'], plan);
  assert.equal(sub.level, 'sub');
  assert.deepEqual(['preciShip', 'egirShip'].map(sub.of), ['sub', null]);
  assert.deepEqual([...sub.mates], ['egirShip']);
  const mateOnly = cardPlanMarks(['egirShip'], plan);
  assert.equal(mateOnly.level, null);
  assert.deepEqual([...mateOnly.mates], ['egirShip']);
  assert.equal(cardPlanMarks(['kjeragShip'], plan), null);

  // the two switches of 设置: my plan off keeps the teammates', the teammates' off keeps mine, both off marks nothing
  const noMine = shopPlanMarks(pub, 'me', { mine: false });
  assert.equal(noMine.main, null);
  assert.equal(noMine.sub.size, 0);
  assert.deepEqual([...noMine.mates.keys()], ['yanShip', 'soloShip', 'egirShip']);
  assert.equal(cardPlanMarks(['yanShip'], noMine).level, null);
  const noMates = shopPlanMarks(pub, 'me', { mates: false });
  assert.equal(noMates.main, 'yanShip');
  assert.equal(noMates.mates.size, 0);
  assert.equal(cardPlanMarks(['egirShip'], noMates), null);
  assert.equal(shopPlanMarks(pub, 'me', { mine: false, mates: false }), null);
  assert.equal(cardPlanMarks([], plan), null);
  assert.equal(cardPlanMarks(['yanShip'], null), null);

  // my chess pool only: an expanded room's groups; a room without a shared pool has nobody
  const grouped = { ...pub, poolGroups: [{ id: 1, playerIds: ['me', 'p3'] }, { id: 2, playerIds: ['p2', 'p4', 'ai_0'] }] };
  assert.deepEqual([...poolMateIds(grouped, 'me')], ['p3']);
  assert.deepEqual([...shopPlanMarks(grouped, 'me').mates.keys()], ['egirShip']);
  assert.deepEqual([...poolMateIds({ ...pub, experimental: { disableSharedPool: true } }, 'me')], []);
  assert.equal(shopPlanMarks({ players: [me], experimental: { disableSharedPool: true } }, 'me').mates.size, 0);
  assert.equal(poolMateIds(pub, 'me'), null, 'one shared pool: every teammate');
  // nothing to mark
  assert.equal(shopPlanMarks({ players: [{ playerId: 'me', bondPlan: null }, { playerId: 'p2', bondPlan: null }] }, 'me'), null);
  assert.equal(shopPlanMarks(null, 'me'), null);
});

test('设置: the two shop-mark switches are on by default; only false turns one off', () => {
  assert.equal(DEFAULT_SETTINGS.planMarkMine, true);
  assert.equal(DEFAULT_SETTINGS.planMarkMates, true);
  assert.equal(sanitizeSettings(null).planMarkMine, true, 'a profile saved before the switches');
  assert.equal(sanitizeSettings({ bgm: 0.3 }).planMarkMates, true);
  for (const junk of ['false', 0, null, {}, []]) {
    assert.equal(sanitizeSettings({ planMarkMine: junk }).planMarkMine, true, JSON.stringify(junk));
    assert.equal(sanitizeSettings({ planMarkMates: junk }).planMarkMates, true, JSON.stringify(junk));
  }
  const off = sanitizeSettings({ planMarkMine: false, planMarkMates: false });
  assert.deepEqual([off.planMarkMine, off.planMarkMates], [false, false]);
  assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(off))), off, 'saved and read back');
});

test('an AI\'s reserved strategy is taken until that AI picks; one reserved for the viewer never is', () => {
  const draft = { reserved: { band_a: 'ai_1', band_b: 'ai_2', band_c: 'me' } };
  const picks = new Map([['ai_2', 'band_b']]);
  assert.deepEqual([...reservedBands(draft, picks, 'me')], [['band_a', 'ai_1']]);
  assert.deepEqual([...reservedBands({}, new Map(), 'me')], []);
  assert.deepEqual([...reservedBands(null, new Map(), 'me')], []);
});
