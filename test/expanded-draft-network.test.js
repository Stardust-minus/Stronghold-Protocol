// Real Match and native HTTP/WS: twenty humans share six reusable legal options, one pick per human.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';

const rules = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 };
for (const family of ['bounty', 'supply', 'shop', 'tactic']) test(`actual twenty-human ${family} draft reuses six options and every manual choice then advances without timeout`, { timeout: 20000 }, async t => {
  class DraftMatch extends Match {
    constructor(opts) {
      const original = opts.data.choices, mode = original.schedule.mode_multi_normal;
      const data = { ...opts.data, choices: { ...original, schedule: { ...original.schedule,
        mode_multi_normal: { ...mode, rounds: { ...mode.rounds, 3: { ...mode.rounds[3], families: [{ family, weight: 1 }] } } } } } };
      super({ ...opts, data, seed: 713, clientCombat: false, botRehearsal: 0 });
    }
    start() { this.startRound(3); }
  }
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, MatchClass: DraftMatch, combatWorkers: 0, trialWorkers: 0 }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  for (let i = 0; i < 20; i++) {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    c.welcome = await c.hello(`Draft${i}`, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
  }
  for (const group of [clients.slice(0, 10), clients.slice(10)]) {
    const host = group[0];
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: rules })).t, 'ok');
    const room = await host.waitFor('room.state', m => m.hostId === host.welcome.playerId);
    for (const c of group.slice(1)) {
      assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
      assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).t, 'ok');
  }
  for (const c of clients) {
    const offered = await c.waitFor('queue.state', m => m.state === 'offered');
    assert.equal((await c.request({ t: 'queue.accept', ticketId: offered.ticketId, offerId: offered.offerId })).t, 'ok');
  }
  const publicFrame = await clients[0].waitFor('m.public', m => m.phase === 'SP_DRAFT', 6000);
  assert.equal(publicFrame.sp.cards.length, 6); assert.equal(publicFrame.sp.allowRepeat, true);
  assert.equal(publicFrame.sp.family, family); assert.equal(publicFrame.sp.order.length, 20);
  const match = srv.lobby.roomOf(srv.registry.byId(clients[0].welcome.playerId)).match, draft = match.sp;
  const byId = new Map(clients.map(c => [c.welcome.playerId, c]));
  const picks = [];
  for (const [i, playerId] of publicFrame.sp.order.entries()) {
    assert.equal(match.spTurn(), playerId);
    const preferred = i % 6, client = byId.get(playerId);
    if (!match.spCardAvailable(draft.cards[preferred])) {
      assert.equal(draft.cards[preferred].kind, 'item');
      assert.equal(match.itemPool.canGain(draft.cards[preferred].id), false);
      assert.equal((await client.request({ t: 'g.choice', idx: preferred })).code, ERR.SOLD_OUT);
      assert.equal(draft.picks[playerId], undefined, 'an exhausted request consumes no manual pick');
    }
    const idx = match.spCardAvailable(draft.cards[preferred]) ? preferred : draft.cards.find(c => match.spCardAvailable(c))?.idx;
    assert.notEqual(idx, undefined, 'the seeded six-card fixture holds enough different legal stock for all twenty humans');
    assert.equal((await client.request({ t: 'g.choice', idx })).t, 'ok');
    assert.equal(draft.picks[playerId], idx); picks.push(idx);
    if (i + 1 < publicFrame.sp.order.length) assert.equal((await client.request({ t: 'g.choice', idx })).code, ERR.ALREADY);
  }
  await clients[0].waitFor('m.public', m => m.phase === 'PREP', 2000);
  assert.equal(match.phase, 'PREP'); assert.equal(Object.keys(draft.picks).length, 20);
  assert.equal(new Set(Object.values(draft.picks)).size, 6);
  assert.equal(draft.picks[clients[19].welcome.playerId], picks[publicFrame.sp.order.indexOf(clients[19].welcome.playerId)]);
  assert.equal(match.errorCount, 0);
});
