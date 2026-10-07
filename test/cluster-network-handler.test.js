import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Network, SessionRegistry } from '../server/net.js';
import { ERR } from '../shared/constants.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.frames = []; }
  send(raw, options, callback) { this.frames.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  ping() {}
  terminate() { this.close(); }
  frame(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(t, handler, options = {}) {
  const network = new Network({ registry: new SessionRegistry(), handler, options });
  const socket = new Socket();
  network.handleConnection(socket, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  socket.frame({ t: 'hello', name: 'Fixture', version: 1 });
  t.after(() => network.close());
  return { network, socket };
}
const create = rid => ({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', rid });

test('coordinator opt-in waits for handler acceptance instead of acknowledging a Promise early', async t => {
  const work = deferred();
  const f = fixture(t, { onMessage: () => work.promise }, { allowAsyncHandlers: true });
  f.socket.frame(create(2));
  assert.equal(f.socket.frames.some(frame => frame.rid === 2), false);
  work.resolve({ ok: true }); await tick();
  assert.deepEqual(f.socket.frames.find(frame => frame.rid === 2), { t: 'ok', rid: 2 });
});

test('handler rejection is a fixed error and cannot echo private exception content', async t => {
  const work = deferred();
  const f = fixture(t, { onMessage: () => work.promise }, { allowAsyncHandlers: true });
  f.socket.frame(create(3));
  work.reject(new Error('fixture-only-private-detail')); await tick();
  assert.equal(f.socket.frames.find(frame => frame.rid === 3).code, ERR.INTERNAL);
  assert.equal(JSON.stringify(f.socket.frames).includes('fixture-only-private-detail'), false);
});

test('late asynchronous replies are fenced from a closed or replaced session transport', async t => {
  const work = deferred();
  const f = fixture(t, { onMessage: () => work.promise }, { allowAsyncHandlers: true });
  const token = f.socket.frames.find(frame => frame.t === 'welcome').token;
  f.socket.frame(create(4));
  const newer = new Socket();
  f.network.handleConnection(newer, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  newer.frame({ t: 'hello', name: 'Fixture', version: 1, token });
  work.resolve({ ok: true }); await tick();
  assert.equal(f.socket.frames.some(frame => frame.rid === 4), false);
  assert.equal(newer.frames.some(frame => frame.rid === 4), false);
});

test('pending handler safety bound is per socket; excess intents are refused before dispatch', async t => {
  const work = deferred(); let calls = 0;
  const f = fixture(t, { onMessage: () => { calls++; return work.promise; } }, { allowAsyncHandlers: true, ratePerSec: 2000, rateBurst: 2000 });
  for (let rid = 1; rid <= 65; rid++) f.socket.frame(create(rid));
  assert.equal(calls, 64);
  assert.equal(f.socket.frames.find(frame => frame.rid === 65).code, ERR.RATE);
  work.resolve({ ok: true }); await tick();
});

test('ordinary synchronous mode remains opt-out and never turns a thenable into success', async t => {
  const work = deferred();
  const f = fixture(t, { onMessage: () => work.promise });
  f.socket.frame(create(6));
  assert.equal(f.socket.frames.find(frame => frame.rid === 6).code, ERR.INTERNAL);
  work.reject(new Error('fixture-only')); await tick();
  assert.throws(() => new Network({ registry: new SessionRegistry(), handler: {}, options: { allowAsyncHandlers: 'yes' } }), TypeError);
});
