// Actual private node HTTP/WS endpoints, with a deliberately small ingress
// adapter and test Match. This is not the complete browser/DNS/auth-gate test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';

class TestMatch {
  constructor(opts) { this.opts = opts; this.disconnects = new Set(); }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', marker: this.opts.roomCode });
    for (const seat of this.opts.seats) if (!seat.isBot) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId });
  }
  onReconnect(id) { this.opts.send(id, { t: 'm.public', phase: 'COMBAT', marker: this.opts.roomCode }); }
  onDisconnect(id) { this.disconnects.add(id); }
  addSpectator(id) { this.opts.send(id, { t: 'm.public', phase: 'COMBAT', marker: this.opts.roomCode }); }
  removeSpectator() {}
  handle(id, message) {
    if (message.t === 'g.watch') {
      this.opts.sendEncoded(id, 'm.field', JSON.stringify({ t: 'm.field', fieldId: message.fieldId, marker: this.opts.roomCode, padding: 'test-frame'.repeat(200) }));
    }
    return { ok: true };
  }
  dispose() {}
}
const spec = roomCode => ({ roomCode, build: 'test-build', protocol: 1, seed: 1, matchNo: 1, mode: 'coop', difficulty: 'NORMAL',
  modeId: 'mode_multi_normal', revivalEnabled: false, snapshotHz: 10, spectators: [`${roomCode}-observer`],
  seats: [0, 1, 2, 3].map(seat => ({ seat, playerId: `${roomCode}-player${seat}`, name: `Player${seat}`, isBot: false, connected: true, loadout: null })) });
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error('local network fixture deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const configs = ['game-a', 'game-b'].map(nodeId => ({ nodeId, generation: `${nodeId}-generation`, build: 'test-build', protocol: 1, key: randomBytes(32) }));
  const nodes = await Promise.all(configs.map(config => startGameNode({ ...config, MatchClass: TestMatch })));
  const channels = new Map(), controls = [];
  const sendControl = (sessionId, frame) => {
    controls.push({ sessionId, type: frame.t, assignmentId: frame.assignmentId }); // never record tickets
    let channel = channels.get(sessionId);
    if (frame.t === 'cluster.prepare') {
      const index = configs.findIndex(config => config.nodeId === frame.nodeId);
      const previous = channel;
      const socket = new WebSocket(nodes[index].url.replace(/^http:/, 'ws:') + '/_cluster/game');
      channel = { socket, assignmentId: frame.assignmentId, bound: false, published: frame.published, pending: [], visible: previous?.visible ?? [] };
      channels.set(sessionId, channel);
      socket.on('error', () => {});
      socket.on('open', () => socket.send(JSON.stringify({ t: 'cluster.bind', assignmentId: frame.assignmentId, sessionId, ticket: frame.ticket })));
      socket.on('message', bytes => {
        const raw = bytes.toString(), message = JSON.parse(raw);
        if (message.t === 'cluster.bound') {
          channel.bound = true;
          previous?.socket.close();
          return;
        }
        if (channel.published) channel.visible.push(raw); else channel.pending.push(raw);
      });
      return true;
    }
    if (!channel || channel.assignmentId !== frame.assignmentId) return true;
    if (frame.t === 'cluster.commit') { channel.published = true; channel.visible.push(...channel.pending); channel.pending = []; }
    if (frame.t === 'cluster.abort') { channel.socket.close(); channels.delete(sessionId); }
    return true;
  };
  const platform = new RemoteGamePlatform({ nodes: configs.map((config, i) => ({ ...config, url: nodes[i].url })),
    build: 'test-build', protocol: 1, sendControl });
  t.after(async () => {
    await platform.close();
    for (const channel of channels.values()) channel.socket.terminate();
    await Promise.all(nodes.map(node => node.close()));
  });
  await platform.refresh();
  return { platform, nodes, configs, channels, controls };
}

function publishRoom(f, staged, input) {
  staged.commit();
  for (const id of [...input.seats.map(s => s.playerId), ...input.spectators]) {
    f.channels.get(id).visible.push(JSON.stringify({ t: 'room.state', code: input.roomCode, inMatch: true }));
  }
  assert.equal(staged.publish(), true);
}

test('two actual game endpoints receive intact parties; startup and teammate-view data bypass coordinator RPC', async t => {
  const f = await fixture(t);
  const inputA = spec('ABCD'), inputB = spec('EFGH');
  const a = await f.platform.prepare(inputA), b = await f.platform.prepare(inputB);
  assert.notEqual(a.nodeId, b.nodeId);
  for (const channel of f.channels.values()) assert.equal(channel.visible.length, 0);
  publishRoom(f, a, inputA); publishRoom(f, b, inputB);
  await Promise.all([f.platform.contexts.get(a.assignmentId).publication, f.platform.contexts.get(b.assignmentId).publication]);
  await until(() => [...f.channels.values()].every(channel => channel.visible.length > 1));
  for (const [id, channel] of f.channels) {
    const messages = channel.visible.map(raw => JSON.parse(raw));
    assert.equal(messages[0].t, 'room.state');
    const marker = id.startsWith('ABCD') ? 'ABCD' : 'EFGH';
    assert.ok(messages.filter(message => message.t === 'm.public').every(message => message.marker === marker));
    if (id.endsWith('observer')) assert.ok(messages.every(message => message.t !== 'm.private'));
    else assert.ok(messages.some(message => message.t === 'm.private' && message.playerId === id));
  }
  const viewer = f.channels.get('ABCD-player0');
  viewer.socket.send(JSON.stringify({ t: 'g.watch', fieldId: 'ABCD-player1', rid: 10 }));
  await until(() => viewer.visible.some(raw => JSON.parse(raw).t === 'm.field'));
  const field = JSON.parse(viewer.visible.find(raw => JSON.parse(raw).t === 'm.field'));
  assert.equal(field.fieldId, 'ABCD-player1');
  assert.equal(field.marker, 'ABCD');
  assert.equal(field.padding.length, 2000);
  assert.ok(f.controls.every(frame => frame.type.startsWith('cluster.')));
});

test('reconnection uses the same published owner and restores spectator data without a new match', async t => {
  const f = await fixture(t), input = spec('ABCD');
  const staged = await f.platform.prepare(input);
  publishRoom(f, staged, input);
  await f.platform.contexts.get(staged.assignmentId).publication;
  const previous = f.channels.get('ABCD-observer');
  previous.socket.close();
  assert.equal(f.platform.resume(staged.assignmentId, 'ABCD-observer'), true);
  await until(() => f.channels.get('ABCD-observer') !== previous && f.channels.get('ABCD-observer').bound);
  await until(() => f.channels.get('ABCD-observer').visible.some(raw => JSON.parse(raw).t === 'm.public'));
  const current = f.channels.get('ABCD-observer');
  assert.equal(current.assignmentId, staged.assignmentId);
  assert.equal(current.published, true);
  assert.equal(f.platform.directory.bySession('ABCD-observer').nodeId, staged.nodeId);
  assert.equal(f.nodes.reduce((sum, node) => sum + node.gameHost.stats().matches, 0), 1);
});
