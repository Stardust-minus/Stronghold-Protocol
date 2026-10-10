// Native HTTP/WS plus the real combat Worker: configured expanded modes reuse band and SP indices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { Match } from '../server/match/Match.js';
import { WorkerFieldRunner } from '../server/match/combat/runner.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';

const options = capacity => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity });
for (const capacity of [4, 8, 12, 16, 20]) for (const family of capacity === 4 ? ['supply'] : ['bounty', 'supply', 'shop', 'tactic']) {
  test(`actual ${capacity}-mode humans choose ${family}, resume during selection and enter a real Worker`, { timeout: 30000 }, async t => {
    class RuleMatch extends Match {
      constructor(opts) {
        const choices = opts.data.choices, mode = choices.schedule.mode_multi_normal;
        const data = { ...opts.data, choices: { ...choices, schedule: { ...choices.schedule,
          mode_multi_normal: { ...mode, rounds: { ...mode.rounds, 3: { ...mode.rounds[3], families: [{ family, weight: 1 }] } } } } } };
        super({ ...opts, data, seed: 713, clientCombat: false, botRehearsal: 0 }); this.jumped = false;
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
    const members = [], repeat = capacity > 4;
    for (let i = 0; i < capacity; i++) members.push(await connect(`RepeatWire${i}`));
    for (const group of [members.slice(0, capacity / 2), members.slice(capacity / 2)]) {
      assert.equal((await group[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: options(capacity) })).t, 'ok');
      const room = await group[0].waitFor('room.state', m => m.hostId === group[0].welcome.playerId);
      for (const c of group.slice(1)) {
        assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
        assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
      }
      assert.equal((await group[0].request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).t, 'ok');
    }
    for (const c of members) {
      const offer = await c.waitFor('queue.state', m => m.state === 'offered');
      assert.equal(offer.required, capacity);
      assert.equal((await c.request({ t: 'queue.accept', ticketId: offer.ticketId, offerId: offer.offerId })).t, 'ok');
    }
    const room = srv.lobby.roomOf(srv.registry.byId(members[0].welcome.playerId)), match = room.match;
    assert.equal((await fetch(srv.url)).status, 200); assert.equal(match.capacityExperiment, repeat); assert.equal(match.twentyPlayerMode, capacity === 20);
    for (const c of members) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
    const band = await members[0].waitFor('m.public', m => m.phase === 'BAND_DRAFT'); assert.equal(band.draft.allowRepeat === true, repeat);
    const byId = new Map(members.map(c => [c.welcome.playerId, c])); let selections = 0;
    assert.equal((await byId.get(match.draft.order[1]).request({ t: 'g.band', bandId: 'band_bldsk' })).code, ERR.NOT_YOUR_TURN);
    while (match.draftTurn()) {
      const pid = match.draftTurn(), c = byId.get(pid);
      assert.equal((await c.request({ t: 'g.band', bandId: 'invalid-band' })).code, ERR.BAD_TARGET);
      if (!repeat && selections > 0) assert.equal((await c.request({ t: 'g.band', bandId: 'band_bldsk' })).code, ERR.BAD_TARGET);
      const bandId = repeat ? 'band_bldsk' : match.gd.bandIds().find(id => !match.bandTaken(id, pid));
      assert.equal((await c.request({ t: 'g.band', bandId })).t, 'ok');
      if (selections === 0) assert.equal((await c.request({ t: 'g.band', bandId })).code, ERR.ALREADY);
      selections++;
    }
    assert.equal(selections, capacity); assert.equal(new Set(match.order.map(ps => ps.bandId)).size, repeat ? 1 : capacity);
    const sp = await members[0].waitFor('m.public', m => m.phase === 'SP_DRAFT', 6000);
    assert.equal(sp.sp.allowRepeat === true, repeat); assert.equal(sp.sp.cards.length, 6); assert.equal(sp.sp.family, family);
    const draft = match.sp, firstCard = draft.cards[0];
    const firstStock = firstCard.kind === 'item' ? Math.floor(match.itemPool.left(firstCard.id) / match.itemPool.need(firstCard.id)) : Infinity;
    assert.equal((await byId.get(draft.order[1]).request({ t: 'g.choice', idx: 0 })).code, ERR.NOT_YOUR_TURN);
    const first = byId.get(match.spTurn());
    assert.equal((await first.request({ t: 'g.choice', idx: 6 })).code, ERR.BAD_TARGET);
    assert.equal((await first.request({ t: 'g.choice', idx: '0' })).code, ERR.BAD_MSG);
    const replies = await Promise.all([first.request({ t: 'g.choice', idx: 0 }), first.request({ t: 'g.choice', idx: 0 })]);
    assert.deepEqual(replies.map(r => r.t === 'ok' ? 'ok' : r.code), ['ok', ERR.ALREADY]);
    const select = async () => {
      const pid = match.spTurn(), c = byId.get(pid);
      if (!match.spCardAvailable(firstCard)) {
        if (repeat) { assert.equal(firstCard.kind, 'item'); assert.equal(match.itemPool.canGain(firstCard.id), false); }
        assert.equal((await c.request({ t: 'g.choice', idx: 0 })).code, ERR.SOLD_OUT);
        assert.equal(draft.picks[pid], undefined, 'a failed stock/taken check never consumes the confirmation');
      }
      const card = draft.cards.find(card => match.spCardAvailable(card));
      assert.ok(card, 'the seeded fixture has enough legal card stock for every human');
      assert.equal((await c.request({ t: 'g.choice', idx: card.idx })).t, 'ok');
      assert.equal(draft.picks[pid], card.idx);
      if (Object.keys(draft.picks).length < capacity) assert.equal((await c.request({ t: 'g.choice', idx: card.idx })).code, ERR.ALREADY);
    };
    const beforeResume = Math.min(7, capacity - 1);
    for (let i = 1; i < beforeResume; i++) await select();
    const high = members.at(-1), resumed = await connect(`RepeatWire${capacity - 1}`, high.welcome.token);
    assert.equal(resumed.welcome.playerId, high.welcome.playerId); byId.set(high.welcome.playerId, resumed); members[capacity - 1] = resumed;
    const recovered = await resumed.waitFor('m.public', m => m.phase === 'SP_DRAFT');
    assert.equal(recovered.sp.allowRepeat === true, repeat); assert.equal(recovered.sp.cards.length, 6);
    assert.deepEqual(recovered.sp.picks, draft.picks); assert.equal(Object.keys(draft.picks).length, beforeResume);
    while (match.spTurn()) await select();
    await members[0].waitFor('m.public', m => m.phase === 'PREP');
    assert.equal(Object.keys(draft.picks).length, capacity);
    if (repeat) {
      assert.equal(draft.picks[draft.order[0]], 0); assert.equal(draft.picks[draft.order[1]], 0, 'same band and same index are permitted within stock');
      assert.equal(Object.values(draft.picks).filter(idx => idx === 0).length, Math.min(capacity, firstStock));
      if (firstCard.kind !== 'item') assert.equal(new Set(Object.values(draft.picks)).size, 1);
    } else assert.equal(new Set(Object.values(draft.picks)).size, capacity);
    for (const c of members) assert.equal((await c.request({ t: 'g.ready', ready: true })).t, 'ok');
    await members[0].waitFor('m.public', m => m.phase === 'COMBAT', 6000);
    const runner = match.runner; assert.ok(runner instanceof WorkerFieldRunner);
    const initial = await runner.session.ready; assert.equal(initial.fields.length, capacity); assert.equal(srv.combatPool.stats().ready, 1);
    assert.equal(match.errorCount, 0); assert.equal(match.simErrors, 0);
  });
}
