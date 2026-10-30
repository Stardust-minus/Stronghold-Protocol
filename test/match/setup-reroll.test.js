import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { ERR, PHASE } from '../../shared/constants.js';
import { REROLL_VOTE_MS, rerollNeed } from '../../server/match/match/setupVote.js';
import { restoreMatch, snapshotMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { validateC2S } from '../../shared/protocol.js';
import { createRng, deriveSeed } from '../../server/sim/rng.js';
import { setupMatchWaves } from '../../server/match/waves.js';
import { drawDisabledBonds } from '../../server/match/pool.js';

const snapshot = (m) => ({ stageId: m.stageId, bossId: m.bossId, hiddenBossId: m.hiddenBossId,
  factions: [...m.factions], schedule: m.factions.schedule, bans: [...m.bannedChess], drawn: [...m.disabledBonds] });
const approve = (m, id, voteId = m.setupVote.id) => m.handle(id, { t: 'g.rerollVote', voteId, agree: true });

test('reroll with one second left gives everyone a fresh full countdown; old timeout cannot advance it', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const fullMs = m.scaled(m.gd.timer('infoCheck') * 1000);
  h.sched.advance(fullMs - 1000);
  assert.equal(m.deadline - h.sched.now(), 1000);
  assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
  h.sched.advance(5000);
  assert.deepEqual(approve(m, 'p_1'), { ok: true });
  const fresh = h.lastBc('m.public');
  assert.equal(fresh.deadline - fresh.serverNow, fullMs);
  assert.ok(fresh.players.every((p) => !p.ready));
  h.sched.advance(fullMs - 1);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
});

test('protocol requires setup revisions and vote identities; old initial ready remains supported', () => {
  assert.equal(validateC2S({ t: 'room.rerollSetup', setupRevision: 0 }), null);
  assert.equal(validateC2S({ t: 'room.cancelReroll', voteId: 1 }), null);
  assert.equal(validateC2S({ t: 'g.rerollVote', voteId: 1, agree: false }), null);
  assert.equal(validateC2S({ t: 'g.infoReady' }), null);
  assert.equal(validateC2S({ t: 'g.infoReady', setupRevision: 2 }), null);
  for (const msg of [{ t: 'room.rerollSetup' }, { t: 'room.rerollSetup', setupRevision: -1 },
    { t: 'room.rerollSetup', setupRevision: 0.5 }, { t: 'g.rerollVote', voteId: 0, agree: true },
    { t: 'g.rerollVote', voteId: 1 }, { t: 'g.rerollVote', voteId: 1, agree: 'yes' },
    { t: 'room.cancelReroll' }, { t: 'g.infoReady', setupRevision: -1 }]) {
    assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
  }
});

test('three of four humans (ceil 0.75 n) reroll the entire official setup and stock, preserving seats/settings/RNG', (t) => {
  const h = makeMatch({ humans: 4, difficulty: 'HARD', seed: 123, spectators: ['viewer'] }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const before = snapshot(m);
  const pool = m.pool;
  const players = [...m.order];
  const rngs = [m.rngSetup, m.rngShop, m.rngDraft, m.rngWaves, m.rngBots, m.rngMeta].map((r) => [r, r.state()]);
  const p0 = h.ps('p_0');
  assert.equal(p0.setDiy({ chess_char_5_diy1_a: { charId: 'char_017_huang', skillIndex: 0 } }), true);
  p0.initDiyStock(new Set([...m.disabledBonds, ...m.staticInactiveBonds]));
  const settings = [p0.loadout, p0.standIns, p0.diy];
  const stock = p0.diyStock;
  m.handle('p_1', { t: 'g.infoReady' });
  h.sched.advance(500);
  assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
  assert.deepEqual(m.setupVote.voters, ['p_0', 'p_1', 'p_2', 'p_3']);
  assert.equal(m.setupVote.need, 3);
  assert.equal(m.deadline, 0);
  assert.deepEqual(approve(m, 'p_1'), { ok: true });
  h.sched.advance(5000);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(snapshot(m), before, 'nothing rerolled below the threshold');
  assert.equal(m.handle('viewer', { t: 'g.rerollVote', voteId: m.setupVote.id, agree: true }).error, ERR.SPECTATOR);
  const voteId = m.setupVote.id;
  assert.deepEqual(approve(m, 'p_2'), { ok: true });
  assert.equal(approve(m, 'p_3', voteId).error, ERR.WRONG_PHASE, 'the vote is over once three agreed');
  assert.equal(m.setupRevision, 1);
  assert.equal(m.setupVote, null);
  const rng = createRng(deriveSeed(m.seed, 'reroll-setup:1'));
  const setup = setupMatchWaves(m.gd, rng);
  const bans = drawDisabledBonds(m.gd, rng);
  assert.deepEqual(snapshot(m), { stageId: setup.stageId, bossId: setup.bossId, hiddenBossId: setup.hiddenBossId,
    factions: [...setup.factions], schedule: setup.factions.schedule, bans: bans.banned, drawn: bans.drawn });
  assert.notDeepEqual(snapshot(m), before);
  assert.equal(m.stage, m.gd.stage(m.stageId));
  assert.notEqual(m.pool, pool);
  assert.deepEqual(m.order, players);
  assert.deepEqual([p0.loadout, p0.standIns, p0.diy], settings);
  assert.equal(p0.diy, settings[2]);
  assert.notEqual(p0.diyStock, stock);
  const off = new Set([...bans.drawn, ...bans.staticOff]);
  const diy = p0.gd.chess('chess_char_5_diy1_a');
  assert.equal(p0.diyBanned.includes(diy.chessId), diy.bonds.every((b) => off.has(b)));
  assert.equal(p0.diyStock.has(diy.chessId), !p0.diyBanned.includes(diy.chessId));
  for (const [r, state] of rngs) assert.equal(r.state(), state);
  for (const id of m.gd.visibleChess) assert.equal(m.pool.has(id), !bans.banned.includes(id));
  assert.ok(m.order.every((p) => !p.infoReady));
  assert.equal(m.deadline, h.sched.now() + m.scaled(m.gd.timer('infoCheck') * 1000));
  assert.equal(h.lastBc('m.public').setupRevision, 1);
  h.invariants();
  for (const p of m.order) assert.deepEqual(m.handle(p.playerId, { t: 'g.infoReady', setupRevision: 1 }), { ok: true });
  h.sched.advance(0);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
});

for (const capacity of [4, 8, 12, 16, 20]) for (const independent of [false, true]) {
  test(`setup reroll replaces every ${capacity}-seat ${independent ? 'independent' : 'shared'} pool atomically`, t => {
    const h = makeMatch({ humans: capacity, seed: 123, difficulty: 'HARD', experimental: {
      revivalEnabled: false, disableSharedPool: independent, ...(capacity > 4 ? { playerCapacity: capacity } : {}),
    } }).start();
    t.after(() => h.m.dispose());
    const m = h.m, groups = m.poolGroups, playerPools = m.playerPools;
    const oldPools = groups.map(g => g.pool), shape = groups.map(({ id, playerIds, scale }) => ({ id, playerIds, scale }));
    assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
    for (const ps of m.order.slice(1)) if (m.setupVote) assert.deepEqual(approve(m, ps.playerId), { ok: true });
    assert.equal(m.setupRevision, 1);
    assert.notEqual(m.poolGroups, groups);
    assert.deepEqual(m.poolGroups.map(({ id, playerIds, scale }) => ({ id, playerIds, scale })), shape);
    if (playerPools) assert.notEqual(m.playerPools, playerPools);
    for (const ps of m.order) {
      const group = m.poolGroups.find(g => g.playerIds.includes(ps.playerId)), pool = m.poolFor(ps);
      assert.strictEqual(pool, group.pool);
      assert.ok(!oldPools.includes(pool), 'no player retains a pre-reroll transaction pool');
      for (const id of m.gd.visibleChess) assert.equal(pool.has(id), !m.bannedChess.includes(id));
    }
    if (!independent) assert.strictEqual(m.pool, m.poolGroups[0].pool);
    h.invariants();
  });
}

test('reject/cancel restores exact remaining countdown and keeps setup and ready flags', (t) => {
  const h = makeMatch({ humans: 2, timerScale: 0.5 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const before = snapshot(m);
  m.handle('p_1', { t: 'g.infoReady' });
  h.sched.advance(1000);
  const remaining = m.deadline - h.sched.now();
  m.requestSetupReroll('p_0', 0);
  h.sched.advance(5000);
  assert.deepEqual(m.handle('p_1', { t: 'g.rerollVote', voteId: m.setupVote.id, agree: false }), { ok: true });
  assert.deepEqual(snapshot(m), before);
  assert.equal(m.setupRevision, 0);
  assert.equal(h.ps('p_1').infoReady, true);
  assert.equal(m.deadline, h.sched.now() + remaining, 'real remaining ms, no extra timer scaling');
  assert.equal(m.requestSetupReroll('p_0', 0).error, ERR.ALREADY, 'one proposal per player per setup revision');
  m.requestSetupReroll('p_1', 0);
  assert.deepEqual(m.cancelSetupReroll('p_0', m.setupVote.id), { ok: true });
  assert.equal(m.deadline, h.sched.now() + remaining);
  h.sched.advance(remaining - 1);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
});

test('reroll cancels queued all-ready transition; stale ready and previous vote cannot affect a new setup', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  for (const p of m.order) m.handle(p.playerId, { t: 'g.infoReady' });
  assert.ok(m._infoAdvanceTimer);
  m.requestSetupReroll('p_0', 0);
  const oldVote = m.setupVote.id;
  assert.equal(m.handle('p_1', { t: 'g.infoReady' }).error, ERR.WRONG_PHASE);
  approve(m, 'p_1');
  h.sched.advance(0);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  for (const msg of [{ t: 'g.infoReady' }, { t: 'g.infoReady', setupRevision: 0 }]) {
    assert.equal(m.handle('p_1', msg).error, ERR.BAD_TARGET);
  }
  assert.equal(m.requestSetupReroll('p_0', 0).error, ERR.BAD_TARGET);
  assert.equal(m.requestSetupReroll('p_0', 1).error, ERR.RATE);
  h.sched.advance(300);
  assert.deepEqual(m.requestSetupReroll('p_0', 1), { ok: true });
  assert.equal(approve(m, 'p_1', oldVote).error, ERR.BAD_TARGET);
  assert.equal(m.cancelSetupReroll('p_0', oldVote).error, ERR.BAD_TARGET);
  assert.equal(m.setupVote.agreed.size, 1);
});

test('solo and one human with bots refresh immediately without a forced timer; fixed rules remain fixed', (t) => {
  for (const mode of ['solo', 'coop']) {
    const h = makeMatch({ mode, humans: 1, bots: 2, difficulty: 'FUNNY' }).start();
    t.after(() => h.m.dispose());
    const m = h.m;
    const stage = m.stageId;
    const staticOff = [...m.staticInactiveBonds];
    assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
    assert.equal(m.stageId, stage);
    assert.deepEqual(m.staticInactiveBonds, staticOff);
    assert.equal(m.deadline, 0);
    assert.equal(m.setupRevision, 1);
    assert.equal(m.setupVote, null);
    assert.equal(h.ps('p_0').infoReady, false);
    assert.ok(m.order.filter((p) => p.isBot).every((p) => p.infoReady));
    m.handle('p_0', { t: 'g.infoReady', setupRevision: 1 });
    h.sched.advance(0);
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.equal(m.requestSetupReroll('p_0', 1).error, ERR.WRONG_PHASE);
  }
});

test('a voter that disconnects or leaves is dropped and the vote recounted, never cancelled; reconnect sees it', (t) => {
  const h = makeMatch({ humans: 4 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  const before = snapshot(m);
  m.requestSetupReroll('p_0', 0);
  const id = m.setupVote.id;
  assert.equal(m.setupVote.need, 3);
  assert.deepEqual(m.handle('p_1', { t: 'g.rerollVote', voteId: id, agree: false }), { ok: true });
  m.onReconnect('p_2');
  assert.equal(h.lastTo('p_2', 'm.public').rerollVote.id, id);
  // the no-voter drops: 3 voters left, need ceil(2.25) = 3, still open
  m.onDisconnect('p_1');
  assert.equal(m.setupVote.id, id);
  assert.deepEqual(m.setupVote.voters, ['p_0', 'p_2', 'p_3']);
  assert.deepEqual([...m.setupVote.rejected], []);
  assert.equal(m.setupVote.need, 3);
  assert.equal(m.handle('p_1', { t: 'g.rerollVote', voteId: id, agree: true }).error, ERR.NOT_IN_ROOM);
  // back online: not a voter of this vote
  m.onReconnect('p_1');
  assert.equal(m.handle('p_1', { t: 'g.rerollVote', voteId: id, agree: true }).error, ERR.NOT_IN_ROOM);
  approve(m, 'p_2');
  assert.deepEqual(snapshot(m), before);
  // p_3 leaves: 2 voters, need 2, both agreed → passes on the recount
  m.onLeave('p_3');
  assert.equal(m.setupVote, null);
  assert.equal(m.setupRevision, 1);
  assert.equal(h.lastBc('m.notice').kind, 'rerollPassed');
});

test('thresholds, early failure on rejections, the 20 s timeout and offline humans outside the vote', (t) => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 12, 16, 20].map(rerollNeed), [1, 2, 3, 3, 4, 6, 9, 12, 15]);
  for (const [n, need] of [[2, 2], [3, 3], [4, 3], [8, 6], [20, 15]]) {
    const h = makeMatch({ humans: n, experimental: n > 4 ? { revivalEnabled: false, disableSharedPool: false, playerCapacity: n } : undefined }).start();
    t.after(() => h.m.dispose());
    h.m.requestSetupReroll('p_0', 0);
    assert.equal(h.m.setupVote.need, need, `n=${n}`);
    assert.equal(h.lastBc('m.public').rerollVote.need, need);
  }
  // 4 humans, one offline: 3 voters, need 3; one no makes passing impossible
  const h = makeMatch({ humans: 4, timerScale: 0.5 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  m.onDisconnect('p_3');
  h.sched.advance(1000);
  const remaining = m.deadline - h.sched.now();
  assert.deepEqual(m.requestSetupReroll('p_1', 0), { ok: true });
  assert.deepEqual(m.setupVote.voters, ['p_0', 'p_1', 'p_2']);
  assert.equal(m.setupVote.need, 3);
  assert.deepEqual(m.handle('p_2', { t: 'g.rerollVote', voteId: m.setupVote.id, agree: false }), { ok: true });
  assert.equal(m.setupVote, null, 'failed early');
  assert.deepEqual(h.lastBc('m.notice'), { t: 'm.notice', kind: 'rerollFailed', voteId: 1, reason: 'rejected' });
  assert.equal(m.deadline, h.sched.now() + remaining);
  // a timed-out vote fails and restores the confirmation time
  h.sched.advance(300);
  const left = m.deadline - h.sched.now();
  assert.deepEqual(m.requestSetupReroll('p_2', 0), { ok: true });
  const vote = h.lastBc('m.public').rerollVote;
  assert.deepEqual(vote, { id: 2, proposerId: 'p_2', voters: ['p_0', 'p_1', 'p_2'], agreed: ['p_2'], rejected: [], need: 3,
    deadline: h.sched.now() + m.scaled(REROLL_VOTE_MS) });
  assert.deepEqual(approve(m, 'p_0'), { ok: true });
  h.sched.advance(m.scaled(REROLL_VOTE_MS) - 1);
  assert.equal(m.setupVote.id, 2);
  assert.equal(m.deadline, 0, 'confirmation stays paused while voting');
  h.sched.advance(1);
  assert.equal(m.setupVote, null);
  assert.deepEqual(h.lastBc('m.notice'), { t: 'm.notice', kind: 'rerollFailed', voteId: 2, reason: 'timeout' });
  assert.equal(m.setupRevision, 0);
  assert.equal(m.deadline, h.sched.now() + left);
  assert.equal(m.phase, PHASE.INFO_CHECK);
});

test('proposer withdrawal, no reroll cap per match and a checkpoint dropping the vote', (t) => {
  const h = makeMatch({ humans: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  m.requestSetupReroll('p_0', 0);
  assert.deepEqual(m.handle('p_0', { t: 'g.rerollVote', voteId: m.setupVote.id, agree: false }), { ok: true });
  assert.equal(m.setupVote, null);
  assert.deepEqual(h.lastBc('m.notice'), { t: 'm.notice', kind: 'rerollCancelled', voteId: 1, by: 'p_0' });
  // feedback #93: past the 3 of 0.3.0, as often as the vote passes
  for (let rev = 0; rev < 6; rev++) {
    h.sched.advance(300);
    assert.deepEqual(m.requestSetupReroll(rev % 2 ? 'p_0' : 'p_1', rev), { ok: true });
    assert.deepEqual(approve(m, rev % 2 ? 'p_1' : 'p_0'), { ok: true });
    assert.equal(m.setupRevision, rev + 1);
  }
  // a failed proposal still cannot be repeated on the same setup
  h.sched.advance(300);
  assert.deepEqual(m.requestSetupReroll('p_0', 6), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'g.rerollVote', voteId: m.setupVote.id, agree: false }), { ok: true });
  assert.equal(m.setupRevision, 6);
  h.sched.advance(300);
  assert.deepEqual(m.requestSetupReroll('p_0', 6), { error: ERR.ALREADY, detail: 'reroll-proposed' });
  // a vote open at a checkpoint is gone after the restore, the paused confirmation time kept
  const h2 = makeMatch({ humans: 2, seed: 7 }).start();
  t.after(() => h2.m.dispose());
  h2.sched.advance(2000);
  const remaining = h2.m.deadline - h2.sched.now();
  h2.m.requestSetupReroll('p_0', 0);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h2.m)));
  assert.equal(doc.deadlineRemainingMs, remaining);
  const h3 = makeMatch({ seats: doc.seats, seed: doc.seed });
  t.after(() => h3.m.dispose());
  assert.equal(restoreMatch(h3.m, doc, { createRngFromState }), true);
  assert.equal(h3.m.setupVote, null);
  assert.equal(h3.m._setupProposals.size, 0);
});

test('autoplay humans still explicitly consent; dispose stops a paused vote and invalid actors are refused', (t) => {
  const h = makeMatch({ humans: 2, bots: 1 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  m.handle('p_1', { t: 'g.autoplay', on: true });
  assert.equal(m.requestSetupReroll('ai_0', 0).error, ERR.NOT_IN_ROOM);
  assert.equal(m.requestSetupReroll('stranger', 0).error, ERR.NOT_IN_ROOM);
  m.requestSetupReroll('p_0', 0);
  assert.equal(m.setupVote.agreed.size, 1);
  h.sched.advance(30000);
  assert.equal(m.setupRevision, 0);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  m.dispose();
  assert.equal(m.requestSetupReroll('p_0', 0).error, ERR.WRONG_PHASE);
  h.sched.advance(30000);
  assert.equal(m.setupRevision, 0);
});

test('failed DIY stock preparation leaves every opening field and player stock intact', (t) => {
  const h = makeMatch({ humans: 2, difficulty: 'HARD' }).start();
  t.after(() => h.m.dispose());
  const m = h.m, before = snapshot(m), pool = m.pool, stage = m.stage, groups = m.poolGroups, playerPools = m.playerPools;
  const stocks = m.order.map((ps) => ps.diyStock), banned = m.order.map((ps) => ps.diyBanned);
  h.sched.advance(1000);
  const remaining = m.deadline - h.sched.now();
  m.requestSetupReroll('p_0', 0);
  const original = h.ps('p_1').buildDiyStock;
  h.ps('p_1').buildDiyStock = () => { throw Error('stock preparation failed'); };
  assert.equal(approve(m, 'p_1').error, ERR.INTERNAL);
  h.ps('p_1').buildDiyStock = original;
  assert.deepEqual(snapshot(m), before); assert.equal(m.pool, pool); assert.equal(m.stage, stage);
  assert.strictEqual(m.poolGroups, groups); assert.strictEqual(m.playerPools, playerPools);
  for (const [i, ps] of m.order.entries()) { assert.equal(ps.diyStock, stocks[i]); assert.equal(ps.diyBanned, banned[i]); }
  assert.equal(m.setupRevision, 0); assert.equal(m.setupVote, null);
  assert.equal(m.deadline - h.sched.now(), remaining);
  assert.equal(h.logs.error.length, 1, 'failure is reported once');
});
