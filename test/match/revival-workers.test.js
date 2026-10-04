// Actual six-worker + four-human WS regression. Real data/rosters/results, no FakeBattle or ignored imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { Match, REVIVAL_UNAVAILABLE_REASONS } from '../../server/match/Match.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { collectViolations } from '../../server/match/invariants.js';
import { TestClient } from '../helpers/wsClient.js';
import { DATA, give, giveItem, legalTileFor } from './harness.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error(`timeout: ${label}`);
}
const keys = ['board', 'hand', 'temp', 'shop', 'offers', 'funds', 'pendingFunds', 'bounties', 'layers', 'effects', 'counters', 'loadout',
  'bonds', 'round', 'lastResult', 'pendingLayerGains', '_tempDue', 'prepsEnded', 'ready', 'eliminatedRound', 'lpAtFinal',
  'bondCountBonus', 'deployCapBonus', 'deployCapMin', 'deviceOverrides', 'tileOverrides', 'stats', 'bandId'];
const retained = (p) => structuredClone(Object.fromEntries(keys.map((k) => [k, p[k]])));
const poolState = (m) => [...m.pool.entries].map(([id, e]) => [id, e.left, e.cap]);
const rngState = (m) => ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((k) => [k, m[k].state()]);
const playerView = (m, p) => m.publicView().players.find((v) => v.playerId === p.playerId);
function reason(m, p, expected) {
  assert.equal(p.revivalUnavailableReason, expected);
  assert.equal(playerView(m, p).revivalUnavailableReason, expected);
  assert.equal(p.privateView().revivalUnavailableReason, expected);
  if (expected != null) assert.ok(REVIVAL_UNAVAILABLE_REASONS.includes(expected));
}

async function scenario(t, options = {}) {
  class Checkpoint extends Match {
    constructor(o) {
      super({ ...o, clientCombat: false, verify: 'off', combatSpeed: 200, timerScale: 1, botRehearsal: 0 });
      this.normalResults = 0; this.settlements = 0; this.rawUnite = null; this.cleanups = 0; this.deferredState = null;
    }
    start() {
      // A legal round-7 checkpoint: natural setup and sequential wave RNG, pool-backed pieces on legal tiles.
      for (let r = 1; r < 7; r++) buildNormalWave(this.gd, this.rngWaves, this.factions, r);
      for (const p of this.order) {
        p.bandId = 'band_bldsk'; p.lp = p.seat === 0 ? 1 : p.seat === 1 ? options.donorLp ?? 11 : 20;
        p.recompute();
      }
      this.startRound(7); this.setDeadline(0); this.enterPrep();
      const target = this.order[0], donor = this.order[1];
      target.revived = options.used === true;
      const kit = options.noPerfect ? [] : ['chess_char_6_01_a', 'chess_char_6_02_a', 'chess_char_6_03_a', 'chess_char_6_04_a'];
      for (const id of kit) {
        assert.ok(this.pool.has(id)); const at = legalTileFor(this, donor, id); assert.ok(at);
        assert.equal(give(this, donor, id, 'board', at).poolCopies, 1);
      }
      const ids = this.gd.visibleChess.filter((id) => this.gd.chess(id)?.tier === 1 && this.pool.has(id));
      assert.ok(ids.length >= 3);
      give(this, target, ids[0]); give(this, target, ids[1]);
      const at = legalTileFor(this, target, ids[2]); assert.ok(at); const boardPiece = give(this, target, ids[2], 'board', at);
      const items = Object.values(DATA.items).filter((x) => x.itemType === 'EQUIP' && !x.isGolden);
      assert.ok(items.length >= 2); giveItem(this, target, items[0].id); boardPiece.items.push(target.newPiece('item', items[1].id));
      target.shop.frozen = true; target.counters.retention = 7; target.recompute(); donor.recompute();
      const eliminate = target.eliminate.bind(target);
      target.eliminate = (...args) => { this.cleanups++; return eliminate(...args); };
      assert.deepEqual(collectViolations(this), []);
      this.markPublic(); this.flush(true);
    }
    _finishCombat(resultOf) { const out = super._finishCombat(resultOf); this.normalResults += this.lastResults.size; return out; }
    _deferDeath(p) { if (p === this.order[0]) this.deferredState = retained(p); return super._deferDeath(p); }
    settle(plan, result) { this.settlements++; this.rawUnite = structuredClone(result); return super.settle(plan, result); }
  }
  const errors = [];
  const srv = await startServer({ host: '127.0.0.1', port: 0, combatWorkers: 6, MatchClass: Checkpoint, seedFn: () => 20261005,
    log: { ...quiet, error: (...args) => errors.push(args.map(String).join(' ')) } });
  const clients = []; let closed = false;
  const close = async () => { if (closed) return; closed = true; await Promise.all(clients.map((c) => c.terminate())); await srv.close(); };
  t.after(close);
  const ok = async (c, msg) => { const reply = await c.request(msg); assert.equal(reply.t, 'ok', `${msg.t}: ${reply.detail || ''} ${errors.join('\n')}`); };
  for (let seat = 0; seat < 4; seat++) {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c); c.id = (await c.hello(`Local${seat}`)).playerId;
  }
  await ok(clients[0], { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = await clients[0].waitFor('room.state', (s) => s.hostId === clients[0].id);
  for (let i = 1; i < 4; i++) await ok(clients[i], { t: 'room.join', code: room.code });
  for (let i = 0; i < 4; i++) {
    await ok(clients[i], { t: 'room.voteRevival', enable: i < (options.yesVotes ?? 4) });
    if (i) await ok(clients[i], { t: 'room.ready', ready: true });
  }
  await ok(clients[0], { t: 'room.start' });
  const m = srv.lobby.rooms.get(room.code).match;
  assert.equal(srv.combatPool.stats().ready, 6); assert.equal(m.combatPool, srv.combatPool); assert.equal(m.verifyMode, 'off');
  for (const c of clients) await ok(c, { t: 'g.ready', ready: true });
  await until(() => m.runner?.remote, 'actual WorkerFieldRunner');
  const request = (extra = {}) => ({ t: 'g.revive', playerId: clients[0].id, matchId: m.battlePrefix, round: m.round, ...extra });
  const settle = async () => {
    await until(() => m.phase === 'SETTLE', 'real normal / unite settlement');
    assert.equal(m.normalResults, 4); assert.equal(m.settlements, 1); assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
    assert.deepEqual(collectViolations(m), []);
    if (m.rawUnite) {
      assert.equal(m.rawUnite.synthetic, undefined); assert.ok(['cleared', 'timeout', 'forced'].includes(m.rawUnite.reason));
      for (const r of Object.values(m.rawUnite.perPlayer)) assert.ok(Array.isArray(r.leaked));
    }
  };
  return { m, clients, close, request, settle, ok, target: m.order[0], donor: m.order[1] };
}

for (const lp of [11, 21]) test(`real six-worker WS LP${lp}: fresh window, in-place rescue and once-only payment`, { timeout: 35_000 }, async (t) => {
  const s = await scenario(t, { donorLp: lp }), { m, clients, target, donor } = s;
  await s.settle();
  const normal = m.lastResults.get(donor.playerId);
  assert.equal(normal.perfect, true); assert.deepEqual(normal.leaked, []); assert.notEqual(normal.synthetic, true);
  assert.ok(m.unitePlan.helpers.includes(donor)); assert.ok(m.rawUnite.perPlayer[donor.playerId]);
  assert.equal(target.pendingDeath, true); assert.equal(m.cleanups, 0); reason(m, target, null);
  assert.ok(m._revival.deadline - Date.now() > 14_500);
  await clients[0].waitFor('m.private', (p) => p.pendingDeath === true, 2000);
  for (const c of clients) await c.waitFor('m.public', (p) => p.phase === 'SETTLE' && p.revival.windowOpen && p.players.some((x) => x.playerId === target.playerId && x.pendingDeath), 2000);
  await sleep(1100); assert.equal(target.pendingDeath, true); assert.equal(m.cleanups, 0); assert.equal(m.settlements, 1);
  const state = retained(target), refs = Object.fromEntries(keys.filter((k) => target[k] && typeof target[k] === 'object').map((k) => [k, target[k]]));
  assert.deepEqual(state, m.deferredState);
  const pool = poolState(m), rng = rngState(m), uid = m.uidSeq;
  assert.equal((await clients[1].request(s.request({ matchId: 'stale-local' }))).detail, 'stale-match');
  assert.equal((await clients[1].request(s.request({ round: 6 }))).detail, 'stale-round');
  // Discard historical PREP LP1 frames: only a newly received rescue private frame can satisfy this assertion.
  const privateStart = clients[0].log.length; clients[0].clearInbox();
  assert.equal((await clients[1].request(s.request())).t, 'ok');
  const freshPrivate = await clients[0].waitFor('m.private', (p) => p.alive && !p.pendingDeath && p.lp === 1, 2000);
  assert.ok(clients[0].log.indexOf(freshPrivate) >= privateStart);
  assert.equal(m.phase, 'SETTLE'); assert.equal(m.round, 7); assert.ok(m._revival.deadline > Date.now());
  const latestPublic = clients[0].log.filter((p) => p.t === 'm.public').at(-1);
  assert.equal(latestPublic.phase, 'SETTLE'); assert.equal(latestPublic.round, 7);
  assert.equal(donor.lp, lp - 10); assert.equal(donor.alive, true); assert.equal(target.lp, 1); assert.equal(target.revived, true); assert.equal(target.pendingDeath, false);
  reason(m, target, null); assert.deepEqual(retained(target), state);
  for (const [k, value] of Object.entries(refs)) assert.equal(target[k], value, k);
  assert.deepEqual(poolState(m), pool); assert.deepEqual(rngState(m), rng); assert.equal(m.uidSeq, uid); assert.equal(m.cleanups, 0);
  const duplicate = await clients[1].request(s.request()); assert.equal(duplicate.t, 'error'); assert.equal(donor.lp, lp - 10);
  if (lp === 21) assert.equal(duplicate.detail, 'revival-target-ineligible', 'donor still has >=11: once-only target guard rejects the duplicate');
  if (lp === 11) { await until(() => m.round === 8, 'original 15s deadline'); assert.equal(target.revived, true); assert.equal(donor.lp, 1); reason(m, target, null); }
  assert.deepEqual(collectViolations(m), []); await s.close();
});

for (const [label, options, expected] of [
  ['actual perfect helper below 11 LP', { donorLp: 10 }, 'donor-lp'],
  ['no leak-free actual helper', { noPerfect: true }, 'no-helper'],
  ['two of four votes', { yesVotes: 2 }, 'disabled'],
  ['previously rescued target dies again', { used: true }, 'already-used'],
]) test(`real six-worker WS finalized diagnosis: ${label}`, { timeout: 15_000 }, async (t) => {
  const s = await scenario(t, options), { m, target, donor, clients } = s;
  await s.settle(); assert.equal(target.pendingDeath, false); assert.equal(target.alive, false); reason(m, target, expected);
  assert.equal(m.cleanups, 1); assert.equal(target.board.size, 0); assert.ok(target.hand.every((p) => p == null));
  if (expected === 'donor-lp') { assert.equal(m.lastResults.get(donor.playerId).perfect, true); assert.ok(m.unitePlan.helpers.includes(donor)); assert.equal(donor.lp, 10); }
  await clients[1].waitFor('m.public', (p) => p.players.some((x) => x.playerId === target.playerId && x.revivalUnavailableReason === expected), 2000);
  m.startRound(8); reason(m, target, expected); m._finalizePendingDeaths(); assert.equal(m.cleanups, 1);
  assert.deepEqual(collectViolations(m), []); await s.close();
});

for (const cause of ['window-expired', 'window-closed', 'left', 'match-ended']) test(`real six-worker WS pending diagnosis: ${cause}`, { timeout: 35_000 }, async (t) => {
  const s = await scenario(t), { m, target, clients } = s;
  await s.settle(); assert.equal(target.pendingDeath, true); reason(m, target, null);
  if (cause === 'window-expired') { await sleep(1000); assert.equal(target.pendingDeath, true); await until(() => m.round === 8, 'real 15s expiry'); }
  else if (cause === 'window-closed') { assert.ok(m._revival.deadline > Date.now()); m.guard(() => m.startRound(8)); }
  else if (cause === 'left') await s.ok(clients[0], { t: 'room.leave' });
  else m.finish({ victory: false, reason: 'error' });
  assert.equal(target.pendingDeath, false); assert.equal(target.alive, false); reason(m, target, cause);
  assert.equal(target.board.size, 0); assert.equal(m.cleanups, 1);
  await clients[1].waitFor('m.public', (p) => p.players.some((x) => x.playerId === target.playerId && x.revivalUnavailableReason === cause), 2000);
  m._finalizePendingDeaths(); assert.equal(m._finalizeDeath(target, { reason: 'no-helper' }), false); assert.equal(m.cleanups, 1); reason(m, target, cause);
  assert.deepEqual(collectViolations(m), []); await s.close();
});

test('real six-worker WS immediate rescue: four fresh public frames and target private publish within the same window', { timeout: 15_000 }, async (t) => {
  const s = await scenario(t, { donorLp: 21 }), { m, target, clients } = s;
  await s.settle();
  for (const c of clients) await c.waitFor('m.public', (p) => p.phase === 'SETTLE' && p.revival.windowOpen && p.players.some((v) => v.playerId === target.playerId && v.pendingDeath), 2000);
  const starts = clients.map((c) => c.log.length); for (const c of clients) c.clearInbox();
  assert.ok(Date.now() - m._lastPubAt < 100, 'rescue exercises the public-throttle branch immediately after the window broadcast');
  assert.equal((await clients[1].request(s.request())).t, 'ok');
  const freshPrivate = await clients[0].waitFor('m.private', (p) => p.alive && !p.pendingDeath && p.lp === 1, 2000);
  assert.ok(clients[0].log.indexOf(freshPrivate) >= starts[0]);
  for (let i = 0; i < clients.length; i++) {
    const pub = await clients[i].waitFor('m.public', (p) => p.players.some((v) => v.playerId === target.playerId && v.alive && v.lp === 1 && v.revived === true), 2000);
    assert.ok(clients[i].log.indexOf(pub) >= starts[i]); assert.equal(pub.phase, 'SETTLE'); assert.equal(pub.round, 7);
    assert.ok(pub.revival.deadline > Date.now());
  }
  assert.equal(m.phase, 'SETTLE'); assert.equal(m.round, 7); assert.ok(m._revival.deadline > Date.now());
  assert.equal(m.settlements, 1); assert.equal(m.cleanups, 0); reason(m, target, null); await s.close();
});

test('real six-worker WS delayed replies: time debt cannot reenter SETTLE or erase pending death', { timeout: 20_000 }, async (t) => {
  const s = await scenario(t, { donorLp: 21 }), { m, target } = s;
  for (const phase of ['COMBAT', 'UNITE']) {
    await until(() => m.phase === phase && m.runner?.ready && m.runner.inflight, `inflight ${phase}`);
    const end = performance.now() + 500; while (performance.now() < end) { /* local parent delay, not worker/result replacement */ }
  }
  await s.settle(); assert.ok(m._revival.deadline - Date.now() > 14_500);
  await sleep(1500); assert.equal(target.pendingDeath, true); assert.equal(m.settlements, 1); assert.equal(m.cleanups, 0); reason(m, target, null);
  assert.equal((await s.clients[1].request(s.request())).t, 'ok'); assert.equal(s.donor.lp, 11);
  assert.deepEqual(collectViolations(m), []); await s.close();
});
