// The local record of a settlement keyed by the match's opaque id (docs/history/0.4.0.md §37.277): m.result carries
// `matchId` (an HMAC of the server's private match secret) instead of the seed. A new record's id comes from it and the
// record keeps it; a record of a settlement that carried the seed (the previous release) keeps its id, loads and dedupes
// as before — additive, no format version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATS_VERSION, buildRecord, recordId, appendRecord, emptyStats, normalizeRecord, importStats, mergeStats,
  recordToResult, recordResult, loadStats } from '../../public/js/ui/stats.js';

const players = [{ playerId: 'p1', seat: 0, name: 'A', isBot: false, left: false, alive: true, victory: true, roundsPassed: 14,
  lp: 20, bandId: 'band_amiya', title: null, trophies: 1, reward: 1, lineup: [], bonds: [], stats: { kills: 3 } }];
const frame = { t: 'm.result', victory: true, roundsPassed: 14, hiddenReached: false, hiddenCleared: false, reason: 'victory',
  teamLp: 20, modeId: 'mode_single_hard', difficulty: 'HARD', stageId: 's', bossId: 'b', hiddenBossId: 'h', durationMs: 600000, players };
const NEW = { ...frame, matchId: 'k2x9q0w1ab-3' };
const OLD = { ...frame, seed: 123456789 };

/** Run `fn` with a Map-backed localStorage. */
function withStorage(fn) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  try { return fn(); } finally { delete globalThis.localStorage; }
}

test('a settlement with matchId: the record id is the match id\'s, the record keeps it, no seed', () => {
  const rec = buildRecord(NEW, { myId: 'p1', roomMode: 'solo', now: 5 });
  assert.equal(rec.matchId, 'k2x9q0w1ab-3');
  assert.equal(rec.seed, null);
  assert.equal(rec.id, recordId(NEW, 'p1'));
  assert.notEqual(rec.id, recordId({ ...NEW, matchId: 'k2x9q0w1ab-4' }, 'p1'), 'another match, another id');
  assert.notEqual(rec.id, recordId(NEW, 'p2'), 'another player, another id');
  assert.equal(recordToResult(rec).matchId, 'k2x9q0w1ab-3', 'a re-viewed settlement names it too');
  // a malformed id is not kept (the id falls back like a settlement without one)
  const bad = buildRecord({ ...NEW, matchId: 'a b' }, { myId: 'p1', now: 5 });
  assert.equal(Object.hasOwn(bad, 'matchId'), false);
  assert.equal(normalizeRecord({ ...rec, matchId: { x: 1 } }).matchId, undefined);
});

test('a record of a settlement with the seed (the previous release): its id is unchanged, it gains no key, it dedupes', () => {
  const old = buildRecord(OLD, { myId: 'p1', roomMode: 'solo', now: 1 });
  // the id the previous release gave it: fnv1a over the seed and the frame, unchanged
  assert.equal(old.id, recordId(OLD, 'p1'));
  assert.equal(Object.hasOwn(old, 'matchId'), false);
  assert.equal(old.seed, 123456789);
  const stored = JSON.parse(JSON.stringify(old));
  assert.deepEqual(normalizeRecord(stored), old, 'loads as it was stored');
  // the new and the old record live side by side; each one appended again (a replayed m.result) is refused
  let stats = appendRecord(emptyStats(), old).stats;
  stats = appendRecord(stats, buildRecord(NEW, { myId: 'p1', now: 5 })).stats;
  assert.equal(stats.records.length, 2);
  assert.equal(appendRecord(stats, buildRecord(OLD, { myId: 'p1', now: 9 })).added, false);
  assert.equal(appendRecord(stats, buildRecord(NEW, { myId: 'p1', now: 9 })).added, false);
  // an import of either (an old export file, this device's own) adds nothing
  const file = { kind: 'local-stats', v: STATS_VERSION, records: [stored] };
  assert.equal(importStats(file, stats).added, 0);
  assert.equal(importStats({ kind: 'local-stats', ...stats }, stats).added, 0);
  assert.equal(mergeStats(stats, file).records.length, 2);
  // an id-less hand-made record keeps the content id it had (no matchId key enters it)
  const { id, ...bare } = stored;
  void id;
  assert.equal(normalizeRecord(bare).id, normalizeRecord({ ...bare }).id);
  assert.equal(Object.hasOwn(normalizeRecord(bare), 'matchId'), false);
});

test('recording on every m.result arrival: the replay of a matchId settlement is the same record', () => {
  withStorage(() => {
    assert.ok(recordResult(NEW, { myId: 'p1', now: 1 }));
    assert.equal(recordResult(NEW, { myId: 'p1', now: 2 }), null, 'replayed: not stored twice');
    assert.equal(loadStats().records.length, 1);
    assert.equal(loadStats().records[0].matchId, 'k2x9q0w1ab-3');
  });
});
