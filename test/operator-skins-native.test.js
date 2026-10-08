// Actual loopback HTTP RPC / WS and real Match; synthetic memory-only credentials, no external hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startGameNode } from '../server/cluster/game-node.js';
import { createRpcAuthenticator, createRpcClient } from '../server/cluster/rpc.js';
import { createTicketAuthority } from '../server/cluster/tickets.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { DATA } from './match/harness.js';
import { OPERATOR_SKINS } from '../shared/skins.js';
import { PHASE, ERR } from '../shared/constants.js';

const charId = 'char_103_angel', a = OPERATOR_SKINS[0].id, b = OPERATOR_SKINS[1].id;
const choices = id => ({ [charId]: id });
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
async function socket(url) {
  const ws = new WebSocket(url.replace(/^http:/, 'ws:') + '/_cluster/game');
  const frames = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()); frames.push(frame);
    for (const item of [...waiters]) if (item.predicate(frame)) { clearTimeout(item.timer); waiters.splice(waiters.indexOf(item), 1); item.resolve(frame); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const wait = predicate => {
    const ready = frames.find(predicate); if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => { const item = { predicate, resolve, timer: setTimeout(() => reject(new Error('local skin WS timeout')), 4000) }; waiters.push(item); });
  };
  return { ws, frames, wait, send: value => ws.send(JSON.stringify(value)) };
}

test('native authenticated skin RPC reaches real Match; WS scout/reconnect never leaks private choices to spectator', { timeout: 20000 }, async t => {
  let match;
  class LocalMatch extends Match {
    constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler(), botRehearsal: 0 }); match = this; }
  }
  const key = randomBytes(32), nodeId = 'skin-native', generation = 'skin-generation', build = 'skin-build';
  const node = await startGameNode({ nodeId, generation, build, key, data: DATA, MatchClass: LocalMatch, log: quiet, shutdownMs: 50 });
  const rpc = createRpcClient({ url: node.url, authority: createRpcAuthenticator({ key, scope: nodeId }) });
  const tickets = createTicketAuthority({ key });
  const clients = [];
  t.after(async () => { rpc.close(); for (const c of clients) c.ws.terminate(); await node.close(); });
  const assignmentId = 'skin-assignment', roomCode = 'ABCD';
  const input = { assignmentId, roomCode, build, protocol: 1, seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
    seats: [{ seat: 0, playerId: 'p1', name: 'P1', isBot: false, connected: true, skins: choices(a) },
      { seat: 1, playerId: 'p2', name: 'P2', isBot: false, connected: true, skins: choices(b) }], spectators: ['s1'] };
  const prepared = await rpc.call('prepare', input);
  const bind = async id => {
    const c = await socket(node.url); clients.push(c);
    c.send({ t: 'cluster.bind', assignmentId, sessionId: id, ticket: tickets.issue({ sessionId: id, roomCode, assignmentId, nodeId,
      role: id === 's1' ? 'spectator' : 'player', build, protocol: 1 }) });
    await c.wait(f => f.t === 'cluster.bound'); return c;
  };
  const p1 = await bind('p1'), p2 = await bind('p2'), spectator = await bind('s1');
  await rpc.call('commit', { assignmentId }); await rpc.call('publish', { assignmentId });
  assert.deepEqual((await p1.wait(f => f.t === 'm.private')).skins, choices(a));
  assert.deepEqual((await p2.wait(f => f.t === 'm.private')).skins, choices(b));
  const payload = { assignmentId, nodeGeneration: generation, actorGeneration: prepared.actorGeneration, sessionId: 'p1', choices: choices(b) };
  assert.deepEqual(await rpc.call('setSkins', payload), { ok: true });
  assert.deepEqual((await p1.wait(f => f.t === 'm.private' && f.skins?.[charId] === b)).skins, choices(b));
  assert.deepEqual(match.players.get('p2').skins, choices(b));
  assert.equal((await rpc.call('setSkins', { ...payload, sessionId: 's1' })).error, ERR.SPECTATOR);
  await assert.rejects(rpc.call('setSkins', { ...payload, actorGeneration: prepared.actorGeneration + 1 }), e => e.code === 'STALE_ASSIGNMENT');
  const ps = match.players.get('p1'); ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
  const piece = ps.newPiece('chess', 'chess_char_3_01_a'); ps.board.set('10,3', piece);
  match.phase = PHASE.PREP;
  spectator.send({ t: 'g.watch', fieldId: 'n:p1', rid: 1 });
  const field = await spectator.wait(f => f.t === 'm.field' && f.units?.some(u => u.skinId === b));
  assert(field.units.every(u => !Object.hasOwn(u, 'skins')));
  assert.equal(field.units.find(u => u.skinId === b).spine, charId);
  assert.equal((await rpc.call('setSkins', { ...payload, choices: {} })).error, ERR.WRONG_PHASE);
  assert.deepEqual(ps.skins, choices(b));
  p1.ws.close(); const resumed = await bind('p1');
  assert.deepEqual((await resumed.wait(f => f.t === 'm.private')).skins, choices(b));
  assert(spectator.frames.every(f => f.t !== 'm.private' && !Object.hasOwn(f, 'skins')));
});
