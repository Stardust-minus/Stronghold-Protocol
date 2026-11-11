// SPDX-License-Identifier: GPL-3.0-or-later
// deploy/stardust/monitoring/collector/metrics.mjs — the cluster coordinator's GET /healthz?traffic=1 JSON
// (server/http/routes.js healthReport) as Prometheus text. Adapted from xinhai-ai/Stronghold-Protocol
// deploy/monitoring/exporter/metrics.mjs (GPL-3.0-or-later): this server has no /metrics, so the field table follows
// healthReport and the modules it reads instead.
//
// Rules:
//   * one fixed table: every exported name, type, help text and finite label set is below; nothing from the JSON
//     becomes a metric or label name, and the only label values copied from it are `app` / `build` (sp_info), after an
//     allowlist check;
//   * a missing, null or non-finite field is absent, never 0; a counter must also be >= 0;
//   * counters are the since-start counts of the process (reconnect, limits.refused, net, persistence, traffic) and end
//     in `_total`; a coordinator restart resets them, which rate() handles;
//   * `performance.*` is the cached 10 s window of server/healthMetrics.js: gauges, in seconds / bytes / ratios;
//     `performance.phases` (per-phase timings) is not exported;
//   * a failed or stale poll presents only the collector's own series (sp_up 0): no game value outlives its poll.

const G = 'gauge';
const C = 'counter';

/** [name, type, help, JSON path, scale] — one unlabelled sample each. */
const SCALARS = [
  ['sp_uptime_seconds', G, 'Seconds since the coordinator process started.', 'uptimeSec'],
  ['sp_protocol_version', G, 'WebSocket protocol version the coordinator speaks.', 'version'],
  ['sp_online', G, 'Players connected to the lobby now.', 'online'],
  ['sp_sockets', G, 'Open WebSocket connections on the coordinator.', 'sockets'],
  ['sp_sessions', G, 'Sessions held, including disconnected ones inside their reconnect window.', 'sessions'],
  ['sp_rooms', G, 'Rooms open now.', 'rooms'],
  ['sp_matches', G, 'Rooms with a running match.', 'matches'],
  ['sp_humans', G, 'Human seats in rooms (players who have not left), connected or not.', 'humans'],
  ['sp_bots', G, 'AI seats in rooms.', 'bots'],
  ['sp_spectators', G, 'Spectators in rooms.', 'spectators'],
  ['sp_queued', G, 'Players in the matchmaking queue.', 'queued'],
  ['sp_content_sets', G, 'Content sets with gameplay plugins that rooms hold now.', 'content.sets'],
  ['sp_content_plugins', G, 'Unofficial plugins the server has (absent when none).', 'content.plugins'],
  ['sp_maintenance', G, 'Maintenance switch of the limits file (1 = on).', 'limits.maintenance'],
  ['sp_performance_window_seconds', G, 'Length of the cached performance window.', 'performance.windowMs', 1e-3],
  ['sp_performance_sampled_timestamp_seconds', G, 'Unix time the cached performance window ended.', 'performance.sampledAt', 1e-3],
  ['sp_event_loop_utilization', G, 'Main-thread event-loop utilization over the last window (0..1).',
    'performance.mainThread.eventLoopUtilization'],
  ['sp_heap_used_bytes', G, 'Main-thread V8 heap used.', 'performance.mainThread.memory.heapUsedBytes'],
  ['sp_heap_total_bytes', G, 'Main-thread V8 heap reserved.', 'performance.mainThread.memory.heapTotalBytes'],
  ['sp_external_memory_bytes', G, 'Main-thread memory held outside the V8 heap.', 'performance.mainThread.memory.externalBytes'],
  ['sp_array_buffers_bytes', G, 'Main-thread ArrayBuffer memory.', 'performance.mainThread.memory.arrayBuffersBytes'],
  ['sp_process_cpu_ratio', G, 'Coordinator process CPU over the last window (1 = one full core; may exceed 1).',
    'performance.process.cpu.percent', 1e-2],
  ['sp_process_resident_memory_bytes', G, 'Coordinator process resident memory (RSS).', 'performance.process.rssBytes'],
  ['sp_ws_snapshots_dropped_total', C, 'Droppable snapshots skipped because a socket buffer was full.', 'net.snapDropped'],
  ['sp_ws_backpressure_closed_total', C, 'Sockets terminated for exceeding the hard buffer limit.', 'net.backpressureClosed'],
  ['sp_state_delta_avoided_bytes_total', C, 'Full-state bytes the m.state delta transport did not send.',
    'net.stateDelta.plainBytesAvoided'],
  ['sp_persistence_save_interval_seconds', G, 'Checkpoint save interval.', 'persistence.saveMs', 1e-3],
  ['sp_checkpoint_captures_total', C, 'Match checkpoints captured.', 'persistence.captures'],
  ['sp_checkpoint_capture_skips_total', C, 'Checkpoint captures skipped (no safe point).', 'persistence.captureSkips'],
  ['sp_lobby_doc_writes_total', C, 'Lobby documents written to the store.', 'persistence.docWrites'],
  ['sp_lobby_doc_failures_total', C, 'Lobby document writes that failed.', 'persistence.docFailures'],
  ['sp_checkpoint_dropped_matches_total', C, 'Stored matches dropped as incompatible on restore.', 'persistence.droppedMatches'],
  ['sp_checkpoint_deleted_total', C, 'Checkpoints deleted after their match ended.', 'persistence.deleted'],
  ['sp_restore_pending', G, 'Remote matches waiting to be restored now.', 'persistence.remote.pending'],
  ['sp_store_writes_total', C, 'Writes to the checkpoint store (Valkey).', 'persistence.store.writes'],
  ['sp_store_write_failures_total', C, 'Failed writes to the checkpoint store.', 'persistence.store.writeFailures'],
  ['sp_store_reads_total', C, 'Reads from the checkpoint store.', 'persistence.store.reads'],
  ['sp_store_read_failures_total', C, 'Failed reads from the checkpoint store.', 'persistence.store.readFailures'],
  ['sp_store_deletes_total', C, 'Deletes in the checkpoint store.', 'persistence.store.deletes'],
  ['sp_store_written_bytes_total', C, 'Bytes written to the checkpoint store.', 'persistence.store.bytesWritten'],
  ['sp_store_last_write_timestamp_seconds', G, 'Unix time of the last checkpoint store write.', 'persistence.store.lastWriteAt', 1e-3],
  ['sp_store_connects_total', C, 'Connections the store client opened.', 'persistence.store.connects'],
  ['sp_store_connect_failures_total', C, 'Store connection attempts that failed.', 'persistence.store.connectFailures'],
  ['sp_ws_connections_total', C, 'WebSocket connections opened (traffic counter).', 'traffic.ws.connections'],
  ['sp_ws_open', G, 'WebSocket connections open now (traffic counter).', 'traffic.ws.open'],
];

/** [name, type, help, label, { label value: JSON path }, scale] — fixed label values only. */
const FAMILIES = [
  ['sp_limit', G, 'Cap in force (0 = unlimited).', 'cap', {
    rooms: 'limits.maxRooms', rooms_per_network: 'limits.maxRoomsPerAddr', matches_per_network: 'limits.maxMatchesPerAddr',
    bots: 'limits.maxBots', bots_per_network: 'limits.maxBotsPerAddr' }],
  ['sp_limit_refusals_total', C, 'room.create / room.start / room.addBot refused by a cap.', 'cap', {
    rooms: 'limits.refused.maxRooms', rooms_per_network: 'limits.refused.maxRoomsPerAddr',
    matches_per_network: 'limits.refused.maxMatchesPerAddr', bots: 'limits.refused.maxBots',
    bots_per_network: 'limits.refused.maxBotsPerAddr' }],
  ['sp_per_network_peak', G, 'Largest use any one client network makes of a per-network cap now.', 'kind', {
    rooms: 'limits.perAddrPeak.rooms', matches: 'limits.perAddrPeak.matches', bots: 'limits.perAddrPeak.bots' }],
  ['sp_hello_total', C, 'First hello of a socket, by outcome (resumed = reconnected into its session).', 'outcome', {
    resumed: 'reconnect.hello.resumed', fresh: 'reconnect.hello.fresh', unknown_token: 'reconnect.hello.unknownToken',
    in_use: 'reconnect.hello.inUse' }],
  ['sp_match_seat_departures_total', C, 'Human seats that left a running match, by cause.', 'cause', {
    afk_online: 'reconnect.matchSeats.afkOnline', afk_offline: 'reconnect.matchSeats.afkOffline',
    expired: 'reconnect.matchSeats.expired' }],
  ['sp_event_loop_delay_seconds', G, 'Main-thread event-loop delay over the last window (20 ms timer resolution).', 'stat', {
    p50: 'performance.mainThread.eventLoopDelayMs.p50', p95: 'performance.mainThread.eventLoopDelayMs.p95',
    p99: 'performance.mainThread.eventLoopDelayMs.p99', max: 'performance.mainThread.eventLoopDelayMs.max' }, 1e-3],
  ['sp_state_frames_total', C, 'm.state frames sent, full or as a delta.', 'kind', {
    full: 'net.stateDelta.full', delta: 'net.stateDelta.delta' }],
  ['sp_state_bytes_total', C, 'm.state bytes sent, full or as a delta.', 'kind', {
    full: 'net.stateDelta.fullBytes', delta: 'net.stateDelta.deltaBytes' }],
  ['sp_restored_total', C, 'Records restored from the checkpoint store at start.', 'kind', {
    sessions: 'persistence.restoredSessions', rooms: 'persistence.restoredRooms', matches: 'persistence.restoredMatches' }],
  ['sp_remote_restores_total', C, 'Matches of a lost game node taken over or rebuilt, or that failed.', 'result', {
    adopted: 'persistence.remote.adopted', rebuilt: 'persistence.remote.rebuilt', failed: 'persistence.remote.failed' }],
  ['sp_http_responses_total', C, 'HTTP responses the coordinator sent, by traffic class.', 'class', trafficPaths('requests')],
  ['sp_http_response_bytes_total', C, 'HTTP body bytes the coordinator sent (after compression), by traffic class.', 'class',
    trafficPaths('bytes')],
  ['sp_http_not_modified_total', C, 'HTTP 304 responses the coordinator sent, by traffic class.', 'class', trafficPaths('notModified')],
  ['sp_ws_wire_bytes_total', C, 'WebSocket bytes on the wire (after permessage-deflate).', 'direction', {
    out: 'traffic.ws.wireOut', in: 'traffic.ws.wireIn' }],
  ['sp_ws_payload_bytes_total', C, 'WebSocket message payload bytes (before compression).', 'direction', {
    out: 'traffic.ws.payloadOut', in: 'traffic.ws.payloadIn' }],
  ['sp_ws_messages_total', C, 'WebSocket messages.', 'direction', { out: 'traffic.ws.messagesOut', in: 'traffic.ws.messagesIn' }],
];

/** [name, help, JSON path, expected type, value meaning 1] — 1 / 0 when the field has the expected type, absent otherwise. */
const FLAGS = [
  ['sp_ok', 'The coordinator reports itself healthy (/healthz ok).', 'ok', 'boolean', true],
  ['sp_performance_ready', 'The performance window is a measurement (status ready).', 'performance.status', 'string', 'ready'],
  ['sp_persistence_enabled', 'Match checkpoints are on (SP_REDIS_URL).', 'persistence.enabled', 'boolean', true],
  ['sp_store_connected', 'The checkpoint store client is connected.', 'persistence.store.connected', 'boolean', true],
];

/**
 * The browsers' network-quality reports (/healthz `netq`, server/netQuality.js; shared/netQuality.js — the edges and
 * label values are copied here because the collector image holds only this directory, and test/collector.test.mjs
 * keeps them equal). Every group is one ISP × device × lane count; a group with any other label value is skipped, and
 * so is the whole section when the server's bucket edges differ. Buckets are exported cumulatively with an `le` label
 * (milliseconds), as counters: histogram_quantile() reads their rates.
 */
export const NETQ = Object.freeze({
  isps: ['ct', 'cu', 'cm', 'edu', 'other', 'unknown'], devices: ['mobile', 'desktop'], lanes: [1, 2, 3],
  provinces: ['11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37', '41', '42', '43', '44', '45',
    '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65', 'xx'],
  rttEdgesMs: [50, 100, 200, 400, 800, 1600], lateEdgesMs: [50, 100, 300, 1000],
});
const NETQ_METRICS = {
  sp_netq_reports_total: 'Network-quality reports from browsers (one a minute per online page).',
  sp_netq_seconds_total: 'Online seconds the network-quality reports cover.',
  sp_netq_rtt_le_total: 'Application ping round trips at or below `le` milliseconds (cumulative buckets).',
  sp_netq_copy_late_le_total: 'Later lane copies of server frames that came at most `le` ms after the first copy (cumulative).',
  sp_netq_lane_events_total: 'Lane WebSockets lost, replaced as stalled or refused, as the browsers reported.',
  sp_netq_reconnects_total: 'Times a visible page went from online to reconnecting.',
  sp_netq_offline_seconds_total: 'Seconds visible pages spent not online after having been online.',
  sp_netq_province_seconds_total: 'Online seconds the network-quality reports cover, per province (GB/T 2260 code) and ISP.',
  sp_netq_province_rtt_le_total: 'Application ping round trips at or below `le` ms, per province and ISP (cumulative).',
  sp_netq_province_copy_late_le_total: 'Later lane copies at most `le` ms after the first copy, per province and ISP (cumulative).',
  sp_netq_province_reconnects_total: 'Times a visible page went from online to reconnecting, per province and ISP.',
  sp_netq_province_offline_seconds_total: 'Seconds visible pages spent not online, per province and ISP.',
};
const sameEdges = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
const countsOf = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => finite(x) && x >= 0);

/** The HTTP traffic classes of shared/assetPaths.js TRAFFIC_CATEGORIES (`total` is derivable and left out). */
function trafficPaths(field) {
  return Object.fromEntries(['assets', 'audio', 'code', 'data', 'other'].map((c) => [c, `traffic.http.${c}.${field}`]));
}

const META = {
  sp_up: [G, 'The last poll of the coordinator /healthz succeeded and is recent (1) or not (0).'],
  sp_scrape_duration_seconds: [G, 'Duration of the last /healthz poll.'],
  sp_last_success_timestamp_seconds: [G, 'Unix time of the last successful /healthz poll.'],
  sp_polls_total: [C, 'Polls of the coordinator /healthz.'],
  sp_poll_failures_total: [C, 'Failed polls of the coordinator /healthz, by reason.'],
  sp_info: [G, 'Release (app) and served client build of the coordinator.'],
};
/** Fixed poll failure reasons (index.mjs PollError). */
export const FAILURE_REASONS = Object.freeze(['timeout', 'network', 'redirect', 'status', 'content_type', 'too_large', 'invalid']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pathValue = (obj, path) => path.split('.').reduce((v, key) => (v && typeof v === 'object' ? v[key] : undefined), obj);

/** Label value escaping of the text exposition format. */
export function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
const escapeHelp = (text) => String(text).replaceAll('\\', '\\\\').replaceAll('\n', '\\n');

/** `app` / `build` label values: short version or hash strings only, else "unknown" (no free text becomes a label). */
export function safeLabelValue(value, pattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/) {
  return typeof value === 'string' && pattern.test(value) ? value : 'unknown';
}

/** Every metric name the collector can export (for the dashboard / rules checks). */
export function exportedMetricNames() {
  return [...Object.keys(META), ...SCALARS.map((s) => s[0]), ...FAMILIES.map((f) => f[0]), ...FLAGS.map((f) => f[0]), ...Object.keys(NETQ_METRICS)];
}

/**
 * Render the exposition text.
 * @param {{ up: boolean, data?: any, lastSuccessAt?: number | null, durationSeconds?: number | null,
 *           polls?: number, failures?: Record<string, number> }} state  the collector's last poll (index.mjs)
 * @param {number} nowMs
 * @param {{ staleAfterMs?: number }} [opts]  a success older than this no longer counts (no stale game values)
 */
export function renderMetrics(state, nowMs = Date.now(), { staleAfterMs = 35_000 } = {}) {
  /** @type {Map<string, { type: string, help: string, samples: string[] }>} */
  const families = new Map();
  const emit = (name, type, help, value, labels = {}) => {
    if (!finite(value) || (type === C && value < 0)) return;
    let family = families.get(name);
    if (!family) families.set(name, family = { type, help, samples: [] });
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
    family.samples.push(`${name}${pairs ? `{${pairs}}` : ''} ${value}`);
  };
  const meta = (name, value, labels) => emit(name, META[name][0], META[name][1], value, labels);

  const fresh = !!state?.up && !!state.data && finite(state.lastSuccessAt) && nowMs - state.lastSuccessAt <= staleAfterMs;
  meta('sp_up', fresh ? 1 : 0);
  meta('sp_scrape_duration_seconds', state?.durationSeconds);
  meta('sp_last_success_timestamp_seconds', finite(state?.lastSuccessAt) ? state.lastSuccessAt / 1000 : undefined);
  meta('sp_polls_total', state?.polls ?? 0);
  for (const reason of FAILURE_REASONS) meta('sp_poll_failures_total', state?.failures?.[reason] ?? 0, { reason });

  if (fresh) {
    const m = state.data;
    meta('sp_info', 1, { app: safeLabelValue(m.app), build: safeLabelValue(m.build) });
    for (const [name, help, path, type, one] of FLAGS) {
      const v = pathValue(m, path);
      if (typeof v === type) emit(name, G, help, v === one ? 1 : 0);
    }
    for (const [name, type, help, path, scale = 1] of SCALARS) {
      const v = pathValue(m, path);
      if (finite(v)) emit(name, type, help, v * scale);
    }
    for (const [name, type, help, label, paths, scale = 1] of FAMILIES) {
      for (const [value, path] of Object.entries(paths)) {
        const v = pathValue(m, path);
        if (finite(v)) emit(name, type, help, v * scale, { [label]: value });
      }
    }
    const q = m.netq;
    if (q && Array.isArray(q.groups) && sameEdges(q.rttEdgesMs, NETQ.rttEdgesMs) && sameEdges(q.lateEdgesMs, NETQ.lateEdgesMs)) {
      const netq = (name, value, labels) => emit(name, C, NETQ_METRICS[name], value, labels);
      const buckets = (name, counts, edges, labels) => {
        let acc = 0;
        counts.forEach((n, i) => { acc += n; netq(name, acc, { ...labels, le: i < edges.length ? String(edges[i]) : '+Inf' }); });
      };
      for (const g of q.groups) {
        if (!g || !NETQ.isps.includes(g.isp) || !NETQ.devices.includes(g.device) || !NETQ.lanes.includes(g.lanes)) continue;
        if (!countsOf(g.rtt, NETQ.rttEdgesMs.length + 1) || !countsOf(g.late, NETQ.lateEdgesMs.length + 1)) continue;
        const labels = { isp: g.isp, device: g.device, lanes: String(g.lanes) };
        netq('sp_netq_reports_total', g.reports, labels);
        netq('sp_netq_seconds_total', g.seconds, labels);
        buckets('sp_netq_rtt_le_total', g.rtt, NETQ.rttEdgesMs, labels);
        buckets('sp_netq_copy_late_le_total', g.late, NETQ.lateEdgesMs, labels);
        for (const event of ['lost', 'stalled', 'refused']) netq('sp_netq_lane_events_total', g[event], { ...labels, event });
        netq('sp_netq_reconnects_total', g.reconnects, labels);
        if (finite(g.offlineMs)) netq('sp_netq_offline_seconds_total', g.offlineMs / 1000, labels);
      }
      for (const p of Array.isArray(q.provinces) ? q.provinces : []) {
        if (!p || !NETQ.provinces.includes(p.province) || !NETQ.isps.includes(p.isp)) continue;
        if (!countsOf(p.rtt, NETQ.rttEdgesMs.length + 1) || !countsOf(p.late, NETQ.lateEdgesMs.length + 1)) continue;
        const labels = { province: p.province, isp: p.isp };
        netq('sp_netq_province_seconds_total', p.seconds, labels);
        buckets('sp_netq_province_rtt_le_total', p.rtt, NETQ.rttEdgesMs, labels);
        buckets('sp_netq_province_copy_late_le_total', p.late, NETQ.lateEdgesMs, labels);
        netq('sp_netq_province_reconnects_total', p.reconnects, labels);
        if (finite(p.offlineMs)) netq('sp_netq_province_offline_seconds_total', p.offlineMs / 1000, labels);
      }
    }
  }

  const lines = [];
  for (const [name, { type, help, samples }] of families) lines.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`, ...samples);
  return lines.join('\n') + '\n';
}
