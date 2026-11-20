#!/usr/bin/env node
// tools/title-cutoffs.mjs — measure 规程's 评语 tier lines (server/match/titleCutoffs.js REGULATION_TITLE_CUTOFFS) on bot-only
// matches: virtual time, the real simulation, the Match defaults (layout rehearsal, the shipped `legacy` bot), every seat
// playing the whole match. Every seat's value of each 评语 kind at the settlement (server/match/results.js regulationValues:
// 盟约层数 BOND, 击败数 KILL, 装备配发 EQUIP, 消耗资金 COIN, 晋升次数 CHAR, 领袖伤害 DAMAGE) is one sample; a kind's rank-1 line
// is the least value about the top `--top1` share (default 0.5) of the samples reach, its rank-2 line the top `--top2`
// (0.15) — lineFor: with whole-number ties, the line whose share is closest to the target.
// No player data is read: the lines come from the server's own bots.
//
// Usage:
//   node tools/title-cutoffs.mjs --version act3autochess@V3_1 [--configs <list>] [--seeds N] [--seed S] [--jobs N]
//                                [--json out.json] [--top1 0.5] [--top2 0.15]
//   node tools/title-cutoffs.mjs --from out.json [more.json …] [--top1 …] [--top2 …]   summarize earlier runs only
//   --configs  comma list of <solo|coopN>:<difficulty or official mode id> (botbench's); default every mode of the version
//              that a room can play: each solo mode (规程: 极速模拟 and 规程等级 1–20) and each co-op difficulty with 2, 3
//              and 4 seats — every configuration weighs the same
//   --seeds N  matches per configuration (seeds S..S+N−1, default 20)
//   --jobs N   worker threads (default 1)
//   --json F   append every seat's sample to F as JSON lines, one match at a time (the input of --from); a run on an
//              existing F skips the matches it already holds, so a stopped run resumes where it was
// Matches run seed by seed across the configurations, so a run stopped early still weighs them alike.
// Prints the lines over every sample, and per room mode and per difficulty for comparison, as the table to paste.

import { toolVersion } from './versions/runtime.mjs';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runMatch } from './ai/run-match.mjs';
import { Match } from '../server/match/Match.js';
import { seedSecret } from '../server/match/secret.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { regulationValues } from '../server/match/results.js';
import { officialModeId } from '../shared/versions.js';

const argv = isMainThread ? process.argv.slice(2) : workerData.argv;
const opt = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { rest.push(a); continue; }
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[k] = v;
}
const TOP1 = Number(opt.top1) > 0 ? Number(opt.top1) : 0.5;
const TOP2 = Number(opt.top2) > 0 ? Number(opt.top2) : 0.15;
const KINDS = ['BOND', 'KILL', 'EQUIP', 'COIN', 'CHAR', 'DAMAGE'];

/**
 * The line a rank starts at for the top `share` of the samples: the least value reached by about that share. The values
 * are whole numbers with ties (晋升次数 6 or 7, 装备 5 …): of the two lines around the boundary — its value (the share at or
 * above it) and one more (the share below it) — the one whose share is closer to `share`, the higher one on a tie. Never
 * below 1, so a zero never earns a rank.
 * @param {number[]} values @param {number} share
 */
export function lineFor(values, share) {
  if (!values.length) return 1;
  const s = values.slice().sort((a, b) => b - a);
  const k = Math.max(1, Math.floor(s.length * share));
  const v = s[k - 1];
  const at = (line) => s.filter((x) => x >= line).length / s.length;
  const line = Math.abs(at(v) - share) < Math.abs(at(v + 1) - share) ? v : v + 1;
  return Math.max(1, line);
}

/** The samples of a --json file: JSON lines (one match's seats per line), or one JSON array. */
function readSamples(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (!text.includes('\n')) return JSON.parse(text).flat();
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return JSON.parse(line); } catch { return []; } });
}

if (opt.from) {
  const files = [opt.from, ...rest];
  summarize(files.flatMap(readSamples));
  process.exit(0);
}

const data = getData({ log: { warn() {}, error() {}, info() {} } });
const modes = Object.entries(data.config.modes || {}).filter(([, m]) => m.inScope).sort(([, a], [, b]) => (a.sortId ?? 0) - (b.sortId ?? 0));
const configs = (opt.configs ? String(opt.configs).split(',') : [
  ...modes.filter(([, m]) => m.type === 'SINGLE').map(([id]) => `solo:${id}`),
  ...[2, 3, 4].flatMap((n) => [...new Set(modes.filter(([, m]) => m.type === 'MULTI').map(([, m]) => m.difficulty))].map((d) => `coop${n}:${d}`)),
]).map((s) => {
  const [m, d] = s.split(':');
  const solo = m === 'solo';
  return { name: s, mode: solo ? 'solo' : 'coop', players: solo ? 1 : Math.max(1, Math.min(4, Number(m.replace('coop', '')) || 4)), difficulty: /^mode_/.test(String(d)) ? String(d) : String(d || 'NORMAL').toUpperCase() };
});
const seeds = Math.max(1, Number(opt.seeds) || 20);
const seed0 = Number(opt.seed) || 1;

async function runOne(cfg, seed) {
  const sched = new VirtualScheduler();
  const seats = Array.from({ length: cfg.players }, (_, i) => ({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
  const modeId = officialModeId(data.config, cfg.mode, cfg.difficulty);
  if (!modeId) throw new RangeError(`${cfg.name}: no ${cfg.mode} mode ${cfg.difficulty} in ${toolVersion}`);
  let summary = null;
  const m = new Match({
    roomCode: 'TITLES', mode: cfg.mode, difficulty: data.config.modes[modeId].difficulty, modeId, seats, seed, matchSecret: seedSecret(seed), data, scheduler: sched,
    log: { info() {}, debug() {}, warn() {}, error() {} }, botStrategy: 'legacy', botStrategySeats: {},
    send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  });
  m.start();
  await runMatch(m, () => summary != null, { maxSteps: 5e6 });
  const rows = summary ? [...m.players.values()].map((ps) => {
    const row = summary.players.find((p) => p.playerId === ps.playerId);
    return { config: cfg.name, mode: cfg.mode, modeId, difficulty: m.gd.difficulty, seed, seat: ps.seat, rounds: row?.roundsPassed ?? null,
      victory: !!row?.victory, title: row?.title?.id ?? null, values: regulationValues(m.gd.titles, ps) };
  }) : [];
  m.dispose();
  return rows;
}

const tasks = [];
for (let i = 0; i < seeds; i++) for (const cfg of configs) tasks.push([cfg, seed0 + i]);
// a resumed run: the matches the --json file already holds are not played again
const have = isMainThread && opt.json && existsSync(opt.json) ? readSamples(opt.json) : [];
const done = new Set(have.map((s) => `${s.config}#${s.seed}`));
const todo = tasks.map((_, i) => i).filter((i) => !done.has(`${tasks[i][0].name}#${tasks[i][1]}`));
const jobs = Math.max(1, Math.min(32, Number(opt.jobs) || 1));
if (!isMainThread) {
  for (const i of workerData.indexes) parentPort.postMessage({ i, rows: await runOne(...tasks[i]) });
} else {
  const all = [...have];
  let n = 0;
  const got = (rows) => {
    all.push(...rows);
    if (opt.json) appendFileSync(opt.json, `${JSON.stringify(rows)}\n`);
    if (++n % 25 === 0 || n === todo.length) process.stderr.write(`${n}/${todo.length} matches (${done.size} from ${opt.json})\n`);
  };
  if (jobs === 1) {
    for (const i of todo) got(await runOne(...tasks[i]));
  } else {
    await Promise.all(Array.from({ length: jobs }, (_, j) => new Promise((resolve, reject) => {
      const indexes = todo.filter((_, k) => k % jobs === j);
      const w = new Worker(new URL(import.meta.url), { workerData: { argv, indexes, version: toolVersion } });
      w.on('message', ({ rows }) => got(rows));
      w.on('error', reject);
      w.on('exit', resolve);
    })));
  }
  summarize(all);
}

/** The lines of every kind over `samples` (each seat of each configuration weighs the same), and the shares they give. */
function summarize(samples) {
  const table = (list) => Object.fromEntries(KINDS.map((k) => {
    const vals = list.map((s) => s.values?.[k] ?? 0);
    const l1 = lineFor(vals, TOP1);
    const l2 = Math.max(l1 + 1, lineFor(vals, TOP2));
    const share = (line) => (vals.length ? vals.filter((v) => v >= line).length / vals.length : 0);
    return [k, { lines: [l1, l2], shares: [share(l1), share(l2)], median: lineFor(vals, 0.5), max: Math.max(0, ...vals) }];
  }));
  const pct = (x) => `${(x * 100).toFixed(1)} %`;
  const print = (label, list) => {
    if (!list.length) return;
    const t = table(list);
    console.log(`\n${label} — ${list.length} samples`);
    console.log('| kind | rank 1 from | share | rank 2 from | share | max |');
    console.log('|---|---|---|---|---|---|');
    for (const k of KINDS) console.log(`| ${k} | ${t[k].lines[0]} | ${pct(t[k].shares[0])} | ${t[k].lines[1]} | ${pct(t[k].shares[1])} | ${t[k].max} |`);
    return t;
  };
  const t = print(`every sample (top ${pct(TOP1)} / ${pct(TOP2)})`, samples);
  for (const mode of ['solo', 'coop']) print(`room mode ${mode}`, samples.filter((s) => s.mode === mode));
  for (const d of [...new Set(samples.map((s) => s.difficulty))]) print(`difficulty ${d}`, samples.filter((s) => s.difficulty === d));
  if (t) console.log(`\nREGULATION_TITLE_CUTOFFS = ${JSON.stringify(Object.fromEntries(KINDS.map((k) => [k, t[k].lines])))}`);
}
