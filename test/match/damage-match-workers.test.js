import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { planUnite } from '../../server/match/unite.js';
import { startServer } from '../../server/index.js';
import { DATA, give } from './harness.js';
import { TestClient } from '../helpers/wsClient.js';

const quiet = { info() {}, error() {}, warn() {}, debug() {} };
async function until(pred, ms = 10000) {
  const end = Date.now() + ms;
  while (!pred()) { assert.ok(Date.now() < end, 'local fixture timed out'); await delay(5); }
}
function fixture(t, { pool = null, humans = 2, clientCombat = false, real = false, speed = 200 } = {}) {
  const sent = [], errors = [];
  const scheduler = real ? undefined : new VirtualScheduler({ instantCombat: false });
  const m = new Match({ roomCode: 'SCOR', matchNo: 9, mode: 'coop', difficulty: 'NORMAL', seed: 731, data: DATA,
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Score ${seat}`, isBot: false, connected: true })),
    send(pid, packet) { sent.push([pid, structuredClone(packet)]); return true; }, broadcast() {}, onEnd() {},
    log: { ...quiet, error(...args) { errors.push(args.map(String).join(' ')); } },
    scheduler, combatPool: pool, clientCombat, verify: 'off', combatSpeed: speed, timerScale: 0.02, botRehearsal: 0 });
  t.after(() => { m.dispose(); scheduler?.dispose(); });
  m.phase = 'PREP'; m.round = 1; m.stageId = 'act1autochess_m01'; m.stage = m.gd.stage(m.stageId);
  m.gd.config = { ...m.gd.config, dp: { ...m.gd.config.dp, init: 99, max: 99 } };
  m.wave = { timeLimit: 4, spawns: [], routes: [{ motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }], overrides: {}, templateId: 'fixture_score' };
  for (const ps of m.order) { ps.lp = 100; ps.bandId = 'band_bldsk'; ps.invalidateDeployMap(); ps.recompute(); }
  const last = (pid) => sent.filter(([p, msg]) => p === pid && msg.t === 'm.damage').at(-1)?.[1];
  return { m, sent, errors, scheduler, last };
}
function deploy(m, ps, count = 1) {
  return Array.from({ length: count }, (_, i) => give(m, ps, 'chess_char_4_22_b', 'board', [9 + i, 8]));
}
const owner = (packet, pid = 'p0') => packet.owners.find((o) => o.playerId === pid);
const hit = (b, u, e, n) => b.dealDamage(u, e, { type: 'true', amount: n });
const tokenDef = { tokenId: 'score_fixture_token', stats: { maxHp: 100, atk: 0, blockCnt: 0, cost: 0 }, rangeGrid: [] };

for (const poolSize of [0, 6]) test(`actual Match ${poolSize ? '6 workers' : 'inline'}: normal+unite freeze, unseen-owner reconnect and new battle reset`, { timeout: 15000 }, async (t) => {
  let pool = null;
  if (poolSize) {
    pool = new CombatWorkerPool({ size: poolSize, data: DATA, log: quiet });
    t.after(() => pool.close()); await pool.start(); assert.equal(pool.stats().ready, 6);
  }
  const h = fixture(t, { pool, real: !!pool });
  const { m } = h;
  deploy(m, m.order[0], 2);
  m.wave.spawns = [{ time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 1, interval: 0 }];
  const oldFields = [];
  m.startCombat(); oldFields.push(...m.fields);
  if (pool) {
    await until(() => m.damageBoard.status === 'frozen');
  } else {
    h.scheduler.runUntil(() => m.damageBoard.status === 'frozen', { maxSteps: 10000 });
  }
  assert.equal(m.damageBoard.status, 'frozen');
  const frozen = m.damageBoard.packet();
  assert.equal(frozen.matchId, m.publicView().matchId);
  assert.equal(frozen.matchId, m.battlePrefix);
  assert.ok(owner(frozen).total > 0, 'real operators removed actual enemy HP');
  assert.ok(owner(frozen).operators.length >= 2, 'two copies of the same definition remain separate');
  const original = owner(frozen).total;
  assert.equal(m._onDamageRows(oldFields[0], { owners: [{ ...owner(frozen), total: original + 1000 }] }), false);
  assert.equal(owner(m.damageBoard.packet()).total, original, 'frozen scores cannot be overwritten by repeats');
  if (pool) await until(() => m.phase === 'PREP' && m.round === 2);
  else h.scheduler.runUntil(() => m.phase === 'PREP' && m.round === 2, { maxSteps: 10000 });
  assert.equal(m.fields.length, 0);
  assert.equal(m.damageBoard.packet().round, 1, 'next PREP still displays the completed previous round');
  m.onDisconnect('p1'); m.onReconnect('p1');
  assert.equal(owner(h.last('p1')).total, original, 'reconnect has a complete teammate score without prior watching');
  assert.deepEqual(m.handle('p1', { t: 'g.watch', fieldId: 'n:p0' }), { ok: true });
  assert.equal(owner(h.last('p1')).total, original);
  m.startCombat();
  assert.equal(m.damageBoard.packet().round, 2);
  assert.equal(m.damageBoard.packet().status, 'live');
  assert.equal(owner(m.damageBoard.packet()).total, 0);
  const before = structuredClone(m.damageBoard.packet());
  m._onDamageRows(oldFields[0], frozen);
  assert.deepEqual(m.damageBoard.packet(), before, 'old phase objects cannot mutate a reused field id');
  m.dispose(); m.dispose();
  assert.equal(m.damageBoard.status, 'frozen');
  assert.equal(m._damageTimer, null);
  assert.deepEqual(h.errors, []);
});

test('actual inline Match retains summon/dead/redeploy/device history and replaces normal+unite absolute rows', (t) => {
  const h = fixture(t); const { m } = h;
  const [piece] = deploy(m, m.order[0]);
  m.startCombat();
  for (const f of m.fields) f.battle.start();
  const field = m.fields[0], b = field.battle, u = b.players[0].units.find((x) => x.uid === piece.uid);
  const e = b.spawnEnemy('enemy_1007_slime', { routeIndex: 0, pos: [9, 10], mods: { hpMul: 100, speedMul: 0 } });
  const token = b.spawnToken(u, 'score_fixture_token', 10, 4, { def: tokenDef });
  hit(b, u, e, 30); hit(b, token, e, 40);
  b.retreat(token, { reason: 'expired', permanent: true }); b.retreat(u);
  hit(b, token, e, 10); hit(b, u, e, 5);
  assert.ok(b.redeploy(u)); hit(b, u, e, 7);
  const device = b.spawnDevice('score_fixture_device', 11, 4); device.ownerId = 'p0'; hit(b, device, e, 13);
  m._sampleDamage(true);
  let r = owner(m.damageBoard.packet());
  assert.equal(r.total, 105); assert.equal(r.operators[0].damage, 92); assert.equal(r.otherDamage, 13);
  const second = m.fields[1].battle;
  second.spawnEnemy('enemy_1007_slime', { routeIndex: 0, pos: [9, 10], mods: { speedMul: 0 } });
  b.kill(e, u); // helper clears, p1 leaks and enters a real unite plan
  m.runner.forceAll('timeout');
  const plan = planUnite(m, m.lastResults); assert.ok(plan);
  m.startUnite(plan);
  const ub = m.fields[0].battle; ub.start();
  const uu = ub.players[0].units.find((x) => x.uid === piece.uid);
  const ue = ub.spawnEnemy('enemy_1007_slime', { routeIndex: 0, pos: [9, 10], mods: { hpMul: 100, speedMul: 0 } });
  hit(ub, uu, ue, 25); m._sampleDamage(true); m._sampleDamage(true);
  r = owner(m.damageBoard.packet()); assert.equal(r.total, 130); assert.equal(r.operators[0].damage, 117);
  m.runner.forceAll('timeout');
  m.settle(plan, ub.result());
  assert.equal(owner(m.damageBoard.packet()).total, 130, 'repeated result callbacks do not add totals');
  assert.equal(m.damageBoard.status, 'frozen');
  const metadata = structuredClone(m.damageBoard.packet());
  m.order[0].board.clear(); m.startRound(2);
  assert.deepEqual(m.damageBoard.packet(), metadata, 'board clear/sell/next prep cannot erase the frozen rows');
  assert.deepEqual(h.errors, []);
});

for (const hidden of [false, true]) test(`actual ${hidden ? 'hidden' : 'boss'} Match packets preserve group privacy through frozen field display`, async (t) => {
  const pool = new CombatWorkerPool({ size: 6, data: DATA, log: quiet }); t.after(() => pool.close()); await pool.start();
  const h = fixture(t, { pool, real: true, humans: 4, speed: 2 }); const { m } = h;
  m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
  m.hiddenLayerSum = 0;
  for (const ps of m.order) deploy(m, ps);
  if (hidden) m.teamLp = 400;
  m.startFinalAssault(hidden);
  await until(() => m.runner.ready && m.runner.ticks > 0);
  m._flushDamage(true);
  const own = m.fields.find((f) => f.players.includes('p0'));
  const other = m.fields.find((f) => f !== own);
  assert.equal(own.players.length, 2); assert.equal(other.players.length, 2);
  assert.deepEqual(h.last('p0').owners.map((o) => o.playerId), own.players);
  assert.equal(m.handle('p0', { t: 'g.watch', fieldId: other.fieldId }).error, 'BAD_TARGET');
  m.onReconnect('p0'); assert.deepEqual(h.last('p0').owners.map((o) => o.playerId), own.players);
  m.addSpectator('observer'); assert.equal(h.last('observer').owners.length, 4);
  m.order[3].alive = false; m._sendDamageTo('p3'); assert.equal(h.last('p3').owners.length, 4);
  m.runner.forceAll();
  await until(() => m.damageBoard.status === 'frozen');
  assert.equal(h.last('p0').status, 'frozen');
  assert.deepEqual(h.last('p0').owners.map((o) => o.playerId), own.players, 'completion delay does not expose the other group');
  m.startRound(m.round + 1);
  m._sendDamageTo('p0'); assert.equal(h.last('p0').owners.length, 4, 'no-field preparation uses existing teammate scouting scope');
  assert.deepEqual(h.errors, []);
});

test('four inline fields coalesce absolute score batches at real 1Hz, not four broadcasts per sample', (t) => {
  const h = fixture(t, { humans: 4, speed: 2 }); const { m } = h;
  m.wave.timeLimit = 60;
  m.wave.spawns = [{ time: 59, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 1 }];
  for (const ps of m.order) deploy(m, ps);
  m.startCombat(); m.flush();
  const before = h.sent.filter(([, p]) => p.t === 'm.damage').length;
  for (const f of m.fields) {
    const b = f.battle; b.start();
    const e = b.spawnEnemy('enemy_1007_slime', { routeIndex: 0, pos: [9, 10], mods: { hpMul: 100, speedMul: 0 } });
    hit(b, b.players[0].units[0], e, 30);
    m._onDamageRows(f, b.damageRows());
  }
  m.flush();
  assert.equal(h.sent.filter(([, p]) => p.t === 'm.damage').length, before);
  h.scheduler.advance(999);
  assert.equal(h.sent.filter(([, p]) => p.t === 'm.damage').length, before);
  h.scheduler.advance(1);
  const packets = h.sent.slice().filter(([, p]) => p.t === 'm.damage');
  assert.equal(packets.length - before, 4, 'one complete batch per permitted viewer, not one per field');
  for (const ps of m.order) assert.equal(h.last(ps.playerId).owners.length, 4);
});

test('client-authoritative Match explicitly has no trusted operator meter and never reads submitted unit stats', (t) => {
  const h = fixture(t, { clientCombat: true }); const { m } = h;
  deploy(m, m.order[0]); m.startCombat();
  const packet = h.last('p0');
  assert.equal(packet.available, false); assert.deepEqual(packet.owners, []);
  assert.equal(packet.matchId, m.publicView().matchId);
  m._onDamageRows(m.fields[0], { owners: [{ playerId: 'p0', total: 1e12, otherDamage: 0, operators: [] }] });
  m._sendDamageTo('p0'); assert.deepEqual(h.last('p0').owners, []);
  assert.ok(h.sent.some(([, p]) => p.t === 'b.start' && p.authoritative), 'old client battle authority still starts normally');
});

test('actual WS six-worker scoreboard delivery and spectator reconnect expose only public score rows', { timeout: 15000 }, async (t) => {
  class ScoringMatch extends Match { constructor(opts) { super({ ...opts, clientCombat: false, verify: 'off', timerScale: 0.02, combatSpeed: 200, botRehearsal: 0 }); } }
  const srv = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 6, MatchClass: ScoringMatch, seedFn: () => 731, log: quiet });
  const clients = []; t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  async function connect(name, token) {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    const w = await c.hello(name, token); c.id = w.playerId; c.token = w.token; return c;
  }
  const ok = async (c, msg) => assert.equal((await c.request(msg)).t, 'ok', msg.t);
  const host = await connect('ScoreHost'), observer = await connect('Observer');
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const room = await host.waitFor('room.state');
  await ok(observer, { t: 'room.spectate', code: room.code }); await ok(host, { t: 'room.start' });
  const info = await host.waitFor('m.public', (p) => p.phase === 'INFO_CHECK'); assert.ok(info.matchId);
  await ok(host, { t: 'g.infoReady' }); await host.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT');
  await ok(host, { t: 'g.band', bandId: 'band_bldsk' }); await host.waitFor('m.public', (p) => p.phase === 'PREP');
  const m = srv.lobby.getRoom(room.code).match;
  deploy(m, m.order[0]); m.wave = { ...m.wave, timeLimit: 4 };
  await ok(host, { t: 'g.ready', ready: true });
  const initial = await observer.waitFor('m.damage', (p) => p.status === 'live'); assert.equal(initial.matchId, info.matchId);
  const frozen = await observer.waitFor('m.damage', (p) => p.status === 'frozen', 5000);
  assert.ok(frozen.owners.length > 0);
  for (const row of frozen.owners) assert.deepEqual(Object.keys(row), ['playerId', 'name', 'seat', 'total', 'operators', 'otherDamage']);
  assert.equal(observer.log.some((p) => p.t === 'm.private'), false);
  await observer.close(); const resumed = await connect('Observer', observer.token);
  const replay = await resumed.waitFor('m.damage', (p) => p.status === 'frozen', 5000);
  assert.deepEqual(replay.owners, frozen.owners);
  assert.equal(replay.matchId, info.matchId);
});
