// Feedback #70 「希望对局记录里可以看到boss战每个干员dps」 / #81 「结算页面是否可以加入干员伤害统计」, client side: the 领袖战
// damage report of a settlement row (public/js/ui/bossDamage.js) — its strict shape, the list a card draws, and how
// 统计数据 keeps it (ui/stats.js: a stored row keeps it without skins, a compacted row drops it, a record over the budget
// gives it up before it is dropped) and hands it to a re-viewed settlement (recordToResult → normalizeResult).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBossDamage, bossDamageList, perSecond, opLook, MAX_DAMAGE_OPS } from '../../public/js/ui/bossDamage.js';
import { buildRecord, normalizeRecord, compactRecord, fitToBudget, recordToResult, FULL_KEEP } from '../../public/js/ui/stats.js';
import { normalizeResult } from '../../public/js/ui/gameLogic.js';

const op = (id, damage, healing = 0, extra = {}) => ({ id, damage, healing, ...extra });
const report = () => [
  { kind: 'hidden', round: 14, seconds: 41.24, total: 900, healing: 0, otherDamage: 0, otherHealing: 0, ops: [op('chess_char_3_09_b', 900)] },
  { kind: 'boss', round: 14, seconds: 96.4, total: 10_030, healing: 300, otherDamage: 30, otherHealing: 0,
    ops: [op('chess_char_3_09_b', 6000), op('chess_char_6_diy1_a', 4000, 300, { diy: { charId: 'char_2013_cerber', skillIndex: 2, uniEquipId: null }, skinId: 'char_2013_cerber@x' }),
      op('chess_char_1_10_b', 0, 0, { standInFor: 'char_x' })] },
];

test('normalizeBossDamage: known scopes once each in order, numbers bounded, foreign fields and bad rows dropped', () => {
  const raw = [...report(), { kind: 'boss', total: 1 }, { kind: 'normal', total: 5 }, null, 'x'];
  raw[1].ops.push({ id: '', damage: 1 }, { damage: 5 }, { id: 'chess_x', damage: -4, healing: NaN, secret: 'y' });
  raw[1].evil = 'z';
  const n = normalizeBossDamage(raw);
  assert.deepEqual(n.map((e) => e.kind), ['boss', 'hidden'], 'boss first; the first entry of a scope wins');
  assert.equal(n[1].seconds, 41.2);
  assert.ok(!('evil' in n[0]));
  const x = n[0].ops.find((o) => o.id === 'chess_x');
  assert.deepEqual(x, { id: 'chess_x', damage: 0, healing: 0 }, 'negative / NaN amounts read 0, unknown fields dropped');
  assert.equal(n[0].ops.length, 4);
  assert.deepEqual(n[0].ops[1].diy, { charId: 'char_2013_cerber', skillIndex: 2, uniEquipId: null });
  assert.equal(n[0].ops[1].skinId, 'char_2013_cerber@x');
  assert.equal(normalizeBossDamage(raw, { skins: false })[0].ops[1].skinId, undefined, 'a stored record keeps no skin');
  assert.equal(n[0].ops[2].standInFor, 'char_x');
  assert.equal(normalizeBossDamage([{ kind: 'boss', ops: Array.from({ length: 40 }, (_, i) => op(`c${i}`, i)) }])[0].ops.length, MAX_DAMAGE_OPS);
  assert.deepEqual(normalizeBossDamage(null), []);
  assert.deepEqual(normalizeBossDamage({ kind: 'boss' }), []);
});

test('bossDamageList: damage / healing lines by value with share and rate; 装置 / 其他 listed; zero lines left out', () => {
  const [boss] = normalizeBossDamage(report());
  const d = bossDamageList(boss, 'damage');
  assert.equal(d.total, 10_030);
  assert.ok(Math.abs(d.rate - 10_030 / 96.4) < 1e-9);
  assert.deepEqual(d.rows.map((r) => r.op?.id ?? 'other'), ['chess_char_3_09_b', 'chess_char_6_diy1_a', 'other'], 'the 0-damage stand-in left out');
  assert.ok(Math.abs(d.rows[0].share - (6000 / 10_030) * 100) < 1e-9);
  assert.ok(Math.abs(d.rows[0].rate - 6000 / 96.4) < 1e-9);
  const h = bossDamageList(boss, 'healing');
  assert.equal(h.total, 300);
  assert.deepEqual(h.rows.map((r) => [r.op.id, r.value, r.share]), [['chess_char_6_diy1_a', 300, 100]]);
  assert.equal(perSecond(10, 0), null);
  assert.deepEqual(bossDamageList(null), { total: 0, rate: null, rows: [] });
});

test('统计数据 keeps the report in a settled record (no skins), drops it when compacted, gives it up before dropping a record', () => {
  const res = { seed: 1, durationMs: 60000, modeId: 'mode_multi_hard', roundsPassed: 14, victory: true, players: [
    { playerId: 'me', seat: 0, name: 'Me', stats: { dmgDealt: 1 }, lineup: [], bonds: [], damage: report() },
    { playerId: 'mate', seat: 1, name: 'Mate', stats: {}, lineup: [], bonds: [] },
  ] };
  const rec = buildRecord(res, { myId: 'me', roomMode: 'coop', now: 1000 });
  const me = rec.players.find((p) => p.playerId === 'me');
  assert.deepEqual(me.damage.map((e) => e.kind), ['boss', 'hidden']);
  assert.equal(me.damage[0].ops[1].skinId, undefined);
  assert.equal('damage' in rec.players.find((p) => p.playerId === 'mate'), false, 'a row without a report stays as it was');
  assert.deepEqual(normalizeRecord(JSON.parse(JSON.stringify(rec))), rec, 'stable through storage');
  assert.equal(compactRecord(rec).players[0].damage, undefined, 'a compacted row has no report');
  // a re-viewed settlement lists it
  const back = normalizeResult(recordToResult(rec), null);
  assert.equal(back.players.find((p) => p.playerId === 'me').damage[0].ops[0].damage, 6000);
  assert.deepEqual(back.players.find((p) => p.playerId === 'mate').damage, []);
  // the budget: a record that does not fit is kept without its reports before it would be dropped
  const recs = Array.from({ length: 3 }, (_, i) => ({ ...rec, id: `r${i}`, t: 2000 - i })); // ids and times of one length
  const full = JSON.stringify(recs[0]).length;
  const bare = JSON.stringify({ ...recs[0], players: recs[0].players.map(({ damage, ...p }) => (void damage, p)) }).length;
  const budget = 40 + 2 * (full + 1) + (bare + 1);  // two full records and one without its reports
  const kept = fitToBudget(recs, budget);
  assert.equal(kept.length, 3, 'nothing dropped');
  assert.ok(kept[0].players[0].damage && kept[1].players[0].damage, 'the newer ones keep their reports');
  assert.equal(kept[2].players[0].damage, undefined, 'the oldest gave them up and stays (re-viewable)');
  assert.equal(kept[2].players[0].lineup.length, rec.players[0].lineup.length);
  assert.equal(fitToBudget(recs, budget - 1).length, 2, 'not even that fits: dropped, as before');
  assert.ok(FULL_KEEP >= 3);
  assert.deepEqual(fitToBudget(recs).map((r) => !!r.players[0].damage), [true, true, true], 'within the budget: all kept');
});

test('the compact form (the wire, a stored record): zero amounts left out, read back as 0; an op takes its look from the lineup', () => {
  const c = normalizeBossDamage(report(), { compact: true, skins: false });
  assert.deepEqual(Object.keys(c[1]), ['kind', 'round', 'seconds', 'total', 'ops'], 'hidden: no healing / other');
  assert.deepEqual(c[0].ops[0], { id: 'chess_char_3_09_b', damage: 6000 });
  assert.deepEqual(normalizeBossDamage(c, { compact: true, skins: false }), c, 'idempotent');
  assert.deepEqual(normalizeBossDamage(c)[1], { ...c[1], healing: 0, otherDamage: 0, otherHealing: 0, ops: [{ id: 'chess_char_3_09_b', damage: 900, healing: 0 }] });
  assert.equal(bossDamageList(c[1], 'healing').total, 0);
  const lineup = [{ id: 'chess_char_3_09_b', diy: { charId: 'char_a', skillIndex: 1, uniEquipId: null }, skinId: 's1' }, { id: 'chess_y', standInFor: 'char_b' }];
  assert.deepEqual(opLook({ id: 'chess_char_3_09_b', damage: 5 }, lineup), { diy: lineup[0].diy, skinId: 's1', id: 'chess_char_3_09_b', damage: 5 });
  assert.deepEqual(opLook({ id: 'chess_char_3_09_b', damage: 5, skinId: 'own' }, lineup).skinId, 'own', 'its own look wins');
  assert.deepEqual(opLook({ id: 'chess_z', damage: 1 }, lineup), { id: 'chess_z', damage: 1 });
  assert.deepEqual(opLook({ id: 'chess_z', damage: 1 }, null), { id: 'chess_z', damage: 1 });
});
