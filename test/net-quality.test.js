// Network-quality reports (shared/netQuality.js, public/js/netQuality.js, server/netQuality.js): the ISP table and its
// IPv6 provinces (tools/isp-table.mjs), the server's per ISP × device × lanes sums, the page's minute report, and net.q
// end to end through a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { parseCidr, ispTable, createNetQuality } from '../server/netQuality.js';
import { NETQ_SCHEMA, NETQ_RTT_EDGES_MS, bucketOf } from '../shared/netQuality.js';
import { validateC2S } from '../shared/protocol.js';
import { startNetQuality } from '../public/js/netQuality.js';
import { laneWebSocket } from '../public/js/lanes.js';
import { Net } from '../public/js/net.js';
import { startServer } from '../server/index.js';
import { ip2regionProvinces6, cidrs6 } from '../tools/isp-table.mjs';

const report = (o = {}) => ({ sec: 60, dev: 'mobile', lanes: 2, open: 2, rtt: [3, 5, 4, 2, 1, 0, 0], late: [100, 6, 3, 1, 0],
  copies: 110, lost: 0, stalled: 1, refused: 0, reconnects: 1, offlineMs: 1200, ...o });

test('net.q: the schema takes a page report and nothing else', () => {
  assert.equal(validateC2S({ t: 'net.q', ...report() }), null);
  for (const bad of [{ sec: 0 }, { dev: 'tablet' }, { lanes: 4 }, { rtt: [1, 2, 3] }, { late: [1, 2, 3, 4, -1] }, { offlineMs: 1e9 }]) {
    assert.notEqual(validateC2S({ t: 'net.q', ...report(bad) }), null, JSON.stringify(bad));
  }
  assert.deepEqual(NETQ_RTT_EDGES_MS.map((e) => bucketOf(NETQ_RTT_EDGES_MS, e)), [0, 1, 2, 3, 4, 5], 'an edge is inside its bucket');
  assert.equal(bucketOf(NETQ_RTT_EDGES_MS, 5000), NETQ_RTT_EDGES_MS.length);
});

test('ISP table: v4 / v6 ranges, the first table holding an address names it, everything else is unknown', () => {
  assert.deepEqual(parseCidr('10.1.2.3/8'), { fam: 4, lo: 0x0a000000, hi: 0x0affffff });
  assert.equal(parseCidr('2001:db8::/32').hi - parseCidr('2001:db8::/32').lo, (1n << 96n) - 1n);
  for (const bad of ['10.0.0.0/33', '300.1.1.1/8', 'x/8', '::/129']) assert.equal(parseCidr(bad), null, bad);
  const t = ispTable({ isps: { ct: ['198.51.100.0/24'], cu: ['2001:db8:1::/48'], cm: ['203.0.113.0/25'], edu: [], other: ['198.51.0.0/16', '203.0.113.0/24'] } });
  assert.equal(t.size, 5);
  assert.equal(t.classify('198.51.100.7'), 'ct');
  assert.equal(t.classify('::ffff:198.51.100.7'), 'ct', 'IPv4-mapped');
  assert.equal(t.classify('198.51.7.1'), 'other');
  assert.equal(t.classify('203.0.113.9'), 'cm');
  assert.equal(t.classify('203.0.113.200'), 'other');
  assert.equal(t.classify('2001:db8:1:ffff::1'), 'cu');
  assert.equal(t.classify('2001:db8:2::1'), 'unknown');
  for (const ip of ['192.0.2.1', 'not-an-ip', '', null]) assert.equal(t.classify(ip), 'unknown');
  assert.equal(ispTable(null).classify('198.51.100.7'), 'unknown', 'no table');
  const p = ispTable({ isps: { ct: ['198.51.100.0/24'] },
    provinces: { 44: ['198.51.100.0/25', '2001:db8:44::/48'], 50: ['203.0.113.0/24', '2001:db8:5000::/40'], 99: ['192.0.2.0/24', '2001:db8:99::/48'] } });
  assert.equal(p.provinces, 2, 'only NETQ_PROVINCES codes');
  assert.equal(p.province('198.51.100.9'), '44');
  assert.equal(p.province('::ffff:198.51.100.9'), '44', 'IPv4-mapped');
  assert.equal(p.province('203.0.113.1'), '50');
  assert.equal(p.province('2001:db8:44:ffff::1'), '44', 'an IPv6 range under a province');
  assert.equal(p.province('2001:db8:50ff::9'), '50');
  for (const ip of ['198.51.100.200', '192.0.2.1', '2001:db8::1', '2001:db8:99::1', '2001:db8:45::1', 'x']) assert.equal(p.province(ip), 'xx', ip);
  assert.equal(ispTable(null).province('198.51.100.9'), 'xx');
});

test('ISP table build: ip2region IPv6 rows become province CIDRs; its 北京市 / China Mobile 广东省 fallback and non-mainland rows are left out', () => {
  const row = (lo, hi, country, prov, city = '0', isp = '0') => [lo, hi, country, prov, city, isp, country === '中国' ? 'CN' : 'JP'].join('|');
  const text = [
    row('::', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', 'Reserved', 'Reserved'),
    row('2001:db8::', '2001:db8:0:ffff:ffff:ffff:ffff:ffff', '中国', '广东省', '深圳市', '电信'),
    row('2001:db8:1::', '2001:db8:2:ffff:ffff:ffff:ffff:ffff', '中国', '广东省', '广州市', '电信'), // merged with the row before
    row('2001:db8:3::', '2001:db8:3:ffff:ffff:ffff:ffff:ffff', '中国', '北京市', '北京市', '联通'), // the fallback
    row('2001:db8:4::', '2001:db8:4:ffff:ffff:ffff:ffff:ffff', '中国', '广西', '南宁市', '移动'),
    row('2001:db8:5::', '2001:db8:5:ffff:ffff:ffff:ffff:ffff', '中国', '新疆维吾尔自治区'),
    row('2001:db8:6::', '2001:db8:6:ffff:ffff:ffff:ffff:ffff', '中国', '香港特别行政区'),
    row('2001:db8:7::', '2001:db8:7:ffff:ffff:ffff:ffff:ffff', '中国', ''),
    row('2001:db8:8::', '2001:db8:8:ffff:ffff:ffff:ffff:ffff', 'Japan', 'Tokyo'),
    row('2001:db8:9::', '2001:db8:9:ffff:ffff:ffff:ffff:ffff', '中国', '广东省'), // not merged: a row in between
    row('2409:8a00::', '2409:8a00:ffff:ffff:ffff:ffff:ffff:ffff', '中国', '广东省', '广州市', '移动'), // China Mobile's fallback
    row('2409:8a01::', '2409:8a01:ffff:ffff:ffff:ffff:ffff:ffff', '中国', '湖南省', '长沙市', '移动'),
    '',
  ].join('\n');
  const r = ip2regionProvinces6(text);
  assert.deepEqual(r.provinces, { 44: ['2001:db8::/47', '2001:db8:2::/48', '2001:db8:9::/48'], 45: ['2001:db8:4::/48'],
    65: ['2001:db8:5::/48'], 43: ['2409:8a01::/32'] });
  assert.deepEqual([r.rows, r.fallback, r.other], [10, 2, 2]);
  const t = ispTable({ isps: {}, provinces: r.provinces });
  assert.equal(t.provinces, 4);
  assert.deepEqual(['2001:db8:1::5', '2001:db8:4:1::1', '2409:8a01:ff::1'].map((ip) => t.province(ip)), ['44', '45', '43']);
  for (const ip of ['2001:db8:3::1', '2001:db8:6::1', '2001:db8:8::1', '2409:8a00::1']) assert.equal(t.province(ip), 'xx', ip);

  assert.deepEqual(cidrs6(0n, (1n << 128n) - 1n), ['::/0']);
  assert.deepEqual(cidrs6(1n, 6n), ['::1/128', '::2/127', '::4/127', '::6/128']);
  const lo = parseCidr('2001:db8:0:1::/128').lo, hi = parseCidr('2001:db8:3:ffff::/64').hi;
  assert.deepEqual(cidrs6(lo, hi), ['2001:db8:0:1::/64', '2001:db8:0:2::/63', '2001:db8:0:4::/62', '2001:db8:0:8::/61',
    '2001:db8:0:10::/60', '2001:db8:0:20::/59', '2001:db8:0:40::/58', '2001:db8:0:80::/57', '2001:db8:0:100::/56',
    '2001:db8:0:200::/55', '2001:db8:0:400::/54', '2001:db8:0:800::/53', '2001:db8:0:1000::/52', '2001:db8:0:2000::/51',
    '2001:db8:0:4000::/50', '2001:db8:0:8000::/49', '2001:db8:1::/48', '2001:db8:2::/47']);
  const one = (ip) => cidrs6(parseCidr(`${ip}/128`).lo, parseCidr(`${ip}/128`).lo)[0];
  assert.equal(one('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1/128', 'one zero word is not ::');
  assert.equal(one('fe80:0:0:1::'), 'fe80:0:0:1::/128', 'the longest zero run is ::');
  assert.equal(one('2001:0:0:1:0:0:1:1'), '2001::1:0:0:1:1/128', 'the first of two as long');
  for (const bad of ['2001:db8::|2001:db8::1|中国|广东省|0|0', '2001:db8::1|2001:db8::|中国|广东省|0|0|CN', 'x|2001:db8::|中国|广东省|0|0|CN',
    `${row('2001:db8::', '2001:db8::ff', '中国', '广东省')}\n${row('2001:db8::80', '2001:db8::1ff', '中国', '广东省')}`]) {
    assert.throws(() => ip2regionProvinces6(bad), /line \d/, bad);
  }
});

test('server sums: per ISP × device × lanes, nothing else kept', () => {
  const q = createNetQuality({ classify: (ip) => (ip === 'a' ? 'ct' : ip === 'b' ? 'bogus' : 'cm'), province: (ip) => (ip === 'a' ? '44' : '99') });
  q.record('a', report());
  q.record('a', report({ rtt: [1, 0, 0, 0, 0, 0, 1] }));
  q.record('b', report({ dev: 'desktop', lanes: 1 }));
  const s = q.snapshot();
  assert.equal(s.reports, 3);
  assert.deepEqual(s.rttEdgesMs, [...NETQ_RTT_EDGES_MS]);
  const ct = s.groups.find((g) => g.isp === 'ct');
  assert.deepEqual(ct.rtt, [4, 5, 4, 2, 1, 0, 1]);
  assert.equal(ct.seconds, 120);
  assert.equal(ct.copies, 220);
  assert.equal(ct.stalled, 2);
  assert.equal(s.groups.find((g) => g.device === 'desktop').isp, 'unknown', 'a label outside NETQ_ISPS becomes unknown');
  assert.ok(!JSON.stringify(s).includes('"a"'), 'no address in the snapshot');
  assert.deepEqual(s.provinces.map((p) => [p.province, p.isp, p.reports, p.seconds]), [['44', 'ct', 2, 120], ['xx', 'unknown', 1, 60]],
    'province × ISP, without the device / lanes split; an unknown code is xx');
  assert.deepEqual(s.provinces[0].rtt, [4, 5, 4, 2, 1, 0, 1]);
});

class FakeNet {
  constructor() { this.status = 'online'; this.sent = []; this.handlers = new Map(); this.ws = { laneCount: 2, readyState: 1 }; }
  on(t, fn) { this.handlers.set(t, [...(this.handlers.get(t) || []), fn]); }
  off() {}
  emit(t, v) { for (const fn of this.handlers.get(t) || []) fn(v); }
  send(t, fields) { const bad = validateC2S({ t, ...fields }); if (bad) throw new Error(bad); this.sent.push(fields); return true; }
}

test('the page report: a minute of pings, lane copies, reconnects and offline time, then a fresh window', () => {
  let clock = 0, timer = null;
  const timers = { setInterval: (fn) => { timer = fn; return 1; }, clearInterval: () => { timer = null; } };
  const metrics = { late: [0, 0, 0, 0, 0], lost: 0, stalled: 0, refused: 0, take() { const o = { late: this.late.slice(), lost: this.lost, stalled: this.stalled, refused: this.refused }; this.late.fill(0); this.lost = this.stalled = this.refused = 0; return o; } };
  const net = new FakeNet();
  const q = startNetQuality({ net, lanes: 2, now: () => clock, isVisible: () => true, device: 'desktop', timers, metrics });
  const step = (sec) => { for (let i = 0; i < sec; i++) { clock += 1000; timer(); } };
  for (const v of [30, 70, 150, 2500, null]) net.emit('ping', v);
  metrics.late[0] += 40; metrics.late[3] += 2; metrics.stalled++;
  step(20);
  net.status = 'reconnecting'; net.emit('status', { status: 'reconnecting' });
  step(5);
  net.status = 'online'; net.emit('status', { status: 'online' });
  step(35);
  assert.equal(net.sent.length, 1);
  const r = net.sent[0];
  assert.equal(validateC2S({ t: 'net.q', ...r }), null);
  assert.deepEqual({ sec: r.sec, dev: r.dev, lanes: r.lanes, open: r.open }, { sec: 55, dev: 'desktop', lanes: 2, open: 2 });
  assert.deepEqual(r.rtt, [1, 1, 1, 0, 0, 0, 1]);
  assert.deepEqual(r.late, [40, 0, 0, 2, 0]);
  assert.equal(r.copies, 42);
  assert.equal(r.stalled, 1);
  assert.equal(r.reconnects, 1);
  assert.equal(r.offlineMs, 5000);
  step(60);
  assert.equal(net.sent.length, 2);
  assert.deepEqual(net.sent[1].rtt, [0, 0, 0, 0, 0, 0, 0], 'a new window');
  assert.equal(net.sent[1].reconnects, 0);
  q.stop();
  assert.equal(timer, null);
  assert.ok(Object.keys(NETQ_SCHEMA).every((k) => k in r));
});

test('real server: net.q after hello is summed into /healthz netq, at most one per socket per 30 s, never answered', { timeout: 15000 }, async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0 });
  t.after(() => server.close());
  const net = new Net({ url: `ws://127.0.0.1:${server.port}/ws`, WebSocket: laneWebSocket({ lanes: 2, WebSocket }) });
  t.after(() => net.close());
  const errors = [];
  net.on('*', (m) => { if (m.t === 'error') errors.push(m); });
  net.setName('NetQ');
  net.connect();
  const end = Date.now() + 8000;
  while (net.status !== 'online') { if (Date.now() > end) throw new Error('no welcome'); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(net.send('net.q', report()), true);
  assert.equal(net.send('net.q', report({ dev: 'desktop' })), true, 'sent, but inside the 30 s gap');
  await new Promise((r) => setTimeout(r, 300));
  const health = await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json();
  assert.equal(health.netq.reports, 1);
  assert.deepEqual(health.netq.groups.map((g) => [g.isp, g.device, g.lanes, g.seconds]), [['unknown', 'mobile', 2, 60]]);
  assert.deepEqual(errors, [], 'no reply, no error');
});
