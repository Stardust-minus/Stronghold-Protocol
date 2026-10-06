// Native ws PMD regression tests. All traffic is synthetic and localhost-only;
// reconnect credentials stay in memory, and wire observations retain only counts/flags.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { NET_DEFAULTS, encode, send, sendRaw } from '../server/net.js';
import { resolveWsCompression, isCompressibleType } from '../server/wsCompression.js';
import { PROTOCOL_VERSION, MATCHMAKING_VERSION } from '../shared/constants.js';

const TYPES = ['b.snap', 'b.ev', 'm.field', 'm.damage'];
const EXPECTED_OPTIONS = {
  threshold: 512,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 12,
  concurrencyLimit: 8,
  zlibDeflateOptions: { level: 6, memLevel: 5 },
};

function spySocket(bufferedAmount = 0) {
  const calls = [];
  return {
    readyState: WebSocket.OPEN, bufferedAmount, calls, terminated: 0,
    send(text, options, callback) {
      // Do not keep text, parsed messages, or credentials in the spy.
      calls.push({ bytes: Buffer.byteLength(text), compress: options?.compress, callback: typeof callback });
      if (typeof callback === 'function') callback();
    },
    terminate() { this.terminated++; },
  };
}

function fixture(type, sequence = 1) {
  const units = Array.from({ length: 96 }, (_, i) => ({
    uid: i + 1, chessId: 'synthetic_operator', ownerId: 'synthetic_player',
    row: i % 4, col: i % 8, hp: 1000, maxHp: 1000, atk: 100, facing: 1,
  }));
  return {
    t: type, battleId: 'synthetic_battle', fieldId: 'synthetic_field',
    testSequence: sequence, tick: 20, units,
  };
}

/** Incremental RFC6455 frame metadata reader; skips payload without retaining it. */
function wireCounts(socket) {
  const frames = [];
  let header = Buffer.alloc(0), remaining = 0, current = null;
  function observe(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (current) {
        const count = Math.min(remaining, chunk.length - offset);
        remaining -= count;
        offset += count;
        if (remaining) continue;
        if (current.opcode === 1) frames.push(current);
        current = null;
        continue;
      }
      const needed = header.length < 2 ? 2 :
        2 + ((header[1] & 127) === 126 ? 2 : (header[1] & 127) === 127 ? 8 : 0) + ((header[1] & 128) ? 4 : 0);
      const count = Math.min(needed - header.length, chunk.length - offset);
      header = Buffer.concat([header, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (header.length < 2) continue;
      const lengthKind = header[1] & 127;
      const headerBytes = 2 + (lengthKind === 126 ? 2 : lengthKind === 127 ? 8 : 0) + ((header[1] & 128) ? 4 : 0);
      if (header.length < headerBytes) continue;
      const payloadBytes = lengthKind === 126 ? header.readUInt16BE(2) :
        lengthKind === 127 ? Number(header.readBigUInt64BE(2)) : lengthKind;
      current = {
        opcode: header[0] & 15, fin: !!(header[0] & 128), rsv1: !!(header[0] & 64),
        masked: !!(header[1] & 128), payloadBytes, wireBytes: headerBytes + payloadBytes,
      };
      header = Buffer.alloc(0);
      remaining = payloadBytes;
      if (!remaining) {
        if (current.opcode === 1) frames.push(current);
        current = null;
      }
    }
  }
  socket.on('data', observe);
  return { frames, dispose: () => socket.off('data', observe) };
}

async function terminate(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { ws._socket?.destroy(); resolve(); }, 1000);
    timer.unref();
    ws.once('close', () => { clearTimeout(timer); resolve(); });
    ws.terminate();
  });
}

async function boot(t, options = {}) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0, ...options,
  });
  const sockets = new Set();
  t.after(async () => {
    await Promise.all([...sockets].map(terminate));
    await srv.close();
  });
  async function connect(perMessageDeflate = true) {
    const serverSide = new Promise((resolve) => srv.wss.once('connection', resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, {
      perMessageDeflate, origin: `http://127.0.0.1:${srv.port}`, handshakeTimeout: 2000,
    });
    sockets.add(ws);
    const inbox = [], waiters = [];
    let messageCount = 0, extensionHeader = '', trace;
    function failWaiters() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('local test socket closed before the expected message'));
      }
    }
    ws.on('error', failWaiters);
    ws.on('close', () => { trace?.dispose(); failWaiters(); });
    ws.on('upgrade', (res) => { extensionHeader = res.headers['sec-websocket-extensions'] || ''; });
    ws.on('message', (data, binary) => {
      if (binary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { failWaiters(); return; }
      const entry = { msg, index: messageCount++ };
      const at = waiters.findIndex((w) => w.type === msg.t && w.predicate(msg));
      if (at < 0) inbox.push(entry);
      else {
        const [waiter] = waiters.splice(at, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
    });
    await new Promise((resolve, reject) => {
      const onError = () => reject(new Error('local test WebSocket handshake failed'));
      ws.once('error', onError);
      ws.once('open', () => { ws.off('error', onError); trace = wireCounts(ws._socket); resolve(); });
    });
    const serverWs = await serverSide;
    return {
      ws, serverWs, trace, extensionHeader,
      transmit(msg) { ws.send(JSON.stringify(msg), { compress: false }); },
      waitFor(type, predicate = () => true) {
        const at = inbox.findIndex((entry) => entry.msg.t === type && predicate(entry.msg));
        if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { type, predicate, resolve, reject };
          waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`timed out waiting for synthetic ${type} traffic`));
          }, 3000);
          waiters.push(waiter);
        });
      },
    };
  }
  return { srv, connect };
}

async function hello(client, token) {
  client.transmit({ t: 'hello', name: 'Synthetic', version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION, ...(token ? { token } : {}) });
  const entry = await client.waitFor('welcome');
  // Boolean assertions prevent the failure reporter from printing credentials.
  assert.ok(typeof entry.msg.token === 'string' && /^[0-9a-f]{32}$/.test(entry.msg.token), 'welcome has an in-memory reconnect credential');
  assert.ok(typeof entry.msg.playerId === 'string', 'welcome has a player identity');
  assert.equal(client.trace.frames[entry.index].rsv1, false);
  return entry.msg;
}

async function roomFor(server, client) {
  client.transmit({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', rid: 101 });
  await client.waitFor('ok', (msg) => msg.rid === 101);
  const { msg } = await client.waitFor('room.state');
  const room = server.lobby.getRoom(msg.code);
  assert.ok(room, 'normal lobby admission created the room');
  return room;
}

async function receivedFrame(client, type, sequence) {
  const entry = await client.waitFor(type, (msg) => msg.testSequence === sequence);
  const frame = client.trace.frames[entry.index];
  assert.ok(frame, 'observed an actual server-to-client frame');
  assert.equal(frame.fin, true);
  assert.equal(frame.masked, false);
  return { msg: entry.msg, frame };
}

function assertRedacted(error, marker) {
  assert.ok(error instanceof TypeError, 'invalid compression mode rejects with TypeError');
  assert.ok(typeof error.message === 'string' && !error.message.includes(marker), 'invalid mode is not reflected in the error');
}

async function withModeEnv(value, run) {
  const previous = process.env.SP_WS_COMPRESSION;
  if (value === undefined) delete process.env.SP_WS_COMPRESSION;
  else process.env.SP_WS_COMPRESSION = value;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.SP_WS_COMPRESSION;
    else process.env.SP_WS_COMPRESSION = previous;
  }
}

describe('WebSocket compression policy', { concurrency: false }, () => {
  test('off by default; on has exactly the bounded PMD options', () => {
    assert.equal(resolveWsCompression(), false);
    assert.equal(resolveWsCompression('off'), false);
    assert.deepEqual(resolveWsCompression('on'), EXPECTED_OPTIONS);
  });

  test('invalid modes reject without reflecting untrusted input', () => {
    const marker = 'synthetic-untrusted-mode-marker';
    for (const value of [marker, '', 'gzip', true, 1, null, { toString: () => marker }]) {
      let caught;
      try { resolveWsCompression(value); } catch (error) { caught = error; }
      assertRedacted(caught, marker);
    }
  });

  test('only the four battle-state types are compressible', () => {
    for (const type of TYPES) assert.equal(isCompressibleType(type), true, type);
    for (const type of ['welcome', 'hello', 'pong', 'ok', 'error', 'room.state', 'lobby.presence', 'queue.state', 'm.public', 'm.private', 'm.result', 'b.damage', 'b.result', 'constructor', '__proto__', '', undefined, null, 1]) {
      assert.equal(isCompressibleType(type), false, 'non-allowlisted type stays uncompressed');
    }
  });

  test('sendRaw explicitly opts out unless compress is literally true', () => {
    for (const value of [undefined, false, 'true', 1, {}]) {
      const ws = spySocket();
      assert.equal(sendRaw(ws, '{"t":"b.snap"}', { compress: value }), true);
      assert.deepEqual(ws.calls, [{ bytes: 14, compress: false, callback: 'function' }]);
    }
    const ws = spySocket();
    assert.equal(sendRaw(ws, '{"t":"b.snap"}', { compress: true }), true);
    assert.equal(ws.calls[0].compress, true);
  });

  test('send uses the allowlist, including a large synthetic credential-bearing welcome', () => {
    for (const type of [...TYPES, 'welcome', 'm.private', 'room.state', 'b.damage']) {
      const ws = spySocket();
      const msg = type === 'welcome'
        ? { t: type, token: '0'.repeat(32), padding: 'synthetic-welcome-only-'.repeat(100) }
        : fixture(type);
      assert.ok(Buffer.byteLength(encode(msg)) > 512);
      assert.equal(send(ws, msg), true);
      assert.equal(ws.calls[0].compress, TYPES.includes(type));
      assert.equal(ws.calls[0].callback, 'function');
    }
  });

  test('compression does not weaken soft/hard backpressure boundaries', () => {
    const snap = fixture('b.snap');
    const atSoft = spySocket(NET_DEFAULTS.snapDropBytes);
    assert.equal(send(atSoft, snap), true);
    const overSoft = spySocket(NET_DEFAULTS.snapDropBytes + 1);
    assert.equal(send(overSoft, snap), false);
    assert.equal(overSoft.calls.length, 0);
    assert.equal(overSoft.terminated, 0);
    assert.equal(send(overSoft, fixture('b.ev')), true, 'reliable events survive soft congestion');
    const atHard = spySocket(NET_DEFAULTS.hardBufferBytes);
    assert.equal(send(atHard, fixture('m.field')), true);
    const overHard = spySocket(NET_DEFAULTS.hardBufferBytes + 1);
    assert.equal(sendRaw(overHard, encode(snap), { droppable: true, compress: true }), false);
    assert.equal(overHard.calls.length, 0);
    assert.equal(overHard.terminated, 1, 'hard cap is checked before soft snapshot dropping');
    const closed = spySocket();
    closed.readyState = WebSocket.CLOSED;
    assert.equal(send(closed, snap), false);
    assert.equal(sendRaw(null, encode(snap), { compress: true }), false);
    const throwing = spySocket();
    throwing.send = () => { throw new Error('synthetic send failure'); };
    assert.equal(send(throwing, snap), false);
    const circular = { t: 'b.snap' };
    circular.self = circular;
    assert.equal(send(spySocket(), circular), false);
  });
});

describe('native WebSocket compression through the complete server', { concurrency: false }, () => {
  for (const [mode, support, compressed] of [['on', true, true], ['off', true, false], ['on', false, false]]) {
    test(`${mode}, client PMD ${support ? 'supported' : 'unsupported'}: hello, native negotiation and real large frames`, { timeout: 10000 }, async (t) => {
      const { srv, connect } = await boot(t, { wsCompression: mode });
      const client = await connect(support);
      assert.equal(client.ws.extensions, compressed ? 'permessage-deflate' : '');
      if (compressed) {
        assert.match(client.extensionHeader, /(?:^|;)\s*server_no_context_takeover(?:;|$)/);
        assert.match(client.extensionHeader, /(?:^|;)\s*client_no_context_takeover(?:;|$)/);
        assert.match(client.extensionHeader, /(?:^|;)\s*server_max_window_bits=12(?:;|$)/);
      } else assert.equal(client.extensionHeader, '');
      const welcome = await hello(client);
      const room = await roomFor(srv, client);
      let sequence = 0;
      // These are the real encode-once lobby paths used for snapshots and events.
      for (const type of [...TYPES, 'b.damage']) {
        const msg = fixture(type, ++sequence), text = encode(msg), rawBytes = Buffer.byteLength(text);
        assert.equal(srv.lobby.sendEncodedToPlayer(room, welcome.playerId, type, text), true);
        const result = await receivedFrame(client, type, sequence);
        assert.equal(result.msg.units.length, msg.units.length, 'standard ws inflated the complete synthetic state');
        const shouldCompress = compressed && TYPES.includes(type);
        assert.equal(result.frame.rsv1, shouldCompress);
        if (shouldCompress) assert.ok(result.frame.wireBytes < rawBytes * 0.5, 'actual PMD wire bytes are below half the synthetic JSON size');
        else assert.equal(result.frame.payloadBytes, rawBytes);
      }
      // Broadcast encoding has its own sendRaw path and must preserve the same policy.
      const broadcast = fixture('b.ev', ++sequence);
      srv.lobby.broadcastRoom(room, broadcast);
      assert.equal((await receivedFrame(client, 'b.ev', sequence)).frame.rsv1, compressed);
      // Do not let the 512-byte threshold mask a welcome-policy regression.
      const largeWelcome = { t: 'welcome', testSequence: ++sequence, token: '0'.repeat(32), padding: 'synthetic-welcome-only-'.repeat(100) };
      assert.equal(send(client.serverWs, largeWelcome), true);
      const largeResult = await receivedFrame(client, 'welcome', sequence);
      assert.equal(largeResult.frame.rsv1, false);
      assert.equal(largeResult.frame.payloadBytes, Buffer.byteLength(encode(largeWelcome)));
      const small = { t: 'b.snap', testSequence: ++sequence, tick: 1, units: [] };
      assert.ok(Buffer.byteLength(encode(small)) < 512);
      assert.equal(srv.lobby.sendEncodedToPlayer(room, welcome.playerId, 'b.snap', encode(small)), true);
      assert.equal((await receivedFrame(client, 'b.snap', sequence)).frame.rsv1, false, 'small allowlisted frames stay below the threshold');
      client.transmit({ t: 'ping', c: 42, rid: 102 });
      assert.equal((await client.waitFor('pong', (msg) => msg.rid === 102)).msg.c, 42);
    });
  }

  test('default, environment selection and explicit option precedence', { timeout: 15000 }, async (t) => {
    const cases = [
      ['unset defaults off', undefined, {}, false],
      ['environment enables PMD', 'on', {}, true],
      ['option off overrides environment on', 'on', { wsCompression: 'off' }, false],
      ['option on overrides environment off', 'off', { wsCompression: 'on' }, true],
    ];
    for (const [name, env, options, enabled] of cases) {
      await t.test(name, async (subtest) => withModeEnv(env, async () => {
        const { connect } = await boot(subtest, options);
        const client = await connect();
        assert.equal(client.ws.extensions, enabled ? 'permessage-deflate' : '');
        await hello(client);
      }));
    }
  });

  test('invalid option/environment rejects startup with a redacted error', async (t) => {
    const marker = 'synthetic-untrusted-startup-marker';
    for (const fromEnv of [false, true]) {
      await t.test(fromEnv ? 'environment' : 'option', async (subtest) => withModeEnv(fromEnv ? marker : undefined, async () => {
        let started, caught;
        try {
          started = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0, ...(fromEnv ? {} : { wsCompression: marker }) });
        } catch (error) { caught = error; }
        finally { await started?.close(); }
        assertRedacted(caught, marker);
      }));
    }
  });

  test('encoded snapshots retain soft dropping and hard socket termination with PMD on', { timeout: 10000 }, async (t) => {
    const { srv, connect } = await boot(t, { wsCompression: 'on' });
    const client = await connect();
    const welcome = await hello(client), room = await roomFor(srv, client);
    let queued = NET_DEFAULTS.snapDropBytes + 1, queuedSends = 0;
    const originalSend = client.serverWs.send;
    client.serverWs.send = function (...args) { queuedSends++; return originalSend.apply(this, args); };
    Object.defineProperty(client.serverWs, 'bufferedAmount', { configurable: true, get: () => queued });
    t.after(() => { delete client.serverWs.bufferedAmount; client.serverWs.send = originalSend; });
    const beforeSoft = queuedSends;
    assert.equal(srv.lobby.sendEncodedToPlayer(room, welcome.playerId, 'b.snap', encode(fixture('b.snap', 501))), false);
    assert.equal(queuedSends, beforeSoft, 'soft-dropped snapshots never enter ws compression/send');
    assert.equal(srv.lobby.sendEncodedToPlayer(room, welcome.playerId, 'b.ev', encode(fixture('b.ev', 502))), true);
    assert.equal((await receivedFrame(client, 'b.ev', 502)).frame.rsv1, true);
    queued = NET_DEFAULTS.hardBufferBytes + 1;
    const beforeHard = queuedSends;
    const closed = new Promise((resolve) => client.ws.once('close', (code) => resolve(code)));
    assert.equal(srv.lobby.sendEncodedToPlayer(room, welcome.playerId, 'm.field', encode(fixture('m.field', 503))), false);
    assert.equal(queuedSends, beforeHard, 'hard-blocked frames never enter ws compression/send');
    assert.equal(await closed, 1006, 'the existing hard backpressure guard terminates the socket');
  });

  test('PMD keeps the existing reconnect identity and room seat', { timeout: 10000 }, async (t) => {
    const { srv, connect } = await boot(t, { wsCompression: 'on' });
    const first = await connect(), original = await hello(first);
    const room = await roomFor(srv, first);
    const second = await connect(), resumed = await hello(second, original.token);
    assert.equal(resumed.resumed, true);
    assert.ok(resumed.token === original.token, 'reconnect credential is unchanged (redacted)');
    assert.equal(resumed.playerId, original.playerId);
    assert.equal((await second.waitFor('room.state')).msg.code, room.code);
    assert.equal(srv.registry.size, 1, 'resuming does not allocate an orphan session');
    second.transmit({ t: 'ping', c: 7, rid: 103 });
    assert.equal((await second.waitFor('pong', (msg) => msg.rid === 103)).msg.c, 7);
  });
});
