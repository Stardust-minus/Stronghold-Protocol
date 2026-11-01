// test/helpers/clusterStack.js — a whole cluster on one host for the checkpoint tests (test/cluster-persist.test.js,
// test/persist-valkey.test.js): game nodes with real Matches (quick battles), coordinator and ingress over native HTTP/WS,
// each process lifetime given a fresh store object over a store the test keeps (`storeFor()`).
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { startCoordinator } from '../../server/cluster/coordinator.js';
import { startGameRuntime } from '../../server/cluster/game-runtime.js';
import { startIngress } from '../../server/cluster/ingress.js';
import { createRpcAuthenticator, createRpcClient } from '../../server/cluster/rpc.js';
import { sendEndReceipt, sendMemberRemoved } from '../../server/cluster/receipts.js';
import { Match } from '../../server/match/Match.js';
import { MATCHMAKING_VERSION } from '../../shared/constants.js';

export const ORIGIN = 'https://persist-cluster-fixture.invalid', BUILD = 'persist-fixture';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (condition, ms = 15_000, what = 'condition') => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() >= deadline) throw new Error(`deadline: ${what}`); await sleep(10); }
};
/** Real matches, quick: battles at the engine's top speed, no bot rehearsal. */
export class QuickMatch extends Match {
  constructor(opts) { super({ ...opts, botRehearsal: 0, combatSpeed: 200 }); }
}

export async function client(url, name, token, hello = {}) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN });
  const frames = [], pending = new Map(); let rid = 0;
  socket.on('error', () => {});
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString()); frames.push(message);
    const request = pending.get(message.rid);
    if (request) { pending.delete(message.rid); if (message.t === 'error') request.reject(Object.assign(new Error(message.code), { code: message.code })); else request.resolve(message); }
  });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ t: 'hello', name, ...(token ? { token } : {}), version: 1, matchmakingVersion: MATCHMAKING_VERSION, ...hello }));
  await until(() => frames.some((f) => f.t === 'welcome' || f.t === 'error'), 5000, 'welcome');
  const welcome = frames.find((f) => f.t === 'welcome');
  const request = (t, fields = {}) => new Promise((resolve, reject) => {
    const id = ++rid;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`request deadline: ${t}`)); }, 10_000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ t, ...fields, rid: id }));
  });
  return { socket, frames, request, playerId: welcome.playerId, token: welcome.token, closed, last: (t) => frames.filter((f) => f.t === t).at(-1) };
}

/** One stack lifetime: game nodes (same ids / keys / ports across lifetimes, new generations), coordinator, ingress. */
export async function stack(storeFor, { configs, ports = [], nodesOnly = false, coordinatorOnly = null, events = new Map() } = {}) {
  const generations = configs.map(() => randomUUID());
  const games = coordinatorOnly ? coordinatorOnly.games : await Promise.all(configs.map((config, i) => startGameRuntime({
    ...config, generation: generations[i], port: ports[i] ?? 0, combatWorkers: 0, MatchClass: QuickMatch, persistStore: storeFor(), persistSaveMs: 60_000,
    onEnd: (receipt) => sendEndReceipt({ client: events.get(config.nodeId), nodeGeneration: generations[i], receipt }),
    onRemoved: (removal) => sendMemberRemoved({ client: events.get(config.nodeId), nodeGeneration: generations[i], removal }) })));
  if (nodesOnly) return { games };
  const nodes = configs.map((config, i) => ({ nodeId: config.nodeId, key: config.key, url: games[i].url }));
  const coordinator = await startCoordinator({ nodes, build: BUILD, port: 0, quiet: true, heartbeatMs: 300, persistStore: storeFor(), persistSaveMs: 60_000 });
  for (const config of configs) events.set(config.nodeId, createRpcClient({ url: coordinator.privateUrl, authority: createRpcAuthenticator({ key: config.key, scope: config.nodeId }) }));
  const ingress = await startIngress({ coordinatorUrl: coordinator.url, nodes, origins: [ORIGIN], shutdownMs: 100 });
  return { games, coordinator, ingress, events, nodes };
}
export const stop = async (s, { coordinator = true, games = true } = {}) => {
  await s.ingress?.close();
  await Promise.all([coordinator ? s.coordinator?.close() : null, ...(games ? s.games.map((g) => g.close()) : [])]);
  for (const e of s.events?.values() || []) e.close();
};
export const nodeConfigs = () => ['game-a', 'game-b'].map((nodeId) => ({ nodeId, key: randomBytes(32), build: BUILD }));
export const actorOf = (s, code) => {
  for (const g of s.games) for (const ctx of g.gameHost.contexts.values()) if (ctx.spec.roomCode === code && ctx.state === 'committed') return ctx;
  return null;
};

/** One human and three AI seats in a co-op room (a single human: no phase is timed), played to `round`'s prep, held there. */
export async function playToPrep(s, round, { hello = {}, configure = null, bots = 3 } = {}) {
  const c = await client(s.ingress.url, 'Doctor', undefined, hello);
  const step = (x) => { if (process.env.SP_TEST_DEBUG) console.error('[step]', x); };
  await c.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  await configure?.(c);
  for (let i = 0; i < bots; i++) await c.request('room.addBot');
  step('created');
  await c.request('room.start');
  step('started');
  const code = c.last('room.state').code;
  await until(() => actorOf(s, code), 10_000, 'actor');
  const ctx = actorOf(s, code), ps = ctx.match.players.get(c.playerId);
  ps.autoplay = true;
  await c.request('g.infoReady');
  let seen = '';
  await until(() => {
    const now = `${ctx.match.phase} R${ctx.match.round} ready=${ctx.match.order.map((p) => +p.ready).join('')}`;
    if (now !== seen) { seen = now; step(now); }
    return ctx.match.phase === 'PREP' && ctx.match.round === round;
  }, 60_000, `prep ${round}`);
  ps.autoplay = false;
  ps.ready = false;
  ctx.match.markPublic();
  await until(() => ctx.match.alivePlayers().every((p) => p.botControlled ? p.ready : true), 10_000, 'bots ready');
  return { c, code, ctx, ps };
}

