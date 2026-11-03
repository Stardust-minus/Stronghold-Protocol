// Feedback #70 「希望对局记录里可以看到boss战每个干员dps」 / #81 「结算页面是否可以加入干员伤害统计」, server side: the damage
// ledger keeps the frozen packet of each final scope (server/match/damageBoard.js `finals`) and the settlement row lists
// the operators of every scope its player fought (server/match/results.js bossDamageRows) — a real Match with inline
// battles on the virtual clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { DamageBoard } from '../../server/match/damageBoard.js';
import { operatorDamageKey } from '../../server/sim/damageBoard.js';
import { buildResult, bossDamageRows, BOSS_DAMAGE_OPS } from '../../server/match/results.js';
import { DATA, give } from './harness.js';

const quiet = { info() {}, error() {}, warn() {}, debug() {} };
const owners = ['p0', 'p1'].map((playerId, seat) => ({ playerId, name: `Owner ${seat}`, seat }));
const row = (playerId, ops, extra = {}) => ({ playerId, total: ops.reduce((n, [, d]) => n + d, 0), otherDamage: 0,
  operators: ops.map(([uid, damage, defId = 'chess_char_4_22_b']) => ({ key: operatorDamageKey(playerId, uid), uid, defId, damage })), ...extra });

test('finals: the boss and the hidden scope each keep their frozen packet; a later freeze never overwrites the other', () => {
  const b = new DamageBoard('fixtureMatch');
  assert.deepEqual(b.finals, {});
  b.startCombat(1, 'normal', owners);
  b.replaceField({ matchId: 'fixtureMatch', round: 1, phase: 'normal', fieldId: 'n:p0', gt: 3, owners: [row('p0', [[1, 50]])], final: true });
  b.freeze();
  assert.deepEqual(b.finals, {}, 'a normal round is no final scope');
  b.startCombat(14, 'boss', owners);
  b.replaceField({ matchId: 'fixtureMatch', round: 14, phase: 'boss', fieldId: 'b1', gt: 80, owners: [row('p0', [[1, 900], [2, 100]]), row('p1', [[3, 400]])], final: true });
  b.freeze();
  assert.equal(b.finals.boss.round, 14);
  assert.equal(b.finals.boss.owners.find((o) => o.playerId === 'p0').total, 1000);
  b.startCombat(14, 'hidden', owners);
  b.replaceField({ matchId: 'fixtureMatch', round: 14, phase: 'hidden', fieldId: 'h1', gt: 20, owners: [row('p0', [[1, 7]])], final: true });
  b.freeze();
  b.freeze();
  assert.equal(b.finals.boss.owners.find((o) => o.playerId === 'p0').total, 1000, 'the boss packet survives the hidden scope');
  assert.equal(b.finals.hidden.owners.find((o) => o.playerId === 'p0').total, 7);
  // a checkpoint carries it (snapshot.js: encodeValue({ ...damageBoard }) → Object.assign on restore)
  const restored = Object.assign(new DamageBoard('fixtureMatch'), structuredClone({ ...b }));
  assert.deepEqual(restored.finals, b.finals);
  // an older checkpoint without it restores an empty set
  const { finals, ...older } = structuredClone({ ...b }); void finals;
  assert.deepEqual(Object.assign(new DamageBoard('fixtureMatch'), older).finals, {});
});

test('bossDamageRows: rounded, sorted, capped, drawn like the lineup; nothing for a browser-run match or a player who fought none', () => {
  const ops = Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, uid: i + 1, defId: 'chess_char_4_22_b', damage: 10 * i + 0.4, healing: i === 3 ? 55.6 : 0 }));
  ops.push({ key: 'gone', uid: 99, defId: 'no_such_chess', damage: 1e6, healing: 0 });
  const board = { finals: {
    boss: { round: 14, owners: [{ playerId: 'p0', total: 1234.6, healing: 55.6, seconds: 81.26, otherDamage: 3.2, otherHealing: 0, operators: ops },
      { playerId: 'p1', total: 0, healing: 0, seconds: 0, otherDamage: 0, otherHealing: 0, operators: [] }] },
  } };
  const gd = { chess: (id) => (id === 'chess_char_4_22_b' ? { chessId: id } : null), standIn: () => null };
  const ps = (playerId) => ({ playerId, gd, diyPickOf: () => null, fieldsStandIn: () => false, skinIdFor: () => 'skin_x' });
  const [e] = bossDamageRows({ clientCombat: false, damageBoard: board }, ps('p0'));
  assert.deepEqual(Object.keys(e), ['kind', 'round', 'seconds', 'total', 'healing', 'otherDamage', 'ops'], 'compact: no zero otherHealing');
  assert.deepEqual([e.kind, e.round, e.seconds, e.total, e.healing, e.otherDamage], ['boss', 14, 81.3, 1235, 56, 3]);
  assert.equal(e.ops.length, BOSS_DAMAGE_OPS, 'capped');
  assert.deepEqual(e.ops.slice(0, 3).map((o) => o.damage), [140, 130, 120], 'by damage, whole numbers');
  assert.ok(!e.ops.some((o) => o.id === 'no_such_chess'), 'a chess the data does not know is left out');
  assert.equal(e.ops[0].skinId, 'skin_x', 'not in the lineup: the op says how it is drawn (the skin it wore)');
  assert.equal('healing' in e.ops[0], false, 'compact: no zero healing');
  assert.equal(e.ops.find((o) => o.healing)?.healing, 56);
  const [inLineup] = bossDamageRows({ clientCombat: false, damageBoard: board }, ps('p0'), new Set(['chess_char_4_22_b']));
  assert.equal(inLineup.ops[0].skinId, undefined, 'in the lineup: the page takes the lineup entry\'s look');
  assert.deepEqual(bossDamageRows({ clientCombat: false, damageBoard: board }, ps('p1')), [], 'no battle time: it fought none');
  assert.deepEqual(bossDamageRows({ clientCombat: true, damageBoard: board }, ps('p0')), [], 'a browser-run match has no trusted meter');
  assert.deepEqual(bossDamageRows({ clientCombat: false, damageBoard: {} }, ps('p0')), []);
});

test('a real Final Assault: every row of the settlement lists its own operators\' boss damage and its battle time', (t) => {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const m = new Match({ roomCode: 'BDMG', matchNo: 9, mode: 'coop', difficulty: 'NORMAL', seed: 731, data: DATA,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p${seat}`, name: `Boss ${seat}`, isBot: false, connected: true })),
    send() { return true; }, broadcast() {}, onEnd() {}, log: quiet, scheduler, clientCombat: false, verify: 'off', combatSpeed: 2,
    timerScale: 0.02, botRehearsal: 0 });
  t.after(() => { m.dispose(); scheduler.dispose(); });
  m.phase = 'PREP'; m.round = m.gd.bossRound; m.stageId = 'act1autochess_m01'; m.stage = m.gd.stage(m.stageId);
  m.hiddenLayerSum = 0;
  for (const ps of m.order) {
    ps.lp = 100; ps.bandId = 'band_bldsk'; ps.invalidateDeployMap(); ps.recompute();
    give(m, ps, 'chess_char_4_22_b', 'board', [9, 8]); give(m, ps, 'chess_char_4_22_b', 'board', [10, 8]);
  }
  m.startFinalAssault(false);
  assert.ok(m.fields.length >= 1 && m.fields.every((f) => f.kind === 'boss' && f.battle));
  const ledger = new Map();   // playerId → the battle's own rows (server/sim/damageBoard.js) at the end
  for (const f of m.fields) {
    const b = f.battle;
    if (!b.started) b.start();
    for (let i = 0; i < 30; i++) b.step();
    const e = b.spawnEnemy('enemy_1007_slime', { routeIndex: 0, pos: [9, 10], mods: { hpMul: 1000, speedMul: 0 } });
    for (const p of b.players) {
      const [a, c] = p.units.filter((u) => u.kind === 'op' && u.ownerId === p.playerId);
      b.dealDamage(a, e, { type: 'true', amount: 3000, calculation: 'resolved' });
      b.dealDamage(c, e, { type: 'true', amount: 1200, calculation: 'resolved' });
    }
    const rows = b.damageRows();
    for (const o of rows.owners) ledger.set(o.playerId, o);
    m._onDamageRows(f, rows, { final: true });
  }
  m._freezeDamage();
  assert.ok(m.damageBoard.finals.boss, 'the frozen boss packet is kept');
  const res = buildResult(m, { victory: true, hiddenReached: false, hiddenCleared: false, reason: 'cleared' });
  for (const p of res.players) {
    assert.equal(p.damage?.length, 1, `${p.playerId}: one scope`);
    const [e] = p.damage;
    assert.equal(e.kind, 'boss');
    assert.equal(e.round, m.gd.bossRound);
    assert.ok(e.seconds > 0, 'its battle time');
    const own = ledger.get(p.playerId);
    assert.deepEqual(e.ops.map((o) => [o.id, o.damage]),
      own.operators.map((o) => [o.defId, Math.round(o.damage)]).sort((x, y) => y[1] - x[1]), 'the ledger\'s operators, by damage');
    assert.ok(e.ops[0].damage >= 3000 && e.ops[1].damage >= 1200, 'each operator its own hits');
    assert.equal(e.total, Math.round(own.total));
    assert.equal('skinId' in e.ops[0] || 'diy' in e.ops[0], false, 'in the lineup: no look of its own');
  }
  assert.ok(JSON.stringify(res).length < 20000, 'a small addition to m.result');
});
