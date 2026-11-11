// server/netQuality.js — the browsers' network-quality reports (C→S net.q, shared/netQuality.js; docs/LATENCY.md,
// Network quality reports) summed since start per ISP × device × lane count, for /healthz `netq` (the monitoring
// collector's sp_netq_* series). A report's client address is classified against the ISP table (SP_ISP_FILE, built by
// tools/isp-table.mjs) and dropped: no address, session or name is kept, and there are at most 36 groups.
import fs from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { NETQ_ISPS, NETQ_PROVINCES, NETQ_RTT_EDGES_MS, NETQ_LATE_EDGES_MS } from '../shared/netQuality.js';

/** Classification order: the first table holding the address names its ISP ('other' is the whole of China). */
const ORDER = ['ct', 'cu', 'cm', 'edu', 'other'];

function v4(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function v6(ip) {
  const [head, tail = null] = ip.split('::');
  const part = (s) => (s ? s.split(':') : []);
  let groups = part(head);
  let rest = tail === null ? [] : part(tail);
  const last = (tail === null ? groups : rest).at(-1);
  if (last && last.includes('.')) { // an embedded IPv4 tail
    const n = v4(last);
    const words = [(n >>> 16).toString(16), (n & 0xffff).toString(16)];
    if (tail === null) groups = [...groups.slice(0, -1), ...words]; else rest = [...rest.slice(0, -1), ...words];
  }
  const fill = tail === null ? [] : new Array(8 - groups.length - rest.length).fill('0');
  return [...groups, ...fill, ...rest].reduce((acc, w) => (acc << 16n) + BigInt(parseInt(w || '0', 16)), 0n);
}

/** @param {string} cidr @returns {{ fam: 4 | 6, lo: number | bigint, hi: number | bigint } | null} */
export function parseCidr(cidr) {
  const [ip, bitsText] = String(cidr).trim().split('/');
  const bits = Number(bitsText);
  if (isIPv4(ip) && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
    const span = 2 ** (32 - bits);
    const lo = Math.floor(v4(ip) / span) * span;
    return { fam: 4, lo, hi: lo + span - 1 };
  }
  if (isIPv6(ip) && Number.isInteger(bits) && bits >= 0 && bits <= 128) {
    const span = 1n << BigInt(128 - bits);
    const lo = (v6(ip) / span) * span;
    return { fam: 6, lo, hi: lo + span - 1n };
  }
  return null;
}

/** Sorted, merged ranges of one family. */
function ranges(list) {
  list.sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const out = [];
  for (const r of list) {
    const prev = out.at(-1);
    if (prev && r.lo <= prev.hi + (typeof r.lo === 'bigint' ? 1n : 1)) { if (r.hi > prev.hi) prev.hi = r.hi; } else out.push({ lo: r.lo, hi: r.hi });
  }
  return out;
}
function contains(list, x) {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (x < list[mid].lo) hi = mid - 1; else if (x > list[mid].hi) lo = mid + 1; else return true;
  }
  return false;
}

/** Address of `ip` as { fam, x }, or null (IPv4-mapped IPv6 is IPv4). */
function addressOf(ip) {
  if (typeof ip !== 'string') return null;
  let addr = ip.trim();
  if (addr.startsWith('::ffff:') && isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (isIPv4(addr)) return { fam: 4, x: v4(addr) };
  if (isIPv6(addr)) return { fam: 6, x: v6(addr) };
  return null;
}

/**
 * The ISP table: { isps: { ct: [cidr…], cu, cm, edu, other }, provinces?: { '44': [cidr…], … } } (tools/isp-table.mjs).
 * classify(ip) gives an ISP label of NETQ_ISPS ('unknown' for an address in no table, a malformed one, or without a
 * table); province(ip) a NETQ_PROVINCES code ('xx' likewise).
 * @param {{ isps?: Record<string, string[]>, provinces?: Record<string, string[]> } | null} doc
 */
export function ispTable(doc) {
  const tables = new Map();
  let size = 0;
  for (const isp of ORDER) {
    const list = Array.isArray(doc?.isps?.[isp]) ? doc.isps[isp] : [];
    const four = [], six = [];
    for (const c of list) { const r = parseCidr(c); if (r) { (r.fam === 4 ? four : six).push(r); size++; } }
    tables.set(isp, { four: ranges(four), six: ranges(six) });
  }
  const provinces = [];
  for (const code of NETQ_PROVINCES) {
    const list = Array.isArray(doc?.provinces?.[code]) ? doc.provinces[code] : [];
    const four = [], six = [];
    for (const c of list) { const r = parseCidr(c); if (r) { (r.fam === 4 ? four : six).push(r); size++; } }
    if (four.length || six.length) provinces.push({ code, four: ranges(four), six: ranges(six) });
  }
  return {
    size,
    provinces: provinces.length,
    classify(ip) {
      const a = size ? addressOf(ip) : null;
      if (!a) return 'unknown';
      for (const isp of ORDER) if (contains(tables.get(isp)[a.fam === 4 ? 'four' : 'six'], a.x)) return isp;
      return 'unknown';
    },
    province(ip) {
      const a = provinces.length ? addressOf(ip) : null;
      if (!a) return 'xx';
      for (const p of provinces) if (contains(p[a.fam === 4 ? 'four' : 'six'], a.x)) return p.code;
      return 'xx';
    },
  };
}

/** Read the ISP table file; a missing or bad file classifies everything as 'unknown' (logged once). */
export function loadIspTable(file, log = console) {
  if (!file) return ispTable(null);
  try {
    const table = ispTable(JSON.parse(fs.readFileSync(file, 'utf8')));
    log.info?.(`[netq] ISP table: ${table.size} ranges, ${table.provinces} provinces`);
    return table;
  } catch (e) {
    log.warn?.(`[netq] ISP table unreadable (${e?.code || e?.message}); reports count as isp=unknown`);
    return ispTable(null);
  }
}

/** @param {{ classify?: (ip: string) => string, province?: (ip: string) => string }} [opts] */
export function createNetQuality({ classify = () => 'unknown', province = () => 'xx' } = {}) {
  const groups = new Map();
  /** province × ISP: the smaller set (no device / lanes split) */
  const provinces = new Map();
  let reports = 0;
  return {
    /** One validated net.q (shared/protocol.js) from a client at `ip`. */
    record(ip, msg) {
      let isp = 'unknown', prov = 'xx';
      try { isp = classify(ip); } catch { /* unknown */ }
      try { prov = province(ip); } catch { /* xx */ }
      if (!NETQ_ISPS.includes(isp)) isp = 'unknown';
      if (!NETQ_PROVINCES.includes(prov)) prov = 'xx';
      const key = `${isp}|${msg.dev}|${msg.lanes}`;
      let g = groups.get(key);
      if (!g) {
        g = { isp, device: msg.dev, lanes: msg.lanes, reports: 0, seconds: 0, rtt: new Array(NETQ_RTT_EDGES_MS.length + 1).fill(0),
          late: new Array(NETQ_LATE_EDGES_MS.length + 1).fill(0), copies: 0, lost: 0, stalled: 0, refused: 0, reconnects: 0, offlineMs: 0 };
        groups.set(key, g);
      }
      g.reports++; reports++;
      g.seconds += msg.sec;
      msg.rtt.forEach((n, i) => { g.rtt[i] += n; });
      msg.late.forEach((n, i) => { g.late[i] += n; });
      for (const k of ['copies', 'lost', 'stalled', 'refused', 'reconnects', 'offlineMs']) g[k] += msg[k];
      const pk = `${prov}|${isp}`;
      let p = provinces.get(pk);
      if (!p) {
        p = { province: prov, isp, reports: 0, seconds: 0, rtt: new Array(NETQ_RTT_EDGES_MS.length + 1).fill(0),
          late: new Array(NETQ_LATE_EDGES_MS.length + 1).fill(0), reconnects: 0, offlineMs: 0 };
        provinces.set(pk, p);
      }
      p.reports++;
      p.seconds += msg.sec;
      msg.rtt.forEach((n, i) => { p.rtt[i] += n; });
      msg.late.forEach((n, i) => { p.late[i] += n; });
      p.reconnects += msg.reconnects;
      p.offlineMs += msg.offlineMs;
    },
    /** Since start: { reports, rttEdgesMs, lateEdgesMs, groups: [...], provinces: [...] } (plain JSON). */
    snapshot() {
      return { reports, rttEdgesMs: [...NETQ_RTT_EDGES_MS], lateEdgesMs: [...NETQ_LATE_EDGES_MS],
        groups: [...groups.values()].map((g) => ({ ...g, rtt: [...g.rtt], late: [...g.late] })),
        provinces: [...provinces.values()].map((p) => ({ ...p, rtt: [...p.rtt], late: [...p.late] })) };
    },
  };
}
