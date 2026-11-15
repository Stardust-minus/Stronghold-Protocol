// 「允许观战者接替 AI」 on the deployed topology (server/aiTakeover.js remoteAiTakeover, ClusterLobby.transferRemoteSeat,
// GameHost.transferAiSeat): real coordinator, game nodes, ingress and Match over native HTTP/WS. The vote itself and its
// cancellations: test/ai-takeover.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { stack, stop, nodeConfigs, actorOf, playToPrep, client, until } from './helpers/clusterStack.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { LOBBY_DEFAULT_VERSION } from '../shared/versions.js';

const enable = (c) => c.request('room.setAiTakeover', { on: true });

async function fixture(t, { store = new MemoryValkey(), round = 2, ...opts } = {}) {
  const storeFor = () => memoryStore(store), configs = nodeConfigs();
  const s = await stack(storeFor, { configs });
  const live = { stack: s };
  t.after(() => stop(live.stack));
  const { c: host, code, ctx } = await playToPrep(s, round, { configure: enable, ...opts });
  const late = await client(s.ingress.url, 'Late', undefined, opts.hello);
  await late.request('room.spectate', { code });
  await until(() => ctx.members.get(late.playerId)?.binding, 10_000, 'the spectator bound');
  const botId = ctx.match.order.find((p) => p.isBot).playerId;
  return { s, live, store, storeFor, configs, host, late, code, ctx, botId, room: s.coordinator.lobby.getRoom(code) };
}
const openVote = async (host, late, botId) => {
  await late.request('room.aiRequest', { botId });
  await until(() => host.last('room.state')?.aiTakeoverVotes?.length === 1, 5000, 'the vote reaches the room');
  return host.last('room.state').aiTakeoverVotes[0];
};
async function takeOver({ host, late, botId }) {
  const vote = await openVote(host, late, botId);
  assert.equal((await host.request('room.aiVote', { voteId: vote.id, approve: true })).t, 'ok');
  await until(() => late.frames.some((f) => f.t === 'welcome' && f.playerId === botId), 5000, 'welcomed as the seat');
  await until(() => late.frames.some((f) => f.t === 'm.private' && f.playerId === botId), 10_000, 'the seat\'s private state');
}

test('the host opts in, a spectator is voted into an AI seat: the seat is theirs on the node, the coordinator and the ingress', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { s, host, late, ctx, botId, room } = f, oldId = late.playerId, lobby = s.coordinator.lobby;
  const ps = ctx.match.players.get(botId);
  ps.funds = 71;
  assert.equal(room.aiTakeoverEnabled, true);
  await takeOver(f);
  assert.equal(late.frames.find((m) => m.t === 'welcome' && m.playerId === botId).takeoverFrom, oldId);
  assert.deepEqual([ps.isBot, ps.connected, ps.funds, ps.aiTakeoverRound], [false, true, 71, 2]);
  assert.equal(ctx.members.get(botId).role, 'player');
  assert.equal(ctx.members.has(oldId), false);
  assert.deepEqual(ctx.spec.takenOver, [botId]);
  assert.equal(ctx.spec.seats.find((x) => x.playerId === botId).isBot, false);
  assert.equal(room.seatOf(botId).isBot, false);
  assert.equal(room.spectatorOf(oldId), null);
  assert.equal(lobby.registry.byId(oldId), null);
  assert.equal(lobby.registry.byId(botId).token, late.token);
  // a repeat of the transfer (its reply got lost) is answered OK and changes nothing
  const game = s.games.find((g) => g.gameHost.contexts.has(ctx.spec.assignmentId));
  assert.deepEqual(game.gameHost.transferAiSeat(ctx.spec.assignmentId, oldId, botId, 'Late', 2), { ok: true });
  assert.deepEqual(game.gameHost.transferAiSeat(ctx.spec.assignmentId, 'somebody', botId, 'Late', 2), { error: 'WRONG_PHASE' });
  // plays on as the seat
  assert.equal((await late.request('g.ready', { ready: true })).t, 'ok');
  assert.equal(ps.ready, true);
  // a reload gets the seat back with the same token
  await late.socket.terminate();
  await until(() => !ps.connected, 5000, 'offline');
  const back = await client(s.ingress.url, 'Late', late.token);
  assert.equal(back.playerId, botId);
  await until(() => back.frames.some((m) => m.t === 'm.private' && m.playerId === botId), 10_000, 'resumed');
  assert.equal(ps.connected, true);
  back.socket.close();
});

test('a refused transfer changes nothing: the spectator keeps watching; a vote fenced to its round does not pass in another', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { host, late, ctx, botId, room } = f, ps = ctx.match.players.get(botId);
  ctx.match.phase = 'COMBAT';
  await assert.rejects(late.request('room.aiRequest', { botId }), { code: 'BAD_TARGET' }, 'no request outside the prep');
  ctx.match.phase = 'PREP';
  const vote = await openVote(host, late, botId);
  ctx.match.round++;
  await assert.rejects(host.request('room.aiVote', { voteId: vote.id, approve: true }), { code: 'BAD_TARGET' });
  ctx.match.round--;
  assert.equal(ps.isBot, true);
  assert.equal(room.seatOf(botId).isBot, true);
  assert.ok(room.spectatorOf(late.playerId));
  assert.equal(ctx.members.get(late.playerId).role, 'spectator');
  assert.ok(ctx.members.get(late.playerId).binding, 'its game channel stands');
  assert.equal(ctx.members.has(botId), false);
  assert.equal(room.match.members.has(botId), false);
  await until(() => !host.last('room.state')?.aiTakeoverVotes?.length, 5000, 'the vote is gone');
  // and asks again
  await takeOver(f);
  assert.equal(ps.isBot, false);
});

test('the next match of the room: the seat stays a human\'s under the AI seat\'s id, also as a spectator elsewhere', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { s, host, late, code, ctx, botId, room } = f;
  await takeOver(f);
  ctx.match.finish({ victory: false, reason: 'test' });
  await until(() => !room.match, 15_000, 'back in the room');
  const result = late.frames.find((m) => m.t === 'm.result');
  assert.ok(result, 'the result reached the seat');
  assert.equal(result.players.find((p) => p.playerId === botId).aiTakeoverRound, 2, 'marked');
  assert.equal((await late.request('room.ready', { ready: true })).t, 'ok');
  assert.equal((await host.request('room.start')).t, 'ok');
  await until(() => { const next = actorOf(s, code); return next && next !== ctx; }, 15_000, 'next match');
  const next = actorOf(s, code);
  assert.deepEqual(next.spec.takenOver, [botId]);
  assert.equal(next.match.players.get(botId).isBot, false);
  assert.equal(next.match.players.get(botId).aiTakeoverRound, undefined, 'a match of its own');
  await until(() => next.members.get(botId)?.binding, 10_000, 'the seat bound');
  // leaves; a session under an AI seat's id can watch another room's match
  assert.equal((await late.request('room.leave')).t, 'ok');
  const other = await client(s.ingress.url, 'Other');
  await other.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  for (let i = 0; i < 3; i++) await other.request('room.addBot');
  await other.request('room.start');
  const otherCode = other.last('room.state').code;
  await until(() => actorOf(s, otherCode), 10_000, 'the other actor');
  assert.equal((await late.request('room.spectate', { code: otherCode })).t, 'ok');
  await until(() => actorOf(s, otherCode).members.get(botId)?.binding, 10_000, 'watching');
  other.socket.close();
});

test('an eight-seat room: the capability versions of the browser\'s own hello stay (the handover hello must not lose them)', { timeout: 120_000 }, async (t) => {
  const hello = { playerCapacityVersion: PLAYER_CAPACITY_VERSION };
  const f = await fixture(t, { hello, bots: 6, configure: async (c) => {
    await enable(c);
    await c.request('room.setExperimental', { experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 } });
  } });
  await takeOver(f);
  const session = f.s.coordinator.lobby.registry.byId(f.botId);
  assert.equal(session.playerCapacityVersion, PLAYER_CAPACITY_VERSION);
  assert.equal(session.matchmakingVersion, MATCHMAKING_VERSION);
  assert.equal(f.ctx.match.players.get(f.botId).isBot, false);
});

test('the whole stack restarts after a handover: the seat comes back a human\'s, marked; the option stays on', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { live, store, storeFor, configs, host, late, code, botId } = f;
  await takeOver(f);
  await stop(live.stack);
  await late.closed;
  const second = await stack(storeFor, { configs });
  live.stack = second;
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 1, 15_000, 'rebuilt');
  assert.equal(second.coordinator.lobby.getRoom(code).aiTakeoverEnabled, true);
  const back = await client(second.ingress.url, 'Late', late.token);
  assert.equal(back.playerId, botId);
  const hostBack = await client(second.ingress.url, 'Doctor', host.token);
  await until(() => back.frames.some((m) => m.t === 'm.private' && m.playerId === botId), 10_000, 'resumed');
  const ctx = actorOf(second, code), ps = ctx.match.players.get(botId);
  assert.deepEqual([ps.isBot, ps.aiTakeoverRound], [false, 2]);
  assert.ok(store.keys('sp:cp:').length >= 1);
  assert.equal((await back.request('g.ready', { ready: true })).t, 'ok');
  back.socket.close(); hostBack.socket.close();
});

test('the coordinator alone restarts after a handover: the match is taken over where it runs, the seat is the session\'s', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { live, storeFor, configs, host, late, code, ctx, botId, s } = f;
  await takeOver(f);
  await stop(s, { games: false });
  await late.closed;
  const second = await stack(storeFor, { configs, coordinatorOnly: s });
  live.stack = second;
  await until(() => second.coordinator.lobby.restoreStats.adopted === 1, 15_000, 'adopted');
  const back = await client(second.ingress.url, 'Late', late.token);
  const hostBack = await client(second.ingress.url, 'Doctor', host.token);
  assert.equal(back.playerId, botId);
  await until(() => ctx.members.get(botId)?.binding, 10_000, 'the seat bound again');
  assert.equal(second.coordinator.lobby.getRoom(code).seatOf(botId).isBot, false);
  back.socket.close(); hostBack.socket.close();
});

test('a game node restarts under a running coordinator after a handover: rebuilt from its checkpoint with the seat a human\'s', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t), { s, late, code, ctx, botId, configs, storeFor } = f;
  await takeOver(f);
  const owner = s.games.find((g) => g.gameHost.contexts.has(ctx.spec.assignmentId));
  await until(() => owner.checkpoints.written.get(ctx.spec.assignmentId)?.ok && JSON.parse(owner.checkpoints.written.get(ctx.spec.assignmentId).json).spec.takenOver?.includes(botId), 10_000, 'a checkpoint after the handover');
  const i = s.games.indexOf(owner), port = Number(new URL(owner.url).port);
  await owner.close();
  const [fresh] = (await stack(storeFor, { configs: [configs[i]], ports: [port], nodesOnly: true, events: s.events })).games;
  s.games[i] = fresh;
  await until(() => s.coordinator.lobby.restoreStats.rebuilt === 1, 30_000, 'rebuilt elsewhere');
  await until(() => { const next = actorOf(s, code); return next && next !== ctx && next.members.get(botId)?.binding; }, 30_000, 'the seat bound on the new actor');
  const next = actorOf(s, code);
  assert.deepEqual([next.match.players.get(botId).isBot, next.match.players.get(botId).aiTakeoverRound], [false, 2]);
  assert.equal(late.socket.readyState, 1, 'moved over on its socket');
});

// (this fork, 0.4.0) Another official version's match on a game node (SP_VERSION_PLACEMENT=node, the default) — with
// 规程·序列Ⅰ the lobby default, most co-op rooms: the node reads and changes the seat in its version host
// (GameHost.aiSeat / transferAiSeat on a hosted actor, Match.acceptAiHandover fenced by the vote's round).
const VERSION_GAME = Object.freeze({ versionCombatWorkers: 0, versionHosts: 1,
  matchHost: { matchOptions: { clientCombat: false, botRehearsal: 0, combatSpeed: 200 } } });
const hostedActor = (s, code) => {
  for (const g of s.games) for (const ctx of g.gameHost.contexts.values()) if (ctx.spec.roomCode === code && ctx.state === 'committed') return { ctx, node: g };
  return null;
};

test(`a ${LOBBY_DEFAULT_VERSION} room on a game node: a spectator is voted into an AI seat of the node's version host`, { timeout: 300_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store);
  const s = await stack(storeFor, { configs: nodeConfigs(), game: VERSION_GAME });
  t.after(() => stop(s));
  const host = await client(s.ingress.url, 'Doctor');
  await host.request('room.create', { mode: 'coop', difficulty: 'NORMAL', version: LOBBY_DEFAULT_VERSION });
  const st = host.last('room.state');
  assert.equal(st.version, LOBBY_DEFAULT_VERSION);
  await enable(host);
  for (let i = 0; i < 2; i++) await host.request('room.addBot');
  await host.request('room.contentReady', { cs: st.content.cs });
  await host.request('room.start');
  const code = st.code;
  await until(() => hostedActor(s, code), 15_000, 'on a node');
  const { ctx } = hostedActor(s, code);
  assert.equal(ctx.match.hosted, true, 'in the node\'s version host');
  const room = s.coordinator.lobby.getRoom(code);
  assert.equal(room.match.hosted, undefined, 'not the coordinator\'s');
  // round 1 on autoplay, then held in round 2's prep (a lone human's prep waits for its Ready)
  await host.request('g.infoReady').catch(() => null);
  await host.request('g.autoplay', { on: true });
  const pub = (f) => host.frames.some((m) => m.t === 'm.public' && f(m));
  await until(() => pub((m) => m.round === 1 && !['PREP', 'ROUND_START', 'INFO_CHECK', 'CUSTOM_CHECK', 'BAND_DRAFT', 'SP_DRAFT'].includes(m.phase)), 150_000, 'round 1 fought');
  await host.request('g.autoplay', { on: false });
  await until(() => pub((m) => m.phase === 'PREP' && m.round === 2), 150_000, 'round 2 prep');
  const late = await client(s.ingress.url, 'Late');
  await late.request('room.spectate', { code });
  await until(() => ctx.members.get(late.playerId)?.binding, 10_000, 'the spectator bound');
  const before = await ctx.match.aiHandoverView();
  const bot = before.players.find((p) => p.isBot && p.alive && !p.left);
  assert.ok(bot, JSON.stringify(before.players));
  const botId = bot.playerId, oldId = late.playerId;
  // the node's answer is its version host's: round 2, nobody on autoplay
  const game = s.games.find((g) => g.gameHost.contexts.has(ctx.spec.assignmentId));
  assert.deepEqual(await game.gameHost.aiSeat(ctx.spec.assignmentId, oldId, botId), { ok: true, round: 2, autoplay: [] });
  assert.deepEqual(await game.gameHost.aiSeat(ctx.spec.assignmentId, 'somebody', botId), { error: 'WRONG_PHASE' });
  // a vote fenced to another round does not pass on the version host
  assert.deepEqual(await game.gameHost.transferAiSeat(ctx.spec.assignmentId, oldId, botId, 'Late', 3), { error: 'WRONG_PHASE' });
  await takeOver({ host, late, botId });
  const after = await ctx.match.aiHandoverView();
  const seat = after.players.find((p) => p.playerId === botId);
  assert.deepEqual([seat.isBot, seat.autoplay, seat.funds, [...seat.pieceUids].sort()], [false, false, bot.funds, [...bot.pieceUids].sort()],
    'the version host\'s seat is a human\'s, with the bot\'s funds and pieces');
  assert.equal(late.frames.find((m) => m.t === 'welcome' && m.playerId === botId).takeoverFrom, oldId);
  assert.equal(ctx.members.get(botId).role, 'player');
  assert.equal(ctx.members.has(oldId), false);
  assert.deepEqual(ctx.spec.takenOver, [botId]);
  assert.equal(ctx.spec.seats.find((x) => x.playerId === botId).isBot, false);
  assert.equal(room.seatOf(botId).isBot, false);
  assert.equal(room.spectatorOf(oldId), null);
  // a repeat of the transfer (its reply got lost) is answered OK and changes nothing
  assert.deepEqual(await game.gameHost.transferAiSeat(ctx.spec.assignmentId, oldId, botId, 'Late', 2), { ok: true });
  // plays on as the seat
  assert.equal((await late.request('g.ready', { ready: true })).t, 'ok', 'the version host takes the Ready of the seat');
});
