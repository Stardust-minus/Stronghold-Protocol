// The network-quality board on the cluster (11-16: every page 「未识别」, no province). The browsers' net.q reach the
// coordinator over the control connection and its Network sums them (server/netQuality.js), so the ISP table
// (SP_ISP_FILE / ispFile) belongs on the coordinator; the game nodes never see a report. The address it classifies is
// the one the entry Nginx forwards (X-Real-IP from a private peer: the Chongqing entry over WG), kept by the ingress
// across the ingress link — not the entry's or the ingress's own address.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { stack, stop, nodeConfigs, until, ORIGIN } from './helpers/clusterStack.js';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { startIngress } from '../server/cluster/ingress.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const REPORT = { sec: 60, dev: 'desktop', lanes: 1, open: 1, rtt: [3, 5, 4, 2, 1, 0, 0], late: [0, 0, 0, 0, 0],
  copies: 0, lost: 0, stalled: 0, refused: 0, reconnects: 0, offlineMs: 0 };
// documentation ranges standing in for 电信 / 移动 and 重庆 (50)
const TABLE = { v: 1, isps: { ct: ['203.0.113.0/24'], cu: [], cm: ['2001:db8::/32'], edu: [], other: ['198.51.100.0/24'] },
  provinces: { 50: ['203.0.113.0/24'] } };

/** A page through `ingressUrl` whose entry forwarded `ip` (null: no forwarding header); sends one net.q. */
async function page(ingressUrl, ip) {
  const headers = ip ? { 'X-Real-IP': ip, 'X-Forwarded-For': ip } : {};
  const socket = new WebSocket(ingressUrl.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN, headers });
  const frames = [];
  socket.on('error', () => {});
  socket.on('message', (bytes) => frames.push(JSON.parse(bytes.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ t: 'hello', name: 'NetQ', version: 1, matchmakingVersion: MATCHMAKING_VERSION }));
  await until(() => frames.some((f) => f.t === 'welcome' || f.t === 'error'), 5000, 'welcome');
  assert.ok(frames.some((f) => f.t === 'welcome'), JSON.stringify(frames.at(-1)));
  socket.send(JSON.stringify({ t: 'net.q', ...REPORT }));
  return socket;
}

test('cluster: the coordinator classifies net.q by the address the entry forwarded, through the ingress link too', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netq-isp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ispFile = path.join(dir, 'isp-table.json');
  fs.writeFileSync(ispFile, JSON.stringify(TABLE));
  const store = new MemoryValkey(), storeFor = () => memoryStore(store);
  const key = randomBytes(32);
  const s = await stack(storeFor, { configs: nodeConfigs(), coordinator: { ispFile, ingresses: [{ ingressId: 'ingress-a', key }] } });
  t.after(() => stop(s));
  // the production shape (cluster-local-stack --ingress-link): control over the authenticated link, trustProxy auto
  const linked = await startIngress({ coordinatorUrl: s.coordinator.url, nodes: s.nodes, origins: [ORIGIN], shutdownMs: 100,
    link: { url: s.coordinator.privateUrl, ingressId: 'ingress-a', key } });
  t.after(() => linked.close());
  assert.equal(await linked.link.whenReady(), true, 'the link is up');
  const sockets = [];
  t.after(() => { for (const ws of sockets) ws.close(); });
  sockets.push(await page(linked.url, '203.0.113.7')); // IPv4 player: ISP and province
  sockets.push(await page(linked.url, '2001:db8::7')); // IPv6 player: ISP only (no IPv6 province in this table)
  sockets.push(await page(s.ingress.url, '198.51.100.9')); // the plain control WebSocket path forwards it as well
  sockets.push(await page(linked.url, null)); // no forwarding header: the peer itself (loopback) is no player address
  const health = async () => (await (await fetch(`${s.coordinator.url}/healthz`)).json()).netq;
  let netq;
  const deadline = Date.now() + 10_000;
  while (!((netq = await health())?.reports >= 4)) { if (Date.now() > deadline) throw new Error(`reports ${netq?.reports}`); await new Promise((r) => setTimeout(r, 50)); }
  const groups = Object.fromEntries(netq.groups.map((g) => [g.isp, g.reports]));
  assert.deepEqual(groups, { ct: 1, cm: 1, other: 1, unknown: 1 });
  const provinces = netq.provinces.map((p) => `${p.province}|${p.isp}|${p.reports}`).sort();
  assert.deepEqual(provinces, ['50|ct|1', 'xx|cm|1', 'xx|other|1', 'xx|unknown|1']);
});
