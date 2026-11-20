// shared/elo.js — the ELO room option's computation (docs/history/0.4.0.md §37.273 / §37.275; shared/experimental.js
// isEloRoom): a player's own recent matches → their weighted wins and games → the shrunk win rate → the tilt's strength
// and parameters → the level the player is shown. Shared on purpose (the owner, 2026-11-20: every player sees their own
// win rate and the expected impact before it affects them): the room's panel (public/js/ui/eloPanel.js) and the server's
// tilt (server/match/Match.js, tilt.js) run the same eloSummary, so what a player reads is what the server does — and a
// later step will run it on server-signed match receipts instead of the page's own records (the owner: ELO does not ship
// before those exist). How a tilt weighs a draw and every random stream stay in server/match/tilt.js.

import { DIFFICULTIES } from './constants.js';
import { N_ } from './i18n.js';

/**
 * room.elo: per mode and difficulty the newest `last` matches that count; `rounds`: the largest roundsPassed an entry may
 * carry; `keys`: one list per mode and difficulty at most.
 */
export const ELO_LIMITS = Object.freeze({ last: 30, keys: 2 * DIFFICULTIES.length, rounds: 30 });
/** `<mode>:<difficulty>` of a room (the key of room.elo `rec`). @param {string} mode @param {string} difficulty */
export const eloKey = (mode, difficulty) => `${mode}:${difficulty}`;
const ELO_KEYS = new Set(['solo', 'coop'].flatMap((mode) => DIFFICULTIES.map((d) => eloKey(mode, d))));
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
/** One match on the wire: `[won (1 | 0), roundsPassed]`. */
export const isEloEntry = (v) => Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) && isInt(v[1], 0, ELO_LIMITS.rounds);
/** One mode and difficulty's matches on the wire, newest first: at most ELO_LIMITS.last entries. */
export const isEloEntries = (v) => Array.isArray(v) && v.length <= ELO_LIMITS.last && v.every(isEloEntry);
/** Structural check of room.elo `rec`: `{ '<mode>:<difficulty>': [[won, roundsPassed], …] }`. */
export const isEloRecords = (v) => isPlain(v) && Object.keys(v).length <= ELO_LIMITS.keys
  && Object.entries(v).every(([k, list]) => ELO_KEYS.has(k) && isEloEntries(list));
/**
 * The matches a match of a room of `mode` and `difficulty` takes from a seat's `rec` (a frozen copy), null when it has
 * none. @param {any} rec @param {string} mode @param {string} difficulty
 */
export function eloEntriesOf(rec, mode, difficulty) {
  const list = isEloRecords(rec) ? rec[eloKey(mode, difficulty)] : undefined;
  return list ? Object.freeze(list.map((e) => Object.freeze([e[0], e[1]]))) : null;
}

/**
 * THE mapping (the owner 2026-11-20: 「把每个人的胜率往 50% 拉」; hindering is strong, so its ramp is gentle; helping goes to
 * M = 8; weights may reach 0 for a player who wins too much). From a player's own matches (eloSummary):
 *   lossRounds a win counts 1 game; a loss counts min(1, roundsPassed / lossRounds) — a quick loss weighs little (the
 *             owner: five losses in the first rounds must not mean full help); 10 of the 14 rounds count fully
 *   minGames  fewer weighted games → no tilt (s = 0)
 *   prior     the rate w = (wins + prior) / (games + 2 · prior) over the weighted games: shrunk towards 50 % (+2 wins
 *             +2 losses)
 *   help      w < 0.5: s = (0.5 − w) / (0.5 − full), at most 1 (w ≤ 0.3: s = +1), base M = m (8), no floor
 *   hinder    w > 0.5: s = −(w − 0.5) / (full − 0.5), at least −1 (w ≥ 0.9), base M = m (4); from `floorFrom` on the key
 *             cards (relevance ≥ 0.5) also slide to weight 0 — `mix` = (w − floorFrom) / (floorFull − floorFrom): none up
 *             to 0.8, all of the way (such a card is never dealt to the player) from 0.9
 *   rescue    an AI teammate rescues a player of s ≥ 0 always (§37.274), one of s < 0 with chance 1 + s (s = −1: never)
 * The tier lever stays off (the shop's tier odds are on screen).
 */
export const ELO_MAP = Object.freeze({
  lossRounds: 10, minGames: 5, prior: 2,
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

/** A match's weight: 1 for a win, min(1, roundsPassed / ELO_MAP.lossRounds) for a loss. @param {boolean} won @param {number} rounds */
export const eloWeight = (won, rounds) => (won ? 1 : Math.min(1, Math.max(0, Number(rounds) || 0) / ELO_MAP.lossRounds));

/**
 * THE computation, the panel's and the server's: a player's matches → `{ n, wins, losses, games, w, s, tilt }`. `entries`:
 * newest first, each `{ victory, roundsPassed, mode?, difficulty? }` (a page's records, later a server's receipts) or a
 * wire entry `[won, roundsPassed]` (room.elo); `mode` / `difficulty` given: only the entries of that mode and difficulty.
 * The newest ELO_LIMITS.last count. `n` matches, `wins` / `losses` of them, `games` their weighted count (eloWeight), `w`
 * the shrunk rate (null below ELO_MAP.minGames weighted games), `s` the strength (0 without a tilt), `tilt` the options
 * server/match/tilt.js setTilt takes (eloTiltAt; null: none).
 * @param {any[]} entries @param {{ mode?: string, difficulty?: string }} [scope]
 */
export function eloSummary(entries, { mode = null, difficulty = null } = {}) {
  let n = 0, wins = 0, games = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (n >= ELO_LIMITS.last) break;
    const wire = Array.isArray(e);
    if (!wire && (!e || typeof e !== 'object')) continue;
    if (!wire && ((mode && e.mode !== mode) || (difficulty && e.difficulty !== difficulty))) continue;
    const won = wire ? e[0] === 1 : e.victory === true;
    n++;
    if (won) wins++;
    games += eloWeight(won, wire ? e[1] : e.roundsPassed);
  }
  games = Math.round(games * 1000) / 1000;
  const w = games >= ELO_MAP.minGames ? (wins + ELO_MAP.prior) / (games + 2 * ELO_MAP.prior) : null;
  const tilt = w == null ? null : eloTiltAt(w);
  return { n, wins, losses: n - wins, games, w, s: tilt ? tilt.s : 0, tilt };
}

/** The tilt of a player's matches (eloSummary), or null: no tilt. @param {any[]} entries */
export const eloTilt = (entries) => eloSummary(entries).tilt;

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
 * What the ELO option does to a player (eloSummary's result — or its matches, summed here): the summary with `raw` (wins /
 * n, null without matches), `dir` 'help' | 'none' | 'hinder', `level` (0 when none), `key` ('few' | 'even' | 'help' |
 * 'hinder'), `rescue` (an AI teammate's chance to rescue the player, 0 … 1) and `measured` ({ off, at } of the level).
 * @param {any} summary
 */
export function eloImpact(summary) {
  const x = summary && !Array.isArray(summary) && typeof summary === 'object' && 'games' in summary ? summary : eloSummary(summary);
  const { tilt } = x;
  const base = { ...x, raw: x.n ? x.wins / x.n : null };
  if (!tilt) {
    return { ...base, dir: 'none', level: 0, key: x.w == null ? 'few' : 'even', rescue: 1, measured: { off: ELO_LEVELS.measured.off, at: ELO_LEVELS.measured.off } };
  }
  const dir = tilt.s > 0 ? 'help' : 'hinder';
  const rows = ELO_LEVELS[dir], mag = Math.abs(tilt.s);
  const mix = /** @type {{ mix?: number }} */ (tilt).mix ?? 0;
  const row = dir === 'hinder' && mix >= 1 ? rows[3] : rows.find((r) => mag <= r.upTo + 1e-9) ?? rows[rows.length - 1];
  return { ...base, dir, level: row.level, key: dir, rescue: dir === 'help' ? 1 : round3(1 + tilt.s),
    measured: { off: ELO_LEVELS.measured.off, at: row.at } };
}
