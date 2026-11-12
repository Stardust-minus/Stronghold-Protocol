// SPDX-License-Identifier: GPL-3.0-or-later
// The healthz → Prometheus collector (collector/index.mjs, collector/metrics.mjs): exposition text from a real
// coordinator report (fixtures/healthz-sample.json, build and content hash replaced), absent-not-zero fields, no stale
// values after a failed poll, and the poll's limits (redirects, status, type, size, timeout, overlap, fixed target).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { renderMetrics, escapeLabel, safeLabelValue, exportedMetricNames, FAILURE_REASONS, NETQ, VERIFY } from '../collector/metrics.mjs';
import { CLIENT_ENGINES, CLIENT_OSES, CLIENT_DEVICES, CLIENT_ROLES, FIELD_KINDS, VERIFY_EDGES_MS, VerifyHub } from '../../../../server/match/verify/hub.js';
import { NETQ_ISPS, NETQ_DEVICES, NETQ_LANES, NETQ_PROVINCES, NETQ_RTT_EDGES_MS, NETQ_LATE_EDGES_MS } from '../../../../shared/netQuality.js';
import { createCollector, fetchHealthz, parseConfig, startServer, validateHealthzUrl, PollError, MAX_BYTES } from '../collector/index.mjs';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/healthz-sample.json', import.meta.url), 'utf8'));
const NOW = 1_792_141_850_000;
const fresh = (data, extra = {}) => ({ up: true, data, lastSuccessAt: NOW, durationSeconds: 0.012, polls: 1, failures: {}, ...extra });

/** A strict reader of the text format: families declared once, HELP/TYPE before their samples, samples contiguous. */
function parse(text) {
  assert.ok(text.endsWith('\n'));
  const families = new Map(), samples = [];
  let current = null;
  for (const line of text.slice(0, -1).split('\n')) {
    let m;
    if ((m = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/.exec(line))) {
      assert.ok(!families.has(m[1]), `family ${m[1]} declared twice`);
      families.set(m[1], { help: m[2] });
      current = m[1];
    } else if ((m = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (gauge|counter)$/.exec(line))) {
      assert.equal(m[1], current, 'TYPE follows its HELP');
      families.get(m[1]).type = m[2];
    } else if ((m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line))) {
      assert.equal(m[1], current, `sample ${m[1]} outside its family block`);
      const labels = {};
      for (const [, k, v] of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v;
      const value = Number(m[3]);
      assert.ok(Number.isFinite(value), `${line}: finite value`);
      samples.push({ name: m[1], labels, value });
    } else assert.fail(`unexpected line: ${JSON.stringify(line)}`);
  }
  const get = (name, labels = {}) => samples.filter((s) => s.name === name
    && Object.entries(labels).every(([k, v]) => s.labels[k] === v)).map((s) => s.value);
  return { families, samples, get, one: (name, labels) => { const v = get(name, labels); assert.equal(v.length, 1, name); return v[0]; } };
}

test('a coordinator report becomes typed metrics in base units; counters end in _total', () => {
  const m = parse(renderMetrics(fresh(sample), NOW));
  for (const [name, { type }] of m.families) {
    assert.ok(name.startsWith('sp_'), name);
    assert.equal(name.endsWith('_total'), type === 'counter', `${name}: _total exactly for counters`);
  }
  assert.equal(m.one('sp_up'), 1);
  assert.equal(m.one('sp_online'), 3346);
  assert.equal(m.one('sp_rooms'), 2249);
  assert.equal(m.one('sp_matches'), 2074);
  assert.equal(m.one('sp_humans'), 3879);
  assert.equal(m.one('sp_queued'), 12);
  assert.equal(m.one('sp_uptime_seconds'), 41343);
  assert.equal(m.one('sp_ok'), 1);
  assert.equal(m.one('sp_info', { app: '0.3.0', build: '0a1b2c3d4e5f' }), 1);
  assert.ok(Math.abs(m.one('sp_event_loop_delay_seconds', { stat: 'p99' }) - 0.021102591) < 1e-12);
  assert.ok(Math.abs(m.one('sp_event_loop_delay_seconds', { stat: 'max' }) - 0.037060607) < 1e-12);
  assert.ok(Math.abs(m.one('sp_process_cpu_ratio') - 0.0774356975812106) < 1e-12);
  assert.equal(m.one('sp_process_resident_memory_bytes'), 624517120);
  assert.equal(m.one('sp_performance_ready'), 1);
  assert.equal(m.one('sp_performance_sampled_timestamp_seconds'), 1792141846.05);
  assert.equal(m.one('sp_limit', { cap: 'rooms' }), 8000);
  assert.equal(m.one('sp_hello_total', { outcome: 'resumed' }), 45762);
  assert.equal(m.one('sp_hello_total', { outcome: 'unknown_token' }), 18033);
  assert.equal(m.one('sp_match_seat_departures_total', { cause: 'expired' }), 287);
  assert.equal(m.one('sp_store_writes_total'), 12402);
  assert.equal(m.one('sp_store_written_bytes_total'), 1643467590);
  assert.equal(m.one('sp_store_connected'), 1);
  assert.equal(m.one('sp_persistence_save_interval_seconds'), 10);
  assert.equal(m.one('sp_http_responses_total', { class: 'assets' }), 720528);
  assert.equal(m.one('sp_http_response_bytes_total', { class: 'data' }), 2480182841);
  assert.equal(m.one('sp_ws_wire_bytes_total', { direction: 'out' }), 0);
  assert.deepEqual(m.get('sp_http_responses_total', { class: 'total' }), [], 'the derivable total is not exported');
  // gauge vs counter where the JSON alone could mislead
  assert.equal(m.families.get('sp_hello_total').type, 'counter');
  assert.equal(m.families.get('sp_restore_pending').type, 'gauge');
  assert.equal(m.families.get('sp_ws_open').type, 'gauge');
  assert.equal(m.families.get('sp_limit_refusals_total').type, 'counter');
  // per-phase timings and hashes are not exported; every name is one of the declared ones
  const declared = new Set(exportedMetricNames());
  for (const name of m.families.keys()) assert.ok(declared.has(name), name);
  assert.doesNotMatch(renderMetrics(fresh(sample), NOW), /gc\.minor|match\.commit|0000000000000000|phase/);
  // the only label values are the fixed sets plus app / build
  for (const { labels } of m.samples) {
    for (const [k, v] of Object.entries(labels)) {
      if (k === 'app' || k === 'build') continue;
      assert.match(v, /^[a-z0-9_]{1,24}$/, `${k}=${v}`);
    }
  }
});

test('missing, null or wrongly typed fields are absent, not zero', () => {
  const data = structuredClone(sample);
  delete data.traffic;
  delete data.persistence;
  delete data.reconnect.hello;
  data.performance = { status: 'warming', sampledAt: null, windowMs: null,
    mainThread: { eventLoopDelayMs: { p50: null, p95: null, p99: null, max: null }, eventLoopUtilization: null,
      memory: { heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, arrayBuffersBytes: null } },
    process: { cpu: { userMs: null, systemMs: null, totalMs: null, percent: null }, rssBytes: null } };
  data.queued = 'many';
  data.spectators = null;
  data.limits.refused.maxRooms = -3; // a counter is never negative
  const m = parse(renderMetrics(fresh(data), NOW));
  for (const name of ['sp_http_responses_total', 'sp_ws_open', 'sp_store_writes_total', 'sp_persistence_enabled',
    'sp_store_connected', 'sp_hello_total', 'sp_event_loop_delay_seconds', 'sp_process_cpu_ratio', 'sp_heap_used_bytes',
    'sp_process_resident_memory_bytes', 'sp_queued', 'sp_spectators']) {
    assert.equal(m.families.has(name), false, `${name} absent`);
  }
  assert.deepEqual(m.get('sp_limit_refusals_total', { cap: 'rooms' }), []);
  assert.equal(m.one('sp_limit_refusals_total', { cap: 'bots' }), 0, 'a real 0 stays');
  assert.equal(m.one('sp_performance_ready'), 0);
  assert.equal(m.one('sp_online'), 3346);
  assert.equal(m.one('sp_match_seat_departures_total', { cause: 'afk_online' }), 113);
});

test('label values: app / build allowlisted, escaping per the text format', () => {
  assert.equal(escapeLabel('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  assert.equal(safeLabelValue('0.3.0'), '0.3.0');
  assert.equal(safeLabelValue('0.3.0"} sp_up 1\n'), 'unknown');
  assert.equal(safeLabelValue('x'.repeat(65)), 'unknown');
  assert.equal(safeLabelValue(42), 'unknown');
  const data = structuredClone(sample);
  data.app = 'rel"18\nsp_up 0';
  data.build = '<script>';
  const text = renderMetrics(fresh(data), NOW);
  assert.match(text, /^sp_info\{app="unknown",build="unknown"\} 1$/m);
  assert.doesNotMatch(text, /script|rel"18/);
  parse(text);
});

test('a failed or stale poll presents no game values', async () => {
  let fail = false;
  const fetchFn = async () => fail ? new Response('nope', { status: 502 })
    : Response.json(sample, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  let now = NOW;
  const collector = createCollector({ url: 'http://10.0.0.2:35400/healthz?traffic=1', fetchFn, now: () => now });
  await collector.poll();
  let m = parse(collector.metrics());
  assert.equal(m.one('sp_up'), 1);
  assert.equal(m.one('sp_online'), 3346);
  fail = true;
  now += 10_000;
  await collector.poll();
  m = parse(collector.metrics());
  assert.equal(m.one('sp_up'), 0);
  assert.equal(m.one('sp_poll_failures_total', { reason: 'status' }), 1);
  assert.equal(m.one('sp_polls_total'), 2);
  assert.equal(m.one('sp_last_success_timestamp_seconds'), NOW / 1000);
  assert.ok(m.families.has('sp_scrape_duration_seconds'));
  for (const name of m.families.keys()) {
    assert.ok(['sp_up', 'sp_scrape_duration_seconds', 'sp_last_success_timestamp_seconds', 'sp_polls_total',
      'sp_poll_failures_total'].includes(name), `${name} must not survive a failed poll`);
  }
  assert.deepEqual(m.get('sp_poll_failures_total').length, FAILURE_REASONS.length, 'every reason has a series');
  // a success that is too old (the loop stalled) is not presented either
  fail = false;
  await collector.poll();
  assert.equal(parse(collector.metrics()).one('sp_online'), 3346);
  now += 36_000;
  m = parse(collector.metrics());
  assert.equal(m.one('sp_up'), 0);
  assert.equal(m.families.has('sp_online'), false);
});

test('polls never overlap: a poll while one runs joins it', async () => {
  let calls = 0, release;
  const fetchFn = () => { calls++; return new Promise((resolve) => { release = () => resolve(Response.json(sample)); }); };
  const collector = createCollector({ url: 'http://127.0.0.1:1/healthz', fetchFn });
  const first = collector.poll(), second = collector.poll();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(collector.state.up, true);
  const third = collector.poll();
  assert.notEqual(third, first);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await third;
  assert.equal(calls, 2);
});

/** A local fake coordinator: path → handler. */
async function serve(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const handler = routes[req.url.split('?')[0]];
    if (handler) handler(req, res); else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
const json = (status, body, type = 'application/json; charset=utf-8') => (req, res) => {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-type': type, 'content-length': bytes.length });
  res.end(bytes);
};
async function reason(promise) {
  try { await promise; } catch (e) { assert.ok(e instanceof PollError, String(e)); return e.reason; }
  assert.fail('expected a PollError');
}

test('fetchHealthz: accepts the report (also a 503 ok:false), refuses everything else', async (t) => {
  const big = '{"pad":"' + 'x'.repeat(MAX_BYTES) + '"}';
  const down = { ...sample, ok: false };
  const fake = await serve({
    '/healthz': json(200, sample),
    '/down/healthz': json(503, down),
    '/moved/healthz': (req, res) => { res.writeHead(302, { location: '/elsewhere/healthz' }); res.end(); },
    '/elsewhere/healthz': json(200, sample),
    '/error/healthz': json(500, sample),
    '/html/healthz': json(200, '<html>login</html>', 'text/html'),
    '/other/healthz': json(200, { ok: true, status: 'fine' }),
    '/broken/healthz': json(200, '{"ok":true,'),
    '/array/healthz': json(200, [sample]),
    '/large/healthz': json(200, big),
    '/chunked/healthz': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const piece = 'x'.repeat(256 * 1024);
      res.write('{"pad":"');
      for (let i = 0; i < 9; i++) res.write(piece);
      res.end('"}');
    },
    '/slow/healthz': (req, res) => { setTimeout(() => json(200, sample)(req, res), 1500); },
    '/stall/healthz': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":'); },
  });
  t.after(fake.close);
  const data = await fetchHealthz(`${fake.base}/healthz?traffic=1`);
  assert.equal(data.online, 3346);
  const downData = await fetchHealthz(`${fake.base}/down/healthz`);
  assert.equal(parse(renderMetrics(fresh(downData), NOW)).one('sp_ok'), 0);
  assert.equal(await reason(fetchHealthz(`${fake.base}/moved/healthz`)), 'redirect');
  assert.ok(!fake.hits.some((u) => u.startsWith('/elsewhere/')), 'the redirect was not followed');
  assert.equal(await reason(fetchHealthz(`${fake.base}/error/healthz`)), 'status');
  assert.equal(await reason(fetchHealthz(`${fake.base}/missing/healthz`)), 'status');
  assert.equal(await reason(fetchHealthz(`${fake.base}/html/healthz`)), 'content_type');
  assert.equal(await reason(fetchHealthz(`${fake.base}/other/healthz`)), 'invalid');
  assert.equal(await reason(fetchHealthz(`${fake.base}/broken/healthz`)), 'invalid');
  assert.equal(await reason(fetchHealthz(`${fake.base}/array/healthz`)), 'invalid');
  assert.equal(await reason(fetchHealthz(`${fake.base}/large/healthz`)), 'too_large');
  assert.equal(await reason(fetchHealthz(`${fake.base}/chunked/healthz`)), 'too_large');
  assert.equal(await reason(fetchHealthz(`${fake.base}/slow/healthz`, { timeoutMs: 200 })), 'timeout');
  assert.equal(await reason(fetchHealthz(`${fake.base}/stall/healthz`, { timeoutMs: 200 })), 'timeout');
  assert.equal(await reason(fetchHealthz('http://127.0.0.1:9/healthz', { timeoutMs: 1000 })), 'network');
});

test('the /metrics server: GET / HEAD only, fixed target whatever the query says', async (t) => {
  const asked = [];
  const fetchFn = async (url) => { asked.push(String(url)); return Response.json(sample); };
  const collector = createCollector({ url: 'http://10.0.0.2:35400/healthz?traffic=1', fetchFn });
  const server = await startServer(collector, { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await collector.poll();
  const res = await fetch(`${base}/metrics?target=http://169.254.169.254/latest&url=http://example.com/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(parse(await res.text()).one('sp_online'), 3346);
  assert.deepEqual(asked, ['http://10.0.0.2:35400/healthz?traffic=1'], 'scraping never triggers or redirects a poll');
  const head = await fetch(`${base}/metrics`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/metrics`, { method: 'POST', body: 'x' })).status, 405);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('configuration: one http(s) /healthz URL without credentials; sane intervals; loopback listen by default', () => {
  const base = { MONITOR_HEALTHZ_URL: 'http://10.0.0.2:35400/healthz?traffic=1' };
  assert.deepEqual(parseConfig(base), { url: 'http://10.0.0.2:35400/healthz?traffic=1', intervalMs: 10_000, timeoutMs: 5_000,
    host: '127.0.0.1', port: 9108 });
  assert.equal(parseConfig({ ...base, MONITOR_LISTEN: '[::1]:9200' }).host, '::1');
  for (const url of ['', 'ftp://h/healthz', 'http://user:secret-pw@h/healthz', 'http://h/healthz#x', 'http://h/metrics', 'file:///healthz']) {
    assert.throws(() => validateHealthzUrl(url), (e) => !String(e.message).includes('secret-pw'), url);
  }
  assert.throws(() => parseConfig({ ...base, MONITOR_TIMEOUT_MS: '10000' }));
  assert.throws(() => parseConfig({ ...base, MONITOR_INTERVAL_MS: '50' }));
  assert.throws(() => parseConfig({ ...base, MONITOR_LISTEN: 'localhost' }));
});

test('netq: the collector copy of the report definitions equals shared/netQuality.js', () => {
  assert.deepEqual(NETQ, { isps: [...NETQ_ISPS], devices: [...NETQ_DEVICES], lanes: [...NETQ_LANES], provinces: [...NETQ_PROVINCES],
    rttEdgesMs: [...NETQ_RTT_EDGES_MS], lateEdgesMs: [...NETQ_LATE_EDGES_MS] });
});

test('netq: groups become cumulative le buckets and counters with fixed labels; foreign labels or edges are skipped', () => {
  const group = { isp: 'cm', device: 'mobile', lanes: 2, reports: 4, seconds: 240, rtt: [5, 3, 2, 1, 0, 0, 1],
    late: [90, 4, 3, 2, 1], copies: 100, lost: 1, stalled: 2, refused: 0, reconnects: 1, offlineMs: 2500 };
  const netq = { reports: 5, rttEdgesMs: NETQ.rttEdgesMs, lateEdgesMs: NETQ.lateEdgesMs,
    groups: [group, { ...group, isp: 'evil"isp' }, { ...group, lanes: 7 }, { ...group, isp: 'ct', rtt: [1] }] };
  const m = parse(renderMetrics(fresh({ ...sample, netq }), NOW));
  const labels = { isp: 'cm', device: 'mobile', lanes: '2' };
  assert.equal(m.one('sp_netq_reports_total', labels), 4);
  assert.equal(m.one('sp_netq_seconds_total', labels), 240);
  assert.deepEqual(['50', '100', '200', '400', '800', '1600', '+Inf'].map((le) => m.one('sp_netq_rtt_le_total', { ...labels, le })), [5, 8, 10, 11, 11, 11, 12]);
  assert.deepEqual(['50', '100', '300', '1000', '+Inf'].map((le) => m.one('sp_netq_copy_late_le_total', { ...labels, le })), [90, 94, 97, 99, 100]);
  assert.equal(m.one('sp_netq_lane_events_total', { ...labels, event: 'stalled' }), 2);
  assert.equal(m.one('sp_netq_reconnects_total', labels), 1);
  assert.equal(m.one('sp_netq_offline_seconds_total', labels), 2.5);
  assert.equal(m.get('sp_netq_reports_total').length, 1, 'only the well-formed group');
  for (const name of Object.keys({ sp_netq_reports_total: 1, sp_netq_rtt_le_total: 1 })) assert.ok(exportedMetricNames().includes(name));
  const prov = { province: '44', isp: 'ct', reports: 3, seconds: 180, rtt: [1, 1, 1, 1, 1, 1, 1], late: [5, 0, 0, 1, 0], reconnects: 2, offlineMs: 1000 };
  const withProv = parse(renderMetrics(fresh({ ...sample, netq: { ...netq, provinces: [prov, { ...prov, province: '71' }, { ...prov, isp: 'x' }] } }), NOW));
  const pl = { province: '44', isp: 'ct' };
  assert.equal(withProv.one('sp_netq_province_seconds_total', pl), 180);
  assert.equal(withProv.one('sp_netq_province_rtt_le_total', { ...pl, le: '+Inf' }), 7);
  assert.equal(withProv.one('sp_netq_province_copy_late_le_total', { ...pl, le: '300' }), 5);
  assert.equal(withProv.one('sp_netq_province_reconnects_total', pl), 2);
  assert.equal(withProv.one('sp_netq_province_offline_seconds_total', pl), 1);
  assert.equal(withProv.get('sp_netq_province_seconds_total').length, 1, 'only mainland province codes and known ISPs');
  const other = parse(renderMetrics(fresh({ ...sample, netq: { ...netq, rttEdgesMs: [10, 20] } }), NOW));
  assert.equal(other.get('sp_netq_reports_total').length, 0, 'different bucket edges: nothing exported');
});

test('verify: the collector copy of the shadow verification vocabularies equals server/match/verify/hub.js', () => {
  assert.deepEqual(VERIFY, { engines: [...CLIENT_ENGINES], oses: [...CLIENT_OSES], devices: [...CLIENT_DEVICES], roles: [...CLIENT_ROLES],
    kinds: [...FIELD_KINDS], edgesMs: [...VERIFY_EDGES_MS] });
});

test('verify: counters, rows with fixed labels and cumulative buckets; foreign labels or edges are skipped', () => {
  const hub = new VerifyHub({ config: { verify: true } });
  hub.noteFieldCpu('boss', { ms: 2500, ticks: 3000 });
  hub.noteReplica({ eng: 'webkit', os: 'ios', dev: 'mobile' }, 'diverged');
  const verify = hub.snapshot();
  Object.assign(verify.jobs, { offered: 9, agree: 6, mismatch: 1 });
  verify.jobs.skipped.noCandidate = 3;
  verify.latency = [1, 2, 0, 0, 0, 0, 0, 0, 4];
  verify.clients = [{ eng: 'blink', os: 'android', dev: 'mobile', role: 'verifier', agree: 6, mismatch: 1, timeout: 2, error: 0 },
    { eng: 'evil"', os: 'android', dev: 'mobile', role: 'verifier', agree: 1, mismatch: 0, timeout: 0, error: 0 }];
  const m = parse(renderMetrics(fresh({ ...sample, verify }), NOW));
  assert.equal(m.one('sp_verify_enabled'), 1);
  assert.equal(m.one('sp_verify_jobs_total', { outcome: 'offered' }), 9);
  assert.equal(m.one('sp_verify_skipped_total', { reason: 'no_candidate' }), 3);
  assert.equal(m.one('sp_shadow_field_cpu_seconds_total', { kind: 'boss' }), 2.5);
  assert.equal(m.one('sp_shadow_field_ticks_total', { kind: 'boss' }), 3000);
  assert.equal(m.one('sp_shadow_replicas_total', { eng: 'webkit', os: 'ios', dev: 'mobile', outcome: 'diverged' }), 1);
  assert.equal(m.one('sp_verify_client_results_total', { eng: 'blink', os: 'android', dev: 'mobile', role: 'verifier', outcome: 'timeout' }), 2);
  assert.equal(m.get('sp_verify_client_results_total').length, 4, 'only the well-formed row (four outcomes)');
  assert.deepEqual(['250', '500', '+Inf'].map((le) => m.one('sp_verify_latency_ms_le_total', { le })), [1, 3, 7]);
  for (const name of ['sp_verify_jobs_total', 'sp_verify_client_results_total', 'sp_shadow_replicas_total', 'sp_verify_latency_ms_le_total']) {
    assert.ok(exportedMetricNames().includes(name), name);
  }
  const other = parse(renderMetrics(fresh({ ...sample, verify: { ...verify, edgesMs: [1, 2] } }), NOW));
  assert.equal(other.get('sp_verify_latency_ms_le_total').length, 0, 'different bucket edges: no histogram');
});
