// 自选候补 (feedback #114, planned by the owner on 2026-11-02; shared/diy.js DIY_BENCH_SIZE / resolveDiySlots): a tier's
// preset holds two candidates besides its two slots, keyed diyBench_<tier>_<n> in the same picks map; the roster rules
// count them like slots of their tier (one operator once per tier, an owned operator once in the whole preset), the
// slots win a clash; resolveDiySlots fields the player's choice, else the first candidates whose bonds are not all
// banned, and keeps a chosen slotted pick in its own slot (a preset without a bench comes back unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S, checkDiyPicks, DIY_LIMITS } from '../shared/protocol.js';
import { DIY_BENCH_SIZE, diyBenchId, diyBenchIds, diyBenchTier, diyKeySlotId, diyKeyTier, diyCandidates, hasDiyChoice,
  resolveDiySlots, validateDiyPicks, diyPickOff } from '../shared/diy.js';
import { KITTED_CHARS } from '../server/sim/content/kits/index.js';
import { DATA } from './match/harness.js';

const T5A = 'chess_char_5_diy1_a', T5B = 'chess_char_5_diy2_a', T6A = 'chess_char_6_diy1_a', T6B = 'chess_char_6_diy2_a';
const B51 = diyBenchId(5, 1), B52 = diyBenchId(5, 2), B61 = diyBenchId(6, 1), B62 = diyBenchId(6, 2);
const own = (charId) => ({ charId, skillIndex: 2, uniEquipId: null });
const CHEN = 'char_010_chen', HAAK = 'char_225_haak'; // 炎 only
const SIEGE = 'char_112_siege'; // 维多利亚
const KALTS = 'char_003_kalts', IFRIT = 'char_134_ifrit', SHINING = 'char_147_shining'; // 协防 (never banned)
const SHARP = 'char_609_acguad'; // a 6★ prototype at both tiers
const opts = { data: DATA, kitted: KITTED_CHARS };

test('bench keys: two per tier, the tier\'s first slot to check against, the wire limit still 8', () => {
  assert.equal(DIY_BENCH_SIZE, 2);
  assert.deepEqual(diyBenchIds(DATA), [B51, B52, B61, B62]);
  assert.equal(DIY_LIMITS.slots, 4 + diyBenchIds(DATA).length);
  assert.equal(diyBenchTier(B62, DATA), 6);
  for (const bad of ['diyBench_5_3', 'diyBench_4_1', 'diyBench_5_0', 'diyBench_5_1x', T5A, null]) assert.equal(diyBenchTier(bad, DATA), null, String(bad));
  assert.equal(diyKeySlotId(B52, DATA), T5A);
  assert.equal(diyKeySlotId(B61, DATA), T6A);
  assert.equal(diyKeySlotId(T5B, DATA), T5B);
  assert.equal(diyKeyTier(T6B, DATA), 6);
  assert.equal(diyKeySlotId('chess_char_5_01_a', DATA), null);
  const full = { [T5A]: own(CHEN), [T5B]: own(HAAK), [B51]: own(KALTS), [B52]: own(IFRIT), [T6A]: own(SIEGE), [T6B]: { charId: SHARP }, [B61]: own(SHINING), [B62]: null };
  assert.equal(validateC2S({ t: 'room.diy', picks: full }), null, 'eight keys fit the wire limit');
});

test('checkDiyPicks keeps the 候补 under the roster rules; the slots win a clash', () => {
  const r = checkDiyPicks({
    [B51]: own(CHEN), // the same operator as slot 5-1: the slot keeps it, the bench pick goes
    [T5A]: own(CHEN),
    [B52]: own(KALTS),
    [T6A]: { charId: SHARP },
    [B61]: { charId: SHARP }, // the same prototype twice in tier 6: dropped
    [B62]: { charId: SHARP, skillIndex: 0 }, // a prototype off its locked skill: dropped
    [T5B]: { charId: SHARP }, // a prototype may fill a tier-5 and a tier-6 slot
    diyBench_5_3: own(IFRIT), // not a key of the data: dropped
  }, opts);
  assert.ok('ok' in r);
  assert.deepEqual(Object.keys(r.picks), [T5A, T5B, T6A, B52]);
  assert.equal(r.dropped, 4);
  // an owned operator once in the whole preset: a tier-6 bench pick of the tier-5 slot's operator goes
  const r2 = checkDiyPicks({ [T5A]: own(SIEGE), [B61]: own(SIEGE), [B62]: own(IFRIT) }, opts);
  assert.deepEqual(Object.keys(r2.picks), [T5A, B62]);
  // the strict check refuses the same clash
  assert.equal(validateDiyPicks({ [T5A]: own(SIEGE), [B61]: own(SIEGE) }, opts).error, 'BAD_TARGET');
  assert.ok('ok' in validateDiyPicks({ [T5A]: own(SIEGE), [B61]: own(CHEN) }, opts));
});

test('diyCandidates / hasDiyChoice: preset order (slots, then bench); a choice only with more candidates than slots', () => {
  const picks = checkDiyPicks({ [B52]: own(IFRIT), [T5B]: own(HAAK), [B51]: own(KALTS), [T6A]: own(SIEGE) }, opts).picks;
  const c = diyCandidates(picks, DATA);
  assert.deepEqual([...c.keys()], [5, 6]);
  assert.deepEqual(c.get(5).map((x) => x.key), [T5B, B51, B52]);
  assert.equal(hasDiyChoice(picks, DATA), true);
  assert.equal(hasDiyChoice({ [T5A]: own(CHEN), [B51]: own(KALTS) }, DATA), false, 'two candidates, two slots');
  assert.equal(hasDiyChoice({}, DATA), false);
});

test('resolveDiySlots: no bench → unchanged; the default skips a pick whose bonds are all banned; a choice; positions kept', () => {
  const yan = new Set(['yanShip']);
  assert.equal(diyPickOff(DATA, CHEN, yan), true);
  assert.equal(diyPickOff(DATA, KALTS, new Set(['emptyShip', 'yanShip'])), true, 'the rule reads the bonds (协防 is never drawn)');
  assert.equal(diyPickOff(DATA, SIEGE, yan), false);
  // a preset without a bench: exactly the slots (a lone slot 5-2 stays in slot 5-2)
  assert.deepEqual(resolveDiySlots({ [T5B]: own(CHEN), [T6A]: own(SIEGE) }, DATA, { off: yan }), { [T5B]: own(CHEN), [T6A]: own(SIEGE) });
  const preset = { [T5A]: own(CHEN), [T5B]: own(KALTS), [B51]: own(HAAK), [B52]: own(IFRIT), [T6A]: own(SIEGE) };
  // no bans: the slotted two
  assert.deepEqual(resolveDiySlots(preset, DATA, { off: new Set() }), { [T5A]: own(CHEN), [T5B]: own(KALTS), [T6A]: own(SIEGE) });
  // 炎 banned: 陈 (slot 5-1) goes, 阿 (炎 too) is skipped, 伊芙利特 takes slot 5-1; 凯尔希 keeps slot 5-2
  assert.deepEqual(resolveDiySlots(preset, DATA, { off: yan }), { [T5A]: own(IFRIT), [T5B]: own(KALTS), [T6A]: own(SIEGE) });
  // everyone of a tier banned but one: the banned fill the rest in preset order
  const all = { [T5A]: own(CHEN), [T5B]: own(HAAK), [B51]: own(SIEGE) };
  assert.deepEqual(resolveDiySlots(all, DATA, { off: new Set(['yanShip', 'victoriaShip']) }), { [T5A]: own(CHEN), [T5B]: own(HAAK) });
  // 炎 banned: 推进之王 comes in for the later of the two banned (阿), the earlier (陈) keeps its slot
  assert.deepEqual(resolveDiySlots(all, DATA, { off: yan }), { [T5A]: own(CHEN), [T5B]: own(SIEGE) });
  // the player's choice wins over the default, a banned pick included; the order of the charIds does not matter
  assert.deepEqual(resolveDiySlots(preset, DATA, { off: yan, choice: { 5: [IFRIT, CHEN] } }), { [T5A]: own(CHEN), [T5B]: own(IFRIT), [T6A]: own(SIEGE) });
  assert.deepEqual(resolveDiySlots(preset, DATA, { off: yan, choice: { 5: [HAAK, IFRIT] } }), { [T5A]: own(HAAK), [T5B]: own(IFRIT), [T6A]: own(SIEGE) });
  // a choice that is not exactly two distinct candidates of the tier: the default (string tier keys as a checkpoint has them)
  for (const bad of [[IFRIT], [IFRIT, IFRIT], [IFRIT, SIEGE], [IFRIT, HAAK, KALTS]]) {
    assert.deepEqual(resolveDiySlots(preset, DATA, { off: yan, choice: { '5': bad } }), { [T5A]: own(IFRIT), [T5B]: own(KALTS), [T6A]: own(SIEGE) }, JSON.stringify(bad));
  }
  assert.deepEqual(resolveDiySlots(preset, DATA, { off: null, choice: { '5': [HAAK, KALTS] } }), { [T5A]: own(HAAK), [T5B]: own(KALTS), [T6A]: own(SIEGE) });
});
