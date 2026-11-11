#!/usr/bin/env node
// Build the ISP table the server classifies network-quality reports with (server/netQuality.js, SP_ISP_FILE;
// docs/LATENCY.md, Network quality reports) from gaoyifan/china-operator-ip (ip-lists branch, public
// BGP-derived lists; check the project for its terms before redistributing): 中国电信 chinanet → ct, 联通 unicom → cu, 移动 cmcc → cm, 教育网 cernet → edu, all of China → other.
//
// Provinces (IPv4 only) come from metowolf/iplist data/cncity/<code>0000.txt — a province's file holds its cities too.
//
//   node tools/isp-table.mjs --out /path/isp-table.json [--base https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists]
//     [--provinces https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/cncity]
//
// Every line is checked with the server's own parser; a list that fails to download or parse aborts the run (no
// partial table). The output names its source and date; rerun it now and then (the lists change monthly).
import fs from 'node:fs';
import { parseCidr } from '../server/netQuality.js';
import { NETQ_PROVINCES } from '../shared/netQuality.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
if (!args.out) { console.error('usage: isp-table.mjs --out FILE [--base URL]'); process.exit(2); }
const base = (args.base || 'https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@ip-lists').replace(/\/+$/, '');
const provBase = (args.provinces || 'https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/cncity').replace(/\/+$/, '');
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
const doc = { v: 1, source: base, provincesSource: provBase, generated: new Date().toISOString().slice(0, 10), isps, provinces };
fs.writeFileSync(`${args.out}.tmp`, JSON.stringify(doc));
fs.renameSync(`${args.out}.tmp`, args.out);
console.log(`[isp-table] ${args.out}: ${Object.entries(isps).map(([k, v]) => `${k} ${v.length}`).join(', ')}; `
  + `provinces ${Object.keys(provinces).length} (${Object.values(provinces).reduce((n, l) => n + l.length, 0)} ranges)`);
