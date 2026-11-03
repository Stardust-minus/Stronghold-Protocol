// The 领袖战 damage report of a settlement row (feedback #70 「希望对局记录里可以看到boss战每个干员dps」, #81 「结算页面是否
// 可以加入干员伤害统计」): m.result players[].damage — one entry per final scope the player fought, 最终攻势 ('boss') then
// 隐秘核心 ('hidden') — built by the server from its damage ledger frozen at the scope's end (server/match/results.js
// bossDamageRows): the battle seconds, the authoritative damage / healing sums, what no operator owns (devices) and the
// operators by damage (summons credited to theirs). The wire is compact: zero amounts are left out, and an operator names
// how it is drawn (a 自选 pick, a stand-in, a skin) only when the row's lineup has no entry of its chess id — the page
// takes that entry's (opLook). The settlement's 数据详情 (screens/result.js) shows it per player card; 统计数据 keeps it in
// the stored rows (ui/stats.js, compact), so a re-viewed settlement shows it too. Pure logic, Node-testable
// (test/ui/boss-damage.test.js).

/** The final scopes, in the order a report lists them. */
export const BOSS_DAMAGE_KINDS = Object.freeze(['boss', 'hidden']);
/** Operator rows kept per scope (a board holds 10; the server keeps 12: server/match/results.js BOSS_DAMAGE_OPS). */
export const MAX_DAMAGE_OPS = 12;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 64) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
/** A whole non-negative amount (bounded: foreign data); anything else 0. */
const amount = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e12) : 0);

/**
 * A row's report in its strict shape: known scopes once each, in BOSS_DAMAGE_KINDS order, every number finite and
 * bounded, at most MAX_DAMAGE_OPS operators each named by a chess id. `skins: false` drops the operators' skins (a stored
 * record keeps no outfit, like its lineup); `compact` leaves the zero amounts out (the wire's and a stored record's form)
 * — else every amount is there.
 * @param {any} raw @param {{ skins?: boolean, compact?: boolean }} [opts]
 * @returns {Array<{ kind: 'boss'|'hidden', round: number, seconds: number, total: number, healing: number, otherDamage: number,
 *   otherHealing: number, ops: Array<{ id: string, damage: number, healing: number, diy?: object, standInFor?: string, skinId?: string }> }>}
 */
export function normalizeBossDamage(raw, { skins = true, compact = false } = {}) {
  if (!Array.isArray(raw)) return [];
  const some = (k, v) => (compact && !amount(v) ? {} : { [k]: amount(v) });
  const byKind = new Map();
  for (const e of raw) {
    if (!isObj(e) || !BOSS_DAMAGE_KINDS.includes(e.kind) || byKind.has(e.kind)) continue;
    const ops = (Array.isArray(e.ops) ? e.ops : []).filter((o) => isObj(o) && str(o.id)).slice(0, MAX_DAMAGE_OPS).map((o) => {
      const op = { id: str(o.id), damage: amount(o.damage), ...some('healing', o.healing) };
      if (isObj(o.diy) && str(o.diy.charId)) {
        op.diy = { charId: str(o.diy.charId), skillIndex: Number.isInteger(o.diy.skillIndex) ? o.diy.skillIndex : 0, uniEquipId: str(o.diy.uniEquipId) };
      }
      if (str(o.standInFor)) op.standInFor = str(o.standInFor);
      if (skins && str(o.skinId)) op.skinId = str(o.skinId);
      return op;
    });
    const seconds = Number.isFinite(e.seconds) && e.seconds > 0 ? Math.min(Math.round(e.seconds * 10) / 10, 1e6) : 0;
    byKind.set(e.kind, { kind: e.kind, round: Number.isInteger(e.round) && e.round > 0 && e.round < 1000 ? e.round : 0, seconds,
      total: amount(e.total), ...some('healing', e.healing), ...some('otherDamage', e.otherDamage), ...some('otherHealing', e.otherHealing), ops });
  }
  return BOSS_DAMAGE_KINDS.filter((k) => byKind.has(k)).map((k) => byKind.get(k));
}

/**
 * How a report's operator is drawn: its own 自选 pick / stand-in / skin, else those of the row's lineup entry of the same
 * chess id (the compact wire leaves them out there).
 * @param {{ id: string }} op @param {any[]} [lineup] the row's lineup
 */
export function opLook(op, lineup = []) {
  const u = (Array.isArray(lineup) ? lineup : []).find((x) => isObj(x) && x.id === op.id);
  if (!u) return op;
  const look = {};
  if (u.diy) look.diy = u.diy;
  if (u.standInFor) look.standInFor = u.standInFor;
  if (u.skinId) look.skinId = u.skinId;
  return { ...look, ...op };
}

/** Per second of the scope's battle time (DPS / HPS); null without battle time. */
export const perSecond = (value, seconds) => (seconds > 0 && Number.isFinite(value) ? value / seconds : null);

/**
 * What a report entry lists for a metric: the operators that dealt damage (healing: that healed), then 装置 / 其他 when it
 * has any, by value; each with its share of the entry's sum (0–100) and its rate (perSecond over the entry's seconds).
 * @param {ReturnType<typeof normalizeBossDamage>[number]} entry @param {'damage'|'healing'} [metric]
 * @returns {{ total: number, rate: number|null, rows: Array<{ key: string, op: any|null, value: number, share: number, rate: number|null }> }}
 */
export function bossDamageList(entry, metric = 'damage') {
  if (!entry) return { total: 0, rate: null, rows: [] };
  const healing = metric === 'healing';
  const total = (healing ? entry.healing : entry.total) || 0;
  const rows = entry.ops.map((op, i) => ({ key: `${i}:${op.id}`, op, value: (healing ? op.healing : op.damage) || 0 }))
    .filter((r) => r.value > 0);
  const other = (healing ? entry.otherHealing : entry.otherDamage) || 0;
  if (other > 0) rows.push({ key: 'other', op: null, value: other });
  rows.sort((a, b) => b.value - a.value);
  const sum = total > 0 ? total : rows.reduce((n, r) => n + r.value, 0);
  return {
    total: sum,
    rate: perSecond(sum, entry.seconds),
    rows: rows.map((r) => ({ ...r, share: sum > 0 ? Math.min(100, (r.value / sum) * 100) : 0, rate: perSecond(r.value, entry.seconds) })),
  };
}
