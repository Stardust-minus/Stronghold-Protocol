// shared/netQuality.js — the browser's network-quality report (C→S `net.q`, docs/LATENCY.md, Network quality reports):
// what a page measured over the last minute, aggregated by the server per ISP / device / lane count and exported to
// Prometheus by the monitoring collector. Nothing in it names a player, a session or an address.
//
//   net.q { sec, dev, lanes, open, rtt[7], late[5], copies, lost, stalled, refused, reconnects, offlineMs }
//   sec         seconds of the window the page was visible (what the counts below cover)
//   dev         'mobile' | 'desktop'
//   lanes       WebSockets the page wants per connection (1 = one plain socket); open: how many are open now
//   rtt         counts of application ping round trips per NETQ_RTT_EDGES_MS bucket (the last one: above the last edge)
//   late        lanes only — for every second (third) copy of a server frame, how much later than the first copy it
//               arrived, per NETQ_LATE_EDGES_MS bucket: the delay that connection alone would have added
//   copies      the number of such copies (sum of late)
//   lost / stalled / refused   lanes that closed / were replaced as stalled / joins refused in the window
//   reconnects  times the connection went from online to reconnecting; offlineMs: visible time not online since then

export const NETQ_REPORT_MS = 60_000;
/** A server takes at most one report per connection per this many ms. */
export const NETQ_MIN_GAP_MS = 30_000;
export const NETQ_RTT_EDGES_MS = Object.freeze([50, 100, 200, 400, 800, 1600]);
export const NETQ_LATE_EDGES_MS = Object.freeze([50, 100, 300, 1000]);
/** ISP labels (server/netQuality.js): 中国电信, 联通, 移动, 教育网, another network in China, not classified. */
export const NETQ_ISPS = Object.freeze(['ct', 'cu', 'cm', 'edu', 'other', 'unknown']);
export const NETQ_DEVICES = Object.freeze(['mobile', 'desktop']);
/**
 * Province labels: the first two digits of the mainland provinces' administrative codes (GB/T 2260), 'xx' = not
 * located (no table, an IPv6 address — the province lists are IPv4 only — or an address in none of them). The server
 * sums a second, smaller set per province × ISP (seconds, round trips, lane copies, reconnects, offline time).
 */
export const NETQ_PROVINCES = Object.freeze(['11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65', 'xx']);
export const NETQ_LANES = Object.freeze([1, 2, 3]);

/** Index of the bucket `v` falls in (edges ascending; values above the last edge go to the last bucket). */
export function bucketOf(edges, v) {
  let i = 0;
  while (i < edges.length && v > edges[i]) i++;
  return i;
}

const count = (max) => (v) => Number.isInteger(v) && v >= 0 && v <= max;
const counts = (n, max) => (v) => Array.isArray(v) && v.length === n && v.every(count(max));

/** The C2S schema of `net.q` (shared/protocol.js C2S). */
export const NETQ_SCHEMA = Object.freeze({
  sec: (v) => Number.isInteger(v) && v >= 1 && v <= 600,
  dev: (v) => NETQ_DEVICES.includes(v),
  lanes: (v) => NETQ_LANES.includes(v),
  open: count(3),
  rtt: counts(NETQ_RTT_EDGES_MS.length + 1, 10_000),
  late: counts(NETQ_LATE_EDGES_MS.length + 1, 1_000_000),
  copies: count(2_000_000),
  lost: count(1000),
  stalled: count(1000),
  refused: count(1000),
  reconnects: count(1000),
  offlineMs: count(600_000),
});
