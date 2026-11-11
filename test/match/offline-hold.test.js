// The offline hold (the owner's rule of 2026-11-11, server/match/match/offlineHold.js): a match whose human seats are
// all offline stands still until one comes back, and ends 'abandoned' when nobody has come back within offlineHoldMs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { OFFLINE_HOLD_MINUTES, OFFLINE_HOLD_GRACE_MS, parseOfflineHoldMinutes } from '../../server/match/match/common.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { canSnapshot, snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';

const MIN = 60_000;

test('SP_OFFLINE_HOLD_MINUTES: unset = 10, 0 = off, an integer up to 1440, anything else refused', () => {
  assert.equal(OFFLINE_HOLD_MINUTES, 10);
  for (const unset of [undefined, null, '']) assert.equal(parseOfflineHoldMinutes(unset), 10);
  assert.equal(parseOfflineHoldMinutes('0'), 0);
  assert.equal(parseOfflineHoldMinutes(' 30 '), 30);
  assert.equal(parseOfflineHoldMinutes('1440'), 1440);
  for (const bad of ['1441', '-1', '1.5', '10m', 'ten', '0x10']) assert.throws(() => parseOfflineHoldMinutes(bad), RangeError, bad);
});

test('co-op: one player offline plays on; all offline holds PREP (no deadline, no AI takeover round); the first back resumes with the time that was left', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 71, fake: true, script: () => ({ duration: 4 }) }).start();
  const m = h.m;
  assert.equal(m.offlineHoldMs, 10 * MIN, 'co-op default: the plain reconnect window');
  h.toPrep(1);
  m.onDisconnect('p_1');
  assert.equal(m._offline, false, 'a teammate online: no hold');
  assert.equal(m.publicView().paused, false);
  h.sched.advance(1000);
  const left = m.deadline - h.sched.now();
  assert.ok(left > 5000, `a timed prep (${left} ms left)`);
  const heldAt = h.sched.now();
  m.onDisconnect('p_0');
  assert.equal(m._offline, true, 'every human offline: held');
  const pub = m.publicView();
  assert.equal(pub.paused, true);
  assert.equal(pub.offlineHold, true);
  h.sched.advance(9 * MIN);
  assert.equal(m.phase, PHASE.PREP, 'nothing advanced while held');
  assert.equal(m.round, 1);
  assert.equal(h.ps('p_1').offlineRounds, 0, 'no prep ended: no offline round counted');
  assert.equal(h.ps('p_1').autoplay, false);
  assert.equal(h.ended, null);
  m.onReconnect('p_0');
  assert.equal(m._offline, false, 'released by the first player back');
  assert.equal(m.publicView().paused, false);
  assert.equal(m.publicView().offlineHold, undefined);
  assert.equal(m.deadline - h.sched.now(), left, 'the deadline moved on by the hold');
  assert.ok(m.offlineHeldMs >= 9 * MIN);
  // the prep runs out on its own clock again: p_0 never readies here, the deadline (+ grace) ends it
  h.run(() => m.phase !== PHASE.PREP);
  assert.notEqual(m.phase, PHASE.PREP);
  assert.ok(h.sched.now() >= heldAt + 9 * MIN + left, 'ended at the shifted deadline, not the old one');
  h.invariants();
  m.dispose();
});

test('co-op: nobody back within offlineHoldMs (+ the grace the platform\'s session expiry goes first in) ends the match abandoned, once', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 72, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  m.onDisconnect('p_0');
  m.onDisconnect('p_1');
  assert.equal(m._offline, true);
  assert.equal(OFFLINE_HOLD_GRACE_MS, MIN, 'a tenth of the 10 min hold, at most 1 min');
  h.sched.advance(10 * MIN + OFFLINE_HOLD_GRACE_MS - 1);
  assert.equal(h.ended, null, 'still waiting one ms before the hold runs out');
  h.sched.advance(2);
  assert.ok(h.ended, 'cleared');
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(h.endedCount, 1);
  assert.equal(m.ended, true);
  assert.equal(m.offlineCleared, true);
  assert.equal(m.paused, false, 'the result is not shown as paused');
  assert.equal(m._timers.size, 0, 'every timer went with it');
  // a player who still comes back gets the result (Match._resync), nothing restarts
  m.onReconnect('p_0');
  assert.equal(h.lastTo('p_0', 'm.result')?.reason, 'abandoned');
  h.sched.advance(30 * MIN);
  assert.equal(h.endedCount, 1);
  m.dispose();
});

test('the hold covers every phase: a strategy draft turn and a battle stand still and go on where they were', () => {
  // the strategy draft: the turn countdown (m.public.draft.turnDeadline) moves with the hold
  const d = makeMatch({ mode: 'coop', humans: 2, seed: 73, fake: true }).start();
  for (const ps of d.m.players.values()) if (!ps.isBot) d.m.handle(ps.playerId, { t: 'g.infoReady' });
  d.run(() => d.m.phase === PHASE.BAND_DRAFT);
  const turnLeft = d.m.draft.turnDeadline - d.sched.now();
  assert.ok(turnLeft > 0);
  d.m.onDisconnect('p_0'); d.m.onDisconnect('p_1');
  d.sched.advance(5 * MIN);
  assert.equal(d.m.phase, PHASE.BAND_DRAFT);
  d.m.onReconnect('p_1');
  assert.equal(d.m.draft.turnDeadline - d.sched.now(), turnLeft);
  assert.equal(d.m.deadline, d.m.draft.turnDeadline, 'one countdown everywhere');
  d.m.dispose();
  // a paced battle (instant: false): the server-run field clock stands still while held
  const b = makeMatch({ mode: 'coop', humans: 2, seed: 74, fake: true, instant: false, script: () => ({ duration: 20 }) }).start();
  b.toPrep(1);
  b.run(() => b.m.phase === PHASE.COMBAT);
  b.sched.advance(2000);
  const f = b.m.fields[0];
  const t0 = f.battle.time;
  b.m.onDisconnect('p_0'); b.m.onDisconnect('p_1');
  b.sched.advance(5 * MIN);
  assert.equal(b.m.phase, PHASE.COMBAT, 'the battle waits');
  assert.equal(f.battle.time, t0, 'its clock did not move');
  b.m.onReconnect('p_0');
  b.sched.advance(2000);
  assert.ok(f.battle.time > t0, 'it runs again');
  b.run(() => b.m.phase !== PHASE.COMBAT);
  assert.notEqual(b.m.phase, PHASE.COMBAT);
  b.invariants();
  b.m.dispose();
});

test('spectator seats do not keep a match running; departed seats are not waited for; offlineHoldMs 0 turns the hold off', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, spectators: ['watcher'], seed: 75, fake: true }).start();
  h.toPrep(1);
  h.m.onLeave('p_1');
  assert.equal(h.m._offline, false);
  h.m.onDisconnect('p_0');
  assert.equal(h.m._offline, true, 'the one player left is offline: held although a spectator watches');
  h.m.dispose();
  assert.equal(h.m._offline, false, 'dispose drops the hold');
  const off = makeMatch({ mode: 'coop', humans: 2, seed: 75, fake: true, offlineHoldMs: 0 }).start();
  off.toPrep(1);
  off.m.onDisconnect('p_0'); off.m.onDisconnect('p_1');
  assert.equal(off.m._offline, false);
  off.run(() => off.m.phase !== PHASE.PREP);
  assert.notEqual(off.m.phase, PHASE.PREP, 'without the hold the prep deadline runs as before');
  off.m.dispose();
});

test('solo: the run holds while its player is away, for the solo window (24 h), even in a battle the player had paused', () => {
  const h = makeMatch({ mode: 'solo', seed: 76, fake: true, instant: false, script: () => ({ duration: 20 }) }).start();
  const m = h.m;
  assert.equal(m.offlineHoldMs, 86_400_000, 'data singleReconnectTime');
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT), 'a solo prep waits for its Ready');
  h.sched.advance(1000);
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: true }), { ok: true });
  m.onDisconnect('p_0');
  assert.equal(m._offline, true);
  assert.equal(m.paused, true);
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: false }), { ok: true }, 'accepted');
  assert.equal(m.paused, true, 'but only a player coming back releases the hold');
  const t0 = m.fields[0].battle.time;
  h.sched.advance(23 * 60 * MIN);
  assert.equal(m.fields[0].battle.time, t0);
  assert.equal(h.ended, null);
  m.onReconnect('p_0');
  assert.equal(m.paused, false, 'back: the battle runs (the player can pause it again)');
  h.sched.advance(2000);
  assert.ok(m.fields[0].battle.time > t0);
  m.dispose();
});

test('a restored match nobody comes back to holds at once and is cleared after the hold', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 77, fake: true }).start();
  assert.ok(h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 2 && canSnapshot(h.m), { ready: false }));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  h.m.dispose();
  const r = makeMatch({ mode: 'coop', seats: doc.seats, seed: doc.seed, fake: true });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState }), true);
  assert.equal(r.m._offline, true, 'every human seat is offline after a restore');
  r.sched.advance(9 * MIN);
  assert.equal(r.m.phase, PHASE.PREP);
  assert.equal(r.m.round, 2);
  r.m.onReconnect('p_0');
  assert.equal(r.m._offline, false, 'the first player back releases it');
  r.m.dispose();
  const gone = makeMatch({ mode: 'coop', seats: doc.seats, seed: doc.seed, fake: true });
  assert.equal(restoreMatch(gone.m, JSON.parse(JSON.stringify(doc)), { createRngFromState }), true);
  gone.sched.advance(10 * MIN + OFFLINE_HOLD_GRACE_MS + 1);
  assert.equal(gone.ended?.reason, 'abandoned', 'nobody back (no session to expire it): cleared by the match itself');
  gone.m.dispose();
});
