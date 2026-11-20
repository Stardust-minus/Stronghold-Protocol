// shared/elo.js — the ELO room option's mapping (docs/history/0.4.0.md §37.273 / §37.275; shared/experimental.js
// isEloRoom): a player's own recent [wins, games] → the shrunk win rate → the tilt's strength and parameters → the level
// the player is shown. Shared on purpose (the owner, 2026-11-20: 「每个玩家开启前要看到自己的胜率和预计影响」): the room's
// panel (public/js/ui/eloPanel.js) and the server's tilt (server/match/tilt.js) call the same functions, so what a player
// reads is what the server does. How a tilt weighs a draw and every random stream stay in server/match/tilt.js.

import { DIFFICULTIES } from './constants.js';
import { N_ } from './i18n.js';

/** room.elo: the newest `last` records of a mode and difficulty are counted; at most one pair per mode and difficulty. */
export const ELO_LIMITS = Object.freeze({ last: 30, keys: 2 * DIFFICULTIES.length });
/** `<mode>:<difficulty>` of a room (the key of room.elo `rec`). @param {string} mode @param {string} difficulty */
export const eloKey = (mode, difficulty) => `${mode}:${difficulty}`;
const ELO_KEYS = new Set(['solo', 'coop'].flatMap((mode) => DIFFICULTIES.map((d) => eloKey(mode, d))));
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** One `[wins, games]` pair: integers, 0 ≤ wins ≤ games ≤ ELO_LIMITS.last. */
export const isEloPair = (v) => Array.isArray(v) && v.length === 2 && isInt(v[1], 0, ELO_LIMITS.last) && isInt(v[0], 0, v[1]);
/** Structural check of room.elo `rec`: `{ '<mode>:<difficulty>': [wins, games] }`. */
export const isEloRecords = (v) => isPlain(v) && Object.keys(v).length <= ELO_LIMITS.keys
  && Object.entries(v).every(([k, pair]) => ELO_KEYS.has(k) && isEloPair(pair));
/**
 * The pair a match of a room of `mode` and `difficulty` takes from a seat's `rec` (a frozen copy), null when it has none.
 * @param {any} rec @param {string} mode @param {string} difficulty
 */
export function eloPairOf(rec, mode, difficulty) {
  const pair = isEloRecords(rec) ? rec[eloKey(mode, difficulty)] : undefined;
  return pair ? Object.freeze([pair[0], pair[1]]) : null;
}

/**
 * THE mapping (the owner 2026-11-20: 「把每个人的胜率往 50% 拉」; hindering is strong, so its ramp is gentle; helping goes to
 * M = 8; weights may reach 0 for a player who wins too much). From a player's own `[wins, games]`:
 *   minGames  fewer games → no tilt (s = 0)
 *   prior     the rate w = (wins + prior) / (games + 2 · prior): shrunk towards 50 % (+2 wins +2 losses)
 *   help      w < 0.5: s = (0.5 − w) / (0.5 − full), at most 1 (w ≤ 0.3: s = +1), base M = m (8), no floor
 *   hinder    w > 0.5: s = −(w − 0.5) / (full − 0.5), at least −1 (w ≥ 0.9), base M = m (4); from `floorFrom` on the key
 *             cards (relevance ≥ 0.5) also slide to weight 0 — `mix` = (w − floorFrom) / (floorFull − floorFrom): none up
 *             to 0.8, all of the way (such a card is never dealt to the player) from 0.9
 *   rescue    an AI teammate rescues a player of s ≥ 0 always (§37.274), one of s < 0 with chance 1 + s (s = −1: never)
 * The tier lever stays off (the shop's tier odds are on screen).
 */
export const ELO_MAP = Object.freeze({
  minGames: 5, prior: 2,
  help: Object.freeze({ full: 0.3, m: 8 }),
  hinder: Object.freeze({ full: 0.9, m: 4, floorFrom: 0.8, floorFull: 0.9 }),
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The tilt of a shrunk win rate `w` — `{ s, m, floor?, mix? }`, the options server/match/tilt.js setTilt takes —, null
 * at 50 %. @param {number} w
 */
export function eloTiltAt(w) {
  if (!Number.isFinite(w)) return null;
  const { help, hinder } = ELO_MAP;
  if (w < 0.5) {
    const s = round3(clamp((0.5 - w) / (0.5 - help.full), 0, 1));
    return s > 0 ? { s, m: help.m } : null;
  }
  const s = round3(-clamp((w - 0.5) / (hinder.full - 0.5), 0, 1));
  if (!(s < 0)) return null;
  const mix = round3(clamp((w - hinder.floorFrom) / (hinder.floorFull - hinder.floorFrom), 0, 1));
  return { s, m: hinder.m, ...(mix > 0 ? { floor: 0, mix } : {}) };
}

/** A player's shrunk win rate from its `[wins, games]`, or null (no pair, fewer than ELO_MAP.minGames). @param {any} pair */
export function eloRate(pair) {
  if (!isEloPair(pair) || pair[1] < ELO_MAP.minGames) return null;
  return (pair[0] + ELO_MAP.prior) / (pair[1] + 2 * ELO_MAP.prior);
}

/** The tilt of a player's `[wins, games]` (eloRate → eloTiltAt), or null: no tilt. @param {any} pair */
export function eloTilt(pair) {
  const w = eloRate(pair);
  return w == null ? null : eloTiltAt(w);
}

/**
 * The levels a player is shown (eloImpact): help 1–3 and hinder 1–3 by |s| in thirds, hinder 4 once the key cards are
 * floored all of the way (mix 1: 「几乎刷不到」). `measured`: the solo win rate of the bot standing in for a player
 * (the headless matches of tools/matchrun.mjs, `games` paired seeds) without the tilt (`off`) and at the level's
 * representative tilt (`at`, %: the tilt eloTiltAt gives at `w`); `label` names the version and mode it was measured on
 * (the panel prints it). The help side saturates (the bot cannot use more cards: its three levels differ within the
 * noise of 300 games, ±5 points); the hinder side is strong — at level 4 the key cards are never dealt and the bot does
 * not win (docs/history/0.4.0.md §37.275).
 */
export const ELO_LEVELS = Object.freeze({
  // 2026-11-20: the bot (legacy strategy) on 规程·序列Ⅰ's 规程等级 15 (终极, the 规程 lobby's first 终极 level), seeds 1–300
  measured: Object.freeze({ label: N_('规程·序列Ⅰ·独立·规程等级 15（终极）'), version: 'act3autochess@V3_1', modeId: 'mode_single_15', games: 300, off: 29.3 }),
  help: Object.freeze([
    Object.freeze({ level: 1, upTo: 1 / 3, w: 0.467, at: 30.7 }),
    Object.freeze({ level: 2, upTo: 2 / 3, w: 0.4, at: 34.0 }),
    Object.freeze({ level: 3, upTo: 1, w: 0.3, at: 32.3 }),
  ]),
  hinder: Object.freeze([
    Object.freeze({ level: 1, upTo: 1 / 3, w: 0.567, at: 25.0 }),
    Object.freeze({ level: 2, upTo: 2 / 3, w: 0.7, at: 22.3 }),
    Object.freeze({ level: 3, upTo: 1, w: 0.85, at: 14.7 }),
    Object.freeze({ level: 4, upTo: 1, w: 0.9, at: 0.0 }),
  ]),
});

/**
 * What the ELO option does to a player with `[wins, games]` (null: none recorded): `{ pair, games, wins, w (shrunk, null
 * with too few games), raw (wins / games, null without games), tilt (eloTilt), dir 'help' | 'none' | 'hinder', level (0
 * when none), key ('few' | 'even' | 'help' | 'hinder'), rescue (an AI teammate's chance to rescue the player, 0 … 1),
 * measured ({ off, at } of the level, at null when not measured) }`.
 * @param {any} pair
 */
export function eloImpact(pair) {
  const ok = isEloPair(pair);
  const wins = ok ? pair[0] : 0, games = ok ? pair[1] : 0;
  const w = eloRate(ok ? pair : null);
  const tilt = w == null ? null : eloTiltAt(w);
  const base = { pair: ok ? [wins, games] : null, games, wins, w, raw: games ? wins / games : null, tilt };
  if (!tilt) {
    return { ...base, dir: 'none', level: 0, key: w == null ? 'few' : 'even', rescue: 1, measured: { off: ELO_LEVELS.measured.off, at: ELO_LEVELS.measured.off } };
  }
  const dir = tilt.s > 0 ? 'help' : 'hinder';
  const rows = ELO_LEVELS[dir], mag = Math.abs(tilt.s);
  const mix = /** @type {{ mix?: number }} */ (tilt).mix ?? 0;
  const row = dir === 'hinder' && mix >= 1 ? rows[3] : rows.find((r) => mag <= r.upTo + 1e-9) ?? rows[rows.length - 1];
  return { ...base, dir, level: row.level, key: dir, rescue: dir === 'help' ? 1 : round3(1 + tilt.s),
    measured: { off: ELO_LEVELS.measured.off, at: row.at } };
}
