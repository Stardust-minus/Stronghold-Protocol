import test from 'node:test';
import assert from 'node:assert/strict';
import { GameHost, GameHostError } from '../server/cluster/game-host.js';
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { checkNotOwned } from '../shared/protocol.js';
import { ERR, PHASE } from '../shared/constants.js';

const isCode = code => error => error instanceof GameHostError && error.code === code;
const seat = (seat, playerId, extra = {}) => ({ seat, playerId, name: playerId, isBot: false, connected: true, ...extra });
const spec = (extra = {}) => ({ assignmentId: 'assignment-1', roomCode: 'ABCD', build: 'test-build', protocol: 1,
  seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
  seats: [seat(0, 'p1'), seat(2, 'p2'), seat(3, 'ai_1', { isBot: true })], spectators: ['s1'],
  revivalEnabled: true, snapshotHz: 10, ...extra });
const channel = () => ({ sent: [], encoded: [], closed: [],
  send(msg) { this.sent.push(msg); return true; },
  sendEncoded(type, data) { this.encoded.push([type, data]); return true; },
  close(code, reason) { this.closed.push([code, reason]); } });
const macrotask = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const matches = [];
  class FakeMatch {
    constructor(opts) {
      this.opts = opts; this.calls = []; this.starts = 0; this.disposes = 0;
      matches.push(this);
      options.construct?.(this);
    }
    start() {
      this.starts++;
      this.calls.push(['start']);
      this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK' });
      for (const s of this.opts.seats) if (!s.isBot) this.opts.send(s.playerId, { t: 'm.private', playerId: s.playerId });
      return options.start?.(this);
    }
    handle(id, msg) { this.calls.push(['handle', id, msg]); return options.handle ? options.handle(this, id, msg) : { ok: true }; }
    setLoadout(id, loadout) { this.calls.push(['setLoadout', id, loadout]); return options.loadout ? options.loadout(this) : { ok: true }; }
    onReconnect(id) { this.calls.push(['onReconnect', id]); this.opts.send(id, { t: 'm.public', resync: true }); options.reconnect?.(this); }
    onDisconnect(id) { this.calls.push(['onDisconnect', id]); options.disconnect?.(this); }
    onLeave(id) { this.calls.push(['onLeave', id]); options.leave?.(this); }
    addSpectator(id) { this.calls.push(['addSpectator', id]); this.opts.send(id, { t: 'm.public', resync: true }); }
    removeSpectator(id) { this.calls.push(['removeSpectator', id]); }
    dispose() { this.disposes++; options.dispose?.(this); }
  }
  let now = 1000;
  const logs = [];
  const host = new GameHost({ data: options.data ?? {}, combatPool: options.combatPool, trialPool: options.trialPool,
    MatchClass: FakeMatch, now: () => now, prepareMs: options.prepareMs ?? 100,
    log: { error: (...values) => logs.push(values) }, onEnd: options.onEnd });
  t.after(() => host.close());
  const prepare = extra => host.prepare(spec(extra));
  const bindAll = (id = 'assignment-1') => {
    const channels = { p1: channel(), p2: channel(), s1: channel() };
    for (const [playerId, transport] of Object.entries(channels)) host.bind(id, playerId, transport);
    return channels;
  };
  return { host, matches, logs, prepare, bindAll, advance: ms => { now += ms; } };
}

// Tests exercise only the actor, with no HTTP/WS listeners or Worker pools.
test('prepare constructs silently; commit publishes buffered copies once and is idempotent', t => {
  const frame = { t: 'm.public', phase: 'constructed', nested: { n: 1 } };
  const { host, matches, prepare, bindAll } = fixture(t, { construct: m => m.opts.broadcast(frame),
    start: () => { frame.nested.n = 99; } });
  const prepared = prepare();
  const channels = bindAll();
  assert.equal(prepared.state, 'prepared');
  assert.equal(matches[0].starts, 0);
  assert.deepEqual(matches[0].calls, []);
  assert.deepEqual(channels.p1.sent, []);
  assert.equal(host.handle(prepared.assignmentId, 'p1', { t: 'g.ready', ready: true }).error, ERR.WRONG_PHASE);
  assert.strictEqual(prepare(), prepared);
  const committed = host.commit(prepared.assignmentId);
  assert.strictEqual(committed, prepared);
  assert.equal(committed.state, 'committed');
  assert.equal(channels.p1.sent[0].nested.n, 1, 'startup frame captured before later mutation');
  assert.equal(channels.p1.sent.filter(f => f.t === 'm.private').length, 1);
  assert.equal(channels.s1.sent.some(f => f.t === 'm.private'), false);
  const count = channels.p1.sent.length;
  assert.strictEqual(host.commit(prepared.assignmentId), committed);
  assert.strictEqual(prepare(), committed);
  assert.equal(matches[0].starts, 1);
  assert.equal(channels.p1.sent.length, count);
  assert.ok(Object.isFrozen(committed) && Object.isFrozen(committed.seats));
});

test('assignment spec keeps seat/loadout data, borrows pools, and never supplies SessionRegistry', t => {
  const combatPool = {}, trialPool = {}, data = {};
  const { host, matches } = fixture(t, { combatPool, trialPool, data });
  const original = spec({ seats: [seat(1, 'p1', { connected: false, loadout: { chess_a: { skill: 1, module: null } } })] });
  const handle = host.prepare(original);
  original.seats[0].loadout.chess_a.skill = 2;
  assert.equal(handle.seats[0].loadout.chess_a.skill, 1);
  assert.deepEqual(matches[0].opts.seats, handle.seats);
  assert.strictEqual(matches[0].opts.combatPool, combatPool);
  assert.strictEqual(matches[0].opts.trialPool, trialPool);
  assert.strictEqual(matches[0].opts.data, data);
  for (const key of ['registry', 'assignmentId', 'build', 'protocol']) assert.equal(Object.hasOwn(matches[0].opts, key), false, key);
  assert.equal(matches[0].opts.revivalEnabled, true);
  assert.equal(matches[0].opts.snapshotHz, 10);
  assert.equal(matches[0].opts.clientCombat, false, 'host remains server-authoritative without an environment setting');
});

test('0.2.0 ownership and DIY are copied, frozen and included in actor identity', t => {
  const { host, matches } = fixture(t);
  const original = spec({ seats: [seat(0, 'p1', {
    notOwned: ['chess_a'], diy: { slot_5: { charId: 'char_a', skillIndex: 1, uniEquipId: null } },
  })] });
  const prepared = host.prepare(original);
  original.seats[0].notOwned.push('chess_b');
  original.seats[0].diy.slot_5.skillIndex = 2;
  assert.deepEqual(prepared.seats[0].notOwned, ['chess_a']);
  assert.equal(prepared.seats[0].diy.slot_5.skillIndex, 1);
  assert.ok(Object.isFrozen(prepared.seats[0].notOwned) && Object.isFrozen(prepared.seats[0].diy.slot_5));
  assert.deepEqual(matches[0].opts.seats[0], prepared.seats[0]);
  assert.throws(() => host.prepare(original), isCode('ASSIGNMENT_CONFLICT'));
  for (const fields of [
    { notOwned: ['../invalid'] }, { notOwned: Array(161).fill('chess_a') },
    { diy: { slot_5: { charId: 'char_a', skillIndex: 10 } } },
    { diy: { slot_5: { charId: 'char_a', skillIndex: 1, secret: true } } },
  ]) assert.throws(() => host.prepare(spec({ assignmentId: 'invalid-fields', seats: [seat(0, 'p1', fields)] })), isCode('INVALID_SPEC'));
});

test('real 0.2.0 Match consumes ownership and DIY from a prepared cluster actor', t => {
  const data = getData({ log: { info() {}, warn() {}, error() {} } });
  const notOwned = Object.keys(data.chess).find(id => checkNotOwned([id], key => data.chess[key]).notOwned.length);
  assert.ok(notOwned);
  const diy = { chess_char_5_diy1_a: { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' } };
  let match;
  class RecordedMatch extends Match { constructor(opts) { super(opts); match = this; } }
  const host = new GameHost({ data, MatchClass: RecordedMatch });
  t.after(() => host.close());
  const prepared = host.prepare(spec({ seats: [seat(0, 'p1', { notOwned: [notOwned], diy })], spectators: [] }));
  const transport = channel(); host.bind(prepared.assignmentId, 'p1', transport);
  host.commit(prepared.assignmentId);
  const player = match.players.get('p1');
  assert.deepEqual(player.standIns, [notOwned]);
  assert.deepEqual(player.diy, diy);
  assert.equal(player.gd.chess('chess_char_5_diy1_a').charId, 'char_112_siege');
  assert.equal(player.diyStock.cap('chess_char_5_diy1_a'), 8);
  assert.ok(transport.sent.some(frame => frame.t === 'm.private' && frame.standIns.includes(notOwned)));
});

test('all supplied spec fields participate in duplicate-prepare conflict detection', t => {
  const { host, prepare } = fixture(t);
  prepare();
  for (const extra of [{ seed: 72 }, { matchNo: 2 }, { build: 'other' }, { protocol: 2 }, { roomCode: 'EFGH' },
    { spectators: [] }, { snapshotHz: 5 }, { revivalEnabled: false },
    { seats: [seat(0, 'p1'), seat(2, 'p2', { connected: false }), seat(3, 'ai_1', { isBot: true })] },
    { mode: 'coop', difficulty: 'HARD', modeId: 'mode_multi_hard' }]) {
    assert.throws(() => host.prepare(spec(extra)), isCode('ASSIGNMENT_CONFLICT'));
  }
  const reordered = spec();
  reordered.seats[0] = { connected: true, name: 'p1', playerId: 'p1', isBot: false, seat: 0 };
  assert.strictEqual(host.prepare(reordered), host.get('assignment-1'), 'object key order is not a conflict');
});

test('validates safe seat/id ranges, roles, loadouts, and entire assignment without constructing', t => {
  const { host, matches } = fixture(t);
  const sparseSeats = Array(2);
  sparseSeats[1] = seat(1, 'p1'); // keep an actual hole, not an explicit undefined entry
  const invalid = [
    { seats: [] }, { seats: [seat(4, 'p1')] }, { seats: [seat(-1, 'p1')] }, { seats: sparseSeats },
    { seats: [seat(0, 'p1'), seat(0, 'p2')] }, { seats: [seat(0, 'p1'), seat(1, 'p1')] },
    { seats: Array.from({ length: 5 }, (_, i) => seat(i, `p${i}`)) },
    { seats: [seat(0, 'ai_1', { isBot: true })] }, { seats: [seat(0, 'ai_1')] },
    { seats: [seat(0, 'p1', { isBot: true })] }, { seats: [seat(0, 'p1\n')] },
    { seats: [seat(0, 'p1', { connected: 1 })] }, { seats: [seat(0, 'p1', { name: 'x'.repeat(13) })] },
    { seats: [seat(0, 'p1', { loadout: { chess: { skill: 10 } } })] },
    { seats: [seat(0, 'p1', { loadout: { chess: { skill: 1, surprise: true } } })] },
    { spectators: ['p1'] }, { spectators: ['s1', 's1'] }, { spectators: ['ai_s'] },
    { seed: -1 }, { seed: 0x100000000 }, { matchNo: 0 }, { protocol: 0 }, { modeId: 'mode_single_normal' },
    { snapshotHz: 1 }, { revivalEnabled: 1 }, { roomCode: 'ABCD\n' }, { assignmentId: 'allocation\n' },
    { mode: 'solo', modeId: 'mode_single_normal', seats: [seat(0, 'p1')], spectators: ['s1'] },
    { extra: 'secret' },
  ];
  for (const extra of invalid) assert.throws(() => host.prepare(spec(extra)), isCode('INVALID_SPEC'));
  assert.equal(matches.length, 0);
});

test('cancel/expiry/release are terminal and late commits cannot resurrect actors', t => {
  const { host, matches, prepare, advance } = fixture(t);
  const a = prepare();
  const c = channel();
  const cleanup = host.bind(a.assignmentId, 'p1', c);
  assert.equal(host.abort(a.assignmentId), true);
  assert.equal(host.abort(a.assignmentId), false);
  assert.equal(cleanup(), false);
  assert.equal(matches[0].disposes, 1);
  assert.throws(() => host.commit(a.assignmentId), isCode('STALE_ASSIGNMENT'));
  assert.throws(() => prepare(), isCode('STALE_ASSIGNMENT'));
  assert.equal(c.closed[0][0], 1001);
  const b = prepare({ assignmentId: 'assignment-2' });
  advance(100);
  assert.throws(() => host.commit(b.assignmentId), isCode('STALE_ASSIGNMENT'));
  assert.equal(matches[1].starts, 0);
  assert.equal(matches[1].disposes, 1);
  assert.equal(host.get(b.assignmentId), null);
  prepare({ assignmentId: 'assignment-3' });
  advance(100);
  assert.equal(host.sweep(), 1);
  assert.equal(host.sweep(), 0);
  const d = prepare({ assignmentId: 'assignment-4' });
  host.commit(d.assignmentId);
  assert.equal(host.abort(d.assignmentId), false);
  assert.equal(host.release(d.assignmentId), true);
  assert.equal(host.dispose(d.assignmentId), false);
  assert.throws(() => host.commit(d.assignmentId), isCode('STALE_ASSIGNMENT'));
});

test('start throws after frames/onEnd: dispose synchronously and leak neither frames nor end callback', t => {
  const ended = [];
  const { host, matches, prepare, bindAll, logs } = fixture(t, { onEnd: r => ended.push(r), start: m => {
    m.opts.send('p1', { t: 'm.result', victory: true });
    m.opts.onEnd({ secret: 'do not publish' });
    throw new Error('ticket-secret');
  } });
  prepare();
  const channels = bindAll();
  assert.throws(() => host.commit('assignment-1'), isCode('INTERNAL'));
  assert.deepEqual(channels.p1.sent, []);
  assert.deepEqual(ended, []);
  assert.equal(matches[0].disposes, 1);
  assert.equal(host.get('assignment-1'), null);
  assert.throws(() => host.commit('assignment-1'), isCode('STALE_ASSIGNMENT'));
  assert.equal(JSON.stringify(logs).includes('ticket-secret'), false);
  assert.equal(matches[0].opts.send('p1', { t: 'm.public' }), false);
});

test('a Promise-returning start is rejected without publication or unhandled rejection', async t => {
  const { host, matches, prepare, bindAll } = fixture(t, { start: () => Promise.reject(new Error('secret')) });
  prepare(); const channels = bindAll();
  assert.throws(() => host.commit('assignment-1'), isCode('INTERNAL'));
  assert.deepEqual(channels.p1.sent, []);
  assert.equal(matches[0].disposes, 1);
  await macrotask();
});

test('encoded startup frames remain buffered and pass through without JSON decoding', t => {
  const wire = 'a pre-encoded Battle frame, not JSON';
  const { host, matches, prepare } = fixture(t, { construct: m => m.opts.sendEncoded('p1', 'b.ev', wire),
    start: m => m.opts.sendEncoded('s1', 'm.field', wire) });
  prepare();
  const player = channel(), observer = channel();
  host.bind('assignment-1', 'p1', player);
  host.bind('assignment-1', 's1', observer);
  assert.deepEqual(player.encoded, []);
  host.commit('assignment-1');
  assert.deepEqual(player.encoded, [['b.ev', wire]]);
  assert.deepEqual(observer.encoded, [['m.field', wire]]);
  assert.equal(matches[0].starts, 1);
});

test('Promise-returning game hooks and channels fail closed without unhandled rejections', async t => {
  const secret = 'asynchronous-secret';
  const { host, matches, prepare, bindAll, logs } = fixture(t, {
    handle: () => Promise.reject(new Error(secret)), loadout: () => Promise.reject(new Error(secret)),
    onEnd: () => Promise.reject(new Error(secret)),
  });
  prepare(); const channels = bindAll(); host.commit('assignment-1');
  assert.deepEqual(host.handle('assignment-1', 'p1', { t: 'g.ready', ready: true }), { error: ERR.INTERNAL });
  assert.deepEqual(host.setLoadout('assignment-1', 'p1', {}), { error: ERR.INTERNAL });
  channels.p1.send = () => Promise.reject(new Error(secret));
  assert.equal(matches[0].opts.send('p1', { t: 'b.snap' }), false);
  assert.equal(channels.p1.closed[0][0], 1013, 'an asynchronous channel is not soft snapshot pressure');
  matches[0].opts.onEnd({ victory: true });
  await macrotask();
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('constructor failure fences its saved hooks even if a partial object escaped', t => {
  let callbacks;
  const ended = [];
  const { host, prepare } = fixture(t, { onEnd: r => ended.push(r), construct: m => {
    callbacks = m.opts;
    m.opts.broadcast({ t: 'm.public' });
    throw new Error('constructor secret');
  } });
  assert.throws(() => prepare(), isCode('INTERNAL'));
  assert.equal(callbacks.send('p1', { t: 'm.result' }), false);
  callbacks.onEnd({ secret: true });
  assert.deepEqual(ended, []);
  assert.throws(() => prepare(), isCode('STALE_ASSIGNMENT'));
});

test('only current assignment members receive object/encoded frames; observer policy fails closed', t => {
  const { host, matches, prepare, bindAll } = fixture(t);
  prepare(); const channels = bindAll(); host.commit('assignment-1');
  const { opts } = matches[0];
  assert.throws(() => host.bind('assignment-1', 'ai_1', channel()), isCode('NOT_MEMBER'));
  assert.throws(() => host.bind('assignment-1', 'intruder', channel()), isCode('NOT_MEMBER'));
  for (const type of ['m.private', 'm.toast', 'm.unitStats', 'm.unknown']) {
    assert.equal(opts.send('s1', { t: type, private: true }), false);
    opts.broadcast({ t: type, private: true });
  }
  assert.equal(channels.s1.sent.some(f => f.private), false);
  for (const id of ['ai_1', 'intruder']) {
    assert.equal(opts.send(id, { t: 'm.public' }), false);
    assert.equal(opts.sendEncoded(id, 'm.field', 'large-frame'), false);
  }
  const wire = 'large Battle frame unchanged, deliberately not parsed by the actor';
  assert.equal(opts.sendEncoded('s1', 'm.field', wire), true);
  assert.strictEqual(channels.s1.encoded[0][1], wire);
  assert.equal(opts.sendEncoded('s1', 'm.private', wire), false);
  for (const type of ['m.ticker', 'm.emote', 'b.pool', 'b.ev', 'b.end', 'b.damage']) opts.broadcast({ t: type });
  for (const type of ['m.ticker', 'm.emote', 'b.pool', 'b.ev', 'b.end', 'b.damage']) assert.ok(channels.s1.sent.some(f => f.t === type));
  assert.equal(host.handle('assignment-1', 's1', { t: 'g.ready', ready: true }).error, ERR.SPECTATOR);
  assert.equal(host.handle('assignment-1', 's1', { t: 'b.result' }).error, ERR.SPECTATOR);
  assert.equal(host.setLoadout('assignment-1', 's1', {}).error, ERR.SPECTATOR);
  assert.deepEqual(host.handle('assignment-1', 's1', { t: 'g.watch', fieldId: 'n:p1' }), { ok: true });
});

test('precommit bind is silent; stale cleanup/intents cannot disconnect or act through a replacement', t => {
  const { host, matches, prepare, bindAll } = fixture(t);
  prepare(); bindAll();
  const first = channel(), second = channel();
  const cleanup1 = host.bind('assignment-1', 'p1', first);
  assert.deepEqual(matches[0].calls, []);
  host.commit('assignment-1');
  const cleanup2 = host.bind('assignment-1', 'p1', second);
  assert.equal(cleanup1(), false);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 0);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onReconnect' && c[1] === 'p1').length, 1);
  assert.equal(host.handle('assignment-1', 'p1', { t: 'g.ready', ready: true }, first).error, ERR.NOT_IN_ROOM);
  assert.equal(host.setLoadout('assignment-1', 'p1', {}, first).error, ERR.NOT_IN_ROOM);
  assert.equal(host.leave('assignment-1', 'p1', first).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(host.handle('assignment-1', 'p1', { t: 'g.ready', ready: true }, second), { ok: true });
  assert.equal(cleanup2(), true);
  assert.equal(cleanup2(), false);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 1);
  assert.equal(matches[0].opts.send('p1', { t: 'm.public' }), false);
});

test('initial connection bits reconcile only after start; permanent leave never disconnects', t => {
  const { host, matches, prepare } = fixture(t);
  prepare({ seats: [seat(0, 'p1', { connected: false }), seat(1, 'p2')] });
  const cleanup = host.bind('assignment-1', 'p1', channel());
  host.commit('assignment-1');
  assert.deepEqual(matches[0].calls.slice(0, 3), [['start'], ['onReconnect', 'p1'], ['onDisconnect', 'p2']]);
  assert.deepEqual(host.leave('assignment-1', 'p1'), { ok: true });
  assert.equal(cleanup(), false);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onLeave' && c[1] === 'p1').length, 1);
  assert.equal(matches[0].calls.some(c => c[0] === 'onDisconnect' && c[1] === 'p1'), false);
  assert.throws(() => host.bind('assignment-1', 'p1', channel()), isCode('NOT_MEMBER'));
  assert.equal(host.addSpectator('assignment-1', 'p1').error, ERR.BAD_TARGET);
});

test('spectator additions/removals preserve hooks and fence removed channel cleanup', t => {
  const { host, matches, prepare, bindAll } = fixture(t);
  prepare(); bindAll();
  assert.deepEqual(host.removeSpectator('assignment-1', 's1'), { ok: true });
  assert.deepEqual(host.addSpectator('assignment-1', 's2'), { ok: true });
  assert.equal(host.member('assignment-1', 's1'), null);
  assert.equal(host.member('assignment-1', 'ai_1'), null);
  assert.deepEqual(host.member('assignment-1', 's2'), { assignmentId: 'assignment-1', playerId: 's2', generation: 1, role: 'spectator', connected: false });
  const s2 = channel();
  const cleanup = host.bind('assignment-1', 's2', s2);
  assert.equal(host.member('assignment-1', 's2').connected, true);
  assert.ok(Object.isFrozen(host.member('assignment-1', 's2')));
  assert.deepEqual(matches[0].calls, []);
  host.commit('assignment-1');
  assert.ok(matches[0].calls.some(c => c[0] === 'removeSpectator' && c[1] === 's1'));
  assert.ok(matches[0].calls.some(c => c[0] === 'addSpectator' && c[1] === 's2'));
  host.removeSpectator('assignment-1', 's2');
  assert.equal(cleanup(), false);
  assert.equal(matches[0].opts.send('s2', { t: 'm.public' }), false);
  assert.throws(() => host.bind('assignment-1', 's2', channel()), isCode('NOT_MEMBER'));
  host.addSpectator('assignment-1', 's2');
  host.bind('assignment-1', 's2', channel());
  assert.equal(cleanup(), false, 'old spectator binding cannot disconnect re-added member');
});

test('only b.snap has soft backpressure; reliable failure detaches and closes the channel', t => {
  const { host, matches, prepare, bindAll } = fixture(t);
  prepare(); const channels = bindAll(); host.commit('assignment-1');
  channels.p1.send = () => false;
  channels.p1.sendEncoded = () => false;
  assert.equal(matches[0].opts.send('p1', { t: 'b.snap' }), false);
  assert.equal(matches[0].opts.sendEncoded('p1', 'b.snap', 'snap'), false);
  assert.equal(channels.p1.closed.length, 0);
  assert.equal(matches[0].opts.sendEncoded('p1', 'b.ev', 'event'), false);
  assert.equal(channels.p1.closed[0][0], 1013);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 1);
  assert.equal(matches[0].opts.send('p1', { t: 'm.public' }), false);
  channels.s1.send = () => { throw new Error('transport secret'); };
  assert.equal(matches[0].opts.send('s1', { t: 'b.snap' }), false, 'thrown send is not soft backpressure');
  assert.equal(channels.s1.closed[0][0], 1013);
  assert.equal(matches[0].calls.some(c => c[0] === 'onDisconnect' && c[1] === 's1'), false);
});

test('handler/hook/callback exceptions are isolated and never echo secrets', t => {
  const secret = 'message-ticket-secret';
  const { host, matches, prepare, bindAll, logs } = fixture(t, { handle: () => { throw new Error(secret); },
    loadout: () => { throw new Error(secret); }, reconnect: () => { throw new Error(secret); },
    disconnect: () => { throw new Error(secret); }, leave: () => { throw new Error(secret); },
    onEnd: () => { throw new Error(secret); }, dispose: () => { throw new Error(secret); } });
  prepare(); bindAll(); host.commit('assignment-1');
  assert.deepEqual(host.handle('assignment-1', 'p1', { t: 'g.ready', ready: true, secret }), { error: ERR.INTERNAL });
  assert.deepEqual(host.setLoadout('assignment-1', 'p1', {}), { error: ERR.INTERNAL });
  const cleanup = host.bind('assignment-1', 'p2', channel());
  assert.equal(cleanup(), true);
  assert.deepEqual(host.leave('assignment-1', 'p2'), { error: ERR.INTERNAL });
  matches[0].opts.onEnd({ victory: true });
  assert.equal(host.get('assignment-1').state, 'ended');
  assert.equal(host.release('assignment-1'), true);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('onEnd receipts keep disconnected human results, replay after disposal, and fire once', async t => {
  const ended = [];
  const { host, matches, prepare, bindAll } = fixture(t, { onEnd: r => ended.push(r) });
  const handle = prepare(); const channels = bindAll(); host.commit('assignment-1');
  const cleanup = host.bind('assignment-1', 'p2', channel()); cleanup();
  const m = matches[0];
  m.opts.broadcast({ t: 'm.public', phase: 'END', round: 9 });
  m.opts.send('p1', { t: 'm.result', playerId: 'p1', victory: true });
  assert.equal(m.opts.send('p2', { t: 'm.result', playerId: 'p2', victory: true }), false);
  m.opts.send('s1', { t: 'm.result', playerId: 's1', victory: true });
  const summary = { victory: true };
  m.opts.onEnd(summary); summary.victory = false;
  m.opts.onEnd({ victory: false });
  assert.equal(ended.length, 1);
  assert.strictEqual(ended[0], handle.receipt);
  assert.equal(handle.state, 'ended');
  assert.equal(handle.receipt.summary.victory, true);
  assert.equal(handle.receipt.results.p2.playerId, 'p2');
  assert.equal(handle.receipt.generation, handle.generation);
  assert.ok(Object.isFrozen(handle.receipt) && Object.isFrozen(handle.receipt.results));
  assert.equal(m.disposes, 0, 'dispose waits until the next macrotask');
  const before = channels.p1.sent.length;
  assert.equal(m.opts.send('p1', { t: 'm.toast' }), false);
  assert.equal(channels.p1.sent.length, before);
  await macrotask();
  assert.equal(m.disposes, 1);
  assert.strictEqual(host.get('assignment-1').receipt, ended[0]);
  const resumed = channel();
  const resumedCleanup = host.bind('assignment-1', 'p2', resumed);
  assert.deepEqual(resumed.sent.map(f => f.t), ['m.public', 'm.result']);
  assert.equal(resumed.sent[1].playerId, 'p2');
  assert.equal(resumedCleanup(), true);
  assert.equal(m.calls.filter(c => c[0] === 'onReconnect' && c[1] === 'p2').length, 1, 'no engine hook after ended disposal');
  assert.deepEqual(host.handle('assignment-1', 'p1', { t: 'b.progress' }), { error: ERR.WRONG_PHASE });
  assert.equal(host.handle('assignment-1', 'p1', { t: 'g.ready', ready: true }).error, ERR.WRONG_PHASE);
});

test('synchronous end during successful start publishes result then stores receipt exactly once', async t => {
  const ended = [];
  const { host, matches, prepare, bindAll } = fixture(t, { onEnd: r => ended.push(r), start: m => {
    m.opts.broadcast({ t: 'm.result', victory: false });
    m.opts.onEnd({ reason: 'abandoned' });
  } });
  prepare(); const channels = bindAll();
  const h = host.commit('assignment-1');
  assert.equal(h.state, 'ended');
  assert.equal(ended.length, 1);
  assert.ok(channels.p1.sent.some(f => f.t === 'm.result'));
  assert.equal(h.receipt.results.s1.t, 'm.result');
  assert.strictEqual(host.commit('assignment-1'), h);
  assert.equal(matches[0].starts, 1);
  await macrotask();
  assert.equal(matches[0].disposes, 1);
});

test('terminal replay never reads an inherited property as a personal result', async t => {
  const { host, matches, prepare } = fixture(t);
  prepare({ seats: [seat(0, 'constructor')], spectators: [] });
  host.bind('assignment-1', 'constructor', channel());
  host.commit('assignment-1');
  matches[0].opts.onEnd({ reason: 'no result emitted' });
  await macrotask();
  const resumed = channel();
  host.bind('assignment-1', 'constructor', resumed);
  assert.deepEqual(resumed.sent, []);
});

test('ending inside a channel failure fences the remainder of an in-flight broadcast', t => {
  const { host, matches, prepare, bindAll } = fixture(t, { disconnect: m => m.opts.onEnd({ reason: 'done' }) });
  prepare(); const channels = bindAll(); host.commit('assignment-1');
  channels.p1.send = () => false;
  const beforePlayer = channels.p2.sent.length, beforeObserver = channels.s1.sent.length;
  matches[0].opts.broadcast({ t: 'm.public', late: true });
  assert.equal(host.get('assignment-1').state, 'ended');
  assert.equal(channels.p2.sent.length, beforePlayer);
  assert.equal(channels.s1.sent.length, beforeObserver);
});

test('multiple actor generations are isolated, and late hooks/cleanup stay fenced after release', t => {
  const ended = [];
  const { host, matches, prepare, bindAll } = fixture(t, { onEnd: r => ended.push(r) });
  const a = prepare(); const ca = bindAll(); host.commit(a.assignmentId);
  const b = prepare({ assignmentId: 'assignment-2', roomCode: 'EFGH' });
  const cb = bindAll(b.assignmentId); host.commit(b.assignmentId);
  assert.notEqual(a.generation, b.generation);
  const cleanup = host.bind(a.assignmentId, 'p1', channel());
  host.release(a.assignmentId);
  assert.equal(cleanup(), false);
  const before = cb.p1.sent.length;
  matches[0].opts.broadcast({ t: 'm.public', old: true });
  matches[0].opts.onEnd({ old: true });
  assert.equal(cb.p1.sent.length, before);
  assert.deepEqual(ended, []);
  matches[1].opts.send('p1', { t: 'm.public', current: true });
  assert.equal(cb.p1.sent.at(-1).current, true);
  assert.equal(ca.p1.sent.some(f => f.current), false);
  assert.deepEqual(host.stats(), { prepared: 0, matches: 1, ended: 0, channels: 3, closed: false });
});

test('close is idempotent, closes actors but not borrowed pools, and refuses new work', t => {
  const combatPool = { close() { assert.fail('borrowed combat pool closed'); } };
  const trialPool = { close() { assert.fail('borrowed trial pool closed'); } };
  const { host, matches, prepare } = fixture(t, { combatPool, trialPool });
  prepare(); prepare({ assignmentId: 'assignment-2', roomCode: 'EFGH' });
  host.commit('assignment-1');
  assert.equal(host.close(), true);
  assert.equal(host.close(), false);
  assert.deepEqual(matches.map(m => m.disposes), [1, 1]);
  assert.deepEqual(host.stats(), { prepared: 0, matches: 0, ended: 0, channels: 0, closed: true });
  assert.throws(() => prepare({ assignmentId: 'assignment-3' }), isCode('HOST_CLOSED'));
});

test('two real Matches with a minimal fixture start independently and preserve documented hooks', async t => {
  const realMatches = [];
  class RealMatch extends Match { constructor(opts) { super(opts); realMatches.push(this); } }
  const data = { chess: { chess_fixture: { chessId: 'chess_fixture', visible: true, tier: 1, bonds: [] } } };
  const receipts = [];
  const host = new GameHost({ data, MatchClass: RealMatch, onEnd: receipt => receipts.push(receipt) });
  t.after(() => host.close());
  for (const [assignmentId, roomCode, playerId] of [['real-a', 'ABCD', 'pa'], ['real-b', 'EFGH', 'pb']]) {
    host.prepare(spec({ assignmentId, roomCode, mode: 'solo', modeId: 'mode_single_normal', seats: [seat(0, playerId)], spectators: [] }));
    const c = channel(); host.bind(assignmentId, playerId, c);
    assert.deepEqual(c.sent, []);
    host.commit(assignmentId);
    assert.ok(c.sent.some(f => f.t === 'm.public' && f.phase === PHASE.INFO_CHECK));
    assert.ok(c.sent.some(f => f.t === 'm.private' && f.playerId === playerId));
  }
  assert.notStrictEqual(realMatches[0].players, realMatches[1].players);
  assert.equal(realMatches[0].registry.constructor.name, 'MetaRegistry');
  assert.equal(realMatches[0].clientCombat, false);
  assert.equal(realMatches[1].clientCombat, false);
  assert.deepEqual(host.setLoadout('real-a', 'pa', {}), { ok: true });
  assert.deepEqual(host.leave('real-a', 'pa'), { ok: true });
  assert.equal(host.get('real-a').state, 'ended');
  assert.equal(host.get('real-b').state, 'committed');
  assert.equal(receipts.length, 1);
  await macrotask();
  assert.equal(realMatches[0].disposed, true);
  assert.equal(realMatches[1].disposed, false);
});
