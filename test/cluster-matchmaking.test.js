// Opt-in async admission, with controlled promises/clocks and no real services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaking, MATCHMAKING_DEFAULTS } from '../server/matchmaking.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function harness(t, config = {}) {
  const clock = { time: 10_000 }, calls = [], events = [], timers = new Map();
  let nextPlayer = 0, syncCalls = 0, nextTimer = 0;
  const scheduled = [];
  const timerApi = {
    setTimeout(fn, ms) {
      const timer = { id: ++nextTimer, fn, ms, at: clock.time + ms, unrefs: 0, unref() { this.unrefs++; } };
      scheduled.push(timer); timers.set(timer.id, timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer.id); },
  };
  const record = (session, message) => { session.messages.push(message); events.push({ playerId: session.playerId, message }); };
  const prepare = (sessions, difficulty, context) => {
    const work = deferred(), call = { sessions, difficulty, context, work, signals: 0 };
    context.signal.addEventListener('abort', () => { call.signals++; }); calls.push(call);
    return work.promise;
  };
  const syncAllocate = (sessions) => {
    syncCalls++;
    for (const session of sessions) session.roomCode = 'SYNC';
    return { code: 'SYNC', publish() { for (const session of sessions) record(session, { t: 'room.state', code: 'SYNC' }); } };
  };
  const queue = new Matchmaking({
    now: () => clock.time, send: record,
    available: (session, entry) => session.connected && !session.unavailable && session.roomCode === entry.party.roomCode,
    members: (session, difficulty, party) => party && session.party
      ? { sessions: session.party, roomCode: session.roomCode, leaderId: session.party[0].playerId }
      : { sessions: [session], roomCode: null, leaderId: session.playerId },
    allocate: config.allocate || syncAllocate,
    asyncAllocate: Object.hasOwn(config, 'asyncAllocate') ? config.asyncAllocate : prepare,
    allocationMs: config.allocationMs,
    options: config.options,
    timers: timerApi,
  });
  t.after(() => queue.close());
  const player = () => ({ playerId: `synthetic_player_${++nextPlayer}`, connected: true, roomCode: null,
    limitKey: null, matchmakingVersion: MATCHMAKING_VERSION, messages: [], matchmakingResult: null });
  const group = () => Array.from({ length: 4 }, player);
  const friendParty = (players, code = 'FRIEND') => {
    for (const p of players) { p.party = players; p.roomCode = code; }
  };
  const join = (players) => {
    const seen = new Set();
    for (const session of players) {
      if (session.party && seen.has(session.party)) continue;
      if (session.party) seen.add(session.party);
      assert.deepEqual(queue.join(session, { difficulty: 'NORMAL', party: !!session.party }), { ok: true });
    }
    return players.map((session) => ({ ...queue.state(session), revivalVote: false }));
  };
  const accept = (players, states = players.map((p) => ({ ...queue.state(p), revivalVote: false }))) =>
    players.map((session, i) => queue.accept(session, states[i]));
  const start = (players = group()) => { const states = join(players); assert.ok(accept(players, states).every((r) => r.ok)); return { players, states }; };
  const fire = () => {
    const timer = queue.timer; assert.ok(timer && timers.has(timer.id), 'one current deadline timer is armed');
    timers.delete(timer.id); clock.time = timer.at; timer.fn(); return timer;
  };
  return { queue, clock, calls, events, scheduled, timers, player, group, friendParty, join, accept, start, fire,
    syncCalls: () => syncCalls };
}

function prepared(h, call, code = 'MATCH', overrides = {}) {
  const counts = { commit: 0, abort: 0, publish: 0 }, oldRooms = call.sessions.map((p) => p.roomCode);
  const result = {
    code,
    commit() { counts.commit++; for (const session of call.sessions) session.roomCode = code; },
    abort() {
      counts.abort++;
      call.sessions.forEach((session, i) => { if (session.roomCode === code) session.roomCode = oldRooms[i]; });
    },
    publish() {
      counts.publish++;
      for (const session of call.sessions) {
        for (const t of ['room.state', 'm.public', 'm.private']) {
          const message = { t, code }; session.messages.push(message); h.events.push({ playerId: session.playerId, message });
        }
      }
    },
    ...overrides,
  };
  return { result, counts };
}

function snapshot(queue, players) {
  return players.map((session) => {
    const entry = queue.entries.get(session.playerId);
    return { entry, ticketId: entry.ticketId, sequence: entry.sequence, joinedAt: entry.joinedAt, expiresAt: entry.expiresAt,
      party: entry.party, partySequence: entry.party.sequence, roomCode: session.roomCode };
  });
}
function retained(h, players, original) {
  for (let i = 0; i < players.length; i++) {
    const session = players[i], e = h.queue.entries.get(session.playerId), before = original[i];
    assert.ok(e === before.entry && e.ticketId === before.ticketId, 'healthy party keeps its original entry and ticket');
    for (const field of ['sequence', 'joinedAt', 'expiresAt']) assert.equal(e[field], before[field], field);
    assert.equal(e.party, before.party); assert.equal(e.party.sequence, before.partySequence);
    assert.equal(session.roomCode, before.roomCode, 'friend room remains unchanged');
    assert.equal(h.queue.state(session).state, 'queued');
    assert.equal(e.accepted, false); assert.equal(e.revivalVote, null);
    assert.equal(Object.hasOwn(h.queue.state(session), 'allocationPending'), false);
  }
}

test('explicit async opt-in and bounded constructor configuration preserve legacy defaults', (t) => {
  const h = harness(t, { asyncAllocate: null });
  assert.equal(h.queue.asyncAllocate, null); assert.equal(h.queue.allocationMs, 6000);
  assert.equal(h.queue.opts.waitMs, MATCHMAKING_DEFAULTS.waitMs);
  const construct = (config) => new Matchmaking({ send() {}, available: () => true, allocate() {}, ...config });
  for (const asyncAllocate of [false, true, 1, 'async', {}]) assert.throws(() => construct({ asyncAllocate }), TypeError);
  for (const allocationMs of [0, -1, 1.5, 8001, Infinity, NaN, '6000', null]) assert.throws(() => construct({ allocationMs }), TypeError);
  for (const allocationMs of [1, 8000]) { const q = construct({ allocationMs }); q.close(); }
  for (const key of ['maxEntries', 'maxPerAddr']) for (const value of [-1, 0.5, '0', 20001]) {
    assert.throws(() => construct({ options: { [key]: value } }), TypeError);
  }
  for (const key of ['waitMs', 'acceptMs']) assert.throws(() => construct({ options: { [key]: 0 } }), TypeError);
});

test('legacy allocate commits synchronously; no pending field or async provider is introduced', (t) => {
  const h = harness(t, { asyncAllocate: null }), players = h.group(), states = h.join(players);
  h.accept(players.slice(0, 3), states.slice(0, 3));
  assert.equal(h.syncCalls(), 0);
  assert.deepEqual(h.queue.accept(players[3], states[3]), { ok: true });
  assert.equal(h.syncCalls(), 1); assert.equal(h.calls.length, 0); assert.equal(h.queue.size, 0);
  for (const p of players) {
    assert.equal(h.queue.state(p).state, 'matched');
    assert.equal(Object.hasOwn(h.queue.state(p), 'allocationPending'), false);
    const at = p.messages.findIndex((m) => m.t === 'room.state');
    assert.deepEqual(p.messages.slice(at).map((m) => m.t), ['room.state', 'queue.state']);
  }
});

test('legacy allocator returning a Promise remains a synchronous allocation error', (t) => {
  const h = harness(t, { asyncAllocate: null, allocate: () => Promise.resolve({ code: 'INVALID' }) });
  const players = h.group(), states = h.join(players), original = snapshot(h.queue, players);
  h.accept(players.slice(0, 3), states.slice(0, 3));
  assert.equal(h.queue.accept(players[3], states[3]).error, ERR.INTERNAL);
  retained(h, players, original); assert.equal(h.queue.offers.size, 0);
});

test('accept acknowledges votes synchronously; one deferred prepare commits then publishes before matched', async (t) => {
  const h = harness(t), players = h.group(); h.friendParty(players.slice(0, 2));
  const states = h.join(players), original = snapshot(h.queue, players);
  h.accept(players.slice(0, 3), states.slice(0, 3));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.queue.accept(players[0], states[0]), { ok: true });
  assert.deepEqual(h.queue.accept(players[3], states[3]), { ok: true });
  assert.equal(h.syncCalls(), 0); assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.deepEqual(call.sessions, players); assert.equal(call.difficulty, 'NORMAL');
  assert.ok(call.context.isCurrent()); assert.equal(call.context.signal.aborted, false);
  for (const p of players) {
    const state = h.queue.state(p);
    assert.equal(state.state, 'offered'); assert.equal(state.acceptedCount, 4); assert.equal(state.allocationPending, true);
    assert.equal(state.deadline, h.clock.time + 6000);
  }
  assert.ok(players.every((p, i) => p.roomCode === original[i].roomCode), 'prepare cannot consume the original friend room');
  for (let i = 0; i < 3; i++) assert.ok(h.accept(players, states).every((r) => r.ok));
  assert.equal(h.calls.length, 1, 'repeated accept never starts a second prepare');
  assert.deepEqual(h.queue.accept(players[0], { ...states[0], revivalVote: true }), { ok: true });
  assert.deepEqual(h.queue.state(players[0]).experimental, { revivalEnabled: false, disableSharedPool: false });
  assert.equal(h.calls.length, 1);
  const ready = prepared(h, call); call.work.resolve(ready.result);
  assert.equal(ready.counts.commit, 0, 'even a resolved promise commits only after its continuation');
  await flush();
  assert.deepEqual(ready.counts, { commit: 1, abort: 0, publish: 1 });
  assert.equal(h.queue.size, 0); assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.parties.size, 0);
  assert.equal(h.queue.timer, null); assert.equal(call.context.isCurrent(), false);
  for (const p of players) {
    assert.equal(p.roomCode, 'MATCH'); assert.equal(h.queue.state(p).state, 'matched');
    const at = p.messages.findIndex((m) => m.t === 'room.state');
    assert.deepEqual(p.messages.slice(at).map((m) => m.t), ['room.state', 'm.public', 'm.private', 'queue.state']);
    assert.equal(p.messages.at(-1).state, 'matched');
    assert.equal(Object.hasOwn(p.messages.at(-1), 'allocationPending'), false);
  }
  assert.ok(h.scheduled.every((timer) => timer.unrefs === 1), 'every deadline timer is unrefed');
  assert.ok(h.accept(players, states).every((r) => r.ok));
  assert.equal(h.calls.length, 1);
});

test('prepare rejection retains healthy friend parties, original tickets/FIFO/TTL and does not repump', async (t) => {
  const h = harness(t), players = h.group(); h.friendParty(players.slice(0, 2));
  h.join(players); const original = snapshot(h.queue, players); h.accept(players);
  h.calls[0].work.reject(new Error('synthetic prepare failure')); await flush();
  retained(h, players, original);
  assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.parties.size, 3); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signals, 1); assert.equal(h.calls[0].context.isCurrent(), false);
  assert.ok(h.queue.timer.ms > 1, 'next wake is ticket TTL, not a past accepted offer deadline');
  assert.ok(players.every((p) => h.queue.state(p).reason === 'allocation_failed'));
});

test('synchronous prepare throw is a failed preparation, not a failed vote response', (t) => {
  let attempts = 0;
  const h = harness(t, { asyncAllocate() { attempts++; throw new Error('synthetic prepare throw'); } });
  const players = h.group(); h.join(players); const original = snapshot(h.queue, players);
  assert.ok(h.accept(players).every((r) => r.ok));
  retained(h, players, original); assert.equal(attempts, 1); assert.equal(h.queue.offers.size, 0);
});

test('partial synchronous commit throw invokes compensation once and never publishes', async (t) => {
  const h = harness(t), players = h.group(); h.friendParty(players.slice(0, 2));
  h.join(players); const original = snapshot(h.queue, players); h.accept(players);
  const call = h.calls[0], ready = prepared(h, call);
  ready.result.commit = () => { ready.counts.commit++; players[0].roomCode = ready.result.code; throw new Error('synthetic commit failure'); };
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 1, abort: 1, publish: 0 });
  retained(h, players, original); assert.equal(h.queue.offers.size, 0); assert.equal(h.calls.length, 1);
  assert.ok(players.every((p) => !p.messages.some((m) => m.t === 'room.state' || m.state === 'matched')));
  h.queue.close(); h.queue.close(); assert.equal(ready.counts.abort, 1);
});

for (const failure of ['promise', 'thenable', 'false', 'error']) test(`commit ${failure} is rejected without publication or lost tickets`, async (t) => {
  const h = harness(t), players = h.group(); h.join(players); const original = snapshot(h.queue, players); h.accept(players);
  const call = h.calls[0], ready = prepared(h, call);
  ready.result.commit = () => {
    ready.counts.commit++;
    if (failure === 'promise') return Promise.reject(new Error('synthetic async commit rejection'));
    if (failure === 'thenable') return { then(resolve, reject) { reject(new Error('synthetic thenable commit')); } };
    return failure === 'false' ? false : { error: ERR.INTERNAL };
  };
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 1, abort: 1, publish: 0 });
  retained(h, players, original); assert.equal(h.queue.offers.size, 0);
});

test('invalid prepared result is compensated and leaves no match publication', async (t) => {
  const h = harness(t), players = h.group(); h.start(players);
  let aborts = 0;
  h.calls[0].work.resolve({ code: null, abort() { aborts++; } }); await flush();
  assert.equal(aborts, 1); assert.equal(h.queue.offers.size, 0);
  assert.ok(players.every((p) => h.queue.state(p).state === 'queued' && p.roomCode === null));
});

test('cancel aborts pending prepare; late cleanup cannot delete a new offer or overwrite a replacement ticket', async (t) => {
  const h = harness(t), { players, states } = h.start(), first = h.calls[0];
  const old = prepared(h, first, 'OLD');
  assert.deepEqual(h.queue.cancel(players[0], states[0]), { ok: true });
  assert.equal(first.signals, 1); assert.equal(first.context.signal.aborted, true);
  assert.equal(first.context.isCurrent(), false); assert.equal(h.queue.size, 3);
  const fresh = h.join(players);
  assert.ok(fresh[0].ticketId !== states[0].ticketId && fresh[0].offerId !== states[0].offerId, 'replacement has a fresh ticket and offer');
  assert.ok(h.accept(players, fresh).every((r) => r.ok));
  const second = h.calls[1], currentOffer = h.queue.offers.get(second.context.offerId), newer = prepared(h, second, 'NEW');
  first.work.resolve(old.result); await flush();
  assert.deepEqual(old.counts, { commit: 0, abort: 1, publish: 0 });
  assert.equal(first.signals, 1); assert.equal(h.queue.offers.get(second.context.offerId), currentOffer);
  assert.ok(h.queue.state(players[0]).ticketId === fresh[0].ticketId, 'old continuation does not restore an obsolete ticket');
  assert.ok(second.context.isCurrent());
  second.work.resolve(newer.result); await flush();
  assert.deepEqual(newer.counts, { commit: 1, abort: 0, publish: 1 });
  assert.ok(players.every((p) => p.roomCode === 'NEW' && h.queue.state(p).state === 'matched'));
});

test('disconnect drops its whole party, preserves accepted peers, and compensates late results once', async (t) => {
  const h = harness(t), players = h.group(); h.friendParty(players.slice(0, 2));
  h.start(players); const call = h.calls[0], ready = prepared(h, call), original = snapshot(h.queue, players);
  players[0].connected = false; h.queue.remove(players[0], 'disconnected');
  assert.equal(call.signals, 1); assert.equal(h.queue.size, 2);
  assert.ok(players.slice(0, 2).every((p) => !h.queue.has(p) && p.roomCode === 'FRIEND'));
  retained(h, players.slice(2), original.slice(2));
  h.queue.remove(players[0]); h.queue.close(); h.queue.close();
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 }); assert.equal(call.signals, 1);
});

for (const invalid of ['available', 'version', 'network']) test(`completion rechecks participant ${invalid} before commit`, async (t) => {
  const h = harness(t), { players } = h.start(), call = h.calls[0], ready = prepared(h, call);
  if (invalid === 'available') players[0].unavailable = true;
  if (invalid === 'version') players[0].matchmakingVersion++;
  if (invalid === 'network') players[0].limitKey = 'different-network';
  assert.equal(call.context.isCurrent(), false);
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 });
  assert.equal(h.queue.has(players[0]), false); assert.equal(h.queue.size, 3);
  assert.ok(players.slice(1).every((p) => h.queue.state(p).state === 'queued' && p.roomCode === null));
});

for (const changed of ['ticketId', 'accepted', 'entry', 'offer', 'entryVersion', 'expiresAt', 'vote', 'entryList', 'deadline']) test(`completion cannot use a changed ${changed} epoch/identity`, async (t) => {
  const h = harness(t), { players } = h.start(), call = h.calls[0], ready = prepared(h, call);
  const entry = h.queue.entries.get(players[0].playerId), offer = h.queue.offers.get(call.context.offerId);
  let replacement;
  if (changed === 'ticketId') entry.ticketId = 'synthetic-replacement-ticket';
  if (changed === 'accepted') entry.accepted = false;
  if (changed === 'entryVersion') entry.version++;
  if (changed === 'expiresAt') entry.expiresAt++;
  if (changed === 'vote') entry.revivalVote = true;
  if (changed === 'entryList') offer.entries.reverse();
  if (changed === 'deadline') offer.deadline++;
  if (changed === 'entry') { replacement = { ...entry, ticketId: 'synthetic-replacement-ticket' }; h.queue.entries.set(players[0].playerId, replacement); }
  if (changed === 'offer') { replacement = { ...offer, allocation: null }; h.queue.offers.set(offer.id, replacement); }
  assert.equal(call.context.isCurrent(), false);
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 });
  if (changed === 'ticketId') assert.ok(h.queue.entries.get(players[0].playerId).ticketId === 'synthetic-replacement-ticket');
  if (changed === 'entry') assert.equal(h.queue.entries.get(players[0].playerId), replacement);
  if (changed === 'offer') assert.equal(h.queue.offers.get(offer.id), replacement);
});

test('pending deadline is min(allocation budget, original offer deadline); refresh breaks all-accepted timeout', async (t) => {
  const h = harness(t, { allocationMs: 8000, options: { acceptMs: 100, waitMs: 10_000 } });
  const players = h.group(), states = h.join(players), initialDeadline = states[0].deadline;
  h.accept(players.slice(0, 3), states.slice(0, 3)); h.clock.time += 75;
  assert.deepEqual(h.queue.accept(players[3], states[3]), { ok: true });
  const call = h.calls[0], ready = prepared(h, call), original = snapshot(h.queue, players);
  assert.equal(h.queue.state(players[0]).deadline, initialDeadline); assert.equal(h.queue.timer.ms, 25);
  h.clock.time = initialDeadline;
  assert.equal(h.queue.accept(players[0], states[0]).error, ERR.BAD_TARGET);
  assert.equal(call.signals, 1); assert.equal(h.queue.offers.size, 0);
  retained(h, players, original); assert.ok(h.queue.timer.ms > 1);
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 });
});

test('pending sweep/timer timeout preserves healthy age and arms TTL instead of spinning a past deadline', async (t) => {
  const h = harness(t, { allocationMs: 50, options: { waitMs: 10_000, acceptMs: 1000 } });
  const { players } = h.start(), original = snapshot(h.queue, players), call = h.calls[0], ready = prepared(h, call);
  assert.equal(h.queue.timer.ms, 50); h.fire();
  assert.equal(call.signals, 1); assert.equal(call.context.isCurrent(), false); assert.equal(h.queue.offers.size, 0);
  retained(h, players, original); assert.equal(h.queue.timer.ms, 9950); assert.equal(h.calls.length, 1);
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 });
  h.fire(); assert.equal(h.queue.size, 0); assert.equal(h.queue.timer, null);
  assert.ok(h.scheduled.every((timer) => timer.ms >= 1 && timer.unrefs === 1));
});

test('ticket TTL expiry aborts pending prepare and never resurrects expired party tickets', async (t) => {
  const h = harness(t, { options: { waitMs: 100, acceptMs: 1000 } }), players = h.group();
  h.friendParty(players.slice(0, 2)); h.start(players);
  const call = h.calls[0], ready = prepared(h, call);
  assert.equal(h.queue.timer.ms, 100); h.fire();
  assert.equal(call.signals, 1); assert.equal(h.queue.size, 0); assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.timer, null);
  assert.ok(players.slice(0, 2).every((p) => p.roomCode === 'FRIEND'));
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 }); assert.equal(h.queue.size, 0);
});

test('completion after deadline without a sweep still cannot commit or publish', async (t) => {
  const h = harness(t, { allocationMs: 50 }), { players } = h.start(), call = h.calls[0], ready = prepared(h, call);
  const original = snapshot(h.queue, players); h.clock.time += 50;
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 });
  retained(h, players, original); assert.equal(h.queue.offers.size, 0); assert.ok(h.queue.timer.ms > 1);
});

test('close cancels once, rejects admission and handles late result cleanup without resurrecting state', async (t) => {
  const h = harness(t), { players } = h.start(), call = h.calls[0], ready = prepared(h, call);
  h.queue.close(); h.queue.close();
  assert.equal(call.signals, 1); assert.equal(call.context.isCurrent(), false);
  assert.equal(h.queue.size, 0); assert.equal(h.queue.parties.size, 0); assert.equal(h.queue.offers.size, 0); assert.equal(h.queue.timer, null);
  assert.equal(h.queue.join(players[0], { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 0, abort: 1, publish: 0 }); assert.equal(call.signals, 1);
  assert.ok(players.every((p) => p.roomCode === null && p.messages.at(-1).reason === 'shutdown'));
});

test('clear is reusable but its old continuation cannot change new tickets/offers', async (t) => {
  const h = harness(t), { players, states } = h.start(), first = h.calls[0], old = prepared(h, first, 'OLD');
  h.queue.clear('reset'); const fresh = h.join(players); h.accept(players, fresh);
  const current = h.calls[1], newer = h.queue.offers.get(current.context.offerId);
  first.work.resolve(old.result); await flush();
  assert.deepEqual(old.counts, { commit: 0, abort: 1, publish: 0 }); assert.equal(first.signals, 1);
  assert.equal(h.queue.offers.get(current.context.offerId), newer);
  assert.ok(h.queue.state(players[0]).ticketId === fresh[0].ticketId && fresh[0].ticketId !== states[0].ticketId);
  assert.ok(current.context.isCurrent());
});

test('commit reentrancy through cancellation is detected, compensated once and never published', async (t) => {
  const h = harness(t), { players, states } = h.start(), call = h.calls[0], ready = prepared(h, call);
  ready.result.commit = () => { ready.counts.commit++; h.queue.cancel(players[0], states[0]); };
  call.work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 1, abort: 1, publish: 0 });
  assert.equal(call.signals, 1); assert.equal(h.queue.has(players[0]), false);
  assert.ok(players.every((p) => p.roomCode === null && !p.messages.some((m) => m.state === 'matched')));
});

for (const cleanup of ['throw', 'reject']) test(`late cleanup ${cleanup} is handled without second abort or new publication`, async (t) => {
  const h = harness(t), { players, states } = h.start(), call = h.calls[0];
  let aborts = 0, commits = 0, publications = 0;
  h.queue.cancel(players[0], states[0]);
  call.work.resolve({ code: 'OLD', commit() { commits++; }, publish() { publications++; },
    abort() { aborts++; if (cleanup === 'throw') throw new Error('synthetic cleanup throw'); return Promise.reject(new Error('synthetic cleanup rejection')); } });
  await flush(); h.queue.close(); h.queue.close();
  assert.equal(aborts, 1); assert.equal(commits, 0); assert.equal(publications, 0); assert.equal(call.signals, 1);
});

test('a failed pending cohort does not disturb an unrelated offer or its successful commit', async (t) => {
  const h = harness(t), first = h.start(), second = h.start();
  const current = h.queue.offers.get(h.calls[1].context.offerId), ready = prepared(h, h.calls[1], 'OTHER');
  const original = snapshot(h.queue, first.players);
  h.calls[0].work.reject(new Error('synthetic independent failure')); await flush();
  assert.equal(h.queue.offers.get(h.calls[1].context.offerId), current); assert.ok(h.calls[1].context.isCurrent());
  retained(h, first.players, original); // The failure itself never repumps.
  h.calls[1].work.resolve(ready.result); await flush();
  assert.deepEqual(ready.counts, { commit: 1, abort: 0, publish: 1 });
  // A later independent successful allocation may pump a fresh offer, but must
  // not allocate that cohort again until every human confirms the fresh offer.
  assert.ok(first.players.every((p, i) => p.roomCode === null && h.queue.state(p).state !== 'matched'
    && h.queue.entries.get(p.playerId).ticketId === original[i].ticketId && !h.queue.entries.get(p.playerId).accepted));
  assert.ok(second.players.every((p) => h.queue.state(p).state === 'matched'));
  assert.equal(h.calls.length, 2);
});
