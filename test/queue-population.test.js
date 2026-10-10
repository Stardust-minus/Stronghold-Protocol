// Queue population is a read-only aggregate, not a matching/admission signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaking } from '../server/matchmaking.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const rules = (capacity = 4, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false,
  ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...extra });

function fixture(t, config = {}) {
  const clock = { time: 10_000 }, timers = new Map(), events = [];
  let nextPlayer = 0, nextTimer = 0, onSend = null;
  const timerApi = {
    setTimeout(fn, ms) {
      const timer = { id: ++nextTimer, fn, at: clock.time + ms, ms, unrefs: 0, unref() { this.unrefs++; } };
      timers.set(timer.id, timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer.id); },
  };
  const queue = new Matchmaking({ now: () => clock.time, timers: timerApi,
    send(session, message) { session.messages.push(message); events.push({ session, message, at: clock.time }); onSend?.(session, message); },
    available: (session, entry) => session.connected && !session.unavailable && !session.isBot && !session.observing
      && session.roomCode === entry.party.roomCode,
    members: session => ({ sessions: session.group || [session], roomCode: session.roomCode,
      leaderId: session.group?.[0].playerId || session.playerId, experimental: session.experimental }),
    allocate(sessions) { for (const session of sessions) session.roomCode = 'MATCH'; return { code: 'MATCH' }; },
    ...config,
  });
  t.after(() => queue.close());
  const player = () => ({ playerId: `queue_player_${++nextPlayer}`, connected: true, roomCode: null,
    matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION, messages: [] });
  const party = (size, capacity = 4, extra = {}) => {
    const group = Array.from({ length: size }, player);
    for (const session of group) { session.group = group; session.roomCode = `FRIEND${nextPlayer}`; session.experimental = rules(capacity, extra); }
    return group;
  };
  const join = (member, difficulty = 'NORMAL') => assert.deepEqual(queue.join(member, { difficulty, party: !!member.group }), { ok: true });
  const advance = ms => {
    const until = clock.time + ms;
    for (;;) {
      const next = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id).find(timer => timer.at <= until);
      if (!next) break;
      timers.delete(next.id); clock.time = next.at; next.fn();
    }
    clock.time = until;
  };
  return { queue, clock, timers, events, player, party, join, advance, hook(fn) { onSend = fn; } };
}

const queued = session => session.messages.filter(message => message.state === 'queued');
const last = session => session.messages.at(-1);
const assertNoCount = state => assert.equal(Object.hasOwn(state, 'waitingCount'), false);
const savedEntries = queue => [...queue.entries.values()].map(entry => ({ entry, ticketId: entry.ticketId,
  sequence: entry.sequence, joinedAt: entry.joinedAt, expiresAt: entry.expiresAt, party: entry.party, partySequence: entry.party.sequence }));
const assertRetained = (queue, saved) => {
  for (const before of saved) {
    const current = queue.entries.get(before.entry.session.playerId);
    assert.equal(current, before.entry);
    for (const field of ['ticketId', 'sequence', 'joinedAt', 'expiresAt', 'party']) assert.equal(current[field], before[field], field);
    assert.equal(current.party.sequence, before.partySequence);
  }
};

test('solo lifecycle counts include self; count-only full snapshots coalesce at 1s and dedupe unchanged buckets', t => {
  const h = fixture(t), a = h.player(), b = h.player(), other = h.player();
  h.join(a); const first = last(a);
  assert.equal(first.waitingCount, 1); assert.equal(first.partySize, 1);
  const timer = h.queue.populationTimer;
  assert.equal(timer.ms, 1000); assert.equal(timer.unrefs, 1);
  h.advance(500); h.join(b); h.join(other, 'HARD');
  assert.equal(last(b).waitingCount, 2); assert.equal(last(other).waitingCount, 1);
  assert.equal(h.queue.populationTimer, timer, 'joins do not postpone a pending aggregate notification');
  assert.equal(queued(a).length, 1);
  h.advance(499); assert.equal(queued(a).length, 1);
  h.advance(1); assert.equal(queued(a).length, 2);
  assert.deepEqual(last(a), { ...first, waitingCount: 2 }, 'a count notification is the entire current ticket snapshot');
  assert.equal(queued(b).length, 1); assert.equal(queued(other).length, 1);
  h.advance(3000); assert.equal(queued(a).length, 2);
  h.queue.sync(a); assert.equal(queued(a).length, 3, 'hello sync is forced despite an unchanged count');
  assert.deepEqual(last(a), { ...first, waitingCount: 2 });
  assert.deepEqual(Object.keys(last(a)).sort(), ['deadline', 'difficulty', 'joinedAt', 'partyId', 'partyLeaderId',
    'partyRoomCode', 'partySize', 'required', 'state', 't', 'ticketId', 'waitingCount'].sort());
  assert.equal(JSON.stringify(last(a)).includes(b.playerId), false, 'no other member identity is disclosed');
});

test('two indivisible three-person parties report six waiting identities without offering a four-player match', t => {
  const h = fixture(t), a = h.party(3), b = h.party(3);
  h.join(a[0]); assert.ok(a.every(member => last(member).waitingCount === 3));
  h.join(b[0]); assert.ok(b.every(member => last(member).waitingCount === 6));
  const saved = savedEntries(h.queue), deadline = h.queue.timer;
  h.advance(1000);
  assert.ok([...a, ...b].every(member => last(member).waitingCount === 6 && last(member).partySize === 3));
  assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.timer, deadline);
  assertRetained(h.queue, saved);
});

test('population isolates frozen version/difficulty/capacity pools but does not imply experimental compatibility', t => {
  const h = fixture(t), a = h.party(2, 4), incompatible = h.party(2, 4, { revivalEnabled: true });
  const eight = h.party(3, 8), twelve = h.party(3, 12), hard = h.player(), old = h.player();
  h.join(a[0]); h.join(incompatible[0]); h.join(eight[0]); h.join(twelve[0]); h.join(hard, 'HARD');
  h.join(old, 'ABYSS');
  const legacy = h.queue.entries.get(old.playerId);
  legacy.difficulty = 'NORMAL'; legacy.version = 'synthetic_previous_version'; old.matchmakingVersion = legacy.version;
  assert.equal(h.queue.state(a[0]).waitingCount, 4);
  assert.equal(h.queue.state(incompatible[0]).waitingCount, 4);
  assert.equal(h.queue.state(eight[0]).waitingCount, 3); assert.equal(h.queue.state(twelve[0]).waitingCount, 3);
  assert.equal(h.queue.state(hard).waitingCount, 1); assert.equal(h.queue.state(old).waitingCount, 1);
  assert.equal(h.queue.offers.size, 0);
  old.matchmakingVersion = MATCHMAKING_VERSION;
  const saved = savedEntries(h.queue), deadline = h.queue.timer;
  h.advance(1000);
  assert.equal(h.queue.state(old).waitingCount, 0, 'changed hello version cannot migrate a frozen old ticket into a new pool');
  assert.equal(h.queue.state(a[0]).waitingCount, 4); assert.equal(h.queue.timer, deadline);
  assertRetained(h.queue, saved);
});

test('offered, pending allocation, matched, idle, AI and observer states do not contribute waitingCount', async t => {
  let finish;
  const h = fixture(t, { asyncAllocate: () => new Promise(resolve => { finish = resolve; }) });
  const players = Array.from({ length: 4 }, h.player), waiting = h.player(), bot = h.player(), observer = h.player();
  bot.isBot = true; observer.observing = true;
  assert.equal(h.queue.join(bot, { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
  assert.equal(h.queue.join(observer, { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
  assertNoCount(h.queue.state(bot)); assertNoCount(h.queue.state(observer));
  for (const member of players) h.join(member);
  for (const member of players) { assert.equal(last(member).state, 'offered'); assertNoCount(last(member)); }
  assert.equal(h.queue.populationTimer, null, 'all-offered pools stop the statistics timer');
  h.join(waiting); assert.equal(last(waiting).waitingCount, 1);
  for (const member of players) assert.deepEqual(h.queue.accept(member, h.queue.state(member)), { ok: true });
  assert.ok(players.every(member => last(member).allocationPending));
  for (const member of players) assertNoCount(last(member));
  assert.equal(h.queue.state(waiting).waitingCount, 1);
  finish({ code: 'MATCH', commit() { for (const member of players) member.roomCode = 'MATCH'; } });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  for (const member of players) { assert.equal(last(member).state, 'matched'); assertNoCount(last(member)); }
  h.advance(1000); assert.equal(last(waiting).waitingCount, 1);
  assert.deepEqual(h.queue.cancel(waiting, last(waiting)), { ok: true }); assertNoCount(last(waiting));
  assert.equal(h.queue.populationTimer, null);
});

test('invalid identities, expired tickets and invalid whole parties are excluded without a statistics sweep or pump', t => {
  const h = fixture(t), valid = h.party(3), invalid = h.party(3), peer = h.player();
  h.join(valid[0]); h.join(invalid[0]); h.join(peer, 'HARD');
  invalid[1].connected = false;
  h.queue.entries.get(peer.playerId).expiresAt = h.clock.time;
  const saved = savedEntries(h.queue), deadline = h.queue.timer;
  t.mock.method(h.queue, 'sweep', () => assert.fail('statistics must not sweep'));
  t.mock.method(h.queue, 'pump', () => assert.fail('statistics must not pump'));
  h.advance(1000);
  assert.ok(valid.every(member => last(member).waitingCount === 3));
  assert.equal(queued(invalid[0]).length, 1); assert.equal(queued(peer).length, 1);
  assert.equal(h.queue.timer, deadline); assertRetained(h.queue, saved);
  assert.equal(h.queue.size, 7, 'read-only counting does not expire or remove tickets');
});

test('population fanout aggregates once, not once per recipient; FIFO, TTL and room rules remain untouched', t => {
  const h = fixture(t), groups = Array.from({ length: 24 }, () => h.party(3));
  for (const group of groups) h.join(group[0]);
  const saved = savedEntries(h.queue), deadline = h.queue.timer;
  const aggregation = t.mock.method(h.queue, 'waitingPopulation');
  t.mock.method(h.queue, 'sweep', () => assert.fail('population callback cannot sweep'));
  t.mock.method(h.queue, 'pump', () => assert.fail('population callback cannot pump'));
  h.advance(1000);
  assert.equal(aggregation.mock.callCount(), 1);
  assert.ok(groups.flat().every(member => last(member).waitingCount === 72));
  assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.timer, deadline);
  assertRetained(h.queue, saved);
  assert.ok(groups.every(group => h.queue.entries.get(group[0].playerId).party.experimental.revivalEnabled === false));
});

test('count bursts that return to the last delivered population emit no redundant queued frame', t => {
  const h = fixture(t), a = h.player(), b = h.player(); h.join(a);
  const timer = h.queue.populationTimer;
  h.join(b); assert.deepEqual(h.queue.cancel(b, last(b)), { ok: true });
  assert.equal(h.queue.populationTimer, timer);
  h.advance(1000); assert.equal(queued(a).length, 1); assert.equal(last(a).waitingCount, 1);
  assert.equal(last(b).state, 'idle'); assert.equal(queued(b).length, 1);
});

test('cancel/disconnect/expiry lifecycle is immediate and delayed counts cannot restore old tickets', t => {
  const h = fixture(t), a = h.party(3), b = h.party(3); h.join(a[0]); h.join(b[0]);
  const old = last(a[0]);
  assert.deepEqual(h.queue.cancel(a[1], last(a[1])), { ok: true });
  assert.ok(a.every(member => last(member).state === 'idle' && last(member).reason === 'cancelled'));
  h.advance(1000); assert.ok(a.every(member => last(member).state === 'idle'));
  assert.ok(b.every(member => last(member).waitingCount === 3));
  h.join(a[0]); const fresh = last(a[0]); assert.notEqual(fresh.ticketId, old.ticketId);
  assert.equal(h.queue.cancel(a[0], old).error, ERR.BAD_TARGET);
  h.advance(1000);
  assert.equal(last(a[0]).ticketId, fresh.ticketId);
  a[1].connected = false; h.queue.remove(a[1], 'disconnected');
  assert.ok(a.every(member => last(member).state === 'idle' && last(member).reason === 'disconnected'));
  for (const member of b) h.queue.entries.get(member.playerId).expiresAt = h.clock.time;
  h.queue.sweep();
  assert.ok(b.every(member => last(member).state === 'idle' && last(member).reason === 'expired'));
  assert.equal(h.queue.size, 0); assert.equal(h.queue.populationTimer, null); assert.equal(h.queue.timer, null);
});

test('returned fully-confirmed offer snapshots include all retained identities immediately after allocation failure', t => {
  const h = fixture(t, { allocate: () => ({ error: ERR.INTERNAL }) }), players = Array.from({ length: 4 }, h.player);
  for (const member of players) h.join(member);
  const saved = savedEntries(h.queue);
  for (const member of players.slice(0, -1)) h.queue.accept(member, h.queue.state(member));
  assert.equal(h.queue.accept(players.at(-1), h.queue.state(players.at(-1))).error, ERR.INTERNAL);
  assert.ok(players.every(member => last(member).state === 'queued' && last(member).waitingCount === 4
    && last(member).reason === 'allocation_failed'));
  assertRetained(h.queue, saved);
  assert.equal(h.queue.offers.size, 0, 'population timer must not trigger an immediate capacity re-offer');
  h.advance(1000); assert.equal(h.queue.offers.size, 0);
});

test('send-time revalidation skips a cancelled/rejoined identity from the aggregated recipient snapshot', t => {
  const h = fixture(t), a = h.party(3), b = h.party(3); h.join(a[0]); h.join(b[0]);
  const old = last(b[0]);
  h.hook((session, message) => {
    if (session === a[0] && message.state === 'queued' && message.waitingCount === 6) {
      h.hook(null); h.queue.cancel(b[0], old); h.join(b[0]);
    }
  });
  h.advance(1000);
  for (const member of b) {
    const at = member.messages.findIndex(message => message.state === 'idle');
    assert.ok(at >= 0); const fresh = last(member);
    assert.notEqual(fresh.ticketId, old.ticketId); assert.equal(fresh.state, 'queued');
    assert.equal(member.messages.slice(at + 1).length, 1, 'only the immediate new-ticket lifecycle snapshot is delivered');
  }
});

test('send-time revalidation skips identities offered by an earlier recipient send', t => {
  const h = fixture(t), a = h.party(3), b = h.party(3), solo = h.player(); h.join(a[0]); h.join(b[0]);
  h.hook((session, message) => {
    if (session === a[0] && message.state === 'queued' && message.waitingCount === 6) {
      h.hook(null); h.join(solo);
    }
  });
  h.advance(1000);
  for (const member of [...a, solo]) { assert.equal(last(member).state, 'offered'); assertNoCount(last(member)); }
  h.advance(1000);
  assert.ok(b.every(member => last(member).state === 'queued' && last(member).waitingCount === 3));
});

for (const operation of ['clear', 'close']) test(`${operation} removes the statistics timer; a late old callback cannot publish or disturb a new timer`, t => {
  const h = fixture(t), a = h.player(); h.join(a); const timer = h.queue.populationTimer;
  if (operation === 'clear') h.queue.clear('reset'); else h.queue.close();
  assert.equal(last(a).state, 'idle'); assert.equal(h.queue.populationTimer, null); assert.equal(h.queue.timer, null);
  assert.equal(h.timers.size, 0);
  if (operation === 'clear') h.join(a);
  const active = h.queue.populationTimer, count = a.messages.length;
  timer.fn(); assert.equal(a.messages.length, count); assert.equal(h.queue.populationTimer, active);
  if (operation === 'close') assert.equal(h.queue.join(a, { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
});

class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() { this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', roomCode: this.opts.roomCode }); }
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}

test('actual localhost HTTP/WS counts isolate difficulty and AI/observers, force hello sync, and never replay queued after matching', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.terminate())); await srv.close(); });
  const connect = async name => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(client);
    client.welcome = await client.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION });
    await client.waitFor('queue.state', state => state.state === 'idle'); return client;
  };
  const [a, b, other, host, observer] = await Promise.all(['CountA', 'CountB', 'Other', 'Host', 'Observer'].map(connect));
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state');
  assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await observer.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  assert.equal((await observer.request({ t: 'queue.join', difficulty: 'NORMAL' })).code, ERR.SPECTATOR);
  const response = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('<html'));
  assert.equal((await a.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  const initial = await a.waitFor('queue.state', state => state.state === 'queued'); assert.equal(initial.waitingCount, 1);
  assert.equal((await b.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  const second = await b.waitFor('queue.state', state => state.state === 'queued'); assert.equal(second.waitingCount, 2);
  assert.equal((await other.request({ t: 'queue.join', difficulty: 'HARD' })).t, 'ok');
  assert.equal((await other.waitFor('queue.state', state => state.state === 'queued')).waitingCount, 1);
  const update = await a.waitFor('queue.state', state => state.state === 'queued' && state.waitingCount === 2, 3000);
  assert.deepEqual(update, { ...initial, waitingCount: 2 });
  a.clearInbox();
  await a.hello('CountA', a.welcome.token, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.deepEqual(await a.waitFor('queue.state', state => state.state === 'queued'), update, 'hello cannot be count-deduped');
  assert.equal((await b.request({ t: 'queue.cancel', ticketId: second.ticketId })).t, 'ok');
  await b.waitFor('queue.state', state => state.state === 'idle');
  assert.equal((await a.waitFor('queue.state', state => state.state === 'queued' && state.waitingCount === 1, 3000)).ticketId, initial.ticketId);
  await b.expectNone('queue.state', state => state.state === 'queued', 1100);
  assert.equal((await b.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  const newer = await b.waitFor('queue.state', state => state.state === 'queued'); assert.notEqual(newer.ticketId, second.ticketId);
  const [c, d] = await Promise.all(['CountC', 'CountD'].map(connect));
  for (const client of [c, d]) assert.equal((await client.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  for (const client of [a, b, c, d]) {
    const offer = await client.waitFor('queue.state', state => state.state === 'offered'); assertNoCount(offer);
    assert.equal((await client.request({ t: 'queue.accept', ticketId: offer.ticketId, offerId: offer.offerId })).t, 'ok');
  }
  for (const client of [a, b, c, d]) {
    const matched = await client.waitFor('queue.state', state => state.state === 'matched'); assertNoCount(matched);
    const at = client.log.indexOf(matched);
    client.clearInbox(); await client.expectNone('queue.state', state => state.state === 'queued', 1100);
    assert.equal(client.log.slice(at + 1).some(state => state.t === 'queue.state' && state.state === 'queued'), false);
  }
  assert.equal(srv.lobby.queue.state(srv.registry.byId(other.welcome.playerId)).waitingCount, 1);
  for (const client of [host, observer]) assert.equal(client.log.some(state => state.t === 'queue.state' && Object.hasOwn(state, 'waitingCount')), false);
});
