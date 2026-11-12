// Shadow verification (server/match/verify/hub.js, match/shadowVerify.js; DESIGN §14): who may verify, what the hub
// counts, the reputation ledger (recorded only), the stats merge and the settings — then two real matches on one
// process with a real combat Worker pool, one verifying the other's battle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { VerifyHub, mergeVerifyStats, networkOf, normalizeSimClient, VERIFY_CAP_TICKS, SLOW_REST_MS } from '../../server/match/verify/hub.js';
import { ReputationLedger, LEDGER_WINDOW_MS } from '../../server/match/verify/ledger.js';
import { parseShadowVerify } from '../../server/match/verify/config.js';
import { resultHashOfResult } from '../../server/match/verify/hash.js';
import { createBattleFromSpec, resultCanonicalJson } from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { resultHashOf } from '../../shared/resultHash.js';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { DATA, give, legalTileFor } from './harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function clock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t, advance(ms) { t += ms; for (const x of timers) if (!x.cleared && !x.fired && x.at <= t) { x.fired = true; x.fn(); } },
    timers: { setTimeout(fn, ms) { const x = { fn, at: t + ms }; timers.push(x); return x; }, clearTimeout(x) { if (x) x.cleared = true; } },
  };
}
const client = (o = {}) => ({ eng: 'blink', os: 'android', dev: 'mobile', build: 'B1', id: `dev_${o.tag ?? 'x'}_0000`, verify: true, ...o });
function fakeMatch(code, seats, { round = 1, requireCs = false } = {}) {
  const sent = [];
  const m = { roomCode: code, round, requireCs, disposed: false, ended: false, data: { config: {} }, players: new Map(), sent,
    sendTo: (pid, msg) => { sent.push([pid, msg]); return true; } };
  seats.forEach((s, seat) => m.players.set(s.id, { playerId: s.id, seat, isBot: !!s.bot, connected: s.connected !== false, left: false,
    spectator: false, simClient: s.client === undefined ? null : s.client }));
  return m;
}
const field = (pid, kind = 'normal') => ({ kind, fieldId: `n:${pid}`, players: [pid], battle: { tickCount: 900 },
  spec: { kind, fieldId: `n:${pid}`, battleId: 'x', players: [{ playerId: pid, units: [] }], spawns: [] } });
function hubWith(config = {}, c = clock()) {
  let n = 0;
  const logs = [];
  const hub = new VerifyHub({ config: { verify: true, ...config }, now: c.now, timers: c.timers, pickIndex: () => 0, chance: () => 0,
    newId: () => `sv${++n}`, log: { info() {}, warn: (s) => logs.push(s), error() {} } });
  return { hub, c, logs };
}
const certify = (hub, ps) => { hub._seat(ps).certified = true; };
const RESULT = { reason: 'cleared', time: 30, killed: 3, total: 3, perPlayer: { p_a: { killed: 3, total: 3, perfect: true, leaked: [], unitsEnd: [] } } };

test('a battle goes to one certified seat of another official match with the owner\'s build — pseudonymized, with the hard cap', () => {
  const { hub } = hubWith();
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'own' }) }]);
  const b = fakeMatch('BBBB', [
    { id: 'q_ok', client: client({ tag: 'ok' }) }, { id: 'q_build', client: client({ tag: 'bu', build: 'B2' }) },
    { id: 'q_new', client: client({ tag: 'new' }) }, { id: 'q_off', client: client({ tag: 'off', verify: false }) },
    { id: 'q_dev', client: client({ tag: 'own' }) }, { id: 'q_gone', client: client({ tag: 'go' }), connected: false },
    { id: 'ai_0', bot: true, client: client({ tag: 'bot' }) },
  ]);
  const c = fakeMatch('CCCC', [{ id: 'r_cs', client: client({ tag: 'cs' }) }], { requireCs: true });
  for (const m of [a, b, c]) hub.register(m);
  for (const m of [a, b, c]) for (const ps of m.players.values()) if (ps.playerId !== 'q_new') certify(hub, ps);
  const f = field('p_a');
  assert.equal(hub.offer(a, f), 'sv1');
  assert.equal(b.sent.length, 1);
  const [to, msg] = b.sent[0];
  assert.equal(to, 'q_ok');
  assert.equal(msg.t, 'b.verify');
  assert.equal(msg.cap, VERIFY_CAP_TICKS);
  assert.equal(msg.spec.battleId, 'sv1');
  assert.equal(JSON.stringify(msg.spec).includes('p_a'), false, 'no player id of the owner\'s match');
  assert.equal(c.sent.length + a.sent.length, 0);
  assert.equal(hub.snapshot().jobs.offered, 1);
});

test('nothing is offered: off, boss fields, plugin specs, an uncertified or AI owner, no candidate, the rate', () => {
  const { hub } = hubWith({ verify: false });
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'a' }) }]);
  hub.register(a);
  assert.equal(hub.matches.size, 0, 'phase 0 registers no match');
  assert.equal(hub.offer(a, field('p_a')), null);
  const on = hubWith().hub;
  const b = fakeMatch('BBBB', [{ id: 'q_1', client: client({ tag: 'b' }) }]);
  on.register(a); on.register(b);
  certify(on, b.players.get('q_1'));
  assert.equal(on.offer(a, field('p_a')), null, 'the owner is not certified');
  assert.equal(on.snapshot().jobs.skipped.noOwner, 1);
  certify(on, a.players.get('p_a'));
  assert.equal(on.offer(a, field('p_a', 'boss')), null);
  const plugin = field('p_a'); plugin.spec.cs = 'a'.repeat(64);
  assert.equal(on.offer(a, plugin), null);
  assert.equal(on.snapshot().jobs.skipped.content, 1);
  b.players.get('q_1').connected = false;
  assert.equal(on.offer(a, field('p_a')), null);
  assert.equal(on.snapshot().jobs.skipped.noCandidate, 1);
  const rate = hubWith({ rate: 0.5 }).hub;
  rate.chance = () => 0.75;
  rate.register(a); rate.register(b); b.players.get('q_1').connected = true;
  certify(rate, a.players.get('p_a')); certify(rate, b.players.get('q_1'));
  assert.equal(rate.offer(a, field('p_a')), null);
  assert.equal(rate.snapshot().jobs.skipped.rate, 1);
});

test('one at a time per seat, perRound per round of its own match; the same network is excluded where addresses are known', () => {
  const { hub } = hubWith({ perRound: 1 });
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'a' }) }, { id: 'p_b', client: client({ tag: 'b' }) }]);
  const b = fakeMatch('BBBB', [{ id: 'q_1', client: client({ tag: 'q' }) }]);
  hub.register(a); hub.register(b);
  for (const m of [a, b]) for (const ps of m.players.values()) certify(hub, ps);
  const vid = hub.offer(a, field('p_a'));
  assert.ok(vid);
  assert.equal(hub.offer(a, field('p_b')), null, 'busy');
  hub.answer(b, b.players.get('q_1'), { vid, rh: 'f'.repeat(64), ms: 10 });
  assert.equal(hub.offer(a, field('p_b')), null, 'its one verification of this round is done');
  b.round = 2;
  assert.ok(hub.offer(a, field('p_b')), 'a new round of its own match');
  const net = hubWith().hub;
  net.register(a); net.register(b);
  for (const m of [a, b]) for (const ps of m.players.values()) certify(net, ps);
  const addr = { p_a: '203.0.113.7', q_1: '203.0.113.200' };
  net.setAddressResolver((pid) => addr[pid] ?? null);
  assert.equal(net.offer(a, field('p_a')), null, 'same /24');
  addr.q_1 = '198.51.100.9';
  assert.ok(net.offer(a, field('p_a')));
  assert.deepEqual(net.snapshot().ip, { checked: 2, unavailable: 0 });
  assert.equal(networkOf('::ffff:10.1.2.3'), '10.1.2');
  assert.equal(networkOf('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2');
});

test('outcomes: agree, a mismatch goes to the ledger, an error, a timeout rests the verifier, a late answer is counted', () => {
  const { hub, c, logs } = hubWith();
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'a' }) }]);
  const b = fakeMatch('BBBB', [{ id: 'q_1', client: client({ tag: 'q' }) }]);
  hub.register(a); hub.register(b);
  for (const m of [a, b]) for (const ps of m.players.values()) certify(hub, ps);
  const q = b.players.get('q_1');
  // agree: the answer before the server's result
  let f = field('p_a');
  let vid = hub.offer(a, f);
  const job = hub.jobs.get(vid);
  hub.answer(b, q, { vid, rh: resultHashOfResult(RESULT, job.rename), ticks: 900, ms: 420 });
  assert.equal(hub.snapshot().jobs.agree, 0, 'waits for the server');
  hub.serverResult(a, f, RESULT);
  assert.equal(hub.snapshot().jobs.agree, 1);
  // mismatch: the server's result first
  b.round = 2; f = field('p_a'); vid = hub.offer(a, f);
  hub.serverResult(a, f, RESULT);
  hub.answer(b, q, { vid, rh: '0'.repeat(64), ms: 300 });
  assert.equal(hub.snapshot().jobs.mismatch, 1);
  assert.equal(hub.ledger.count({ account: 'q_1' }), 1);
  assert.ok(logs.some((l) => l.includes('verifier hash')));
  // an answer from another seat is not heard; an error
  b.round = 3; f = field('p_a'); vid = hub.offer(a, f);
  hub.answer(a, a.players.get('p_a'), { vid, rh: '1'.repeat(64) });
  assert.ok(hub.jobs.has(vid));
  hub.answer(b, q, { vid, error: true });
  assert.equal(hub.snapshot().jobs.error, 1);
  // timeout → resting; the late answer
  b.round = 4; f = field('p_a'); vid = hub.offer(a, f);
  c.advance(20_000 + 2001);
  const s = hub.snapshot();
  assert.equal(s.jobs.timeout, 1);
  b.round = 5;
  assert.equal(hub.offer(a, field('p_a')), null, 'resting after a timeout');
  hub.answer(b, q, { vid, rh: '2'.repeat(64) });
  assert.equal(hub.snapshot().jobs.late, 1);
  c.advance(SLOW_REST_MS);
  assert.ok(hub.offer(a, field('p_a')));
  const rows = hub.snapshot().clients.filter((r) => r.role === 'verifier');
  assert.deepEqual(rows.map(({ agree, mismatch, error, timeout }) => ({ agree, mismatch, error, timeout })), [{ agree: 1, mismatch: 1, error: 1, timeout: 1 }]);
  assert.equal(hub.snapshot().latency.reduce((x, y) => x + y, 0), 3);
  assert.ok(hub.snapshot().deviceMs[1] >= 1);
});

test('a replica\'s end hash certifies its seat; a certified owner\'s wrong hash is recorded, an uncertified one is not', () => {
  const { hub } = hubWith();
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'a' }) }, { id: 'p_b', client: client({ tag: 'b' }) }]);
  const pa = a.players.get('p_a'), pb = a.players.get('p_b');
  const f = field('p_a');
  const good = resultHashOfResult(RESULT);
  hub.ownerDigest(a, pb, f, '3'.repeat(64)); // a teammate watching, before the server result
  hub.ownerDigest(a, pa, f, good);
  assert.equal(hub._seat(pa).certified, false);
  hub.serverResult(a, f, RESULT);
  assert.equal(hub._seat(pa).certified, true);
  assert.equal(hub._seat(pb).certified, false);
  assert.equal(hub.ledger.stats().records, 0, 'an uncertified replica and a watcher are never recorded');
  const f2 = field('p_a');
  hub.serverResult(a, f2, RESULT);
  hub.ownerDigest(a, pa, f2, '4'.repeat(64));
  assert.equal(hub.ledger.count({ account: 'p_a' }), 1);
  const snap = hub.snapshot();
  const own = snap.clients.find((r) => r.role === 'owner');
  assert.deepEqual([own.agree, own.mismatch], [1, 1]);
  assert.equal(snap.replicas[0].completed, 3);
});

test('the ledger: 7 days, the account OR the device, levels 1–4, and a match flagged at 4 (recorded only)', () => {
  let t = 0;
  const ledger = new ReputationLedger({ now: () => t });
  ledger.note({ account: 'p_1', device: 'dev_a' });
  t += 1000;
  ledger.note({ account: 'p_2', device: 'dev_a' }); // a new session on the same device
  ledger.note({ account: 'p_1', device: 'dev_b' }); // the same session on another device
  assert.equal(ledger.count({ account: 'p_1', device: 'dev_a' }), 3);
  assert.equal(ledger.level({ account: 'p_1', device: 'dev_a' }), 3);
  t += LEDGER_WINDOW_MS - 500;
  assert.equal(ledger.count({ account: 'p_1', device: 'dev_a' }), 2, 'the first record left the window');
  const { hub, logs } = hubWith();
  const a = fakeMatch('AAAA', [{ id: 'p_a', client: client({ tag: 'a' }) }]);
  for (let i = 0; i < 4; i++) hub._record(a, a.players.get('p_a'), 'verifier', 'normal');
  assert.equal(a.shadowFlags.unranked.records, 4);
  assert.equal(hub.snapshot().ledger.unrankedMatches, 1);
  assert.equal(hub.snapshot().ledger.level4, 1);
  assert.ok(logs.some((l) => l.includes('recorded only')));
});

test('phase 0 counters, the snapshot merge over nodes, the client descriptor, the settings', () => {
  const { hub } = hubWith({ verify: false });
  hub.noteFieldCpu('normal_human', { ms: 12.5, ticks: 900 });
  hub.noteFieldCpu('boss', { ms: 40, ticks: 2000 });
  hub.noteReplica(normalizeSimClient(client()), 'started');
  hub.noteReplica(normalizeSimClient(client()), 'diverged');
  hub.noteReplica(null, 'off');
  const s = hub.snapshot();
  assert.deepEqual(s.fields.normal_human, { fields: 1, ticks: 900, ms: 13 });
  assert.equal(s.replicas.find((r) => r.eng === 'blink').diverged, 1);
  const merged = mergeVerifyStats([s, hubWith({ verify: true }).hub.snapshot(), s, null]);
  assert.equal(merged.verify, true);
  assert.equal(merged.fields.boss.ms, 80);
  assert.equal(merged.replicas.find((r) => r.eng === 'blink').started, 2);
  assert.deepEqual(merged.edgesMs, s.edgesMs);
  assert.equal(merged.config.deadlineMs, 20_000);
  assert.equal(mergeVerifyStats([]), null);
  assert.deepEqual(normalizeSimClient({ eng: 'nope', os: 'ios', dev: 'tv', build: 'x y', id: 'short', verify: 1 }),
    { eng: 'other', os: 'ios', dev: 'desktop', build: null, id: null, verify: false });
  assert.deepEqual(parseShadowVerify({}), { verify: false, rate: 1, maxJobs: 64, perRound: 2, deadlineMs: 20_000 });
  assert.equal(parseShadowVerify({ SP_SHADOW_VERIFY: '1', SP_SHADOW_VERIFY_RATE: '0.25' }).rate, 0.25);
  for (const env of [{ SP_SHADOW_VERIFY: 'yes' }, { SP_SHADOW_VERIFY_RATE: '2' }, { SP_SHADOW_VERIFY_PER_ROUND: '0' },
    { SP_SHADOW_VERIFY_DEADLINE_MS: '100' }, { SP_SHADOW_VERIFY_MAX: '1.5' }]) assert.throws(() => parseShadowVerify(env), RangeError);
});

// ---------------------------------------------------------------------------------------------- real matches

async function until(predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { assert.ok(Date.now() < deadline, `timed out: ${label}`); await delay(5); }
}
function soloMatch(t, { pool, hub, code, pid, seed }) {
  const sent = [];
  const m = new Match({ roomCode: code, mode: 'solo', difficulty: 'NORMAL', seed, data: DATA,
    seats: [{ seat: 0, playerId: pid, name: pid, isBot: false, connected: true }],
    send: (to, msg) => { sent.push([to, structuredClone(msg)]); return true; }, broadcast() {}, onEnd() {},
    log: quiet, timerScale: 0.02, combatSpeed: 200, botRehearsal: 0, clientCombat: false, verify: 'off', combatPool: pool, verifyHub: hub });
  t.after(() => m.dispose());
  m.phase = 'PREP'; m.round = 1; m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, 1);
  for (const ps of m.order) {
    ps.lp = 40; ps.bandId = 'band_bldsk'; ps.invalidateDeployMap(); ps.recompute();
    for (const id of ['chess_char_1_10_a', 'chess_char_3_01_a', 'chess_char_2_02_a']) give(m, ps, id, 'board', legalTileFor(m, ps, id));
  }
  return { m, sent };
}

for (const honest of [true, false]) {
  test(`two matches on one process: a seat of B verifies A's server-run battle (${honest ? 'honest' : 'a wrong hash'})`, { timeout: 60_000 }, async (t) => {
    const pool = new CombatWorkerPool({ size: 1, data: DATA, log: quiet });
    t.after(() => pool.close());
    await pool.start();
    const hub = new VerifyHub({ config: { verify: true }, log: quiet });
    const A = soloMatch(t, { pool, hub, code: 'AAAA', pid: 'p_a', seed: 731 });
    const B = soloMatch(t, { pool, hub, code: 'BBBB', pid: 'q_b', seed: 732 });
    // what the pages say about themselves (g.sim client, as battle/clientInfo.js sends it)
    assert.deepEqual(A.m.handle('p_a', { t: 'g.sim', local: true, client: client({ tag: 'aaaa' }) }), { ok: true });
    assert.deepEqual(B.m.handle('q_b', { t: 'g.sim', local: true, client: client({ tag: 'bbbb' }) }), { ok: true });
    for (const m of [A.m, B.m]) certify(hub, m.players.values().next().value);
    A.m.startCombat();
    await until(() => B.sent.some(([, msg]) => msg.t === 'b.verify'), 'b.verify to B');
    const [, task] = B.sent.find(([, msg]) => msg.t === 'b.verify');
    assert.equal(JSON.stringify(task.spec).includes('p_a'), false);
    // the verifier's run, as battle/verifyWorker.js does it
    const b = createBattleFromSpec(task.spec, new DataSource(DATA, null), { quiet: true, recordEvents: false });
    while (!b.finished && b.tickCount < task.cap) b.step();
    const rh = honest ? await resultHashOf(resultCanonicalJson(b.result())) : 'e'.repeat(64);
    assert.deepEqual(B.m.handle('q_b', { t: 'g.verifyResult', vid: task.vid, rh, ticks: b.tickCount, ms: 5 }), { ok: true });
    await until(() => hub.snapshot().jobs.agree + hub.snapshot().jobs.mismatch > 0, 'the server result');
    const s = hub.snapshot();
    assert.equal(honest ? s.jobs.agree : s.jobs.mismatch, 1);
    assert.equal(hub.ledger.stats().records, honest ? 0 : 1);
    assert.ok(s.fields.normal_human.fields >= 1 && s.fields.normal_human.ms > 0 && s.fields.normal_human.ticks > 0, 'phase 0: Worker step time');
    assert.equal(A.m.errorCount ?? 0, 0);
  });
}
