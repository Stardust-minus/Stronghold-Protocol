// Native HTTP/WS plus the real combat Worker: twenty humans reuse one band and one SP index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { WorkerFieldRunner } from '../server/match/combat/runner.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';

const options = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 };
for (const family of ['bounty', 'supply', 'shop', 'tactic']) test(`actual twenty humans choose one band and ${family} idx0, resume during selection and enter a real Worker`, { timeout: 30000 }, async t => {
  class RuleMatch extends Match {
    constructor(opts) {
      const choices = opts.data.choices, mode = choices.schedule.mode_multi_normal;
      const data = { ...opts.data, choices: { ...choices, schedule: { ...choices.schedule,
        mode_multi_normal: { ...mode, rounds: { ...mode.rounds, 3: { ...mode.rounds[3], families: [{ family, weight: 1 }] } } } } } };
      super({ ...opts, data, clientCombat: false, botRehearsal: 0 }); this.jumped = false;
    }
    enterBattleCheck() { super.enterBattleCheck(); this.setDeadline(0.01, () => this.startRound(1)); }
    startRound(round) { if (!this.jumped) { this.jumped = true; round = 3; } super.startRound(round); }
    enterPrep() {
      super.enterPrep();
      // Repeated team item grants may overflow; this controlled fixture resolves temp before probing Worker startup.
      for (const ps of this.order) if (!ps.tempEmpty) ps.resolveTemp();
    }
  }
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, MatchClass: RuleMatch, combatWorkers: 1, trialWorkers: 0 }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    c.welcome = await c.hello(name, token, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION }); return c;
  };
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await connect(`RepeatWire${i}`));
  for (const group of [members.slice(0, 10), members.slice(10)]) {
    assert.equal((await group[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: options })).t, 'ok');
    const room = await group[0].waitFor('room.state', m => m.hostId === group[0].welcome.playerId);
    for (const c of group.slice(1)) {
      assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
      assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    assert.equal((await group[0].request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).t, 'ok');
  }
  for (const c of members) {
    const offer = await c.waitFor('queue.state', m => m.state === 'offered');
    assert.equal((await c.request({ t: 'queue.accept', ticketId: offer.ticketId, offerId: offer.offerId })).t, 'ok');
  }
  const room = srv.lobby.roomOf(srv.registry.byId(members[0].welcome.playerId)), match = room.match;
  assert.equal((await fetch(srv.url)).status, 200); assert.equal(match.twentyPlayerMode, true);
  for (const c of members) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  const band = await members[0].waitFor('m.public', m => m.phase === 'BAND_DRAFT'); assert.equal(band.draft.allowRepeat, true);
  const byId = new Map(members.map(c => [c.welcome.playerId, c])); let selections = 0;
  while (match.draftTurn()) {
    const c = byId.get(match.draftTurn()); assert.equal((await c.request({ t: 'g.band', bandId: 'band_bldsk' })).t, 'ok');
    if (selections++ === 0) assert.equal((await c.request({ t: 'g.band', bandId: 'band_bldsk' })).code, ERR.ALREADY);
  }
  assert.equal(selections, 20); assert.ok(match.order.every(ps => ps.bandId === 'band_bldsk'));
  const sp = await members[0].waitFor('m.public', m => m.phase === 'SP_DRAFT', 6000);
  assert.equal(sp.sp.allowRepeat, true); assert.equal(sp.sp.cards.length, 6); assert.equal(sp.sp.family, family);
  const draft = match.sp;
  const first = byId.get(match.spTurn());
  const replies = await Promise.all([first.request({ t: 'g.choice', idx: 0 }), first.request({ t: 'g.choice', idx: 0 })]);
  assert.deepEqual(replies.map(r => r.t === 'ok' ? 'ok' : r.code), ['ok', ERR.ALREADY]);
  for (let i = 1; i < 7; i++) assert.equal((await byId.get(match.spTurn()).request({ t: 'g.choice', idx: 0 })).t, 'ok');
  const high = members[19], resumed = await connect('RepeatWire19', high.welcome.token);
  assert.equal(resumed.welcome.playerId, high.welcome.playerId); byId.set(high.welcome.playerId, resumed); members[19] = resumed;
  const recovered = await resumed.waitFor('m.public', m => m.phase === 'SP_DRAFT');
  assert.equal(recovered.sp.allowRepeat, true); assert.equal(recovered.sp.cards.length, 6);
  assert.deepEqual(recovered.sp.picks, draft.picks); assert.equal(Object.keys(draft.picks).length, 7);
  while (match.spTurn()) assert.equal((await byId.get(match.spTurn()).request({ t: 'g.choice', idx: 0 })).t, 'ok');
  await members[0].waitFor('m.public', m => m.phase === 'PREP');
  assert.equal(Object.keys(draft.picks).length, 20); assert.ok(Object.values(draft.picks).every(idx => idx === 0));
  for (const c of members) assert.equal((await c.request({ t: 'g.ready', ready: true })).t, 'ok');
  await members[0].waitFor('m.public', m => m.phase === 'COMBAT', 6000);
  const runner = match.runner; assert.ok(runner instanceof WorkerFieldRunner);
  const initial = await runner.session.ready; assert.equal(initial.fields.length, 20); assert.equal(srv.combatPool.stats().ready, 1);
  assert.equal(match.errorCount, 0); assert.equal(match.simErrors, 0);
});
