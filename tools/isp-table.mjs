#!/usr/bin/env node
// Build the ISP table the server classifies network-quality reports with (server/netQuality.js, SP_ISP_FILE;
// docs/LATENCY.md, Network quality reports) from gaoyifan/china-operator-ip (ip-lists branch, public
// BGP-derived lists; check the project for its terms before redistributing): 中国电信 chinanet → ct, 联通 unicom → cu, 移动 cmcc → cm, 教育网 cernet → edu, all of China → other.
//
// Provinces: IPv4 from metowolf/iplist data/cncity/<code>0000.txt — a province's file holds its cities too. IPv6 from
// lionsoul2014/ip2region data/ipv6_source.txt (Apache-2.0 OR MIT), pinned to one commit and its sha256 (PROVINCES6):
// a China row `start|end|中国|<province>|<city>|<ISP>|CN` goes to that province (its name without 省 / 市 / 自治区) as
// CIDRs, after the province's IPv4 lists. ip2region names a China IPv6 range it cannot place 北京市 (in China Mobile's
// 2409:8000::/20: 广东省) — 96% of what it has in 中国电信's 240e::/20, 97% in 联通's 2408:8000::/20, 90% of China
// Mobile's in 广东省 (2026-11-12) — so those rows are left out (FALLBACK6): such an address, and so a Beijing IPv6
// player too, stays xx. Hong Kong, Macau and Taiwan are not NETQ_PROVINCES codes.
//
//   node tools/isp-table.mjs --out /path/isp-table.json [--base https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists]
//     [--provinces https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/cncity]
//     [--provinces6 URL --provinces6-sha256 HEX]   (another ip2region ipv6_source.txt, e.g. a mirror: both or neither;
//                                                  --provinces6 none: IPv4 provinces only, the table as before 2026-11-20)
//
// Every line is checked with the server's own parser; a list that fails to download or parse aborts the run (no
// partial table), and so does an IPv6 source whose sha256 is not the pinned one. The output names its sources and
// date; rerun it now and then (the lists change monthly; move PROVINCES6 to a newer commit by hand).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIPv6 } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseCidr } from '../server/netQuality.js';
import { NETQ_PROVINCES } from '../shared/netQuality.js';

/** ip2region's IPv6 source at commit 9a905861 (2026-11-12, "merge the fixes and re-gen the v6 xdb"). */
export const PROVINCES6 = Object.freeze({
  url: 'https://raw.githubusercontent.com/lionsoul2014/ip2region/9a905861a06429d0ba217dcdaa146b994c37f5f9/data/ipv6_source.txt',
  sha256: '022fcac8f293ae5f7deff1bdcd79d243ae3ee2f3c1cd17a953f2c9634f207bda',
});
/** ip2region's province names without 省 / 市 / 自治区 → the NETQ_PROVINCES code (GB/T 2260). */
const PROVINCE_NAMES = Object.freeze({ 北京: '11', 天津: '12', 河北: '13', 山西: '14', 内蒙古: '15', 辽宁: '21', 吉林: '22',
  黑龙江: '23', 上海: '31', 江苏: '32', 浙江: '33', 安徽: '34', 福建: '35', 江西: '36', 山东: '37', 河南: '41', 湖北: '42',
  湖南: '43', 广东: '44', 广西: '45', 海南: '46', 重庆: '50', 四川: '51', 贵州: '52', 云南: '53', 西藏: '54', 陕西: '61',
  甘肃: '62', 青海: '63', 宁夏: '64', 新疆: '65' });
/** ip2region's "somewhere in China" IPv6 labels: [code, only inside this CIDR (null: anywhere)]. */
const FALLBACK6 = Object.freeze([['11', null], ['44', '2409:8000::/20']]);

/** An IPv6 address (BigInt) as RFC 5952 text. */
function text6(x) {
  const w = Array.from({ length: 8 }, (_, i) => Number((x >> BigInt(112 - 16 * i)) & 0xffffn));
  let at = -1, len = 1;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > len) { at = i; len = j - i; }
    i = j > i ? j : i + 1;
  }
  const hex = w.map((n) => n.toString(16));
  return at < 0 ? hex.join(':') : `${hex.slice(0, at).join(':')}::${hex.slice(at + len).join(':')}`;
}

/** The fewest CIDRs covering the IPv6 addresses lo … hi (BigInt, inclusive). */
export function cidrs6(lo, hi) {
  const out = [];
  while (lo <= hi) {
    let bits = 0n;
    while (bits < 128n && ((lo >> bits) & 1n) === 0n && lo + (1n << (bits + 1n)) - 1n <= hi) bits++;
    out.push(`${text6(lo)}/${128n - bits}`);
    lo += 1n << bits;
  }
  return out;
}

/**
 * The China rows of an ip2region ipv6_source.txt (ascending, non-overlapping `start|end|country|province|city|ISP|cc`)
 * as { provinces: { code: [cidr…] }, rows: China rows, fallback: rows left out by FALLBACK6, other: China rows of no
 * mainland province (Hong Kong, Macau, Taiwan, none) }. Adjacent rows of one province are merged. A bad line throws.
 * @param {string} text
 */
export function ip2regionProvinces6(text) {
  const fallback = FALLBACK6.map(([code, cidr]) => [code, cidr ? parseCidr(cidr) : null]);
  const provinces = {};
  const counts = { rows: 0, fallback: 0, other: 0 };
  let prev = -1n, run = null;
  const flush = () => { if (run) (provinces[run.code] ??= []).push(...cidrs6(run.lo, run.hi)); run = null; };
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const f = line.split('|');
    const lo = f.length === 7 && isIPv6(f[0]) ? parseCidr(`${f[0]}/128`).lo : null;
    const hi = lo !== null && isIPv6(f[1]) ? parseCidr(`${f[1]}/128`).lo : null;
    if (hi === null || hi < lo || lo <= prev) throw new Error(`line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`);
    prev = hi;
    if (f[2] !== '中国') return;
    counts.rows++;
    const code = PROVINCE_NAMES[f[3].replace(/(?:壮族|回族|维吾尔)?自治区$|[省市]$/, '')];
    if (!code) { counts.other++; flush(); return; }
    if (fallback.some(([c, r]) => c === code && (!r || (lo >= r.lo && hi <= r.hi)))) { counts.fallback++; flush(); return; }
    if (run && run.code === code && run.hi + 1n === lo) run.hi = hi;
    else { flush(); run = { code, lo, hi }; }
  });
  flush();
  return { provinces, ...counts };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
  if (!args.out || (args.provinces6 !== 'none' && !args.provinces6 !== !args['provinces6-sha256'])) {
    console.error('usage: isp-table.mjs --out FILE [--base URL] [--provinces URL] [--provinces6 URL --provinces6-sha256 HEX | --provinces6 none]');
    process.exit(2);
  }
  const base = (args.base || 'https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists').replace(/\/+$/, '');
  const provBase = (args.provinces || 'https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/cncity').replace(/\/+$/, '');
  const prov6 = args.provinces6 === 'none' ? null
    : args.provinces6 ? { url: args.provinces6, sha256: args['provinces6-sha256'].toLowerCase() } : PROVINCES6;
  const LISTS = { ct: ['chinanet', 'chinanet6'], cu: ['unicom', 'unicom6'], cm: ['cmcc', 'cmcc6'], edu: ['cernet', 'cernet6'], other: ['china', 'china6'] };

  async function list(url, min = 10) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const lines = (await res.text()).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const line of lines) if (!parseCidr(line)) throw new Error(`${url}: bad line ${JSON.stringify(line.slice(0, 64))}`);
    if (lines.length < min) throw new Error(`${url}: only ${lines.length} lines`);
    return lines;
  }
  const isps = {};
  for (const [isp, files] of Object.entries(LISTS)) {
    isps[isp] = [];
    for (const file of files) isps[isp].push(...(await list(`${base}/${file}.txt`)));
  }
  const provinces = {};
  for (const code of NETQ_PROVINCES.filter((c) => c !== 'xx')) provinces[code] = await list(`${provBase}/${code}0000.txt`, 3);
  const v4 = Object.values(provinces).reduce((n, l) => n + l.length, 0);

  let six = null, v6 = 0;
  if (prov6) {
    const res = await fetch(prov6.url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${prov6.url}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== prov6.sha256) throw new Error(`${prov6.url}: sha256 ${sha256}, not the pinned ${prov6.sha256}`);
    six = ip2regionProvinces6(bytes.toString('utf8'));
    for (const [code, cidrs] of Object.entries(six.provinces)) { provinces[code].push(...cidrs); v6 += cidrs.length; }
    if (v6 < 1000) throw new Error(`${prov6.url}: only ${v6} IPv6 province ranges`);
  }

  const doc = { v: 1, source: base, provincesSource: provBase, ...(prov6 && { provinces6Source: prov6.url, provinces6Sha256: prov6.sha256 }),
    generated: new Date().toISOString().slice(0, 10), isps, provinces };
  fs.writeFileSync(`${args.out}.tmp`, JSON.stringify(doc));
  fs.renameSync(`${args.out}.tmp`, args.out);
  console.log(`[isp-table] ${args.out}: ${Object.entries(isps).map(([k, v]) => `${k} ${v.length}`).join(', ')}; `
    + (six ? `provinces ${Object.keys(provinces).length} (${v4} IPv4 + ${v6} IPv6 ranges; of ${six.rows} ip2region China rows `
      + `${six.fallback} fallback and ${six.other} outside the mainland provinces left out)`
      : `provinces ${Object.keys(provinces).length} (${v4} ranges)`));
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) await main();
