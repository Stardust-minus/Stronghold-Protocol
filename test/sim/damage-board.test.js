import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { operatorDamageKey } from '../../server/sim/damageBoard.js';

const defs = { chess: { score_op: chessRec({ id: 'score_op', skill: null, stats: { atk: 0 }, rangeGrid: [] }) },
  enemies: { score_dummy: enemyRec({ key: 'score_dummy', hp: 100000, atk: 0, speed: 0 }) } };
function arena(opts = {}) {
  const h = makeBattle({ defs, content: 'none', autoFinish: false, devices: false,
    units: [{ uid: 11, chessId: 'score_op', row: 9, col: 3 }, { uid: 12, chessId: 'score_op', row: 10, col: 3 }],
    flags: { dpInit: 99, dpMax: 99 }, ...opts });
  h.b.start();
  return h;
}
const row = (b, id = 'p1') => b.damageRows().owners.find((r) => r.playerId === id);
const hit = (b, source, target, amount) => b.dealDamage(source, target, { type: 'true', amount });
const tokenDef = { tokenId: 'score_token', name: 'fixture summon', stats: { maxHp: 100, atk: 0, cost: 0, blockCnt: 0 }, rangeGrid: [] };

test('actual HP loss only: shields, overkill, dodges, cancellation and friendly HP loss do not inflate rows', () => {
  const h = arena();
  const b = h.b, u = h.unit(11), ally = h.unit(12), e = h.spawn('score_dummy', { pos: [11, 8] });
  b.addBuff(e, { key: 'shield', shield: 50 });
  assert.equal(hit(b, u, e, 80), 30);
  e.hp = 5;
  assert.equal(hit(b, u, e, 5000), 5);
  assert.equal(hit(b, u, ally, 50), 50, 'friendly damage removes HP but is not dealt damage');
  const e2 = h.spawn('score_dummy', { pos: [12, 8] });
  b.addBuff(e2, { key: 'dodge', mods: { dodgePhys: 1 } });
  assert.equal(b.dealDamage(u, e2, { type: 'phys', amount: 500 }), 0);
  const cancel = b.on('hit', (c) => { c.dmg.cancel = true; });
  assert.equal(hit(b, u, e2, 100), 0);
  b.off(cancel);
  const r = row(b);
  assert.equal(r.total, 35);
  assert.equal(r.operators.find((op) => op.uid === 11).damage, 35);
  assert.equal(r.otherDamage, 0);
  assert.equal(b.result().perPlayer.p1.damageDealt, 35);
  assert.ok(h.eventsOf('dmg').some((ev) => ev[2] === 5000), 'overkill event amount is deliberately not the score');
});

test('same definition remains two UID rows; nested expired summons and dead-source DOT credit their root once', () => {
  const h = arena();
  const b = h.b, u = h.unit(11), v = h.unit(12), e = h.spawn('score_dummy', { pos: [12, 8] });
  const before = b.damageRows();
  assert.deepEqual(before.owners[0].operators.map((op) => op.uid), [11, 12]);
  hit(b, u, e, 20);
  hit(b, v, e, 30);
  const t = b.spawnToken(u, 'score_token', 11, 4, { def: tokenDef });
  const nested = b.spawnToken(t, 'score_token', 12, 4, { def: tokenDef });
  assert.ok(t && nested);
  hit(b, t, e, 40);
  hit(b, nested, e, 10);
  b.retreat(t, { reason: 'expired', permanent: true });
  b.retreat(u);
  // Scheduled damage outlives its source; existing source.stats.dmg remains authoritative.
  b.after(0.01, () => hit(b, t, e, 15));
  b.after(0.01, () => hit(b, u, e, 5));
  h.step(2);
  assert.equal(b.redeploy(u), true);
  hit(b, u, e, 7);
  // A form/redeployment may change the live definition, never the original display metadata.
  u.defId = 'transformed_live_definition';
  b.units.push(u); // a historical duplicate reference must not double count the same stats
  const r = row(b);
  assert.deepEqual(r.operators, [
    { key: operatorDamageKey('p1', 11), uid: 11, defId: 'score_op', damage: 97 },
    { key: operatorDamageKey('p1', 12), uid: 12, defId: 'score_op', damage: 30 },
  ]);
  assert.equal(r.total, 127);
  assert.equal(r.otherDamage, 0);
  assert.equal(before.owners[0].total, 0, 'old public rows are detached');
});

test('element gauges do not count; actual HP burst/DOT still count after the filler dies', () => {
  const h = arena();
  const b = h.b, u = h.unit(11), e = h.spawn('score_dummy', { pos: [12, 8] });
  b.dealDamage(u, e, { type: 'element', element: 'burn', amount: 999 });
  assert.equal(row(b).total, 0);
  assert.equal(u.stats.dmg, 0);
  b.dealDamage(u, e, { type: 'element', element: 'burn', amount: 1 });
  assert.equal(row(b).total, 7000);
  assert.equal(row(b).operators[0].damage, 7000);
  const dotTarget = h.spawn('score_dummy', { pos: [11, 8] });
  b.dealDamage(u, dotTarget, { type: 'element', element: 'neural', amount: 1000 });
  b.retreat(u);
  h.run(1.1);
  assert.ok(u.stats.dmg > 7000, 'neural continuous HP damage is credited to the dead filler');
  assert.equal(row(b).total, u.stats.dmg);
  assert.equal(row(b).operators[0].damage, u.stats.dmg);
  assert.ok(u.stats.elem > 0, 'element damage has its separate counter, not the scoreboard');
});

test('owner-only devices/orphan tokens/cyclic references are other damage, never guessed operators', () => {
  const h = arena();
  const b = h.b, e = h.spawn('score_dummy', { pos: [12, 8] });
  const device = b.spawnDevice('fixture_turret', 11, 6);
  device.ownerId = 'p1'; // mirrors content/devices.js; devices are not in ps.units
  const orphan = b.spawnToken('p1', 'score_token', 12, 4, { def: tokenDef });
  const cyclic = b.spawnToken('p1', 'score_token', 11, 4, { def: tokenDef });
  cyclic.ownerUnit = cyclic;
  hit(b, device, e, 19);
  hit(b, orphan, e, 23);
  hit(b, cyclic, e, 29);
  const r = row(b);
  assert.equal(r.total, 71);
  assert.equal(r.otherDamage, 71);
  assert.equal(r.operators.reduce((n, op) => n + op.damage, 0), 0);
});

test('UID-less operators have stable distinct keys and invalid counters cannot leak nonfinite data', () => {
  const h = arena({ players: [{ playerId: 'p1', units: [
    { uid: null, chessId: 'score_op', row: 9, col: 3 }, { uid: null, chessId: 'score_op', row: 10, col: 3 },
  ] }] });
  const [a, b] = h.b.players[0].units;
  a.stats.dmg = NaN;
  b.stats.dmg = Infinity;
  const one = row(h.b), two = row(h.b);
  assert.equal(new Set(one.operators.map((op) => op.key)).size, 2);
  assert.deepEqual(one, two);
  assert.ok(one.operators.every((op) => op.uid === null && op.damage === 0));
});

test('two boss fields count only shared pool HP actually removed, not both attempted hits', () => {
  const pool = new SharedBossPool(100);
  const a = arena({ kind: 'boss', sharedBoss: pool });
  const b = arena({ kind: 'boss', sharedBoss: pool, players: [{ playerId: 'p2', side: 'R', units: [
    { uid: 11, chessId: 'score_op', row: 9, col: 3 },
  ] }] });
  const ea = a.spawn('score_dummy', { pos: [5, 10] });
  const eb = b.spawn('score_dummy', { pos: [5, 10] });
  ea.bossPool = pool;
  eb.bossPool = pool;
  assert.equal(hit(a.b, a.unit(11), ea, 80), 80);
  assert.equal(hit(b.b, b.unit(11), eb, 80), 20);
  assert.equal(row(a.b).total + row(b.b, 'p2').total, 100);
  assert.equal(row(b.b, 'p2').operators[0].damage, 20);
});

test('fieldMeta sides come from actual halves even when the first unite helper is right', () => {
  const h = arena({ kind: 'unite', players: [
    { playerId: 'rightFirst', colOffset: 8, units: [] }, { playerId: 'leftSecond', colOffset: 0, units: [] },
  ] });
  const meta = h.b.fieldMeta();
  assert.deepEqual(meta.players, ['rightFirst', 'leftSecond']);
  assert.deepEqual(meta.sides, { rightFirst: 'R', leftSecond: 'L' });
  assert.equal(Object.hasOwn(h.b.result(), 'damageRows'), false, 'trial/default result shape unchanged');
});
