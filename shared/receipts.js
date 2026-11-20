// shared/receipts.js — server-signed match receipts and the browser's identity token (docs/history/0.4.0.md §37.276):
// their wire formats, structural parsing (no key here: the server checks the MAC, server/resultReceipts.js and
// server/identity.js) and what the page and the server count from a list of them. Shared on purpose: the page reads
// its own receipts (ui/receipts.js: the 已核验 mark, the ELO panel, the 名片 trophies) with the very parser and the
// very counting the server runs on the receipts it verified.
//
// Identity token (the owner, 2026-11-20: 「按 cookie 加导出带身份的方案」; the server signs and stores nothing):
//   id1.<k>.<id>.<sub>.<iat>.<mac>
//   k    the identity key's generation label · id the browser's random id (16 bytes, base64url) — never in a receipt,
//        never logged · sub = HMAC(identity key, 'sub|' + id), its first 16 bytes (base64url): the pseudonym receipts
//        carry, computed when the identity is born and carried from then on, so a key rotation never changes it ·
//        iat the time it was (re-)signed, ms · mac HMAC-SHA256 of everything before it under generation k
// Receipt (one per human seat that saw its match's settlement; never for a test match or a quit):
//   rc1.<k>.<sub>.<rec>.<mode>.<diff>.<ver>.<w>.<rp>.<tr>.<ai>.<mod>.<elo>.<at>.<mac>
//   k the receipt key's generation · sub the seat's identity · rec the match (12 random bytes, the same on every seat's
//   receipt of it) · mode 'solo' | 'coop' · diff the difficulty · ver the official version id · w 1 = the player's own
//   row won (m.result players[].victory) · rp its roundsPassed · tr its trophies · ai 1 = an AI took the seat over ·
//   mod 1 = the room played gameplay plugins · elo 1 = the room had the ELO option · at the time it was signed, ms ·
//   mac HMAC-SHA256 of everything before it under generation k
// Every field has one spelling (the regexes below): a string that parses is canonical, so the MAC covers exactly it.

import { DIFFICULTIES } from './constants.js';
import { ELO_LIMITS, eloKey } from './elo.js';
import { versionById } from './versions.js';

/**
 * Bounds: `chars` the longest receipt or token; `elo` receipts room.elo carries (one mode and difficulty's newest);
 * `trophies` receipts room.trophies carries; `verify` receipts one rc.verify asks about.
 */
export const RECEIPT_LIMITS = Object.freeze({ chars: 256, elo: ELO_LIMITS.last, trophies: 150, verify: 100, rounds: 99, trophyMax: 99 });
/** The identity cookie: `__Host-` + Secure on https, a plain name on LAN http (HttpOnly, SameSite=Lax, Path=/). */
export const ID_COOKIE = Object.freeze({ secure: '__Host-sp_id', plain: 'sp_id', maxAgeSec: 400 * 24 * 3600 });
/**
 * The seasons whose 名片 trophies the server counts from presented receipts only (the owner, 2026-11-20: 三期 — 规程; the
 * 二期 trophies stay the page's own count).
 */
export const RECEIPT_TROPHY_SEASONS = Object.freeze(new Set(['act3autochess']));

const LABEL = /^[A-Za-z0-9_-]{1,16}$/;
// 16 bytes in base64url: 21 free characters and a last one of 2 significant bits
const B16 = /^[A-Za-z0-9_-]{21}[AQgw]$/;
// 12 bytes: 16 characters, no padding bits
const B12 = /^[A-Za-z0-9_-]{16}$/;
// 32 bytes (HMAC-SHA256): 42 free characters and a last one of 4 significant bits
const MAC = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TIME = /^(?:0|[1-9]\d{0,15})$/;
const SMALL = /^(?:0|[1-9]\d?)$/;
const BIT = /^[01]$/;
const VER = /^[a-z0-9]{1,32}(?:@[A-Za-z0-9_]{1,16})?$/;

/** @param {unknown} s @param {number} n @returns {string[] | null} the dotted parts (exactly n) of a bounded string */
function partsOf(s, n) {
  if (typeof s !== 'string' || s.length > RECEIPT_LIMITS.chars) return null;
  const parts = s.split('.');
  return parts.length === n ? parts : null;
}

/**
 * The fields of an identity token, or null when it is not one (structure only: the server checks the MAC).
 * @param {unknown} s
 * @returns {{ k: string, id: string, sub: string, iat: number, body: string, mac: string } | null}
 */
export function parseIdToken(s) {
  const p = partsOf(s, 6);
  if (!p || p[0] !== 'id1' || !LABEL.test(p[1]) || !B16.test(p[2]) || !B16.test(p[3]) || !TIME.test(p[4]) || !MAC.test(p[5])) return null;
  const iat = Number(p[4]);
  if (!Number.isSafeInteger(iat)) return null;
  return { k: p[1], id: p[2], sub: p[3], iat, body: p.slice(0, 5).join('.'), mac: p[5] };
}

/** The body an identity token's MAC covers. @param {{ k: string, id: string, sub: string, iat: number }} f */
export const idTokenBody = (f) => ['id1', f.k, f.id, f.sub, f.iat].join('.');

/**
 * @typedef {{ k: string, sub: string, rec: string, mode: 'solo' | 'coop', diff: string, ver: string, w: 0 | 1, rp: number,
 *   tr: number, ai: 0 | 1, mod: 0 | 1, elo: 0 | 1, at: number }} ReceiptFields
 */

/**
 * The fields of a receipt, or null when it is not one (structure only: the server checks the MAC).
 * @param {unknown} s
 * @returns {(ReceiptFields & { body: string, mac: string }) | null}
 */
export function parseReceipt(s) {
  const p = partsOf(s, 15);
  if (!p || p[0] !== 'rc1' || !LABEL.test(p[1]) || !B16.test(p[2]) || !B12.test(p[3]) || (p[4] !== 'solo' && p[4] !== 'coop')
    || !DIFFICULTIES.includes(p[5]) || !VER.test(p[6]) || !BIT.test(p[7]) || !SMALL.test(p[8]) || !SMALL.test(p[9])
    || !BIT.test(p[10]) || !BIT.test(p[11]) || !BIT.test(p[12]) || !TIME.test(p[13]) || !MAC.test(p[14])) return null;
  const at = Number(p[13]);
  if (!Number.isSafeInteger(at)) return null;
  const bit = (v) => /** @type {0 | 1} */ (v === '1' ? 1 : 0);
  return { k: p[1], sub: p[2], rec: p[3], mode: /** @type {'solo' | 'coop'} */ (p[4]), diff: p[5], ver: p[6], w: bit(p[7]),
    rp: Number(p[8]), tr: Number(p[9]), ai: bit(p[10]), mod: bit(p[11]), elo: bit(p[12]), at, body: p.slice(0, 14).join('.'), mac: p[14] };
}

/** The body a receipt's MAC covers (its fields in their one spelling). @param {ReceiptFields} f */
export const receiptBody = (f) => ['rc1', f.k, f.sub, f.rec, f.mode, f.diff, f.ver, f.w, f.rp, f.tr, f.ai, f.mod, f.elo, f.at].join('.');

/** A receipt string (structure). */
export const isReceipt = (v) => parseReceipt(v) !== null;
/** A list of at most `max` strings of a receipt's length (structure; each one is parsed where it is used). */
export const isReceiptList = (max) => (v) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= RECEIPT_LIMITS.chars);

/** The season of a receipt's version (shared/versions.js), null for an unknown one. @param {{ ver: string }} r */
export const receiptSeason = (r) => versionById(r.ver)?.season ?? null;

/**
 * Newest first, one per match: the receipts (parsed) sorted by `at`, a match (`rec`) listed twice taken once.
 * @template {{ rec: string, at: number }} T @param {T[]} list @returns {T[]}
 */
export function receiptsByMatch(list) {
  const seen = new Set();
  return [...list].sort((a, b) => b.at - a.at).filter((r) => (seen.has(r.rec) ? false : (seen.add(r.rec), true)));
}

/**
 * What the ELO option takes from receipts (parsed, already verified on the server): the ones of identity `sub`, one
 * mode, difficulty and version, never an AI-taken seat or a gameplay-plugin match — per `<mode>:<difficulty>:<version>` the newest
 * ELO_LIMITS.last as wire entries `[won, roundsPassed]` (shared/elo.js eloSummary).
 * @param {ReceiptFields[]} list @param {string | null} sub
 * @returns {Record<string, Array<[number, number]>>}
 */
export function eloReceiptEntries(list, sub) {
  /** @type {Record<string, Array<[number, number]>>} */
  const out = {};
  if (typeof sub !== 'string') return out;
  for (const r of receiptsByMatch(list.filter((r) => r && r.sub === sub && r.ai === 0 && r.mod === 0))) {
    const key = eloKey(r.mode, r.diff, r.ver);
    const entries = out[key] || (out[key] = []);
    if (entries.length < ELO_LIMITS.last) entries.push([r.w, Math.min(ELO_LIMITS.rounds, r.rp)]);
  }
  return out;
}

/**
 * The 名片 trophies of a season counted from receipts (parsed, already verified): of any identity (an imported file's
 * too: the owner, 2026-11-20), one per match, never a gameplay-plugin match.
 * @param {ReceiptFields[]} list @param {string} season
 */
export function receiptTrophies(list, season) {
  let n = 0;
  for (const r of receiptsByMatch(list.filter((r) => r && r.mod === 0 && receiptSeason(r) === season))) n += r.tr;
  return n;
}
