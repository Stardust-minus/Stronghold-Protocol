// In-process actors and real HTTP/RPC + WS both preserve configured repeat rules and owner/privacy fences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../server/cluster/game-host.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { Match } from '../server/match/Match.js';
import { DATA } from './match/harness.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { until } from './match/combat-fixtures.js';

const channel = () => ({ messages: [], send(m) { this.messages.push(m); return true; }, sendEncoded(t, bytes) { this.messages.push(JSON.parse(bytes)); return true; }, close() {} });
const options = capacity => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity });
const repeatMatch = family => class extends Match {
  constructor(opts) {
    const choices = opts.data.choices, mode = choices.schedule.mode_multi_normal;
    const data = { ...opts.data, choices: { ...choices, schedule: { ...choices.schedule,
      mode_multi_normal: { ...mode, rounds: { ...mode.rounds, 3: { ...mode.rounds[3], families: [{ family, weight: 1 }] } } } } } };
    super({ ...opts, data, clientCombat: false, botRehearsal: 0 });
  }
};
const assignment = (capacity, count, name) => ({ assignmentId: name, roomCode: 'ABCD', build: 'local-repeat-build', protocol: 1,
  mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seed: 19, matchNo: 1, experimental: options(capacity),
  seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Player${seat}`, connected: true, isBot: false })), spectators: ['observer'] });

for (const capacity of [8, 12, 16, 20]) for (const family of ['bounty', 'supply', 'shop', 'tactic']) {
  test(`in-process cluster ${capacity}-mode ${family} actor retains same-band/same-idx snapshots across owner replacement`, async t => {
    const host = new GameHost({ data: DATA, MatchClass: repeatMatch(family) }); t.after(() => host.close());
    const spec = assignment(capacity, capacity, `repeated-${capacity}-${family}`);
    host.prepare(spec); const channels = new Map([...spec.seats.map(s => s.playerId), 'observer'].map(id => [id, channel()]));
    for (const [id, c] of channels) host.bind(spec.assignmentId, id, c); host.commit(spec.assignmentId);
    const match = host.contexts.get(spec.assignmentId).match;
    for (const seat of spec.seats) assert.deepEqual(host.handle(spec.assignmentId, seat.playerId, { t: 'g.infoReady' }, channels.get(seat.playerId)), { ok: true });
    await until(() => match.phase === 'BAND_DRAFT');
    assert.equal(match.publicView().draft.allowRepeat, true);
    assert.equal(host.handle(spec.assignmentId, match.draft.order[1], { t: 'g.band', bandId: 'band_bldsk' }, channels.get(match.draft.order[1])).error, ERR.NOT_YOUR_TURN);
    while (match.draftTurn()) {
      const id = match.draftTurn(); assert.deepEqual(host.handle(spec.assignmentId, id, { t: 'g.band', bandId: 'band_bldsk' }, channels.get(id)), { ok: true });
      assert.equal(host.handle(spec.assignmentId, id, { t: 'g.band', bandId: 'band_bldsk' }, channels.get(id)).error, ERR.ALREADY);
    }
    await until(() => match.phase === 'BATTLE_CHECK');
    assert.equal(Object.keys(match.draft.picks).length, capacity); assert.equal(new Set(Object.values(match.draft.picks)).size, 1);
    match.setDeadline(0); match.round = 3; match.enterSpDraft(); const draft = match.sp;
    assert.equal(match.publicView().sp.allowRepeat, true); assert.equal(draft.cards.length, 6);
    const firstCard = draft.cards[0];
    const firstStock = firstCard.kind === 'item' ? Math.floor(match.itemPool.left(firstCard.id) / match.itemPool.need(firstCard.id)) : Infinity;
    const select = () => {
      const id = match.spTurn();
      if (!match.spCardAvailable(firstCard)) {
        assert.equal(firstCard.kind, 'item'); assert.equal(match.itemPool.canGain(firstCard.id), false);
        assert.equal(host.handle(spec.assignmentId, id, { t: 'g.choice', idx: 0 }, channels.get(id)).error, ERR.SOLD_OUT);
        assert.equal(draft.picks[id], undefined, 'exhausted equipment cannot consume an actor confirmation');
      }
      const card = draft.cards.find(c => match.spCardAvailable(c));
      assert.ok(card, 'the seeded actor fixture has enough different legal stock for every member');
      assert.deepEqual(host.handle(spec.assignmentId, id, { t: 'g.choice', idx: card.idx }, channels.get(id)), { ok: true });
      assert.equal(draft.picks[id], card.idx);
      assert.equal(host.handle(spec.assignmentId, id, { t: 'g.choice', idx: card.idx }, channels.get(id)).error, ERR.ALREADY);
    };
    for (let i = 0; i < 7; i++) select();
    const high = `p${capacity - 1}`, old = channels.get(high), replacement = channel(); host.bind(spec.assignmentId, high, replacement); channels.set(high, replacement);
    assert.equal(host.handle(spec.assignmentId, high, { t: 'g.choice', idx: 0 }, old).error, ERR.NOT_IN_ROOM);
    const snapshot = replacement.messages.findLast(m => m.t === 'm.public');
    assert.equal(snapshot.sp.allowRepeat, true); assert.equal(snapshot.sp.cards.length, 6); assert.deepEqual(snapshot.sp.picks, draft.picks);
    while (match.spTurn()) select();
    await until(() => match.phase === 'PREP');
    assert.equal(Object.keys(draft.picks).length, capacity);
    assert.equal(draft.picks[draft.order[0]], 0); assert.equal(draft.picks[draft.order[1]], 0, 'same index remains legal within its real stock');
    assert.equal(Object.values(draft.picks).filter(idx => idx === 0).length, Math.min(capacity, firstStock));
    if (firstCard.kind !== 'item') assert.ok(Object.values(draft.picks).every(idx => idx === 0));
    for (const [id, c] of channels) {
      const personal = c.messages.filter(m => m.t === 'm.private');
      if (id === 'observer') assert.equal(personal.length, 0);
      else assert.ok(personal.length > 0 && personal.every(m => m.playerId === id));
    }
    assert.equal(host.member(spec.assignmentId, high).role, 'player'); assert.equal(match.errorCount, 0);
  });
}

// Established game-node/platform fixture pattern, with actual loopback RPC and ticket-bound WS, not an ingress mock.
async function realCluster(t, MatchClass) {
  const nodeId = 'draft-node', key = Buffer.alloc(32, 0x34), clients = [], bindings = [], channels = new Map();
  const node = await startGameNode({ nodeId, generation: 'draft-epoch', build: 'local-repeat-build', protocol: 1, key, data: DATA, MatchClass });
  const platform = new RemoteGamePlatform({ nodes: [{ nodeId, key, url: node.url }], build: 'local-repeat-build', protocol: 1,
    sendControl(id, frame) {
      if (frame.t === 'cluster.prepare') bindings.push((async () => {
        const c = await TestClient.connect(node.url.replace(/^http:/, 'ws:') + '/_cluster/game'); clients.push(c);
        c.send({ t: 'cluster.bind', assignmentId: frame.assignmentId, sessionId: id, ticket: frame.ticket, rid: null });
        await c.waitFor('cluster.bound'); channels.set(id, c);
      })());
      if (frame.t === 'cluster.abort' || frame.t === 'cluster.terminate') channels.get(id)?.ws.terminate();
      return true;
    } });
  t.after(async () => { await platform.close(); await Promise.all(clients.map(c => c.terminate())); await node.close(); });
  await platform.refresh(); return { node, platform, channels, bindings };
}

for (const [capacity, count] of [[4, 4], [8, 2], [8, 5], [12, 5], [16, 5], [20, 5]]) {
  test(`realRPC/WS cluster ${capacity}-mode actual ${count} players retain drafts, observer privacy and owner reconnect`, { timeout: 15000 }, async t => {
    const f = await realCluster(t, repeatMatch('supply')), spec = assignment(capacity, count, `rpc-repeated-${capacity}-${count}`);
    const handle = await f.platform.prepare(spec); await Promise.all(f.bindings);
    handle.commit(); handle.publish(); await f.platform.contexts.get(handle.assignmentId).publication;
    const match = f.node.gameHost.contexts.get(handle.assignmentId).match, repeat = capacity > 4;
    assert.equal(f.channels.size, count + 1); assert.equal(match.playerCapacity, capacity);
    assert.equal(f.platform.directory.bySession(`p${count - 1}`).assignmentId, handle.assignmentId);
    for (const seat of spec.seats) assert.equal((await f.channels.get(seat.playerId).request({ t: 'g.infoReady' })).t, 'ok');
    const observer = f.channels.get('observer');
    const band = await observer.waitFor('m.public', m => m.phase === 'BAND_DRAFT'); assert.equal(band.draft.allowRepeat === true, repeat);
    while (match.draftTurn()) {
      const id = match.draftTurn(), c = f.channels.get(id);
      if (!repeat && Object.keys(match.draft.picks).length) assert.equal((await c.request({ t: 'g.band', bandId: 'band_bldsk' })).code, ERR.BAD_TARGET);
      const bandId = repeat ? 'band_bldsk' : match.gd.bandIds().find(b => !match.bandTaken(b, id));
      assert.equal((await c.request({ t: 'g.band', bandId })).t, 'ok');
      if (Object.keys(match.draft.picks).length === 1) assert.equal((await c.request({ t: 'g.band', bandId })).code, ERR.ALREADY);
    }
    await until(() => match.phase === 'BATTLE_CHECK'); match.setDeadline(0); match.round = 3; match.enterSpDraft();
    const draft = match.sp, firstCard = draft.cards[0];
    const firstStock = firstCard.kind === 'item' ? Math.floor(match.itemPool.left(firstCard.id) / match.itemPool.need(firstCard.id)) : Infinity;
    assert.equal(draft.cards.length, 6); assert.equal(match.publicView().sp.allowRepeat === true, repeat);
    const first = f.channels.get(match.spTurn()); assert.equal((await first.request({ t: 'g.choice', idx: 0 })).t, 'ok');
    assert.equal((await first.request({ t: 'g.choice', idx: 0 })).code, ERR.ALREADY);
    const high = `p${count - 1}`, old = f.channels.get(high);
    assert.equal(f.platform.resume(handle.assignmentId, high), true); await until(() => f.channels.get(high) !== old);
    const resumed = f.channels.get(high); assert.notEqual(resumed, old);
    const recovered = await resumed.waitFor('m.public', m => m.phase === 'SP_DRAFT');
    assert.equal(recovered.sp.cards.length, 6); assert.equal(recovered.sp.allowRepeat === true, repeat); assert.deepEqual(recovered.sp.picks, draft.picks);
    await old.closed;
    while (match.spTurn()) {
      const id = match.spTurn(), c = f.channels.get(id);
      if (!match.spCardAvailable(firstCard)) {
        if (repeat) { assert.equal(firstCard.kind, 'item'); assert.equal(match.itemPool.canGain(firstCard.id), false); }
        assert.equal((await c.request({ t: 'g.choice', idx: 0 })).code, ERR.SOLD_OUT);
        assert.equal(draft.picks[id], undefined, 'exhausted stock leaves the resumed owner confirmation available');
      }
      const card = draft.cards.find(card => match.spCardAvailable(card));
      assert.ok(card, 'this real-RPC fixture has enough different legal stock for all members');
      assert.equal((await c.request({ t: 'g.choice', idx: card.idx })).t, 'ok');
      assert.equal(draft.picks[id], card.idx);
      if (Object.keys(draft.picks).length < count) assert.equal((await c.request({ t: 'g.choice', idx: card.idx })).code, ERR.ALREADY);
    }
    await until(() => match.phase === 'PREP');
    assert.equal(Object.keys(draft.picks).length, count);
    if (repeat) {
      assert.equal(draft.picks[draft.order[0]], 0); assert.equal(draft.picks[draft.order[1]], 0, 'same index survives owner reconnect within stock');
      assert.equal(Object.values(draft.picks).filter(idx => idx === 0).length, Math.min(count, firstStock));
    } else assert.equal(new Set(Object.values(draft.picks)).size, count);
    await until(() => spec.seats.every(s => f.channels.get(s.playerId).log.some(m => m.t === 'm.private')));
    for (const [id, c] of f.channels) {
      const personal = c.log.filter(m => m.t === 'm.private');
      if (id === 'observer') assert.equal(personal.length, 0);
      else assert.ok(personal.length > 0 && personal.every(m => m.playerId === id));
    }
    assert.equal(f.node.gameHost.stats().matches, 1); assert.equal(match.errorCount, 0);
  });
}
