// The page's network-quality report (shared/netQuality.js; docs/LATENCY.md, Network quality reports): every
// NETQ_REPORT_MS, while online, it sends `net.q` with what this page measured since the last one — application ping
// round trips (visible page only, like the latency pill), how much later the second / third lane copies of server
// frames came than the first (public/js/lanes.js laneMetrics), lane events, reconnects and offline time. Never answered;
// nothing in it identifies the player, the session or the address.
import { NETQ_REPORT_MS, NETQ_RTT_EDGES_MS, NETQ_SCHEMA, bucketOf } from '../../shared/netQuality.js';
import { laneMetrics } from './lanes.js';

const TICK_MS = 1000;
/** A window shorter than this online is carried over to the next report. */
const MIN_REPORT_SEC = 10;

export function detectDevice(nav = globalThis.navigator, mm = globalThis.matchMedia) {
  try {
    if (typeof nav?.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile ? 'mobile' : 'desktop';
    if (typeof mm === 'function' && mm('(pointer: coarse)').matches) return 'mobile';
  } catch { /* fall through */ }
  return 'desktop';
}

const clampAll = (arr, max) => arr.map((v) => Math.min(max, v));

/**
 * @param {{ net: any, lanes: number, now?: () => number, isVisible?: () => boolean, device?: string,
 *   timers?: { setInterval: Function, clearInterval: Function }, reportMs?: number, metrics?: typeof laneMetrics }} opts
 * @returns {{ stop: () => void, flush: () => boolean }}
 */
export function startNetQuality({ net, lanes, now = () => performance.now(), isVisible = () => globalThis.document?.visibilityState !== 'hidden',
  device = detectDevice(), timers = globalThis, reportMs = NETQ_REPORT_MS, metrics = laneMetrics }) {
  const rtt = new Array(NETQ_RTT_EDGES_MS.length + 1).fill(0);
  let onlineMs = 0, offlineMs = 0, reconnects = 0, everOnline = false, online = net.status === 'online';
  let last = now(), sinceReport = 0;
  metrics.take(); // what lanes measured before this window is not ours to report
  const onPing = (v) => { if (typeof v === 'number' && Number.isFinite(v) && v >= 0) rtt[bucketOf(NETQ_RTT_EDGES_MS, v)]++; };
  const onStatus = (snap) => {
    const nowOnline = snap?.status === 'online';
    if (online && !nowOnline && isVisible()) reconnects++;
    if (nowOnline) everOnline = true;
    online = nowOnline;
  };
  net.on('ping', onPing);
  net.on('status', onStatus);
  if (online) everOnline = true;

  const flush = () => {
    const sec = Math.round(onlineMs / 1000);
    if (sec < MIN_REPORT_SEC || net.status !== 'online') return false;
    const m = metrics.take();
    const ws = net.ws;
    const msg = {
      sec: Math.min(600, sec), dev: device, lanes: Math.max(1, Math.min(3, lanes | 0)),
      open: Math.max(0, Math.min(3, typeof ws?.laneCount === 'number' ? ws.laneCount : (ws?.readyState === 1 ? 1 : 0))),
      rtt: clampAll(rtt, 10_000), late: clampAll(m.late, 1_000_000), copies: Math.min(2_000_000, m.late.reduce((a, b) => a + b, 0)),
      lost: Math.min(1000, m.lost), stalled: Math.min(1000, m.stalled), refused: Math.min(1000, m.refused),
      reconnects: Math.min(1000, reconnects), offlineMs: Math.min(600_000, Math.round(offlineMs)),
    };
    for (const [k, check] of Object.entries(NETQ_SCHEMA)) if (!check(msg[k])) return false;
    const sent = net.send('net.q', msg);
    rtt.fill(0); onlineMs = 0; offlineMs = 0; reconnects = 0;
    return sent;
  };

  const tick = () => {
    const at = now(), dt = Math.max(0, Math.min(10_000, at - last));
    last = at;
    if (net.status === 'online') onlineMs += dt;
    else if (everOnline && isVisible()) offlineMs += dt;
    sinceReport += dt;
    if (sinceReport >= reportMs) { sinceReport = 0; flush(); }
  };
  const timer = timers.setInterval(tick, TICK_MS);
  return {
    stop() { timers.clearInterval(timer); net.off?.('ping', onPing); net.off?.('status', onStatus); },
    flush,
  };
}
