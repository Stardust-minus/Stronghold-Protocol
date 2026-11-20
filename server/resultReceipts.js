// server/resultReceipts.js — server-signed match receipts (docs/history/0.4.0.md §37.276; the owner's decisions of
// 2026-11-20): at every match end (Lobby.onMatchEnd — the standalone server's and a cluster coordinator's, which runs the
// same function) each human seat that saw the settlement — not a test match, not a seat that left — gets a receipt of its
// own row (shared/receipts.js: sub, the match, mode, difficulty, version, won, rounds passed, trophies, AI takeover,
// gameplay plugins, the ELO option, the time) signed with HMAC-SHA256 under the receipt key (SP_RESULT_KEY_FILE, two
// generations: server/identity.js loadKeyring). It goes to that player alone as `m.receipt { rc }` and into the room's
// result replay; m.result itself is unchanged. The page keeps it on its record (ui/stats.js `rc`) and presents it:
//   * room.elo `rc` — help (s > 0) only from verified receipts of the session's own identity; the page's own list may
//     only make it harder (eloTrustedRec);
//   * room.trophies `rc` — the 名片 trophies of the 规程 season (RECEIPT_TROPHY_SEASONS), of any identity;
//   * rc.verify `rc` — which of them verify (the 已核验 mark).
// Nothing is stored: a receipt is checked when it is presented. Logs and /healthz get aggregate counts only, never a
// receipt, a sub or a token.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eloTrusted, isEloKey } from '../shared/elo.js';
import { RECEIPT_LIMITS, eloReceiptEntries, parseReceipt, receiptBody } from '../shared/receipts.js';
import { DEFAULT_VERSION, versionById } from '../shared/versions.js';

const mac = (key, body) => createHmac('sha256', key).update(body).digest('base64url');
const sameMac = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bit = (v) => (v ? 1 : 0);
const small = (v) => Math.max(0, Math.min(RECEIPT_LIMITS.rounds, Math.round(Number(v) || 0)));

/**
 * The receipt authority: sign and verify. @param {{ keys: import('./identity.js').Keyring, now?: () => number }} opts
 */
export function createReceipts({ keys, now = Date.now }) {
  if (!keys || !keys.keys?.get(keys.k)) throw new TypeError('receipts: a key ring is required');
  const counts = { issued: 0, checked: 0, valid: 0, invalid: 0 };

  /**
   * One receipt. @param {{ sub: string, rec: string, mode: string, diff: string, ver: string, w: boolean, rp: number,
   *   tr: number, ai: boolean, mod: boolean, elo: boolean }} f @returns {string | null} null: a field it cannot carry
   */
  function issue(f) {
    const fields = { k: keys.k, sub: f.sub, rec: f.rec, mode: f.mode, diff: f.diff, ver: f.ver, w: bit(f.w), rp: small(f.rp),
      tr: small(f.tr), ai: bit(f.ai), mod: bit(f.mod), elo: bit(f.elo), at: now() };
    const body = receiptBody(/** @type {any} */ (fields));
    const rc = `${body}.${mac(keys.keys.get(keys.k), body)}`;
    if (!parseReceipt(rc)) return null;
    counts.issued++;
    return rc;
  }

  /** The fields of a receipt whose MAC holds under an accepted generation, else null. @param {unknown} rc */
  function verify(rc) {
    counts.checked++;
    const f = parseReceipt(rc);
    const key = f ? keys.keys.get(f.k) : null;
    if (!f || !key || !sameMac(mac(key, f.body), f.mac) || f.at > now() + 60_000 || !versionById(f.ver)) { counts.invalid++; return null; }
    counts.valid++;
    return f;
  }

  /** The receipts of a list that verify (bounded by the caller's schema). @param {unknown} list */
  const verifyAll = (list) => (Array.isArray(list) ? list : []).map(verify).filter(Boolean);

  return Object.freeze({ issue, verify, verifyAll,
    /** /healthz: aggregate counts only */
    stats: () => ({ keys: keys.ephemeral ? 'ephemeral' : 'file', generations: keys.keys.size, ...counts }) });
}

/** A match's receipt id: 12 random bytes, the same on every seat's receipt of that match. */
export const newMatchRef = () => randomBytes(12).toString('base64url');

/**
 * The receipts of a match end (Lobby.onMatchEnd): playerId → receipt, for each human row of the settlement (`summary`:
 * m.result without `t`) whose seat is still in the room, not departed, and whose session has an identity. None for a
 * test match or a room without the authority.
 * @param {ReturnType<typeof createReceipts> | null} receipts
 * @param {{ summary: any, room: any, subOf: (playerId: string) => string | null }} args
 * @returns {Map<string, string>}
 */
export function matchReceipts(receipts, { summary, room, subOf }) {
  const out = new Map();
  const rows = Array.isArray(summary?.players) ? summary.players : [];
  if (!receipts || !rows.length || summary.test === true || room.test === true) return out;
  const diff = typeof summary.difficulty === 'string' ? summary.difficulty : room.difficulty;
  const ver = typeof summary.version === 'string' ? summary.version : room.version || DEFAULT_VERSION;
  const rec = newMatchRef();
  for (const row of rows) {
    if (!row || row.isBot || row.left === true || typeof row.playerId !== 'string') continue;
    const seat = room.seatOf(row.playerId);
    if (!seat || seat.isBot || seat.left) continue;
    const sub = subOf(row.playerId);
    if (typeof sub !== 'string') continue;
    const rc = receipts.issue({ sub, rec, mode: room.mode, diff, ver, w: row.victory === true, rp: row.roundsPassed, tr: row.trophies,
      ai: Number.isInteger(row.aiTakeoverRound), mod: !!room.modded, elo: room.experimental?.elo === true });
    if (rc) out.set(row.playerId, rc);
  }
  return out;
}

/**
 * room.elo with receipts (the owner, 2026-11-20: help only from receipts; a page's own list may only push lower — the
 * minimum of the two): per mode, difficulty and version the list a match takes (server/match/Match.js runs eloSummary on it) —
 * shared/elo.js eloTrusted, the ELO panel's own choice: the verified receipts' entries, unless the page's own list (`rec`)
 * gives a stronger hindrance.
 * @param {Record<string, readonly (readonly number[])[]>} rec the page's own lists (shared/elo.js isEloRecords)
 * @param {import('../shared/receipts.js').ReceiptFields[]} verified the receipts that verified, of any identity
 * @param {string | null} sub the session's identity
 * @returns {Record<string, Array<[number, number]>>}
 */
export function eloTrustedRec(rec, verified, sub) {
  const mine = eloReceiptEntries(verified, sub);
  const out = {};
  // a key without its version (a page of the build before) never counts: its matches' version is unknown
  for (const key of new Set([...Object.keys(rec || {}), ...Object.keys(mine)].filter(isEloKey))) {
    const own = /** @type {Array<[number, number]>} */ ((rec?.[key] || []).map((e) => [e[0], e[1]]));
    out[key] = eloTrusted(own, mine[key] || []).entries;
  }
  return out;
}
