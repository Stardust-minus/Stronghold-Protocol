import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotStats, snapshotUnitStats, notePieceUnits } from '../../public/js/screens/game/early.js';
import { liveStat } from '../../public/js/ui/detailPanel.js';

const field = { fieldId: 'n:p0', units: [
  { id: 1, uid: 7, ownerId: 'p1' },
  { id: 2, uid: 7, ownerId: 'p0' },
  { id: 3, ownerId: 'p1' },
] };
const entry = (id, atk = 720) => ({ id, uid: 7, atk, maxHp: 1200, def: 250, res: 20, interval: 0.8,
  base: { atk: 600, maxHp: 1000, def: 200, res: 10, interval: 1 }, range: [[0, 0], [0, 1]], dir: 'RIGHT' });
const frame = (entries, fieldId = field.fieldId) => ({ fieldId,
  units: entries.map(e => [e.id, 3, 10, 800, 1200, 0, 10, 0, 0]), unitStats: entries });

test('server battle cards show effective values, green bonuses and their own base', () => {
  const live = snapshotUnitStats(snapshotStats(frame([entry(2)])), field, { id: 2 });
  assert.equal(live.src, 'battle');
  assert.deepEqual(liveStat(live, 'atk', 600), { v: '720', tone: 'up', sub: '+120', title: '基础 600' });
  assert.equal(liveStat(live, 'maxHp', 1000).sub, '+200');
  assert.equal(liveStat(live, 'def', 200).sub, '+50');
  assert.equal(liveStat(live, 'res', 10).sub, '+10');
  assert.equal(liveStat(live, 'interval', 1).tone, 'up');
  assert.equal(liveStat(live, 'interval', 1).sub, '−0.20');
  assert.deepEqual(live.range, [[0, 0], [0, 1]]);
  assert.equal(live.dir, 'RIGHT');
});

test('an own prep card left open resolves by piece uid AND owner, not the first matching teammate uid', () => {
  const stats = snapshotStats(frame([entry(1, 900), entry(2, 720)]));
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 7, ownerId: 'p0' }).atk, 720);
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 7, ownerId: 'p1' }).atk, 900);
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 7 }), null);
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 7, ownerId: 'outsider' }), null);
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 999, ownerId: 'p0' }), null);
});

test('direct ids cover a teammate, enemy or summon without an own piece uid', () => {
  const stats = snapshotStats(frame([entry(3, 400)]));
  assert.equal(snapshotUnitStats(stats, field, { id: 3 }).atk, 400);
  assert.equal(snapshotUnitStats(stats, field, { id: 99 }), null);
});

test('a live getter follows successive buffs, debuffs and removal, never prep or a stale map', () => {
  let stats = snapshotStats(frame([entry(2)]));
  const getter = () => snapshotUnitStats(stats, field, { id: 2 });
  stats = snapshotStats(frame([entry(2, 900)]));
  assert.equal(liveStat(getter(), 'atk', 600).sub, '+300');
  stats = snapshotStats(frame([entry(2, 450)]));
  assert.equal(liveStat(getter(), 'atk', 600).tone, 'down');
  assert.equal(liveStat(getter(), 'atk', 600).sub, '−150');
  stats = snapshotStats(frame([entry(2, 600)]));
  assert.equal(liveStat(getter(), 'atk', 600).tone, null);
  stats = snapshotStats(frame([]));
  assert.equal(getter(), null);
});

test('field-local ids cannot reuse the previous field stats and scouted prep boards are not live battles', () => {
  const stats = snapshotStats(frame([entry(2)]));
  assert.equal(snapshotUnitStats(stats, { ...field, fieldId: 'n:p1' }, { id: 2 }), null);
  assert.equal(snapshotUnitStats(stats, { ...field, prep: true }, { id: 2 }), null);
  assert.equal(snapshotUnitStats(stats, null, { id: 2 }), null);
  assert.equal(snapshotUnitStats(snapshotStats(null), field, { id: 2 }), null);
});

test('legacy and missing server payloads replace the cache instead of leaving old bonuses on screen', () => {
  for (const snap of [null, {}, { fieldId: field.fieldId }, { ...frame([entry(2)]), unitStats: undefined },
    { ...frame([entry(2)]), unitStats: null }, { ...frame([entry(2)]), unitStats: {} }]) {
    assert.equal(snapshotStats(snap).units.size, 0);
    assert.equal(snapshotUnitStats(snapshotStats(snap), field, { id: 2 }), null);
  }
});

test('unlisted or malformed entries cannot expose hidden or removed units, and payloads are not mutated', () => {
  const snap = frame([entry(2)]);
  snap.unitStats.push(entry(100), null, { id: '2', atk: 10000 });
  const before = JSON.stringify(snap);
  const stats = snapshotStats(snap);
  assert.equal(stats.units.size, 1);
  assert.equal(snapshotUnitStats(stats, field, { id: 100 }), null);
  const live = snapshotUnitStats(stats, field, { id: 2 });
  assert.notEqual(live, snap.unitStats[0]);
  assert.equal(Object.hasOwn(snap.unitStats[0], 'src'), false);
  assert.equal(JSON.stringify(snap), before);
});

test('early buffered frames and reconnects contain a full stats replacement', () => {
  const buffered = new Map([[field.fieldId, frame([entry(2, 780)])]]);
  const stats = snapshotStats(buffered.get(field.fieldId));
  assert.equal(snapshotUnitStats(stats, field, { pieceUid: 7, ownerId: 'p0' }).atk, 780);
  assert.equal(snapshotUnitStats(snapshotStats(frame([entry(2, 650)])), field, { id: 2 }).atk, 650);
});

test('empty initial field metadata gains piece identities from spawn events, including buffered starts', () => {
  const empty = { ...field, units: [] };
  const events = field.units.map(u => ['spawn', u]);
  events.push(['die', 2], ['spawn', { id: 100, kind: 'enemy' }], null);
  const units = notePieceUnits(new Map(), { infos: [], events });
  assert.equal(units.size, 2, 'only owner-bound piece uids are retained; non-piece units need no mapping');
  const stats = snapshotStats(frame([entry(1, 900), entry(2, 720)]));
  assert.equal(snapshotUnitStats(stats, empty, { pieceUid: 7, ownerId: 'p0', units }).atk, 720);
  assert.equal(snapshotUnitStats(stats, empty, { pieceUid: 7, ownerId: 'p1', units }).atk, 900);
  assert.equal(snapshotUnitStats(stats, empty, { pieceUid: 7, ownerId: 'p0', units: new Map() }), null);
  notePieceUnits(units, { events: [['spawn', { id: 4, uid: 7, ownerId: 'p0' }]] });
  assert.equal(snapshotUnitStats(snapshotStats(frame([entry(4, 760)])), empty, { pieceUid: 7, ownerId: 'p0', units }).atk, 760,
    'removed ids cannot shadow the currently listed incarnation');
});

test('game wiring resets stats at field/relay/prep boundaries, replays early data and preserves client live getters', () => {
  const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(src, /snapStatsRef\.current = snapshotStats\(earlySnap\)/);
  assert.match(src, /snapStatsRef\.current = snapshotStats\(snap\)/);
  assert.ok((src.match(/snapStatsRef\.current = snapshotStats\(null\)/g) || []).length >= 4);
  assert.match(src, /enteredFieldRef\.current === field && lastFieldRef\.current === field\.fieldId/);
  assert.match(src, /snapshotUnitStats\(snapStatsRef\.current, field, \{ id, pieceUid, ownerId: myId, units: pieceUnitsRef\.current \}\)/);
  assert.match(src, /notePieceUnits\(new Map\(\), \{ infos: field\.units, events: early \}\)/);
  assert.match(src, /notePieceUnits\(pieceUnitsRef\.current, \{ events: msg\.ev \}\)/);
  assert.match(src, /battleRunner\.unitIdOf\(pieceUid, myId, fid\)/);
  assert.match(src, /battleRunner\.unitStats\(uid, fid\)/);
});
