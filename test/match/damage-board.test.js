import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DamageBoard, createDamageBoard } from '../../server/match/damageBoard.js';
import { operatorDamageKey } from '../../server/sim/damageBoard.js';
import { S2C } from '../../shared/protocol.js';

const owners = ['p0', 'p1', 'p2', 'p3'].map((playerId, seat) => ({ playerId, name: `Owner ${seat}`, seat,
  authToken: 'fixture-only-do-not-copy', board: ['private-fixture'], funds: 100 }));
function score(playerId, damage, otherDamage = 0, extra = {}) {
  return { playerId, total: damage + otherDamage, otherDamage, operators: [
    { key: operatorDamageKey(playerId, 11), uid: 11, defId: 'same_def', damage },
  ], ...extra };
}
function put(b, rows, opts = {}) {
  return b.replaceField({ matchId: 'fixtureMatch', round: 1, phase: 'normal', fieldId: 'n:p0', gt: 1,
    owners: rows, ...opts });
}
const sum = (board, playerId = 'p0') => board.packet().owners.find((o) => o.playerId === playerId);

test('normal finals plus live unite replace absolute values, not replies; same-def pieces stay separate', () => {
  const b = createDamageBoard('fixtureMatch');
  b.startCombat(1, 'normal', owners);
  assert.ok(put(b, [score('p0', 100, 7)], { final: true }));
  assert.ok(put(b, [score('p0', 100, 7)], { final: true }));
  assert.equal(sum(b).total, 107);
  assert.ok(put(b, [score('p1', 80)], { fieldId: 'n:p1', final: true }));
  b.startCombat(1, 'unite', owners);
  const update = (damage, extra = {}) => put(b, [score('p0', damage, 3), score('p1', 40)],
    { fieldId: 'u', phase: 'unite', gt: 2, ...extra });
  assert.ok(update(20));
  assert.ok(update(30));
  assert.equal(sum(b).total, 140);
  assert.equal(sum(b).operators[0].damage, 130);
  assert.equal(sum(b).otherDamage, 10);
  assert.equal(sum(b, 'p1').total, 120);
  const row = score('p0', 30, 3);
  row.operators.push({ key: operatorDamageKey('p0', 12), uid: 12, defId: 'same_def', damage: 5 });
  row.total += 5;
  assert.ok(put(b, [row], { phase: 'unite', fieldId: 'u', gt: 3, final: true }));
  assert.deepEqual(sum(b).operators.map((op) => [op.uid, op.damage]), [[11, 130], [12, 5]]);
  assert.equal(sum(b).total, 145);
});

test('healing rides the same ledger (optional on input); seconds add up the battle time of every field an owner fought', () => {
  const b = createDamageBoard('fixtureMatch');
  b.startCombat(1, 'normal', owners);
  const healed = score('p0', 10, 0, { healing: 50, otherHealing: 4 });
  healed.operators[0].healing = 46;
  assert.ok(put(b, [healed], { gt: 30, final: true }));
  assert.ok(put(b, [score('p1', 5)], { fieldId: 'n:p1', gt: 25, final: true }), 'a row without healing heals 0');
  b.startCombat(1, 'unite', owners);
  const unite = score('p0', 1, 0, { healing: 6 });
  unite.operators[0].healing = 6;
  assert.ok(put(b, [unite, score('p1', 2)], { phase: 'unite', fieldId: 'u', gt: 12, final: true }));
  const p0 = sum(b), p1 = sum(b, 'p1');
  assert.deepEqual([p0.healing, p0.otherHealing, p0.operators[0].healing, p0.seconds], [56, 4, 52, 42]);
  assert.deepEqual([p1.healing, p1.otherHealing, p1.operators[0].healing, p1.seconds], [0, 0, 0, 37]);
  for (const bad of [{ healing: -1 }, { healing: NaN }, { otherHealing: Infinity }]) {
    assert.equal(put(b, [score('p0', 1, 0, bad)], { phase: 'unite', fieldId: 'u:bad', gt: 1 }), false);
  }
  const badOp = score('p0', 1); badOp.operators[0].healing = -1;
  assert.equal(put(b, [badOp], { phase: 'unite', fieldId: 'u:bad', gt: 1 }), false);
});

test('stale match/round/phase/gt/seq and post-terminal live updates cannot regress the stream', () => {
  const b = new DamageBoard('fixtureMatch');
  b.startCombat(1, 'normal', owners);
  put(b, [score('p0', 15)], { gt: 3, seq: 7 });
  for (const stale of [{ matchId: 'other' }, { round: 0 }, { phase: 'unite' }, { gt: 2 }, { seq: 6 }]) {
    assert.equal(put(b, [score('p0', 1000)], { gt: 3, seq: 7, ...stale }), false);
  }
  assert.equal(sum(b).total, 15);
  assert.ok(put(b, [score('p0', 25)], { gt: 4, seq: 8, final: true }));
  assert.equal(put(b, [score('p0', 1000)], { gt: 5, seq: 9 }), false);
  b.startCombat(1, 'unite', owners);
  assert.equal(put(b, [score('p0', 1000)], { gt: 20, final: true }), false);
  assert.equal(sum(b).total, 25);
});

test('freeze survives PREP board changes, eliminated owners and unseen teammate reconnects; battle start alone resets', () => {
  const b = new DamageBoard('fixtureMatch');
  b.startCombat(1, 'normal', owners);
  put(b, [score('p0', 75, 5), score('p3', 100)], { final: true });
  const packet = b.freeze();
  assert.equal(packet.status, 'frozen');
  assert.equal(packet.round, 1);
  assert.equal(packet.owners.length, 4, 'all owners retained, including eliminated/missing fields');
  assert.deepEqual(packet.owners.find((o) => o.playerId === 'p2'), {
    playerId: 'p2', name: 'Owner 2', seat: 2, total: 0, healing: 0, seconds: 0, operators: [], otherDamage: 0, otherHealing: 0,
  });
  const reconnect = b.packet();
  assert.equal(reconnect.owners.find((o) => o.playerId === 'p3').total, 100, 'no earlier observation is required');
  reconnect.owners[0].operators[0].damage = 999;
  packet.owners.length = 0;
  assert.equal(sum(b).total, 80, 'packets cannot mutate the frozen server state');
  assert.equal(put(b, [score('p0', 5000)], { gt: 100, final: true }), false);
  // PREP deliberately calls neither startCombat nor clear. Selling/changing live boards cannot affect this copy.
  assert.equal(b.packet().round, 1);
  assert.ok(b.startCombat(2, 'normal', [{ playerId: 'p0', name: 'New name', seat: 0 }, ...owners.slice(1)]));
  assert.equal(b.packet().status, 'live');
  assert.equal(sum(b).total, 0);
  assert.equal(b.previousRound.owners[0].total, 80);
  assert.equal(put(b, [score('p0', 9000)], { final: true }), false, 'late prior-round terminal reply ignored');
  assert.ok(put(b, [score('p0', 4)], { round: 2 }));
  assert.equal(sum(b).total, 4);
});

test('boss and hidden freeze separately, never add a replayed final scope to normal/unite', () => {
  const b = new DamageBoard('fixtureMatch');
  b.startCombat(14, 'boss', owners);
  put(b, [score('p0', 200), score('p1', 300)], { round: 14, phase: 'boss', fieldId: 'b1', final: true });
  put(b, [score('p2', 400), score('p3', 500)], { round: 14, phase: 'boss', fieldId: 'b2', final: true });
  assert.equal(b.freeze().owners.reduce((n, o) => n + o.total, 0), 1400);
  assert.equal(b.startCombat(14, 'boss', owners), false, 'duplicate start must not unfreeze a completed scope');
  assert.ok(b.startCombat(14, 'hidden', owners));
  assert.equal(sum(b).total, 0);
  assert.equal(b.previousRound.owners.reduce((n, o) => n + o.total, 0), 1400);
  assert.equal(put(b, [score('p0', 9999)], { round: 14, phase: 'boss', fieldId: 'b1', final: true }), false);
  assert.ok(put(b, [score('p0', 13)], { round: 14, phase: 'hidden', fieldId: 'h1', final: true }));
  assert.equal(b.freeze().owners[0].total, 13);
});

test('capture whitelists public score metadata only and keeps authoritative total separate from op sums', () => {
  const b = new DamageBoard('fixtureMatch');
  b.startCombat(1, 'normal', owners);
  const input = score('p0', 10, 3, { total: 20, client: { secret: 'fixture' }, authToken: 'fixture', funds: 9 });
  input.operators[0].loadout = 'private';
  assert.ok(put(b, [input]));
  input.total = 1000;
  input.operators[0].damage = 1000;
  const packet = b.packet();
  assert.equal(sum(b).total, 20, 'do not pretend sum(operator) equals all player damage');
  assert.equal(sum(b).otherDamage, 3);
  assert.deepEqual(Object.keys(packet.owners[0]), ['playerId', 'name', 'seat', 'total', 'healing', 'seconds', 'operators', 'otherDamage', 'otherHealing']);
  assert.deepEqual(Object.keys(packet.owners[0].operators[0]), ['key', 'uid', 'defId', 'damage', 'healing']);
  assert.equal(JSON.stringify(packet).includes('secret'), false);
  assert.equal(JSON.stringify(packet).includes('authToken'), false);
});

test('malformed/nonfinite/unknown-owner rows are rejected atomically and additive protocol remains compatible', () => {
  const b = new DamageBoard('fixtureMatch');
  assert.equal(b.packet(), null);
  assert.equal(b.freeze(), null);
  assert.throws(() => b.startCombat(0, 'normal'), /round/);
  b.startCombat(1, 'normal', owners);
  put(b, [score('p0', 10)]);
  for (const bad of [score('unknown', 1), score('p0', NaN), score('p0', Infinity), score('p0', -1),
    score('p0', 10, -1), { ...score('p0', 1), operators: [{ key: 'x', damage: -1 }] }]) {
    assert.equal(put(b, [bad]), false);
  }
  assert.equal(put(b, [score('p0', 12), score('p0', 15)]), false);
  assert.equal(sum(b).total, 10);
  assert.ok(S2C.includes('m.damage') && S2C.includes('b.damage'));
});

test('bossRounds archives the Final Assault and Hidden Core scopes for the settlement record (项目 4)', () => {
  const b = new DamageBoard('fixtureMatch');
  assert.equal(b.bossRounds(), null, 'nothing fought yet');
  b.startCombat(1, 'normal', owners);
  put(b, [score('p0', 11)]);
  b.freeze();
  assert.equal(b.bossRounds(), null, 'a normal round is not part of the boss ledger');
  b.startCombat(14, 'boss', owners);
  put(b, [score('p0', 200), score('p1', 300)], { round: 14, phase: 'boss', fieldId: 'b1', final: true });
  b.freeze();
  const afterBoss = b.bossRounds();
  assert.equal(afterBoss.boss.round, 14);
  assert.equal(afterBoss.boss.phase, 'boss');
  assert.equal(afterBoss.boss.owners.reduce((n, o) => n + o.total, 0), 500);
  assert.equal(afterBoss.hidden, null);
  // the hidden round adds its own scope without disturbing the boss one
  b.startCombat(15, 'hidden', owners);
  put(b, [score('p0', 7)], { round: 15, phase: 'hidden', fieldId: 'h1', final: true });
  b.freeze();
  const both = b.bossRounds();
  assert.equal(both.hidden.round, 15);
  assert.equal(both.hidden.owners.find((o) => o.playerId === 'p0').total, 7);
  assert.equal(both.boss.owners.reduce((n, o) => n + o.total, 0), 500);
  // per-operator rows ride along, and the archive is a snapshot: a later round's reset leaves it alone
  const op = both.boss.owners.find((o) => o.playerId === 'p0').operators[0];
  assert.equal(op.key, operatorDamageKey('p0', op.uid));
  b.startCombat(16, 'normal', owners);
  assert.equal(b.bossRounds().boss.round, 14);
  assert.equal(b.bossRounds().hidden.round, 15);
});
