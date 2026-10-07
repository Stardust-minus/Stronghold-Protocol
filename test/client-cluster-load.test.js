import test from 'node:test';
import assert from 'node:assert/strict';
import { Net, PING_SAMPLE_MAX_AGE_MS } from '../public/js/net.js';

const load = { scope: 'game', nodes: [{ label: 'game-03', status: 'ready', loadState: 'normal',
  loadDetails: { windowMs: 10000, ageMs: 1000, cpuPercent: 200, rssMiB: 1000, heapMiB: 100, eluPercent: 20, p95Ms: 21, p99Ms: 25 },
  key: 'not-public', url: 'http://internal', pid: 123 }] };
function fixture() {
  let now = 1000;
  const sent = [];
  const net = new Net({ now: () => now });
  net.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {} };
  net._setStatus('online');
  const reply = extra => {
    net._sendPing(); const ping = sent.at(-1); now += 20;
    net._onPong({ t: 'pong', c: ping.c, rid: ping.rid, clusterLoad: load, ...extra });
  };
  return { net, reply, advance: ms => { now += ms; }, now: () => now };
}

test('matched heartbeat sanitizes cluster telemetry into the connection snapshot', () => {
  const f = fixture();
  f.reply();
  assert.equal(f.net.snapshot().clusterLoad.nodes[0].label, 'game-03');
  assert.doesNotMatch(JSON.stringify(f.net.snapshot()), /not-public|internal|pid/);
  f.reply({ clusterLoad: undefined });
  assert.equal(f.net.clusterLoad, null, 'legacy pong cannot retain a previous owner sample');
  f.reply({ clusterLoad: { ...load, scope: 'invalid' } });
  assert.equal(f.net.clusterLoad, null);
});

test('disconnect and stale probes clear node telemetry with RTT', () => {
  const f = fixture(); f.reply();
  f.net._setStatus('reconnecting');
  assert.equal(f.net.clusterLoad, null);
  f.net._setStatus('online'); f.reply();
  f.advance(PING_SAMPLE_MAX_AGE_MS);
  f.net._expireLatency(f.now());
  assert.equal(f.net.clusterLoad, null);
  assert.equal(f.net.ping, null);
});
