import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { damageNumber, damageRows, acceptDamageSnapshot } from '../../public/js/ui/damageBoard.js';
import { emptyMatch } from '../../public/js/store.js';

const packet = (round = 2, status = 'live') => ({ matchId: 'game', round, status, owners: [
  { playerId: 'p1', operators: [{ key: 'op1', uid: 1, defId: 'a', damage: 100 }, { key: 'op2', uid: 2, defId: 'a', damage: 250 }], otherDamage: 50 },
  { playerId: 'p2', operators: [{ key: 'op3', uid: 3, defId: 'b', damage: 10 }], otherDamage: 0 },
] });

test('ranked output follows selected owner and keeps two same operators separate', () => {
  const p = packet(), before = structuredClone(p);
  assert.deepEqual(damageRows(p, 'p1').rows.map(r => [r.key, r.damage]), [['op2', 250], ['op1', 100], ['other', 50]]);
  assert.equal(damageRows(p, 'p1').total, 400);
  assert.deepEqual(damageRows(p, 'p2').rows.map(r => r.key), ['op3']);
  assert.equal(damageRows(p, 'p2').total, 10);
  assert.equal(damageRows(p, 'unknown').available, false);
  assert.deepEqual(p, before, 'selector cannot mutate stored/frozen values');
});

test('current match/round cannot be overwritten by stale data or a late live snapshot after freeze', () => {
  const live = packet(), frozen = packet(2, 'frozen');
  assert.strictEqual(acceptDamageSnapshot(null, live, 'game'), live);
  assert.strictEqual(acceptDamageSnapshot(live, frozen, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, packet(1), 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, live, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, { ...live, matchId: 'old' }, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, { ...live, round: NaN }, 'game'), frozen);
  const next = packet(3); assert.strictEqual(acceptDamageSnapshot(frozen, next, 'game'), next);
  assert.strictEqual(acceptDamageSnapshot(null, live, null), null);
});

test('unavailable client/hidden-group data is not mislabeled zero damage and numbers stay bounded', () => {
  assert.equal(damageRows({ ...packet(), available: false }, 'p1').available, false);
  for (const n of [undefined, NaN, Infinity, -1]) assert.equal(damageNumber(n), '0');
  assert.equal(damageNumber(999), '999'); assert.equal(damageNumber(12345), '1.23万'); assert.equal(damageNumber(1e8), '1.00亿');
  assert.equal(emptyMatch().damage, null);
});

test('scoreboard defaults collapsed and shares the actual current-view owner with the bond strip', () => {
  const component = readFileSync(new URL('../../public/js/ui/damageBoard.js', import.meta.url), 'utf8');
  assert.match(component, /useState\(false\)/);
  assert.match(component, /snapshot\.status === 'frozen'/);
  const game = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(game, /<\$\{DamageBoard\} snapshot=\$\{damage\} ownerId=\$\{strip\.ownerId\}/);
  assert.match(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8'), /\/css\/screens\/damage-board\.css/);
});
