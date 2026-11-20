// ui/receipts.js — the page's side of the match receipts and the identity cookie (docs/history/0.4.0.md §37.276;
// shared/receipts.js the formats, server/resultReceipts.js / server/identity.js the server's side):
//   * id.token (after every welcome): this browser's identity token — the page keeps it in memory only, to write it into a
//     stats export (ui/stats.js exportStats) and to compare an imported file's (screens/stats.js); `fresh` (the socket came
//     without a valid cookie): the page stores it as its cookie at once (POST /api/identity).
//   * m.receipt: the player's own receipt of a match that just ended, onto that match's stored record (ui/stats.js
//     recordReceipt; kept pending a moment when its m.result is not recorded yet — a cluster's frames may cross).
//   * the 已核验 mark: which records' receipts the server confirms (rc.verify, asked for the receipts on screen, cached
//     for the page's life); a receipt the server just sent is one.
//   * the 规程 名片 trophies (room.trophies): the receipts of that season with trophies, after each welcome and whenever they
//     change — the server shows on the seat card what it counts of them; the page's own card counts them the same way
//     (cardTrophies, shared/receipts.js receiptTrophies).
//   * ELO (ui/loadoutSync.js installEloSync, ui/eloPanel.js): the receipts of this identity for room.elo `rc`
//     (eloReceipts) and the panel's lists (eloReceiptLists).
// Switching identity (adoptIdentity): POST the token, then a fresh socket, whose upgrade carries the new cookie.

import { createStore, useStore } from '../store.js';
import { RECEIPT_LIMITS, RECEIPT_TROPHY_SEASONS, eloReceiptEntries, parseIdToken, parseReceipt, receiptSeason, receiptTrophies, receiptsByMatch } from '../../../shared/receipts.js';
import { eloKey } from '../../../shared/elo.js';
import { recordReceipt } from './stats.js';

/** POST /api/identity (server/identity.js IDENTITY_PATH). */
export const IDENTITY_PATH = '/api/identity';

/** This browser's identity as the server last told it (id.token): the token and its pseudonym `sub`; null before. */
export const idStore = createStore({ token: /** @type {string | null} */ (null), sub: /** @type {string | null} */ (null) });
/** Bumped whenever what the receipts count may have changed (a receipt stored, an import, another identity). */
export const receiptRev = createStore({ rev: 0 });
export const bumpReceipts = () => receiptRev.set({ rev: receiptRev.get().rev + 1 });

/** @type {Map<string, 0 | 1>} receipt → whether the server confirmed it (the page's life) */
const verified = new Map();
export const verifyStore = createStore({ rev: 0 });
/** @type {string[]} receipts whose record was not stored yet */
let pending = [];

/** The parsed receipts of records (each record's own), newest first, one per match. @param {any[]} records */
export function recordReceipts(records) {
  const out = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const r = rec && typeof rec.rc === 'string' ? parseReceipt(rec.rc) : null;
    if (r) out.push({ ...r, rc: rec.rc });
  }
  return receiptsByMatch(out);
}

/**
 * room.elo `rc`: the receipts of this identity for a room of `mode`, `difficulty` and `version` (newest first, at most
 * RECEIPT_LIMITS.elo; never an AI-taken seat or a gameplay-plugin match — what the server takes of them).
 * @param {any[]} records @param {string} mode @param {string} difficulty @param {string} version @param {string | null} [sub]
 */
export function eloReceipts(records, mode, difficulty, version, sub = idStore.get().sub) {
  if (!sub) return [];
  return recordReceipts(records).filter((r) => r.sub === sub && r.mode === mode && r.diff === difficulty && r.ver === version && r.ai === 0 && r.mod === 0)
    .slice(0, RECEIPT_LIMITS.elo).map((r) => r.rc);
}

/** The ELO entries of this identity's receipts, per `<mode>:<difficulty>:<version>` (shared/receipts.js eloReceiptEntries). @param {any[]} records */
export const eloReceiptLists = (records, sub = idStore.get().sub) => eloReceiptEntries(recordReceipts(records), sub);
/** One mode, difficulty and version's of them. */
export const eloReceiptList = (records, mode, difficulty, version, sub = idStore.get().sub) => eloReceiptLists(records, sub)[eloKey(mode, difficulty, version)] || [];

/** room.trophies `rc`: the receipts of the server-counted seasons with trophies, newest first, at most RECEIPT_LIMITS.trophies. @param {any[]} records */
export function trophyReceipts(records) {
  return recordReceipts(records).filter((r) => r.tr > 0 && r.mod === 0 && RECEIPT_TROPHY_SEASONS.has(receiptSeason(r) ?? ''))
    .slice(0, RECEIPT_LIMITS.trophies).map((r) => r.rc);
}

/**
 * The 名片 trophies of a season (ui/playerCard.js): in a season the server counts from receipts (规程) the same count of
 * the records' receipts — any identity's, one per match —, else null (the page's own count applies).
 * @param {any[]} records @param {string | null} season
 */
export function cardTrophies(records, season) {
  if (!season || !RECEIPT_TROPHY_SEASONS.has(season)) return null;
  return receiptTrophies(recordReceipts(records), season);
}

/** A receipt of the server onto its record (m.receipt): stored now, else kept for the next recorded result. @param {unknown} rc */
export function takeReceipt(rc) {
  if (typeof rc !== 'string' || !parseReceipt(rc)) return false;
  verified.set(rc, 1); // the server sent it just now
  if (recordReceipt(rc)) { pending = pending.filter((x) => x !== rc); bumpReceipts(); return true; }
  if (!pending.includes(rc)) pending = [...pending, rc].slice(-8);
  return false;
}

/** After a result was recorded (main.js m.result): the receipts that were waiting for it. */
export function retryReceipts() {
  if (!pending.length) return;
  const left = pending.filter((rc) => !recordReceipt(rc));
  const stored = left.length !== pending.length;
  pending = left;
  if (stored) bumpReceipts();
}

/** Whether the server confirmed a receipt: 1, 0, or undefined (not asked yet). @param {string | null | undefined} rc */
export const receiptVerified = (rc) => (rc ? verified.get(rc) : undefined);
/** The same, re-read when answers arrive. */
export const useReceiptVerified = (rc) => useStore(() => receiptVerified(rc), Object.is, verifyStore);

/**
 * Ask the server about receipts it has not answered for yet (rc.verify, RECEIPT_LIMITS.verify at a time). Failures leave
 * them unasked (no mark). @param {{ request: Function, status?: string }} net @param {string[]} list
 */
export async function verifyReceipts(net, list) {
  const ask = [...new Set(list.filter((rc) => typeof rc === 'string' && parseReceipt(rc) && !verified.has(rc)))];
  if (!ask.length || !net || net.status !== 'online') return;
  for (let i = 0; i < ask.length; i += RECEIPT_LIMITS.verify) {
    const chunk = ask.slice(i, i + RECEIPT_LIMITS.verify);
    let answer;
    try { answer = await net.request('rc.verify', { rc: chunk }); } catch { return; }
    const valid = Array.isArray(answer?.valid) ? answer.valid : [];
    chunk.forEach((rc, j) => { if (valid[j] === 1 || valid[j] === 0) verified.set(rc, valid[j]); });
    verifyStore.set({ rev: verifyStore.get().rev + 1 });
  }
}

/**
 * Store a token as this browser's identity cookie (POST /api/identity: the server checks it and sets the cookie).
 * @param {string} token @param {(url: string, init: any) => Promise<any>} [doFetch] @returns {Promise<boolean>}
 */
export async function postIdentity(token, doFetch = (...a) => globalThis.fetch(...a)) {
  try {
    const res = await doFetch(IDENTITY_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }) });
    return !!res && res.status === 204;
  } catch { return false; }
}

/**
 * Switch this browser to an imported identity (the player said yes): the cookie, then a fresh socket — the session takes
 * the identity its upgrade carries. @param {{ reconnectNow?: Function }} net @param {string} token
 */
export async function adoptIdentity(net, token, doFetch) {
  if (!parseIdToken(token) || !(await postIdentity(token, doFetch))) return false;
  try { net?.reconnectNow?.(); } catch { /* the next connection picks it up */ }
  return true;
}

/** Is `token` (an imported file's) another identity than this browser's? Unknown current: yes. @param {string | null} token */
export function otherIdentity(token) {
  const f = parseIdToken(token);
  return !!f && f.sub !== idStore.get().sub;
}

/**
 * Wire it to the connection (main.js): id.token, m.receipt, and the 规程 trophies' room.trophies after each welcome and
 * whenever the receipts change. @param {{ net: any, records: () => any[], timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 */
export function installReceipts({ net, records, timers, doFetch }) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null, lastSent = null, everSent = false, retries = 0;
  const flush = async () => {
    timer = null;
    if (net.status !== 'online') return;
    let list;
    try { list = trophyReceipts(records()); } catch { return; }
    const json = JSON.stringify(list);
    if (json === lastSent || (!list.length && !everSent)) return;
    lastSent = json;
    try { await net.request('room.trophies', { rc: list }); everSent ||= list.length > 0; retries = 0; } catch (err) {
      lastSent = null;
      // a full heavy-message budget (RATE) or a lost reply: again a little later; a refusal of the content stays refused
      if (['RATE', 'TIMEOUT', 'OFFLINE', 'DISCONNECTED'].includes(err?.code) && retries++ < 5) schedule(2000);
    }
  };
  const schedule = (ms = 300) => { T.clearTimeout(timer); timer = T.setTimeout(() => { void flush(); }, ms); };
  const offs = [
    net.on('id.token', (msg) => {
      const f = parseIdToken(msg?.token);
      if (!f) return;
      const changed = idStore.get().sub !== f.sub;
      idStore.set({ token: msg.token, sub: f.sub });
      if (msg.fresh === true) void postIdentity(msg.token, doFetch);
      if (changed) bumpReceipts();
    }),
    net.on('m.receipt', (msg) => { takeReceipt(msg?.rc); }),
    net.on('welcome', () => { lastSent = null; schedule(400); }),
    receiptRev.subscribe(() => schedule()),
  ];
  return () => { T.clearTimeout(timer); for (const off of offs) off?.(); };
}
