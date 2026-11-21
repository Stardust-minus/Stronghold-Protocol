// tools/versions/forkDiy.mjs — the 盟约 seasons play 规程's 自选 rule (the owner's decision of 2026-11-21: 「都走这个，盟约
// 也换成6-6 选2+2这样」): six 自选 slots at tier 5 and six at tier 6 (12, as act3autochess diyChessDict), and the
// 选择自编 step after the strategy draft that brings 0–2 of each tier into the match (constData.diyCharLimitForLevels
// {"5":2,"6":2} and the CUSTOM_CHECK enter step, 30 s with a 10 s hint — 规程's own values). The 盟约 tables have two
// slots per tier and neither field, so a profile with `forkDiy: true` (tools/versions/profiles.mjs) gets them here:
//   * chess: slots 3…6 of each tier, copies of the tier's slot 1 (its `_a` / `_b` pair: tier, price, status, merge,
//     requirement) under the next ids, after the tier's last slot; `identifier` continues after the data's largest,
//     `shopSortId` after the slot's previous one (规程's numbering);
//   * backups.diy.slots: the new slots, the tier's slot 1 entry under the new ids, in chess order;
//   * config: diyBringLimits and the CUSTOM_CHECK step before BATTLE_CHECK.
// With more than two slots a tier no 候补 is left (shared/diy.js diyBenchSize): a stored 盟约 preset's bench keys move to
// slots 3 and 4 (shared/diy.js promoteDiyBench). tools/build-data.mjs applies this to every potential pass of such a
// profile; `node tools/versions/forkDiy.mjs <data dir>…` applies it to built files in place (idempotent).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORK_DIY = Object.freeze({
  slotsPerTier: 6,
  bringLimits: Object.freeze({ 5: 2, 6: 2 }),
  step: Object.freeze({ step: 'CUSTOM_CHECK', time: 30, hint: 10, title: '选择自编' }),
});

const SLOT = /^chess_char_(\d)_diy(\d+)_([ab])$/;
const slotId = (tier, n, form) => `chess_char_${tier}_diy${n}_${form}`;

/**
 * chess.json with slots up to FORK_DIY.slotsPerTier at each tier that has 自选 slots (a new object, keys in order).
 * @param {Record<string, any>} chess @returns {Record<string, any>}
 */
export function forkDiyChess(chess) {
  const tiers = new Map(); // tier → largest slot number
  for (const id of Object.keys(chess)) {
    const m = SLOT.exec(id);
    if (m && chess[id]?.isDiy) tiers.set(Number(m[1]), Math.max(tiers.get(Number(m[1])) ?? 0, Number(m[2])));
  }
  let ident = Math.max(0, ...Object.values(chess).map((c) => (Number.isInteger(c?.identifier) ? c.identifier : 0)));
  const add = new Map(); // id of a tier's last slot `_b` → the records that follow it
  for (const [tier, last] of tiers) {
    const a1 = chess[slotId(tier, 1, 'a')];
    const b1 = chess[slotId(tier, 1, 'b')];
    if (!a1 || !b1 || last >= FORK_DIY.slotsPerTier) continue;
    const rows = [];
    let sort = chess[slotId(tier, last, 'a')]?.shopSortId ?? a1.shopSortId;
    for (let n = last + 1; n <= FORK_DIY.slotsPerTier; n++) {
      const a = slotId(tier, n, 'a');
      const b = slotId(tier, n, 'b');
      sort = Number.isInteger(sort) ? sort + 1 : sort;
      rows.push([a, { ...structuredClone(a1), chessId: a, baseId: a, goldenId: b, upgradeChessId: b, identifier: ++ident, shopSortId: sort }]);
      rows.push([b, { ...structuredClone(b1), chessId: b, baseId: a, goldenId: b, identifier: ++ident, shopSortId: sort }]);
    }
    add.set(slotId(tier, last, 'b'), rows);
  }
  const out = {};
  for (const [id, rec] of Object.entries(chess)) {
    out[id] = rec;
    for (const [k, v] of add.get(id) ?? []) out[k] = v;
  }
  return out;
}

/**
 * backups.json with the slots of `chess` (forkDiyChess) in backups.diy.slots, in chess order (mutates and returns `backups`).
 * @param {any} backups @param {Record<string, any>} chess
 */
export function forkDiyBackups(backups, chess) {
  const slots = backups?.diy?.slots;
  if (!slots) return backups;
  const next = {};
  for (const id of Object.keys(chess)) {
    const m = SLOT.exec(id);
    if (!m || m[3] !== 'a' || !chess[id]?.isDiy) continue;
    const first = slots[slotId(Number(m[1]), 1, 'a')];
    next[id] = slots[id] ?? (first ? { ...first, goldenId: chess[id].goldenId } : undefined);
    if (!next[id]) delete next[id];
  }
  backups.diy.slots = next;
  return backups;
}

/** config.json with diyBringLimits and the CUSTOM_CHECK enter step (mutates and returns `config`). @param {any} config */
export function forkDiyConfig(config) {
  // the field sits where tools/build-data.mjs buildConfig writes a version's own (after finalAssault, before timers)
  const limits = Object.fromEntries(Object.entries(FORK_DIY.bringLimits).map(([k, v]) => [String(k), v]));
  if (!config.diyBringLimits) {
    const entries = Object.entries(config);
    const at = entries.findIndex(([k]) => k === 'timers');
    entries.splice(at < 0 ? entries.length : at, 0, ['diyBringLimits', limits]);
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, Object.fromEntries(entries));
  }
  const steps = config.timers?.enterSteps;
  if (Array.isArray(steps) && !steps.some((s) => s?.step === FORK_DIY.step.step)) {
    const at = steps.findIndex((s) => s?.step === 'BATTLE_CHECK');
    steps.splice(at < 0 ? steps.length : at, 0, { ...FORK_DIY.step });
  }
  return config;
}

/** Apply the rule to a built data directory in place (each file rewritten whole, as tools/build-data.mjs writes it). */
function applyToDir(dir) {
  const read = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  const write = (name, obj) => {
    const dest = join(dir, `${name}.json`);
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, dest);
  };
  const chess = forkDiyChess(read('chess'));
  write('chess', chess);
  write('backups', forkDiyBackups(read('backups'), chess));
  write('config', forkDiyConfig(read('config')));
  const n = Object.values(chess).filter((c) => c?.isDiy && !c.isGolden).length;
  console.log(`${dir}: ${n} 自选 slots`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: node tools/versions/forkDiy.mjs <data dir>…'); process.exit(2); }
  for (const d of dirs) applyToDir(d);
}
