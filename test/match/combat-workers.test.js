// Fixed worker backend through the REAL asynchronous Match and HTTP/WS lifecycle.
// Numeric parity uses the original FieldRunner, not a second copy of CombatEngine or a public digest.
// The controlled transport delays real CombatEngine DTOs to make pause/cancellation races deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer, parseCombatWorkers, parseTrialWorkers } from '../../server/index.js';
import { Lobby } from '../../server/lobby.js';
import { NET_DEFAULTS } from '../../server/net.js';
import { Match } from '../../server/match/Match.js';
import { FieldRunner, emptyPerPlayer } from '../../server/match/fields.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { planUnite } from '../../server/match/unite.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { WorkerFieldRunner, RemoteBattle, MAX_WORKER_ADVANCE_TICKS } from '../../server/match/combat/runner.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, give, giveItem, legalTileFor } from './harness.js';
import { TestClient } from '../helpers/wsClient.js';

const captureLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const quiet = captureLog().log;
const clone = (x) => structuredClone(x);
function assertSnapshotUnitStats(snap) {
  assert.ok(Array.isArray(snap.unitStats), 'every server full snapshot carries the detail array, even when empty');
  assert.deepEqual(snap.unitStats.map((u) => u.id), snap.units.map((u) => u[0]), 'details follow exact tuple visibility');
  assert.ok(snap.units.every((u) => u.length === 9), 'the compact tuple schema is unchanged');
  for (const u of snap.unitStats) {
    assert.ok(u.base && Number.isFinite(u.atk) && Number.isFinite(u.base.atk) && Number.isFinite(u.def));
    for (const key of ['buffs', '_s', 'mem', 'skill', 'player', 'ownerUnit', 'kit']) assert.equal(Object.hasOwn(u, key), false, `no raw Unit ${key}`);
  }
}
async function until(predicate, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(5);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Start directly at a reproducible PREP fixture, with real data and the real scheduler. Lobby/draft
// traversal is separately exercised by the WS test below; no production methods are replaced here.
function fixture(t, { pool = null, humans = 4, mode = 'coop', speed = 200, ...opts } = {}) {
  const sent = [], bc = [], ended = [];
  const logs = captureLog();
  const m = new Match({
    roomCode: 'WORK', mode, difficulty: 'NORMAL', seed: 731, data: DATA,
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    send: (pid, msg) => { sent.push([pid, clone(msg)]); return true; },
    broadcast: (msg) => bc.push(clone(msg)), onEnd: (s) => ended.push(clone(s)),
    log: logs.log, timerScale: 0.02, combatSpeed: speed, botRehearsal: 0,
    clientCombat: false, verify: 'off', combatPool: pool, ...opts,
  });
  t.after(() => m.dispose());
  m.phase = 'PREP';
  m.round = 1;
  m.stageId = 'act2autochess_m04';
  m.stage = m.gd.stage(m.stageId);
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, 1);
  for (const ps of m.order) {
    ps.lp = 40;
    ps.bandId = 'band_bldsk';
    ps.invalidateDeployMap();
    ps.recompute();
  }
  return { m, sent, bc, ended, logs };
}
function deploy(m, ps, ids = ['chess_char_1_10_a', 'chess_char_3_01_a', 'chess_char_2_02_a']) {
  for (const id of ids) {
    const tile = legalTileFor(m, ps, id);
    assert.ok(tile, `legal tile for ${id}`);
    give(m, ps, id, 'board', tile);
  }
}
async function realPool(t, size = 2) {
  const pool = new CombatWorkerPool({ size, data: DATA, log: quiet });
  t.after(() => pool.close());
  await pool.start();
  assert.equal(pool.stats().ready, size);
  return pool;
}
function fieldsResult(m) {
  return clone(m.fields.map((f) => ({
    fieldId: f.fieldId, kind: f.kind, players: f.players, live: f.live,
    result: f.battle.result(), errors: f.battle.errors,
  })));
}
function settlementState(m) {
  return clone({
    phase: m.phase, round: m.round, lastResults: [...m.lastResults],
    teamLp: m.teamLp, overtimeApplied: m.overtimeApplied,
    boss: m.bossPool ? { hp: m.bossPool.hp, maxHp: m.bossPool.maxHp, byPlayer: [...m.bossPool.byPlayer] } : null,
    hiddenReached: m.hiddenReached, simErrors: m.simErrors, simErrorLog: [...m.simErrorLog],
    errorCount: m.errorCount, errors: m.errors, dispatcherErrors: m.dispatcher.errors,
    players: m.order.map((p) => ({
      playerId: p.playerId, lp: p.lp, lpAtFinal: p.lpAtFinal, alive: p.alive,
      stats: p.stats, funds: p.funds, pendingFunds: p.pendingFunds, layers: p.layers,
      pendingLayerGains: p.pendingLayerGains, bounties: p.bounties, effects: p.effects,
      board: [...p.board], hand: p.hand, temp: p.temp,
    })),
  });
}
function captureSettlement(m, boss = false) {
  const done = deferred();
  const method = boss ? '_finishFinal' : 'settle';
  const original = m[method];
  m[method] = function (...args) {
    const fields = fieldsResult(this);
    original.apply(this, args);
    done.resolve({ fields, state: settlementState(this), uniteResult: boss ? null : clone(args[1]) });
  };
  return done.promise;
}
function assertFullResults(result) {
  assert.ok(result.fields.length > 0);
  for (const f of result.fields) {
    assert.ok(f.result && Object.keys(f.result.perPlayer).length > 0);
    assert.equal(f.result.errors, 0, `${f.fieldId} simulation errors`);
    assert.deepEqual(f.errors, []);
    assert.equal(f.result.synthetic, undefined, 'real simulation must not become a synthetic win');
    for (const pp of Object.values(f.result.perPlayer)) {
      for (const key of ['leaked', 'layerGains', 'coins', 'damageDealt', 'bossDamage', 'healingDone', 'deaths', 'unitsEnd', 'unitStats']) {
        assert.ok(Object.hasOwn(pp, key), `full internal result retains ${key}`);
      }
      assert.ok(pp.unitsEnd.length > 0, 'operator end state actually compared');
      assert.ok(pp.unitStats.length > 0, 'unit statistics actually compared');
    }
  }
  assert.equal(result.state.simErrors, 0);
  assert.equal(result.state.errorCount, 0);
  assert.equal(result.state.dispatcherErrors, 0);
}

for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
  test(`workers: asynchronous ${kind} Match results and settlement exactly match original inline FieldRunner`, { timeout: 30_000 }, async (t) => {
    const pool = await realPool(t);
    const pair = [fixture(t), fixture(t, { pool })];
    const completions = [];
    for (const h of pair) {
      const m = h.m;
      for (const ps of m.order) deploy(m, ps);
      if (kind === 'normal') {
        // Retain the real wave and operators, but force the same timeout before any accidental unite transition.
        m.wave = { ...m.wave, timeLimit: 16 };
        completions.push(captureSettlement(m));
        m.startCombat();
      } else if (kind === 'unite') {
        m.wave = { ...m.wave, timeLimit: 24 };
        const enemyKey = m.wave.spawns[0].enemyKey;
        for (const ps of m.order) {
          const pp = emptyPerPlayer();
          pp.unitsEnd = [...ps.board.values()].filter((p) => p.kind === 'chess').map((p, i) => ({ uid: p.uid, alive: i !== 0, hpPct: 0.6, sp: 3, skillActive: false }));
          if (ps.seat >= 2) {
            pp.perfect = false;
            pp.leaked = Array.from({ length: 3 + ps.seat }, () => ({ enemyKey, counted: true, lpr: 1, mods: { hpMul: 0.5, bountyCoins: 2 } }));
          }
          m.lastResults.set(ps.playerId, pp);
        }
        const plan = planUnite(m, m.lastResults);
        assert.equal(plan.helpers.length, 2);
        assert.equal(plan.leakers.length, 2);
        completions.push(captureSettlement(m));
        m.startUnite(plan);
      } else {
        m.round = kind === 'hidden' ? m.gd.hiddenRound : m.gd.bossRound;
        m.bossId = 'boss_1';
        m.hiddenBossId = 'boss_8';
        // Exercise fractional overtime plus shared LP and same-tick terminal ordering without a long wall-clock wait.
        m.gd.config = { ...m.gd.config, bossOvertimeAfter: 12, bossOvertimeDrainPerSec: 1.25 };
        if (kind === 'hidden') {
          m.hiddenReached = true;
          m.teamLp = 160;
          for (const ps of m.order) ps.lpAtFinal = ps.lp;
        }
        completions.push(captureSettlement(m, true));
        m.startFinalAssault(kind === 'hidden');
      }
      assert.ok(m.runner instanceof (m.combatPool ? WorkerFieldRunner : FieldRunner));
    }
    const [inline, worker] = await Promise.all(completions);
    assertFullResults(worker);
    assert.deepEqual(worker, inline, 'all internal result fields, per-player settlement, errors, HP/LP and stats agree');
    if (kind === 'boss' || kind === 'hidden') {
      assert.equal(worker.fields.length, 2, 'two boss fields share one worker phase');
      assert.ok(worker.state.overtimeApplied > 0, 'overtime authority exercised');
      assert.equal(worker.state.teamLp, 0);
      assert.equal(worker.state.players.reduce((n, p) => n + p.lp, 0), 0);
      assert.ok(worker.state.boss.byPlayer.length > 0, 'boss damage attribution actually exercised');
    }
    const remote = pair[1];
    assert.ok(remote.sent.some(([, msg]) => msg.t === 'm.field' && !msg.prep));
    assert.ok(remote.sent.some(([, msg]) => msg.t === 'b.snap' && msg.gt > 0));
    for (const h of pair) for (const [, msg] of h.sent) if (msg.t === 'b.snap') assertSnapshotUnitStats(msg);
    assert.ok(remote.sent.some(([, msg]) => msg.t === 'b.ev'));
    assert.equal(remote.sent.some(([, msg]) => msg.t === 'b.start'), false);
    assert.deepEqual(remote.logs.errors, []);
    await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0, 'completed phase releases pool session');
    for (const h of pair) h.m.dispose();
  });
}

for (const hidden of [false, true]) {
  test(`workers: ${hidden ? 'hidden' : 'boss'} victory retains complete results, credits damage once and finishes identically`, { timeout: 30_000 }, async (t) => {
    const pool = await realPool(t);
    const pair = [fixture(t), fixture(t, { pool })];
    const completions = [];
    for (const { m } of pair) {
      for (const ps of m.order) deploy(m, ps, ['chess_char_4_17_b', 'chess_char_6_18_b', 'chess_char_6_20_b']);
      m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
      m.bossId = 'boss_3';
      m.hiddenBossId = hidden ? 'boss_8' : null;
      const id = hidden ? m.hiddenBossId : m.bossId;
      // Keep real boss mechanics/operators, with a small scenario HP pool to reach victory in seconds.
      m.gd.raw = { ...m.gd.raw, bosses: { ...m.gd.raw.bosses,
        [id]: { ...m.gd.boss(id), bloodPoint: { NORMAL: 200 } } } };
      if (hidden) {
        m.hiddenReached = true;
        m.teamLp = 160;
        for (const ps of m.order) ps.lpAtFinal = ps.lp;
      }
      completions.push(captureSettlement(m, true));
      m.startFinalAssault(hidden);
    }
    const [inline, worker] = await Promise.all(completions);
    assertFullResults(worker);
    assert.deepEqual(worker, inline);
    assert.equal(worker.state.boss.hp, 0);
    assert.equal(worker.state.boss.maxHp, 200);
    assert.ok(worker.state.teamLp > 0);
    const credited = worker.state.players.reduce((sum, p) => sum + p.stats.bossDamage, 0);
    assert.ok(Math.abs(credited - 200) < 1e-7, 'shared pool damage is credited once, not once per mirrored field');
    await until(() => pair.every((h) => h.m.ended), 'victory reaches RESULT');
    const summaries = pair.map((h) => {
      assert.equal(h.ended.length, 1);
      assert.equal(h.m.outcome.victory, true);
      assert.equal(h.m.outcome.hiddenCleared, hidden);
      assert.deepEqual(h.logs.errors, []);
      const { durationMs, ...summary } = h.m.lastResultMsg;
      assert.ok(durationMs >= 0);
      return summary;
    });
    assert.deepEqual(summaries[1], summaries[0], 'complete final summary agrees except wall-clock duration');
  });
}

test('workers: real unite carries operator/summon state and reached layers, then preserves pending-death rescue settlement', { timeout: 15_000 }, async (t) => {
  const pool = await realPool(t, 1);
  const pair = [fixture(t, { humans: 2, revivalEnabled: true }), fixture(t, { pool, humans: 2, revivalEnabled: true })];
  const completions = [];
  for (const { m } of pair) {
    const [target, donor] = m.order;
    target.lp = 1; donor.lp = 11;
    deploy(m, target, ['chess_char_1_10_a']);
    deploy(m, donor, ['chess_char_6_11_a']); // 缪尔赛思 and her board 流形
    const op = [...donor.board.values()].find((p) => p.kind === 'chess');
    const token = donor.newPiece('token', 'token_10030_mlyss_wtrman', { ownerUid: op.uid });
    const tile = [...donor.summonRange(token)].find((key) => {
      const [r, c] = key.split(',').map(Number);
      return !donor.board.has(key) && donor._legal(token, r, c);
    });
    assert.ok(tile, 'a legal 流形 tile inside its owner range');
    donor.board.set(tile, token);
    donor.recompute();
    donor.layers.sargonShip = 12;
    donor.pendingLayerGains = { sargonShip: 3 };
    donor.recompute();
    m.wave = { ...m.wave, timeLimit: 4 };
    const leaker = emptyPerPlayer(), helper = emptyPerPlayer();
    leaker.perfect = false;
    leaker.leaked = [{ enemyKey: m.wave.spawns[0].enemyKey, counted: true, lpr: 1, mods: { hpMul: 1e6 } }];
    helper.layerGains = { sargonShip: 3 };
    helper.unitsEnd = [
      { uid: op.uid, hpPct: 0.5, sp: 3, skillActive: true, alive: true },
      { uid: token.uid, hpPct: 0.3, sp: 40, skillActive: false, alive: true },
    ];
    // The preceding own-field reports are seeded fixtures; 联防 itself uses the real Battle in the real worker.
    m.lastResults.set(target.playerId, leaker); m.lastResults.set(donor.playerId, helper);
    const plan = planUnite(m, m.lastResults);
    assert.deepEqual(plan.helpers.map((p) => p.playerId), [donor.playerId]);
    completions.push(captureSettlement(m));
    m.startUnite(plan);
    const input = m.combatPool ? m.fields[0].spec.players[0] : m.fields[0].battle.opts.players[0];
    assert.deepEqual(input.units.find((u) => u.uid === op.uid).carryState, { hpPct: 0.5, sp: 3 });
    assert.deepEqual(input.units.find((u) => u.uid === token.uid).carryState, { sp: 40 });
    assert.equal(input.bonds.sargonShip.layers, 15);
  }
  const [inline, worker] = await Promise.all(completions);
  assert.deepEqual(worker, inline, 'full internal result, carry and lethal settlement stay identical');
  assert.equal(worker.uniteResult.synthetic, undefined);
  assert.equal(worker.uniteResult.errors, 0);
  assert.ok(['cleared', 'timeout'].includes(worker.uniteResult.reason));
  const pp = worker.uniteResult.perPlayer.p_1;
  assert.ok(pp.unitsEnd.some((u) => u.defId === 'token_10030_mlyss_wtrman'), 'worker retains the summon end state');
  for (const { m, logs } of pair) {
    const [target, donor] = m.order;
    assert.equal(target.pendingDeath, true);
    assert.ok(target.board.size > 0, 'pending death has not returned or wiped holdings');
    assert.equal(donor.layers.sargonShip, 15, 'normal layer gains settle only once');
    assert.equal(m.publicView().revival.windowOpen, true);
    assert.deepEqual(m.publicView().revival.eligible, [donor.playerId]);
    assert.deepEqual(m.handle(donor.playerId, { t: 'g.revive', playerId: target.playerId, matchId: m.battlePrefix, round: m.round }), { ok: true });
    assert.equal(target.lp, 1); assert.equal(target.pendingDeath, false); assert.equal(target.alive, true);
    assert.equal(donor.lp, 1);
    assert.deepEqual(logs.errors, []);
  }
});

// A worker-like transport with real DTO construction, but explicit delivery. Computing before returning
// the promise reproduces an already-executed worker command whose message has not reached Match yet.
class ControlledPool {
  constructor() { this.sessions = []; this.queue = []; this.maxInflight = 0; }
  create(input, { onFailure }) {
    const engine = new CombatEngine(input, { data: DATA, log: quiet });
    const s = { engine, onFailure, closed: false, commands: [], inflight: 0 };
    this.sessions.push(s);
    const enqueue = (op, payload = {}) => {
      assert.equal(s.closed, false, 'no command after session cancellation');
      s.commands.push({ op, payload });
      s.inflight++;
      this.maxInflight = Math.max(this.maxInflight, s.inflight);
      const d = deferred();
      const dto = op === 'init' ? engine.state({ snapshotFields: input.specs.map((x) => x.fieldId) })
        : op === 'advance' ? engine.advance(payload.ticks, payload)
          : op === 'state' ? engine.state(payload)
            : op === 'forceField' ? engine.forceField(payload.fieldId, payload.reason)
              : engine.forceAll(payload.reason);
      const request = { s, op, dto, ...d };
      this.queue.push(request);
      return d.promise;
    };
    return {
      ready: enqueue('init'),
      request: enqueue,
      close: () => { if (!s.closed) { s.closed = true; engine.dispose(); } },
    };
  }
  async deliver(request = this.queue[0]) {
    assert.ok(request, 'a response is pending');
    this.queue.splice(this.queue.indexOf(request), 1);
    request.s.inflight--;
    request.resolve(request.dto);
    await Promise.resolve();
    await Promise.resolve();
    return request;
  }
  async next(op) {
    await until(() => this.queue.some((x) => x.op === op), `${op} request`);
    return this.queue.find((x) => x.op === op);
  }
}
const combatFrames = (h) => h.sent.filter(([, msg]) => ['b.snap', 'b.ev', 'm.field'].includes(msg.t));
async function readyControlled(t, opts = {}) {
  const pool = new ControlledPool();
  const h = fixture(t, { pool, humans: 1, mode: 'solo', speed: 2, ...opts });
  h.m.wave = { ...h.m.wave, timeLimit: 90 };
  deploy(h.m, h.m.order[0]);
  h.m.startCombat();
  const runner = h.m.runner;
  await pool.deliver();
  assert.equal(runner.ready, true);
  return { ...h, pool, runner };
}

test('workers: deterministic pacing retains active time through latency/resync, bounds turns and discards pause catch-up', async (t) => {
  let clock = 1000;
  const h = await readyControlled(t, { now: () => clock });
  const { m, pool, runner } = h;
  // Use the real Match/runner and DTO transport, but pump a controlled wall clock with no interval races.
  m.sched.clearInterval(runner.interval);
  runner.interval = null;
  const interval = 1000 / 30;
  const pump = (elapsed = 0) => { clock += elapsed; runner._pump(); };
  const advances = () => pool.sessions[0].commands.filter((c) => c.op === 'advance').map((c) => c.payload.ticks);

  pump(interval); // 33.333 ms at 2x: the first two ticks are in flight.
  assert.deepEqual(advances(), [2]);
  pump(interval); // 66.667 ms: retain elapsed time while the first reply is delayed.
  pump(interval); // 100 ms: still one command in flight, now four ticks owed.
  assert.equal(pool.queue.length, 1);
  await pool.deliver();
  pump();
  assert.deepEqual(advances(), [2, 4], 'worker latency below the cap must not slow the game clock');
  await pool.deliver();
  assert.equal(runner.ticks, 6);

  runner.requestField('p_0', 'n:p_0');
  pump(interval);
  assert.equal(pool.queue[0].op, 'state');
  pump(interval);
  pump(interval);
  assert.equal(pool.queue.length, 1, 'resync never overlaps an advance');
  await pool.deliver();
  assert.equal(runner.resync.size, 0);
  pump();
  assert.deepEqual(advances(), [2, 4, 6], 'time spent sending and awaiting resync remains owed');
  await pool.deliver();
  assert.equal(runner.ticks, 12);

  pump(interval);
  pump(1000); // A delayed worker leaves sixty active ticks owed, without creating another queued command.
  assert.equal(pool.queue.length, 1);
  await pool.deliver();
  assert.equal(advances().at(-1), MAX_WORKER_ADVANCE_TICKS, 'reply immediately admits one bounded catch-up turn');
  assert.equal(pool.queue.length, 1);
  await pool.deliver();
  assert.equal(advances().at(-1), 60 - MAX_WORKER_ADVANCE_TICKS, 'remaining active debt is retained, not discarded');
  await pool.deliver();
  pump();
  assert.equal(runner.ticks, 74, 'all active wall time was actually simulated');
  assert.equal(pool.queue.length, 0, 'no spin or extra command once the debt is drained');

  pump(interval);
  assert.equal(advances().at(-1), 2);
  pump(interval); // Accumulate pre-pause debt while that command is in flight.
  const beforePause = runner.ticks;
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: true }), { ok: true });
  pump(60_000);
  await pool.deliver();
  assert.equal(runner.ticks, beforePause, 'the pending reply stays held during pause');
  assert.ok(runner.held);
  pump(60_000);
  assert.equal(pool.queue.length, 0);
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: false }), { ok: true });
  assert.equal(runner.ticks, beforePause + 2, 'resume applies the pre-pause reply once');
  pump();
  assert.equal(pool.queue.length, 0, 'resume clears both paused time and pre-pause accumulator debt');
  pump(interval);
  assert.equal(advances().at(-1), 2, 'resume restarts ordinary 2x pacing without catch-up');
  await pool.deliver();
  assert.equal(pool.maxInflight, 1);
  assert.deepEqual(h.logs.errors, []);
});

test('workers: encoded resync selects only the newest consistent frame in a delayed batch', async (t) => {
  let clock = 1000;
  const h = await readyControlled(t, { now: () => clock });
  const { m, pool, runner } = h;
  m.sched.clearInterval(runner.interval);
  runner.interval = null;
  clock += 100;
  runner._pump(); // Six simulation ticks produce two distinct snapshot frames.
  const response = pool.queue[0];
  assert.equal(response.op, 'advance');
  assert.ok(response.dto.frames.length >= 2);
  assert.ok(response.dto.frames.every((f) => typeof f.metaWire === 'string' && typeof f.snapshotWire === 'string'));
  const latest = response.dto.frames.at(-1);
  assertSnapshotUnitStats(JSON.parse(latest.snapshotWire));
  runner.requestField('p_0', 'n:p_0');
  const before = h.sent.length;
  await pool.deliver(response);
  const frames = h.sent.slice(before).filter(([, msg]) => ['m.field', 'b.snap', 'b.ev'].includes(msg.t)).map(([, msg]) => msg);
  assert.deepEqual(frames, [JSON.parse(latest.metaWire), JSON.parse(latest.snapshotWire)],
    'rejoin sends the newest metadata/snapshot pair, not older events or backwards snapshots');
  assert.equal(runner.resync.size, 0);
  const remote = m.fields[0].battle;
  assert.deepEqual(remote.fieldMeta(), JSON.parse(latest.metaWire));
  const { t: type, gt, ...snapshot } = JSON.parse(latest.snapshotWire);
  assert.equal(type, 'b.snap');
  assert.deepEqual(remote.snapshot(), { ...snapshot, t: gt }, 'cached accessor converts protocol time back to simulation time');
  assert.deepEqual(h.logs.errors, []);
});

test('workers: a pre-pause in-flight terminal response applies no frame or settlement until resume, once', { timeout: 10_000 }, async (t) => {
  const h = await readyControlled(t);
  const { m, pool, runner } = h;
  runner.forceAll('timeout');
  const response = await pool.next('forceAll');
  assert.equal(response.dto.done, true);
  const before = { frames: combatFrames(h).length, ticks: runner.ticks, lp: m.order[0].lp, lastResults: [...m.lastResults] };
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: true }), { ok: true });
  await pool.deliver(response);
  await delay(100);
  assert.equal(runner.held, response.dto);
  assert.equal(runner.ticks, before.ticks);
  assert.equal(combatFrames(h).length, before.frames);
  assert.equal(m.order[0].lp, before.lp);
  assert.deepEqual([...m.lastResults], before.lastResults);
  assert.equal(m.fields[0].live, true);
  assert.equal(pool.queue.length, 0, 'paused runner posts no more commands');
  const oldDeadline = m.deadline;
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: false }), { ok: true });
  assert.equal(runner.done, true);
  assert.equal(runner.held, null);
  assert.equal(m.fields[0].live, false);
  assert.equal(m.lastResults.size, 1);
  assert.equal(pool.sessions[0].closed, true);
  const results = clone([...m.lastResults]);
  runner.resume();
  assert.deepEqual([...m.lastResults], results);
  assert.ok(m.pausedMs >= 80);
  assert.ok(oldDeadline > 0);
  assert.equal(pool.maxInflight, 1);
  assert.deepEqual(h.logs.errors, []);
});

test('workers: pause before initialization, then disconnect resumes the held reply without catch-up', { timeout: 10_000 }, async (t) => {
  const pool = new ControlledPool();
  const h = fixture(t, { pool, humans: 1, mode: 'solo', speed: 2 });
  const { m } = h;
  m.startCombat();
  const runner = m.runner;
  assert.deepEqual(m.handle('p_0', { t: 'g.pause', on: true }), { ok: true });
  await pool.deliver();
  assert.equal(runner.ready, true);
  assert.ok(runner.held);
  assert.equal(combatFrames(h).length, 0);
  await delay(100);
  m.onDisconnect('p_0');
  assert.equal(m.paused, false);
  assert.equal(runner.held, null);
  const advance = await pool.next('advance');
  assert.ok(advance.s.commands.at(-1).payload.ticks <= 3, 'paused wall time is not simulated on resume');
  assert.equal(pool.maxInflight, 1);
});

for (const ending of ['dispose', 'leave', 'finish']) {
  test(`workers: ${ending} cancels an in-flight phase and ignores its late successful response and failure callback`, { timeout: 10_000 }, async (t) => {
    const h = await readyControlled(t);
    const { m, runner, pool } = h;
    const response = await pool.next('advance');
    if (ending === 'dispose') m.dispose();
    else if (ending === 'leave') m.onLeave('p_0');
    else m.finish({ victory: false, reason: 'test' });
    const before = { frames: combatFrames(h).length, state: settlementState(m), ends: h.ended.length };
    assert.equal(pool.sessions[0].closed, true);
    await pool.deliver(response);
    pool.sessions[0].onFailure(new Error('late failure'));
    runner.forceAll('stale');
    runner.forceField('n:p_0', 'stale');
    await delay(75);
    assert.equal(combatFrames(h).length, before.frames);
    assert.deepEqual(settlementState(m), before.state);
    assert.equal(h.ended.length, before.ends);
    assert.equal(runner.interval, null);
    assert.equal(pool.queue.length, 0);
    assert.deepEqual(h.logs.errors, []);
  });
}

test('workers: old RemoteBattle force and late response cannot mutate a replacement phase with the same field id', { timeout: 10_000 }, async (t) => {
  const h = await readyControlled(t);
  const { m, pool, runner } = h;
  const old = m.fields[0].battle;
  const response = await pool.next('advance');
  runner.stop();
  m.startCombat();
  const replacement = m.runner;
  assert.notEqual(replacement, runner);
  assert.equal(m.fields[0].fieldId, old.fieldId);
  old.forceEnd('left');
  runner.forceAll('forced');
  await pool.deliver(response);
  assert.equal(replacement.ticks, 0);
  assert.equal(replacement.ready, false);
  await pool.deliver(await pool.next('init'));
  assert.equal(replacement.ready, true);
  const next = await pool.next('advance');
  assert.equal(next.s, pool.sessions[1]);
  assert.equal(pool.sessions[1].commands.some((x) => x.op.startsWith('force')), false);
  assert.equal(pool.maxInflight, 1);
});

test('workers: queued force controls cannot overtake a running advance or create duplicate settlement', { timeout: 10_000 }, async (t) => {
  const h = await readyControlled(t, { mode: 'coop', humans: 2 });
  const { m, pool, runner } = h;
  const advance = await pool.next('advance');
  for (let i = 0; i < 50; i++) m.fields[0].battle.forceEnd('left');
  runner.forceAll('forced');
  await delay(80);
  assert.equal(pool.queue.length, 1);
  assert.equal(runner.controls.size, 1, 'forceAll supersedes per-field requests');
  await pool.deliver(advance);
  const force = await pool.next('forceAll');
  assert.equal(pool.sessions[0].commands.at(-1).op, 'forceAll');
  await pool.deliver(force);
  assert.equal(runner.done, true);
  assert.equal(m.lastResults.size, 2);
  assert.ok([...m.lastResults.values()].every((x) => Array.isArray(x.unitStats)));
  assert.equal(pool.maxInflight, 1);
  assert.equal(pool.sessions[0].commands.filter((x) => x.op === 'forceAll').length, 1);
  assert.deepEqual(h.logs.errors, []);
});

test('workers: disconnected and switched resync requests are pruned instead of starving advance', { timeout: 10_000 }, async (t) => {
  let clock = 1000;
  const h = await readyControlled(t, { mode: 'coop', humans: 2, now: () => clock });
  const { m, pool, runner } = h;
  m.sched.clearInterval(runner.interval);
  runner.interval = null;
  clock += 100;
  runner._pump();
  const advance = await pool.next('advance');
  m._sendField('p_0', 'n:p_0');
  m.onDisconnect('p_0');
  // A watcher changed while a resync for its previous field was queued.
  runner.requestField('p_1', 'n:p_0');
  m.watchers.set('p_1', 'n:p_1');
  const at = pool.sessions[0].commands.length;
  clock += 100;
  await pool.deliver(advance);
  const next = await pool.next('advance');
  assert.equal(pool.sessions[0].commands[at].op, 'advance');
  assert.equal(runner.resync.size, 0);
  clock += 100;
  await pool.deliver(next);
  // Reply-driven catch-up can already have another advance in flight when reconnect arrives.
  // This manual transport must deliver it, rather than waiting forever for a state behind it.
  const catchingUp = await pool.next('advance');
  const fieldsBefore = h.sent.filter(([pid, msg]) => pid === 'p_0' && msg.t === 'm.field').length;
  m.onReconnect('p_0');
  assert.equal(runner.resync.get('p_0'), 'n:p_0');
  await pool.deliver(catchingUp);
  // A fresh frame can satisfy the resync itself; otherwise the next bounded command fetches state.
  if (runner.resync.has('p_0')) await pool.deliver(await pool.next('state'));
  assert.equal(runner.resync.size, 0);
  assert.ok(h.sent.filter(([pid, msg]) => pid === 'p_0' && msg.t === 'm.field').length > fieldsBefore);
  assert.equal(pool.maxInflight, 1);
});

for (const hidden of [false, true]) {
  test(`workers: runtime failure visibly ends ${hidden ? 'hidden' : 'normal'} battle exactly once without fabricated settlement`, { timeout: 10_000 }, async (t) => {
    const h = await readyControlled(t);
    const { m, pool } = h;
    m.hiddenReached = hidden;
    const response = await pool.next('advance');
    const before = clone(m.order[0].stats);
    pool.sessions[0].onFailure(new Error('controlled worker crash'));
    assert.equal(m.ended, true);
    assert.equal(m.outcome.reason, 'error');
    assert.equal(m.outcome.victory, hidden);
    assert.equal(m.outcome.hiddenCleared, false);
    assert.equal(m.lastResults.size, 0);
    assert.deepEqual(m.order[0].stats, before);
    assert.equal(h.ended.length, 1);
    assert.ok(h.bc.some((x) => x.t === 'm.ticker' && JSON.stringify(x).includes('战斗演算服务异常')));
    await pool.deliver(response);
    pool.sessions[0].onFailure(new Error('duplicate failure'));
    assert.equal(h.ended.length, 1);
    assert.equal(m.errorCount, 1);
    assert.equal(pool.sessions[0].closed, true);
  });
}

test('workers: terminating the real owning thread ends its Match once and does not resume on replacement', { timeout: 10_000 }, async (t) => {
  const pool = await realPool(t);
  const h = fixture(t, { pool, humans: 1, mode: 'solo', speed: 2 });
  const { m } = h;
  deploy(m, m.order[0]);
  m.startCombat();
  await until(() => m.runner.ready && m.runner.ticks > 0, 'real worker advances');
  const generation = m.runner.session.generation;
  const slot = pool.sessions.get(generation).slot;
  const oldWorker = slot.worker;
  await oldWorker.terminate();
  await until(() => m.ended, 'worker exit ends Match visibly');
  assert.equal(m.outcome.reason, 'error');
  assert.equal(m.outcome.victory, false);
  assert.equal(m.errorCount, 1);
  assert.equal(h.ended.length, 1);
  assert.equal(m.lastResults.size, 0);
  assert.equal(pool.stats().sessions, 0);
  assert.ok(h.bc.some((x) => x.t === 'm.ticker' && JSON.stringify(x).includes('战斗演算服务异常')));
  const state = settlementState(m);
  await until(() => slot.ready && slot.worker !== oldWorker, 'bounded pool replacement boots');
  await delay(100);
  assert.deepEqual(settlementState(m), state, 'replacement never reanimates the cancelled generation');
  assert.equal(h.ended.length, 1);
  assert.equal(oldWorker.threadId, -1);
});

test('workers: listener startup failure closes the env-configured pool before rejecting', { timeout: 10_000 }, async (t) => {
  const occupied = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 0, quiet: true });
  t.after(() => occupied.close());
  const logs = captureLog();
  const original = CombatWorkerPool.prototype.start;
  const env = process.env.SP_COMBAT_WORKERS;
  const captured = [];
  let metricsCreated = 0;
  // Capture both real pools; a failed listener must not strand either set of workers.
  CombatWorkerPool.prototype.start = function (...args) { captured.push(this); return original.apply(this, args); };
  process.env.SP_COMBAT_WORKERS = '2';
  try {
    await assert.rejects(startServer({ port: occupied.port, host: '127.0.0.1', trialWorkers: 1, log: logs.log,
      healthMetricsFactory: () => { metricsCreated++; assert.fail('failed listener cannot create metrics'); } }), { code: 'EADDRINUSE' });
  } finally {
    CombatWorkerPool.prototype.start = original;
    if (env === undefined) delete process.env.SP_COMBAT_WORKERS; else process.env.SP_COMBAT_WORKERS = env;
    for (const pool of captured) t.after(() => pool.close());
  }
  assert.equal(metricsCreated, 0);
  assert.equal(captured.length, 2, 'both pools start before binding');
  assert.deepEqual(captured.map((pool) => [pool.role, pool.size]), [['combat', 2], ['trial', 1]]);
  for (const pool of captured) {
    assert.equal(pool.stats().status, 'closed');
    assert.equal(pool.stats().workers, 0);
    assert.equal(pool.stats().pending, 0);
    assert.equal(pool.terminating.size, 0);
  }
  assert.deepEqual(logs.errors, [], 'expected listen failure does not become spurious worker errors');
});

test('workers: opt-in leaves default, virtual schedulers, custom Battle fixtures and client combat inline', (t) => {
  const trap = { create() { assert.fail('ineligible Match must not create a worker session'); } };
  for (const opts of [
    { pool: null },
    { pool: trap, scheduler: new VirtualScheduler() },
    { pool: trap, scheduler: new VirtualScheduler({ instantCombat: false }) },
    { pool: trap, BattleClass: FakeBattle },
    { pool: trap, clientCombat: true },
  ]) {
    const h = fixture(t, { humans: 1, mode: 'solo', ...opts });
    assert.equal(h.m.combatPool, null);
    if (!h.m.clientCombat) {
      h.m.startCombat();
      assert.ok(h.m.runner instanceof FieldRunner);
      assert.equal(h.m.fields[0].battle instanceof RemoteBattle, false);
    }
    h.m.dispose();
    opts.scheduler?.dispose();
  }
});

test('workers: configuration strictly accepts only integer options/env 0..32 and defaults to off', async (t) => {
  for (const n of [0, 1, 2, 32]) {
    assert.equal(parseCombatWorkers(n), n);
    assert.equal(parseCombatWorkers(String(n)), n);
  }
  for (const n of [undefined, null, '']) assert.equal(parseCombatWorkers(n), 0);
  for (const n of [-1, 33, 1.5, NaN, Infinity, '1e1', '0x2', '01', '+2', '2 workers', ' ', true, {}, [], [2]]) {
    assert.throws(() => parseCombatWorkers(n), /SP_COMBAT_WORKERS/, `reject ${JSON.stringify(n)}`);
  }
  await assert.rejects(startServer({ port: 0, host: '127.0.0.1', combatWorkers: '1e1', quiet: true }), /SP_COMBAT_WORKERS/);
  const before = process.env.SP_COMBAT_WORKERS;
  t.after(() => { if (before === undefined) delete process.env.SP_COMBAT_WORKERS; else process.env.SP_COMBAT_WORKERS = before; });
  delete process.env.SP_COMBAT_WORKERS;
  const off = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => off.close());
  assert.equal(off.combatPool, null);
  const health = await (await fetch(`${off.url}/healthz`)).json();
  assert.deepEqual(health.combat, { backend: 'inline', workers: 0 });
  assert.equal(health.maxRooms, 0);
  process.env.SP_COMBAT_WORKERS = 'garbage';
  await assert.rejects(startServer({ port: 0, quiet: true }), /SP_COMBAT_WORKERS/);
  const override = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 0, quiet: true });
  t.after(() => override.close());
  assert.equal(override.combatPool, null, 'explicit zero takes precedence over env');
});

test('trial workers: configuration accepts 0..2, explicit zero overrides env, and worker0 never starts a trial pool', async (t) => {
  for (const n of [0, 1, 2]) {
    assert.equal(parseTrialWorkers(n), n);
    assert.equal(parseTrialWorkers(String(n)), n);
  }
  for (const n of [undefined, null, '']) assert.equal(parseTrialWorkers(n), 1);
  for (const n of [-1, 3, 1.5, NaN, Infinity, '1e0', '0x1', '01', '+1', ' ', true, {}, [], [1]]) {
    assert.throws(() => parseTrialWorkers(n), /SP_TRIAL_WORKERS/);
  }
  await assert.rejects(startServer({ port: 0, combatWorkers: 0, trialWorkers: 3, quiet: true }), /SP_TRIAL_WORKERS/);
  const before = process.env.SP_TRIAL_WORKERS;
  t.after(() => { if (before === undefined) delete process.env.SP_TRIAL_WORKERS; else process.env.SP_TRIAL_WORKERS = before; });
  process.env.SP_TRIAL_WORKERS = '2';
  const off = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 0, quiet: true });
  t.after(() => off.close());
  assert.equal(off.combatPool, null);
  assert.equal(off.trialPool, null);
  assert.equal((await (await fetch(`${off.url}/healthz`)).json()).trial.status, 'disabled');
  const override = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, trialWorkers: 0, quiet: true });
  t.after(() => override.close());
  assert.equal(override.combatPool.stats().ready, 1);
  assert.equal(override.trialPool, null);
  process.env.SP_TRIAL_WORKERS = 'bad';
  await assert.rejects(startServer({ port: 0, combatWorkers: 0, quiet: true }), /SP_TRIAL_WORKERS/);
});

test('trial workers: server mode defaults to 6+1, supports 6+2, and trial failure never changes combat health', { timeout: 30_000 }, async (t) => {
  const beforeMode = process.env.SP_COMBAT, beforeTrial = process.env.SP_TRIAL_WORKERS;
  t.after(() => {
    if (beforeMode === undefined) delete process.env.SP_COMBAT; else process.env.SP_COMBAT = beforeMode;
    if (beforeTrial === undefined) delete process.env.SP_TRIAL_WORKERS; else process.env.SP_TRIAL_WORKERS = beforeTrial;
  });
  process.env.SP_COMBAT = 'server';
  delete process.env.SP_TRIAL_WORKERS;
  for (const count of [undefined, 2]) {
    const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 6, trialWorkers: count, quiet: true });
    t.after(() => srv.close());
    const health = await (await fetch(`${srv.url}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.combat.ready, 6);
    assert.equal(health.trial.ready, count ?? 1);
    assert.equal(health.trial.scope, 'bot-rehearsal');
    assert.ok(['warming', 'ready'].includes(health.performance.status));
    assert.equal(srv.lobby.combatPool, srv.combatPool);
    assert.equal(srv.lobby.trialPool, srv.trialPool);
    assert.equal(srv.trialPool.role, 'trial');
    const threads = srv.combatPool.slots.map((slot) => slot.worker.threadId);
    await srv.trialPool.close();
    const response = await fetch(`${srv.url}/healthz`);
    assert.equal(response.status, 200);
    const down = await response.json();
    assert.equal(down.combat.ready, 6);
    assert.equal(down.trial.status, 'closed');
    assert.equal(down.trial.workers, 0);
    assert.ok(['warming', 'ready'].includes(down.performance.status), 'trial closure does not stop diagnostics');
    assert.deepEqual(srv.combatPool.slots.map((slot) => slot.worker.threadId), threads);
    const closeCombat = srv.combatPool.close.bind(srv.combatPool);
    srv.combatPool.close = (...args) => {
      assert.equal(srv.healthMetrics.snapshot().status, 'stopped', 'metrics are disposed before awaiting pool close');
      return closeCombat(...args);
    };
    await Promise.all([srv.close(), srv.close()]);
    assert.equal(srv.combatPool.stats().workers, 0);
    assert.equal(srv.trialPool.terminating.size, 0);
  }
  process.env.SP_COMBAT = 'client';
  const client = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, quiet: true });
  t.after(() => client.close());
  assert.equal(client.trialPool, null, 'default client mode does not add unused trial threads');
});

test('trial workers: handler startup failure closes both already-started pools', { timeout: 15_000 }, async (t) => {
  const original = CombatWorkerPool.prototype.start, captured = [];
  CombatWorkerPool.prototype.start = function (...args) { captured.push(this); return original.apply(this, args); };
  try {
    await assert.rejects(startServer({ port: 0, host: '127.0.0.1', publicDir: 1,
      combatWorkers: 1, trialWorkers: 1, quiet: true }), { code: 'ERR_INVALID_ARG_TYPE' });
  } finally {
    CombatWorkerPool.prototype.start = original;
    for (const pool of captured) t.after(() => pool.close());
  }
  assert.deepEqual(captured.map((pool) => pool.role), ['combat', 'trial']);
  for (const pool of captured) {
    assert.equal(pool.stats().status, 'closed');
    assert.equal(pool.stats().workers, 0);
    assert.equal(pool.terminating.size, 0);
  }
});

test('trial workers: failed trial startup closes only that pool and exposes inline degradation', { timeout: 15_000 }, async (t) => {
  const original = CombatWorkerPool.prototype.start;
  let failed = null, srv;
  const warnings = [];
  CombatWorkerPool.prototype.start = async function (...args) {
    await original.apply(this, args);
    if (this.role === 'trial') { failed = this; throw new Error('test trial bootstrap failed after starting'); }
    return this;
  };
  try {
    srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, trialWorkers: 1,
      log: { ...quiet, warn: (message) => warnings.push(message) } });
    t.after(() => srv.close());
  } finally {
    CombatWorkerPool.prototype.start = original;
    if (failed) t.after(() => failed.close());
  }
  assert.ok(failed);
  assert.equal(failed.stats().status, 'closed');
  assert.equal(failed.stats().workers, 0);
  assert.equal(failed.terminating.size, 0);
  assert.equal(srv.trialPool, null);
  assert.equal(srv.lobby.trialPool, null);
  const response = await fetch(`${srv.url}/healthz`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.combat.ready, 1);
  assert.equal(health.trial.backend, 'inline');
  assert.equal(health.trial.status, 'degraded');
  assert.ok(['warming', 'ready'].includes(health.performance.status));
  assert.ok(warnings.some((message) => message.includes('rehearsal stays inline')));
});

test('workers: health reports its streaming scope and becomes unavailable when the configured pool is gone', { timeout: 10_000 }, async (t) => {
  const logs = captureLog();
  const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 2, log: logs.log });
  t.after(() => srv.close());
  const healthy = await fetch(`${srv.url}/healthz`);
  assert.equal(healthy.status, 200);
  const up = await healthy.json();
  assert.equal(up.ok, true);
  assert.equal(up.combat.backend, 'workers');
  assert.equal(up.combat.scope, 'server-streaming');
  assert.equal(up.combat.ready, 2);
  assert.ok(['warming', 'ready'].includes(up.performance.status));
  const stats = srv.combatPool.stats;
  try {
    for (const [status, ready, expected] of [['ready', 1, 200], ['ready', 0, 503], ['starting', 1, 503]]) {
      srv.combatPool.stats = function () { return { ...stats.call(this), status, ready }; };
      const response = await fetch(`${srv.url}/healthz`);
      assert.equal(response.status, expected, 'readiness remains ready status AND at least one combat worker');
      assert.equal((await response.json()).ok, expected === 200);
      const head = await fetch(`${srv.url}/healthz`, { method: 'HEAD' });
      assert.equal(head.status, expected);
      assert.equal(await head.text(), '');
    }
  } finally { srv.combatPool.stats = stats; }
  // Closing before HTTP shutdown makes the unavailable state stable, rather than racing automatic replacement.
  await srv.combatPool.close();
  const unavailable = await fetch(`${srv.url}/healthz`);
  assert.equal(unavailable.status, 503);
  const down = await unavailable.json();
  assert.equal(down.ok, false);
  assert.equal(down.combat.status, 'closed');
  assert.equal(down.combat.ready, 0);
  assert.equal(down.combat.workers, 0);
  assert.equal(down.combat.backend, 'workers', 'never claim a silent inline fallback');
  assert.ok(['warming', 'ready'].includes(down.performance.status), 'combat readiness never controls diagnostics');
  assert.deepEqual(logs.errors, []);
});

test('workers: unavailable diagnostics never change ready combat health', { timeout: 10_000 }, async (t) => {
  const warnings = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, trialWorkers: 0,
    log: { ...quiet, warn: (message) => warnings.push(message) },
    healthMetricsFactory: () => { throw new Error('test metrics unavailable'); },
  });
  t.after(() => srv.close());
  const response = await fetch(`${srv.url}/healthz`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.combat.status, 'ready');
  assert.equal(health.combat.ready, 1);
  assert.equal(health.performance.status, 'unavailable');
  assert.equal(health.performance.windowMs, null);
  assert.equal(health.performance.process.cpu.percent, null);
  assert.equal(warnings.length, 1);
});

test('workers: unlimited default crosses the old4096-room boundary; positive caps remain opt-in', () => {
  const sessions = new Map();
  const lobby = new Lobby({ registry: { byId: (id) => sessions.get(id) }, log: quiet, getData: () => DATA });
  const session = (n, limitKey = null) => {
    const s = { playerId: `cap_${n}`, name: `Cap${n}`, connected: false, roomCode: null, limitKey };
    sessions.set(s.playerId, s);
    return s;
  };
  try {
    assert.equal(lobby.opts.maxRooms, 0);
    for (let n = 0; n < 4096; n++) assert.deepEqual(lobby.create(session(n), { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.equal(lobby.rooms.size, 4096);
    assert.ok([...lobby.rooms.values()].every((room) => room.match == null));
    const extra = session(4096);
    assert.deepEqual(lobby.create(extra, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.ok(extra.roomCode);
    assert.equal(lobby.rooms.size, 4097);
    lobby.disposeRoom(lobby.rooms.values().next().value, 'empty');
    assert.equal(lobby.rooms.size, 4096);
  } finally { lobby.shutdown(); }
  assert.equal(lobby.rooms.size, 0);
  assert.equal(lobby.graceTimers.size, 0);
  const capped = new Lobby({ registry: { byId: (id) => sessions.get(id) }, log: quiet, getData: () => DATA, options: { maxRooms: 2 } });
  try {
    for (let n = 0; n < 2; n++) assert.deepEqual(capped.create(session(`small${n}`), { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.equal(capped.create(session('blocked'), { mode: 'solo', difficulty: 'NORMAL' }).error, 'INTERNAL');
  } finally { capped.shutdown(); }
});

test('workers: encoded transport preserves room/seat admission, connection and backpressure boundaries without result-replay bypass', (t) => {
  const sent = [], sendOptions = [];
  let terminated = 0;
  const ws = { readyState: 1, bufferedAmount: 0,
    send(data, options, cb) { sent.push(data); sendOptions.push(options); (typeof options === 'function' ? options : cb)?.(); },
    terminate() { terminated++; } };
  const session = { playerId: 'p_0', name: 'Transport', connected: false, roomCode: null, ws };
  const sessions = new Map([['p_0', session]]);
  const lobby = new Lobby({ registry: { byId: (id) => sessions.get(id) }, log: quiet, getData: () => DATA });
  t.after(() => lobby.shutdown());
  assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.rooms.get(session.roomCode);
  const seat = room.seatOf('p_0');
  session.connected = true;
  seat.connected = true;
  const wires = {
    'm.field': JSON.stringify({ t: 'm.field', fieldId: 'n:p_0', kind: 'normal', units: [] }),
    'b.snap': JSON.stringify({ t: 'b.snap', fieldId: 'n:p_0', gt: 1, units: [] }),
    'b.ev': JSON.stringify({ t: 'b.ev', fieldId: 'n:p_0', gt: 1, ev: [] }),
    'b.damage': JSON.stringify({ t: 'b.damage', fieldId: 'n:p_0', gt: 1, owners: [] }),
    'm.damage': JSON.stringify({ t: 'm.damage', matchId: 'fixture', round: 1, status: 'frozen', owners: [] }),
  };
  const send = (type = 'b.snap', pid = 'p_0', data = wires[type]) => lobby.sendEncodedToPlayer(room, pid, type, data);
  for (const [type, wire] of Object.entries(wires)) {
    assert.equal(send(type), true);
    assert.equal(sent.at(-1), wire, 'the original wire string is passed unchanged');
    assert.equal(sendOptions.at(-1).compress, type !== 'b.damage', 'only allowlisted encoded battle types opt into compression');
  }
  const accepted = sent.length;
  assert.equal(send('b.snap', 'outsider'), false);
  seat.isBot = true; assert.equal(send(), false); seat.isBot = false;
  seat.left = true; assert.equal(send(), false); seat.left = false;
  session.connected = false; assert.equal(send(), false); session.connected = true;
  session.roomCode = 'ELSE'; assert.equal(send(), false); session.roomCode = room.code;
  sessions.delete('p_0'); assert.equal(send(), false); sessions.set('p_0', session);
  room.disposed = true; assert.equal(send(), false); room.disposed = false;
  ws.readyState = 3; assert.equal(send(), false); ws.readyState = 1;
  assert.equal(send('b.snap', 'p_0', {}), false);
  assert.equal(send('m.result', 'p_0', JSON.stringify({ t: 'm.result', victory: true })), false);
  assert.equal(room.replay, null, 'encoded sends cannot replace the result-replay lifecycle');
  assert.equal(sent.length, accepted, 'none of the denied frames reaches the socket');

  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  assert.equal(send('b.snap'), false, 'only snapshots may be dropped at the soft limit');
  assert.equal(send('b.ev'), true);
  assert.equal(send('m.field'), true, 'rejoin metadata is not droppable');
  assert.equal(send('m.damage'), true, 'frozen scores are not droppable snapshots');
  assert.equal(send('b.damage'), true, 'field scores are not droppable snapshots');
  const softAccepted = sent.length;
  ws.bufferedAmount = NET_DEFAULTS.hardBufferBytes + 1;
  assert.equal(send('b.ev'), false);
  assert.equal(terminated, 1, 'all frame types retain the hard-buffer termination rule');
  assert.equal(sent.length, softAccepted);
  ws.bufferedAmount = 0;

  let transportCalls = 0;
  const h = fixture(t, { humans: 1, mode: 'solo', sendEncoded: (pid, type, wire) => { transportCalls++; return send(type, pid, wire); } });
  assert.equal(h.m.sendEncoded('p_0', 'b.snap', wires['b.snap']), true);
  assert.equal(transportCalls, 1);
  assert.equal(h.m.sendEncoded('p_0', 'm.result', JSON.stringify({ t: 'm.result' })), false);
  assert.equal(h.m.sendEncoded('outsider', 'b.snap', wires['b.snap']), false);
  h.m.order[0].left = true;
  assert.equal(h.m.sendEncoded('p_0', 'b.snap', wires['b.snap']), false);
  h.m.order[0].left = false;
  h.m.dispose();
  assert.equal(h.m.sendEncoded('p_0', 'b.snap', wires['b.snap']), false);
  assert.equal(transportCalls, 1, 'Match also rejects result and unauthorized sends before the encoded callback');
});

test('workers: a real WS spectator receives encoded live/resync frames without player authority or private state', { timeout: 15_000 }, async (t) => {
  const logs = captureLog();
  class StreamingMatch extends Match {
    constructor(o) { super({ ...o, clientCombat: false, verify: 'off', timerScale: 0.02, combatSpeed: 2, botRehearsal: 0 }); }
  }
  const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, MatchClass: StreamingMatch, seedFn: () => 731, log: logs.log });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    const welcome = await c.hello(name, token); c.id = welcome.playerId; c.token = welcome.token;
    return c;
  };
  const ok = async (c, msg) => assert.equal((await c.request(msg)).t, 'ok', msg.t);
  const host = await connect('房主'), observer = await connect('观战');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const roomState = await host.waitFor('room.state');
  await ok(observer, { t: 'room.spectate', code: roomState.code });
  await ok(host, { t: 'room.start' });
  await ok(host, { t: 'g.infoReady' });
  await host.waitFor('m.public', (m) => m.phase === 'BAND_DRAFT');
  await ok(host, { t: 'g.band', bandId: 'band_bldsk' });
  await host.waitFor('m.public', (m) => m.phase === 'PREP');
  const room = srv.lobby.getRoom(roomState.code), m = room.match;
  assert.equal(m.order.length, 1);
  assert.equal(m.soloUntimed, true, 'a spectator does not make a second human player');
  assert.equal(m.revivalEnabled, false);
  m.wave = { ...m.wave, timeLimit: 90, spawns: [{ ...m.wave.spawns[0], time: 0.2, count: 1, interval: 0 }] };
  const encoded = [], send = m.opts.sendEncoded;
  m.opts.sendEncoded = (pid, type, wire) => { encoded.push({ pid, type, wire }); return send(pid, type, wire); };
  await ok(host, { t: 'g.ready', ready: true });
  await observer.waitFor('m.field', (f) => !f.prep);
  const snapshot = await observer.waitFor('b.snap', (s) => s.gt > 0);
  await observer.waitFor('b.ev');
  assert.ok(m.runner instanceof WorkerFieldRunner);
  assert.equal(m.players.has(observer.id), false);
  assert.ok(m.fields.every((f) => !f.players.includes(observer.id)));
  assert.equal((await observer.request({ t: 'g.revive', playerId: host.id, round: 1, matchId: m.battlePrefix })).code, 'SPECTATOR');
  await observer.terminate();
  const resumed = await connect('观战', observer.token);
  assert.equal(resumed.id, observer.id);
  assert.equal((await resumed.waitFor('room.state')).spectators[0].connected, true);
  const meta = await resumed.waitFor('m.field', (f) => !f.prep);
  const snap = await resumed.waitFor('b.snap');
  assert.equal(meta.fieldId, snapshot.fieldId);
  assert.ok(snap.gt >= snapshot.gt);
  assertSnapshotUnitStats(snapshot);
  assertSnapshotUnitStats(snap);
  assert.equal(resumed.log.filter((x) => x.t === 'm.field' || x.t === 'b.snap')[0].t, 'm.field');
  assert.equal(srv.lobby.stats().online, 2);
  for (const c of [observer, resumed]) assert.ok(!c.log.some((x) => ['m.private', 'm.toast', 'm.unitStats', 'b.start'].includes(x.t)));
  for (const type of ['m.field', 'b.snap', 'b.ev']) assert.ok(encoded.some((x) => x.pid === observer.id && x.type === type));
  await ok(host, { t: 'room.removeSpectator', playerId: resumed.id });
  assert.equal((await resumed.waitFor('room.closed')).reason, 'kicked');
  const at = encoded.filter((x) => x.pid === resumed.id).length;
  await delay(100);
  assert.equal(encoded.filter((x) => x.pid === resumed.id).length, at, 'removed spectators receive no worker frames');
  assert.equal(m.spectators.has(resumed.id), false);
  assert.equal(m.watchers.has(resumed.id), false);
  assert.deepEqual(logs.errors, []);
});

test('workers: real WS streaming, dynamic metadata reconnect, pause, room shutdown and worker teardown', { timeout: 30_000 }, async (t) => {
  const logs = captureLog();
  class StreamingMatch extends Match {
    constructor(o) { super({ ...o, clientCombat: false, verify: 'off', timerScale: 0.02, combatSpeed: 2, botRehearsal: 0 }); }
  }
  const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 2, MatchClass: StreamingMatch, seedFn: () => 731, log: logs.log });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  async function player(token) {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const welcome = await c.hello('Worker WS', token);
    c.id = welcome.playerId;
    c.token = welcome.token;
    return c;
  }
  async function ok(c, msg) { assert.equal((await c.request(msg)).t, 'ok', msg.t); }
  const a = await player();
  await ok(a, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const room = await a.waitFor('room.state');
  await ok(a, { t: 'room.start' });
  await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
  await ok(a, { t: 'g.infoReady' });
  await a.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT');
  await ok(a, { t: 'g.band', bandId: 'band_bldsk' });
  await a.waitFor('m.public', (p) => p.phase === 'PREP');
  const m = srv.lobby.rooms.get(room.code).match;
  assert.equal(m.combatPool, srv.combatPool, 'lobby injects the process-shared pool');
  const encoded = [], objectFrames = [];
  const sendWire = m.opts.sendEncoded;
  assert.equal(typeof sendWire, 'function', 'lobby supplies the pre-encoded transport');
  m.opts.sendEncoded = (pid, type, wire) => { encoded.push({ pid, type, wire }); return sendWire(pid, type, wire); };
  const sendObject = m.sendFn;
  m.sendFn = (pid, msg) => {
    if (msg.t === 'b.snap' || msg.t === 'b.ev' || (msg.t === 'm.field' && !msg.prep)) objectFrames.push(msg);
    return sendObject(pid, msg);
  };
  // A real equipped operator: the PREP preview and the actual owning worker's initial detail DTO must agree.
  const ps = m.players.get(a.id);
  for (const p of ps.board.values()) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.recompute();
  const chessId = 'chess_char_1_10_a';
  const tile = legalTileFor(m, ps, chessId);
  assert.ok(tile);
  const carrier = give(m, ps, chessId, 'board', tile);
  const blade = giveItem(m, ps, 'chess_item_3_07_e_a');
  await ok(a, { t: 'g.equip', itemUid: blade.uid, targetUid: carrier.uid });
  await ok(a, { t: 'g.unitStats', seq: 41 });
  const preview = (await a.waitFor('m.unitStats', (msg) => msg.seq === 41)).units.find((u) => u.uid === carrier.uid);
  assert.ok(preview.atk > preview.base.atk, 'the actual PREP numbers include equipment');
  // Keep the real wave but make one real enemy spawn after initialization, so the resync must refresh metadata.
  m.wave = { ...m.wave, timeLimit: 90, spawns: [{ ...m.wave.spawns[0], time: 0.2, count: 1, interval: 0 }] };
  await ok(a, { t: 'g.ready', ready: true });
  const initial = await a.waitFor('m.field', (f) => !f.prep);
  const initialSnap = await a.waitFor('b.snap', (s) => s.fieldId === initial.fieldId);
  assertSnapshotUnitStats(initialSnap);
  assert.deepEqual(initialSnap.unitStats, [], 'initial state is not started: undeployed operators must remain private');
  const firstLiveSnap = await a.waitFor('b.snap', (s) => s.unitStats?.some((u) => u.uid === carrier.uid));
  assertSnapshotUnitStats(firstLiveSnap);
  const first = firstLiveSnap.unitStats.find((u) => u.uid === carrier.uid);
  const { id: _previewId, ...want } = preview;
  const { id: _battleId, ...have } = first;
  assert.deepEqual(have, want, 'the worker sends real effective/base DTOs, not record-only stats');
  const enemyKey = m.wave.spawns[0].enemyKey;
  const spawned = await a.waitFor('b.snap', (s) => s.gt > 0 && s.unitStats?.some((u) => u.defId === enemyKey), 10_000);
  const spawnedIds = spawned.unitStats.filter((u) => u.defId === enemyKey).map((u) => u.id);
  assert.ok(spawnedIds.length > 0);
  assert.equal(a.log.some((x) => x.t === 'b.start'), false);
  assert.ok(m.runner instanceof WorkerFieldRunner);
  assert.ok(m.fields.every((f) => f.battle instanceof RemoteBattle));
  const health = await (await fetch(`${srv.url}/healthz`)).json();
  assert.equal(health.maxRooms, 0);
  assert.equal(health.combat.backend, 'workers');
  assert.equal(health.combat.workers, 2);
  assert.equal(health.combat.sessions, 1);
  await a.terminate();
  const b = await player(a.token);
  assert.equal(b.id, a.id);
  const refreshed = await b.waitFor('m.field', (f) => f.fieldId === initial.fieldId && !f.prep);
  for (const id of spawnedIds) assert.ok(refreshed.units.some((u) => u.id === id), `rejoin metadata contains spawned unit ${id}`);
  const snap = await b.waitFor('b.snap', (s) => s.fieldId === refreshed.fieldId);
  assert.ok(snap.gt >= spawned.gt);
  assertSnapshotUnitStats(spawned);
  assertSnapshotUnitStats(snap);
  const resumedStats = snap.unitStats.find((u) => u.uid === carrier.uid);
  assert.ok(resumedStats && resumedStats.atk > resumedStats.base.atk, 'the first real reconnect frame retains equipment bonuses');
  assert.deepEqual(resumedStats.base, preview.base);
  const order = b.log.filter((x) => x.t === 'm.field' || x.t === 'b.snap');
  assert.equal(order[0].t, 'm.field', 'metadata precedes the first reconnect snapshot');
  await ok(b, { t: 'g.pause', on: true });
  const pausedTick = m.runner.ticks;
  await delay(120);
  assert.equal(m.runner.ticks, pausedTick);
  await ok(b, { t: 'g.pause', on: false });
  await until(() => m.runner.ticks > pausedTick, 'real worker resumes after WS pause');
  for (const type of ['m.field', 'b.snap', 'b.ev']) {
    assert.ok(encoded.some((entry) => entry.type === type && entry.pid === a.id), `${type} traverses the encoded path`);
  }
  assert.ok(encoded.some((entry) => entry.wire === JSON.stringify(initial)), 'initial metadata arrives byte-equivalent to the worker wire');
  assert.ok(encoded.some((entry) => entry.wire === JSON.stringify(spawned)), 'snapshot arrives byte-equivalent to the worker wire');
  assert.ok(encoded.some((entry) => entry.wire === JSON.stringify(refreshed)), 'rejoin also uses the encoded path');
  assert.ok(encoded.some((entry) => entry.wire === JSON.stringify(snap)), 'reconnect details arrive byte-equivalent to the worker wire');
  for (const entry of encoded) if (entry.type === 'b.snap') assertSnapshotUnitStats(JSON.parse(entry.wire));
  assert.deepEqual(objectFrames, [], 'live worker frames never fall back to main-thread object encoding');
  assert.equal(typeof m.fields[0].battle._snapshotWire, 'string');
  assert.equal(m.fields[0].battle._snapshot, null, 'normal streaming keeps only the wire cache');
  const workers = srv.combatPool.slots.map((slot) => slot.worker);
  await Promise.all([srv.close(), srv.close()]);
  assert.equal((await b.waitFor('room.closed')).reason, 'shutdown');
  assert.equal((await b.closed).code, 1001);
  assert.equal(m.disposed, true);
  assert.equal(srv.lobby.rooms.size, 0);
  assert.equal(srv.combatPool.stats().status, 'closed');
  assert.equal(srv.combatPool.stats().sessions, 0);
  assert.equal(srv.combatPool.stats().pending, 0);
  assert.equal(srv.combatPool.stats().workers, 0);
  assert.ok(workers.every((w) => w.threadId === -1), 'close awaited worker termination');
  assert.deepEqual(logs.errors, [], 'clean server shutdown is not logged as a worker failure');
});
