// Terminal fanout only: real engine/Worker views stay fresh; accepted sends are not delivery ACKs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { RemoteBattle, WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { FieldRunner, emptyPerPlayer } from '../../server/match/fields.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { combatData } from '../../server/match/combat/data.js';
import { TICK } from '../../server/sim/constants.js';
import { NET_DEFAULTS, sendRaw } from '../../server/net.js';
import { TestClient } from '../helpers/wsClient.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

function unequalNormal() {
  const input = phase('normal');
  input.specs[0].timeLimit = 1;
  input.specs[1].timeLimit = 4;
  return { ...input, wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 5 };
}

function adapter(input, send = () => true) {
  let now = 1000, completions = 0;
  const sent = [], effects = [];
  const fields = input.specs.map((spec) => ({ spec, fieldId: spec.fieldId, kind: spec.kind,
    players: spec.players.map(p => p.playerId), live: true, battle: new RemoteBattle(spec) }));
  const m = {
    disposed: false, ended: false, paused: false, gameSpeed: 2,
    players: new Map([['p0', { connected: true }], ['p1', { connected: true }]]),
    spectators: new Map(), watchers: new Map([['p0', fields[0].fieldId]]),
    sched: { now: () => now, clearInterval() {}, setInterval() {} },
    watchersOf(id) { return [...this.watchers].filter(([, fid]) => fid === id).map(([pid]) => pid); },
    sendEncoded(pid, type, wire) { sent.push({ pid, type, wire }); return send(pid, type, wire); },
    sendTo(pid, msg) { return this.sendEncoded(pid, msg.t, JSON.stringify(msg)); },
    markPublic() {}, guard(fn) { fn(); }, reportError(label, e) { throw new Error(`${label}: ${e}`); },
    _onDamageRows() { return false; },
    bossPool: { hp: 0, byPlayer: new Map(), damage(pid, amount) { effects.push({ type: 'bossDamage', playerId: pid, amount }); } },
    _teamLpLoss(amount) { effects.push({ type: 'lpLoss', amount }); }, _syncTeamLp() {},
  };
  const runner = new WorkerFieldRunner(m, fields, { onDone() { completions++; } });
  m.runner = runner;
  return { m, runner, fields, sent, effects, clock(value) { now = value; }, get completions() { return completions; } };
}
const snaps = (h, pid = 'p0') => h.sent.filter(s => s.pid === pid && s.type === 'b.snap');

function normalReference(input) {
  const fields = input.specs.map(spec => ({ fieldId: spec.fieldId, kind: spec.kind,
    players: spec.players.map(p => p.playerId), battle: createBattleFromSpec(spec, combatData(DATA), { logger: QUIET }) }));
  const runner = new FieldRunner({ markPublic() {}, watchersOf() { return []; }, reportError(label, e) { throw new Error(`${label}: ${e}`); } },
    fields, { onDone() {} });
  return { fields, runner };
}

test('natural early/late normal endings retain fresh Worker cache and exact original results; phase final bypasses dedupe', () => {
  const input = unequalNormal();
  const engine = new CombatEngine(input, { data: DATA, log: QUIET });
  const reference = normalReference(input);
  const h = adapter(input);
  try {
    h.runner._apply(engine.state({ snapshotFields: [input.specs[0].fieldId] }));
    let out;
    do {
      out = engine.advance(1, { snapshotFields: [input.specs[0].fieldId] });
      h.runner._apply(out);
      reference.runner._tick(); reference.runner._checkDone();
    } while (out.fields[0].live);
    assert.equal(out.done, false, 'the second real battle is still running');
    assert.equal(out.fields[0].result.reason, 'timeout', 'natural time limit, not forceField');
    const terminal = h.fields[0].battle._snapshotWire;
    const at = snaps(h).length;
    for (let i = 0; i < 10; i++) {
      out = engine.advance(1, { snapshotFields: [input.specs[0].fieldId] });
      assert.equal(out.frames.find(f => f.fieldId === input.specs[0].fieldId).snapshotWire, terminal, 'engine still supplies the current final baseline');
      h.runner._apply(out);
      reference.runner._tick(); reference.runner._checkDone();
    }
    assert.equal(snaps(h).length, at, 'identical terminal fanout is suppressed within the retry window');
    assert.equal(h.fields[0].battle._snapshotWire, terminal);
    do {
      out = engine.advance(1, { snapshotFields: [input.specs[0].fieldId] });
      h.runner._apply(out);
      reference.runner._tick(); reference.runner._checkDone();
    } while (!out.done);
    assert.equal(snaps(h).at(-1).wire, terminal, 'phase completion retries the unchanged early final even in the same real millisecond');
    assert.ok(snaps(h).length > at);
    assert.equal(h.completions, 1);
    assert.deepEqual(out.fields.map(f => f.result), reference.fields.map(f => reference.runner.resultOf(f)));
    assert.deepEqual(h.fields.map(f => f.battle.result()), out.fields.map(f => f.result));
    assert.equal(out.ticks, reference.runner.ticks);
    assert.deepEqual(out.effects, []);
  } finally { h.runner.stop(); engine.dispose(); }
});

class BossProbe {
  constructor(opts) {
    this.opts = opts; this.fieldId = opts.fieldId; this.kind = opts.kind; this.sharedBoss = opts.sharedBoss;
    this.time = 0; this.tickCount = 0; this.finished = false; this.errors = []; this.hooks = new Map(); this.events = [];
    this.revision = 0;
  }
  on(name, fn) { this.hooks.set(name, fn); return name; }
  off(name) { this.hooks.delete(name); }
  step() {
    this.time = ++this.tickCount * TICK;
    if (this.opts.flags.hit) this.sharedBoss.damage(this.opts.players[0].playerId, this.opts.flags.hit);
    if (this.opts.flags.end) this.forceEnd('cleared');
  }
  forceEnd(reason) { this.finished = true; this.reason = reason; }
  result() { return { reason: this.reason, time: this.time, errors: 0,
    perPlayer: Object.fromEntries(this.opts.players.map(p => [p.playerId, emptyPerPlayer()])) }; }
  snapshot() { return { fieldId: this.fieldId, t: this.time, hp: this.sharedBoss.hp, units: [] }; }
  fieldMeta() { return { fieldId: this.fieldId, units: [], revision: this.revision, ended: this.finished }; }
  drainEvents() { return this.events.splice(0); }
}
function bossProbe() {
  return { wireFrames: true, coalesceFrames: true,
    boss: { maxHp: 100, hp: 100, teamLp: 100, bossOvertimeAfterReal: 100 },
    specs: [{ end: true }, { hit: 3 }].map((flags, i) => ({ fieldId: `b${i}`, kind: 'boss', flags,
      players: [{ playerId: `p${i}` }], spawns: [] })) };
}

test('finished Boss snapshots retain later same-tick/shared HP, same-gt meta changes and every reliable event', () => {
  const input = bossProbe();
  const engine = new CombatEngine(input, { BattleClass: BossProbe, log: QUIET });
  const h = adapter(input);
  try {
    const first = engine.advance(1, { snapshotFields: ['b0'] });
    h.runner._apply(first);
    assert.deepEqual(snaps(h).map(s => JSON.parse(s.wire).hp), [100, 97], 'later field hit refreshes the already-ended field in this very tick');
    const gt = JSON.parse(snaps(h).at(-1).wire).gt;
    const next = engine.advance(1, { snapshotFields: ['b0'] });
    h.runner._apply(next);
    assert.equal(JSON.parse(snaps(h).at(-1).wire).hp, 94);
    assert.equal(JSON.parse(snaps(h).at(-1).wire).gt, gt, 'gt-only dedupe would lose this shared HP');
    engine.fields[1].battle.opts.flags.hit = 0;
    h.runner._apply(engine.advance(0));
    const at = snaps(h).length;
    engine.fields[0].battle.revision++;
    h.runner._apply(engine.advance(0));
    assert.equal(snaps(h).length, at + 1, 'changed metadata at the same gt forces a snapshot and cache refresh');
    assert.equal(JSON.parse(h.fields[0].battle._metaWire).revision, 1);
    engine.fields[0].battle.events.push(['effect', 'terminal']);
    h.runner._apply(engine.advance(0));
    assert.equal(snaps(h).length, at + 1);
    assert.deepEqual(JSON.parse(h.sent.filter(s => s.type === 'b.ev').at(-1).wire).ev, [['effect', 'terminal']]);
    assert.deepEqual(h.effects, [...first.effects, ...next.effects], 'ordered effects are applied once despite snapshot dedupe');
    const forced = engine.forceAll();
    h.runner._apply(forced);
    assert.equal(JSON.parse(snaps(h).at(-1).wire).hp, forced.boss.hp);
    assert.equal(h.completions, 1);
  } finally { h.runner.stop(); engine.dispose(); }
});

test('soft-drop failures retry immediately; accepted-but-lost baselines retry at 1s, never become a terminal latch', () => {
  const input = unequalNormal();
  let reject = true, delivered = 0;
  const engine = new CombatEngine(input, { data: DATA, log: QUIET });
  const h = adapter(input, (pid, type) => {
    if (type !== 'b.snap') return true;
    if (reject) return false;
    delivered++; return true;
  });
  try {
    h.runner._apply(engine.forceField(input.specs[0].fieldId));
    const at = snaps(h).length;
    h.runner._apply(engine.advance(0));
    assert.equal(snaps(h).length, at + 1, 'failed local enqueue does not count as a delivered baseline');
    assert.equal(h.runner.terminalSnapshots.size, 0);
    reject = false;
    h.runner._apply(engine.advance(0));
    assert.equal(delivered, 1);
    h.clock(1999); h.runner._apply(engine.advance(0));
    assert.equal(delivered, 1);
    h.clock(2000); h.runner._apply(engine.advance(0));
    assert.equal(delivered, 2, 'accepted enqueue may be dropped by a downstream ingress; retry is still owed');
    h.clock(100); h.runner._apply(engine.advance(0));
    assert.equal(delivered, 3, 'a backwards wall clock must not suppress a final indefinitely');
  } finally { h.runner.stop(); engine.dispose(); }
});

test('state, watch, fresh viewer and rejoin bypass previous terminal content; paused explicit state retains its bypass', async () => {
  const input = unequalNormal();
  const engine = new CombatEngine(input, { data: DATA, log: QUIET });
  const h = adapter(input);
  try {
    h.runner._apply(engine.forceField(input.specs[0].fieldId));
    const at = snaps(h).length;
    h.runner._apply(engine.advance(0));
    assert.equal(snaps(h).length, at);
    h.runner.session = { request(op, payload) { assert.equal(op, 'state'); return Promise.resolve(engine.state(payload)); }, close() {} };
    h.runner._request('state', { snapshotFields: [input.specs[0].fieldId] });
    await Promise.resolve();
    assert.equal(snaps(h).length, at + 1, 'explicit state response is not deduped');
    h.m.paused = true;
    h.runner._request('state', { snapshotFields: [input.specs[0].fieldId] });
    await Promise.resolve();
    assert.equal(snaps(h).length, at + 1, 'pre-pause state stays held');
    h.m.paused = false;
    h.runner.resume();
    assert.equal(snaps(h).length, at + 2, 'held state still bypasses dedupe after resume');
    h.m.watchers.set('p1', input.specs[0].fieldId);
    h.runner._apply(engine.advance(0));
    assert.equal(snaps(h, 'p1').length, 1, 'new viewer has no other viewer\'s terminal latch');
    h.m.players.get('p0').connected = false;
    h.runner._apply(engine.advance(0));
    assert.equal(h.runner.terminalSnapshots.has('p0'), false);
    h.m.players.get('p0').connected = true;
    h.runner.requestField('p0', input.specs[0].fieldId);
    const before = h.sent.length;
    h.runner._apply(engine.state({ snapshotFields: [input.specs[0].fieldId] }));
    assert.deepEqual(h.sent.slice(before).filter(s => s.pid === 'p0').map(s => s.type), ['m.field', 'b.snap', 'b.damage']);
    assert.equal(h.runner.resync.has('p0'), false);
    h.m.watchers.set('p0', input.specs[1].fieldId);
    h.runner.requestField('p0', input.specs[1].fieldId);
    h.runner._apply(engine.state({ snapshotFields: [input.specs[1].fieldId] }));
    h.m.watchers.set('p0', input.specs[0].fieldId);
    h.runner.requestField('p0', input.specs[0].fieldId);
    const switchAt = snaps(h).length;
    h.runner._apply(engine.state({ snapshotFields: [input.specs[0].fieldId] }));
    assert.equal(snaps(h).length, switchAt + 1, 'switching back replays a current baseline');
    h.m.spectators.set('observer', { connected: true });
    h.m.watchers.set('observer', input.specs[0].fieldId);
    h.runner.requestField('observer', input.specs[0].fieldId);
    h.runner._apply(engine.state({ snapshotFields: [input.specs[0].fieldId] }));
    assert.equal(snaps(h, 'observer').length, 1);
    h.runner.stop();
    assert.equal(h.runner.terminalSnapshots.size, 0, 'phase cancellation releases per-viewer wires');
  } finally { h.runner.stop(); engine.dispose(); }
});

// RFC6455 server-to-client framing without PMD/masking. This is a local payload/socket budget, not TLS or WAN.
const frameBytes = wire => Buffer.byteLength(wire) + (Buffer.byteLength(wire) < 126 ? 2 : Buffer.byteLength(wire) < 65536 ? 4 : 10);

test('real local Worker + loopback WS: ten post-early-end replies retain events/results with bounded terminal wire replay', { timeout: 15_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise(resolve => wss.close(resolve));
  });
  await once(wss, 'listening');
  const input = unequalNormal();
  const peers = [];
  for (let i = 0; i < 2; i++) {
    const accepted = once(wss, 'connection');
    const client = await TestClient.connect(`ws://127.0.0.1:${wss.address().port}`, { wsOptions: { perMessageDeflate: false } });
    const [ws] = await accepted;
    t.after(() => client.terminate());
    let softDrop = false;
    const h = adapter(input, (pid, type, wire) => {
      assert.equal(pid, 'p0');
      // Test-only queue pressure on the actual socket; no production net policy changes.
      Object.defineProperty(ws, 'bufferedAmount', { configurable: true,
        get: () => softDrop ? NET_DEFAULTS.snapDropBytes + 1 : 0 });
      return sendRaw(ws, wire, { droppable: type === 'b.snap' });
    });
    if (i === 0) h.runner._sendSnapshot = (pid, f, frame) => h.m.sendEncoded(pid, 'b.snap', frame.snapshotWire); // original fanout
    const session = pool.create(input);
    t.after(() => session.close());
    h.runner.session = session;
    const initial = await session.ready;
    h.runner._apply(initial);
    let seq = 0;
    const flush = async () => {
      const wire = JSON.stringify({ t: 'test.boundary', seq: ++seq });
      ws.send(wire);
      await client.waitFor('test.boundary', msg => msg.seq === seq);
      return frameBytes(wire);
    };
    await flush();
    peers.push({ h, client, ws, session, flush, setDrop(value) { softDrop = value; } });
  }
  const request = async ticks => {
    const outputs = await Promise.all(peers.map(p => p.session.request('advance', { ticks, snapshotFields: [input.specs[0].fieldId] })));
    assert.deepEqual(outputs[0], outputs[1], 'dedupe never changes engine frames, effects or results');
    for (let i = 0; i < peers.length; i++) peers[i].h.runner._apply(outputs[i]);
    return outputs[0];
  };
  let out;
  do { out = await request(1); } while (out.fields[0].live);
  assert.equal(out.done, false);
  await Promise.all(peers.map(p => p.flush()));
  const before = peers.map(p => ({ log: p.client.log.length, socket: p.ws._socket.bytesWritten }));
  const markerBytes = [0, 0];
  for (let n = 1; n <= 10; n++) {
    for (const p of peers) p.h.clock(1000 + n * 100);
    out = await request(1);
    for (let i = 0; i < peers.length; i++) markerBytes[i] += await peers[i].flush();
  }
  const budget = peers.map((p, i) => {
    const frames = p.client.log.slice(before[i].log).filter(msg => msg.t !== 'test.boundary');
    const snapshots = frames.filter(msg => msg.t === 'b.snap');
    const payloadBytes = snapshots.reduce((n, msg) => n + Buffer.byteLength(JSON.stringify(msg)), 0);
    const socketBytes = p.ws._socket.bytesWritten - before[i].socket - markerBytes[i];
    assert.equal(socketBytes, frames.reduce((n, msg) => n + frameBytes(JSON.stringify(msg)), 0), 'actual socket byte counter matches observed uncompressed frame payloads plus RFC6455 headers');
    return { snapshots: snapshots.length, payloadBytes, socketBytes, events: frames.filter(msg => msg.t === 'b.ev').length };
  });
  assert.equal(budget[0].snapshots, 10);
  assert.equal(budget[1].snapshots, 1, '1s retry remains; ten duplicate enqueues are not needed');
  assert.equal(budget[0].payloadBytes, 10 * budget[1].payloadBytes);
  assert.equal(budget[0].socketBytes, 10 * budget[1].socketBytes);
  assert.equal(budget[0].events, budget[1].events);
  t.diagnostic(`local terminal wire budget (10 replies, PMD off): ${JSON.stringify({ original: budget[0], deduped: budget[1] })}`);

  const current = peers[1];
  const dropAt = current.client.log.filter(msg => msg.t === 'b.snap').length;
  current.setDrop(true); current.h.clock(3000);
  await request(1); await current.flush();
  assert.equal(current.client.log.filter(msg => msg.t === 'b.snap').length, dropAt, 'actual sendRaw soft limit drops terminal snapshots');
  current.setDrop(false); current.h.clock(3001);
  await request(1); await current.flush();
  assert.equal(current.client.log.filter(msg => msg.t === 'b.snap').length, dropAt + 1, 'first recovered reply retries a rejected terminal baseline');

  current.h.runner.requestField('p0', input.specs[0].fieldId);
  const state = await current.session.request('state', { snapshotFields: [input.specs[0].fieldId] });
  const stateAt = current.client.log.length;
  current.h.runner._apply(state, true); await current.flush();
  assert.deepEqual(current.client.log.slice(stateAt).filter(msg => msg.t !== 'test.boundary').map(msg => msg.t), ['m.field', 'b.snap', 'b.damage']);
  do { out = await request(1); } while (!out.done);
  await Promise.all(peers.map(p => p.flush()));
  assert.deepEqual(peers[0].h.fields.map(f => f.battle.result()), peers[1].h.fields.map(f => f.battle.result()));
  assert.deepEqual(peers[0].h.effects, peers[1].h.effects);
  assert.ok(peers.every(p => p.h.completions === 1));
  for (const p of peers) p.h.runner.stop();
});
