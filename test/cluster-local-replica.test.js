// Local display replicas over the deployed topology (browser → private ingress → game node with a real combat Worker
// pool → GameHost → the real Match): g.sim reaches the node as a game intent, the declared player's own field arrives as
// b.start { local } and b.sync digests (never its b.snap), the digests are those of the received spec, and g.sim
// { stream } brings the stream back. The coordinator is the small protocol fixture of test/cluster-bond-plan.test.js;
// the match rules themselves: test/match/local-replica.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { startIngress } from '../server/cluster/ingress.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { Match } from '../server/match/Match.js';
import { GameData } from '../server/match/gamedata.js';
import { CombatWorkerPool } from '../server/match/combat/pool.js';
import { getData } from '../server/data.js';
import { DataSource } from '../server/sim/simdata.js';
import { createBattleFromSpec } from '../server/sim/spec.js';
import { isSyncTick, stateHash } from '../server/sim/syncHash.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://cluster-fixture.invalid';
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const wait = (fn, ms = 60_000, label = 'local replica fixture deadline') => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const poll = () => { if (fn()) resolve(); else if (Date.now() >= end) reject(new Error(label)); else setTimeout(poll, 10); };
  poll();
});
async function connect(url) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN });
  const frames = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let rid = 100;
  return { socket, frames, send: message => socket.send(JSON.stringify(message)), ask: message => { const r = ++rid; socket.send(JSON.stringify({ ...message, rid: r })); return r; } };
}
const reply = (c, rid) => c.frames.find(frame => (frame.t === 'ok' || frame.t === 'error') && frame.rid === rid);
const lastPublic = c => c.frames.filter(frame => frame.t === 'm.public').at(-1);

test('g.sim crosses ingress → game node: b.start { local } + b.sync with the received spec\'s digests, no own b.snap; g.sim stream brings it back', { timeout: 120_000 }, async t => {
  const controlServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const controlWss = new WebSocketServer({ server: controlServer, path: '/ws', perMessageDeflate: false });
  const sessions = new Map();
  controlWss.on('connection', socket => {
    socket.on('error', () => {});
    let uid;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.t === 'hello') {
        uid = message.name;
        sessions.set(uid, socket);
        socket.send(JSON.stringify({ t: 'welcome', playerId: uid, token: 'fixture-only-token', name: uid, serverNow: Date.now(), version: 1 }));
      } else if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong', c: message.c, s: Date.now(), rid: message.rid }));
      else socket.send(JSON.stringify({ t: 'ok', rid: message.rid }));
    });
    socket.on('close', () => { if (sessions.get(uid) === socket) sessions.delete(uid); });
  });
  await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
  const coordinatorUrl = `http://127.0.0.1:${controlServer.address().port}`;
  const key = randomBytes(32);
  const data = getData({ log: QUIET });
  const combatPool = new CombatWorkerPool({ size: 1, data, log: QUIET });
  await combatPool.start();
  const game = await startGameNode({ nodeId: 'game-a', generation: 'generation-a', build: 'test-build', key, data,
    MatchClass: Match, combatPool, streamMarkers: true, afkRemoveRounds: 0 });
  const nodes = [{ nodeId: 'game-a', url: game.url, key }];
  const entry = await startIngress({ coordinatorUrl, nodes, origins: [ORIGIN], shutdownMs: 100 });
  const platform = new RemoteGamePlatform({ nodes, build: 'test-build', protocol: 1,
    sendControl: (id, message) => {
      const socket = sessions.get(id); if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(message)); return true;
    } });
  const clients = [];
  t.after(async () => {
    await platform.close();
    for (const client of clients) client.socket.terminate();
    await entry.close();
    await game.close();
    await combatPool.close();
    for (const socket of controlWss.clients) socket.terminate();
    await new Promise(resolve => controlWss.close(resolve));
    controlServer.closeAllConnections(); await new Promise(resolve => controlServer.close(resolve));
  });
  await platform.refresh();
  const client = async id => {
    const c = await connect(entry.url); clients.push(c);
    c.send({ t: 'hello', name: id, version: 1, matchmakingVersion: MATCHMAKING_VERSION });
    await wait(() => c.frames.some(frame => frame.t === 'welcome'));
    return c;
  };
  const p1 = await client('p1'), p2 = await client('p2');
  const seat = (i, id) => ({ seat: i, playerId: id, name: id, isBot: false, connected: true, loadout: null });
  const modeId = 'mode_multi_funny';
  const staged = await platform.prepare({ roomCode: 'LOCL', build: 'test-build', protocol: 1, mode: 'coop', modeId,
    difficulty: 'FUNNY', seed: 11, matchNo: 1, snapshotHz: 10, revivalEnabled: false,
    seats: [seat(0, 'p1'), seat(1, 'p2')], spectators: [] });
  staged.commit();
  for (const id of ['p1', 'p2']) sessions.get(id)?.send(JSON.stringify({ t: 'room.state', code: 'LOCL', inMatch: true }));
  staged.publish();
  await platform.contexts.get(staged.assignmentId).publication;
  for (const c of [p1, p2]) await wait(() => lastPublic(c)?.phase === 'INFO_CHECK');
  assert.equal(lastPublic(p1).localReplica, true, 'the node offers local replicas');

  // p1's browser declares it simulates locally (a game intent, answered by the node); p2's never does
  const declared = p1.ask({ t: 'g.sim', local: true });
  await wait(() => reply(p1, declared));
  assert.equal(reply(p1, declared).t, 'ok');

  // through the opening: briefing, the strategy draft, 选择自编, then a prep both players ready at once
  for (const c of [p1, p2]) c.ask({ t: 'g.infoReady', setupRevision: lastPublic(c).setupRevision ?? 0 });
  const bands = new GameData(data, modeId).bandIds();
  await wait(() => {
    for (const [c, id] of [[p1, 'p1'], [p2, 'p2']]) {
      const pub = lastPublic(c);
      if (pub?.phase === 'BAND_DRAFT' && pub.draft?.turn === id && !c.asked) {
        c.asked = true;
        c.ask({ t: 'g.band', bandId: bands.find(b => !Object.values(pub.draft.picks).includes(b)) });
      }
      if (pub?.phase === 'BAND_DRAFT' && pub.draft?.turn !== id) c.asked = false;
      // 选择自编 (CUSTOM_CHECK): every version since 2026-11-21 — both bring none rather than wait out its 30 s
      if (pub?.phase === 'CUSTOM_CHECK' && !c.brought) { c.brought = true; c.ask({ t: 'g.diyBring', slots: [] }); }
    }
    return lastPublic(p1)?.phase === 'PREP';
  }, 60_000, 'prep');
  for (const c of [p1, p2]) c.ask({ t: 'g.ready', ready: true });
  await wait(() => lastPublic(p1)?.phase === 'COMBAT', 60_000, 'combat');

  await wait(() => p1.frames.filter(f => f.t === 'b.sync').length >= 3, 60_000, 'b.sync');
  const start = p1.frames.find(f => f.t === 'b.start');
  assert.ok(start && start.local === true && start.authoritative === false && start.fieldId === 'n:p1', 'own field as a local replica');
  assert.equal(p2.frames.some(f => f.t === 'b.start' || f.t === 'b.sync'), false, 'an undeclared browser is streamed');
  await wait(() => p2.frames.some(f => f.t === 'b.snap' && f.fieldId === 'n:p2'), 30_000, 'p2 stream');
  assert.equal(p1.frames.some(f => (f.t === 'b.snap' || f.t === 'b.ev' || f.t === 'm.field') && f.fieldId === 'n:p1'), false, 'never its own stream');
  // the digests are those of the spec the browser received (JSON over the wire)
  const syncs = p1.frames.filter(f => f.t === 'b.sync' && f.battleId === start.battleId);
  const b = createBattleFromSpec(start.spec, new DataSource(data, null), { logger: QUIET });
  const mine = new Map();
  while (!b.finished && b.tickCount < syncs.at(-1).tick) { b.step(); if (isSyncTick(b)) mine.set(b.tickCount, stateHash(b)); }
  for (const s of syncs) assert.equal(mine.get(s.tick), s.h, `digest of tick ${s.tick}`);

  // the replica asks for the stream: b.end stream, then the field's meta and snapshots
  const back = p1.ask({ t: 'g.sim', battleId: start.battleId, stream: true, tick: syncs[0].tick });
  await wait(() => reply(p1, back));
  assert.equal(reply(p1, back).t, 'ok');
  await wait(() => p1.frames.some(f => f.t === 'b.end' && f.battleId === start.battleId && f.reason === 'stream'), 10_000, 'b.end stream');
  await wait(() => p1.frames.some(f => f.t === 'b.snap' && f.fieldId === 'n:p1') || lastPublic(p1)?.phase !== 'COMBAT', 30_000, 'own stream');
  if (lastPublic(p1)?.phase === 'COMBAT') assert.ok(p1.frames.some(f => f.t === 'm.field' && f.fieldId === 'n:p1'), 'meta first');
});
