// ui/gameLogic/predict.js — what an accepted prep intent does to the own m.private, for the client-side prediction
// (rel26, the owner's request of 2026-11-02: 商店购买、出售、部署、刷新 must not wait for the server under a high RTT or
// packet loss). ui/prediction.js applies these at once and replays them over every authoritative m.private until its
// `ack` (shared/protocol.js ACKED_INTENTS) names them; the server stays the only authority — a refused or different
// outcome is simply replaced by the next m.private.
//
// Only the DIRECT effects are predicted, mirroring server/match/player/economy.js (buy, sell, refresh, freeze, levelUp)
// and placement.js (move): funds, the shop slots (a level-up's new empty ones too, from m.private shop.next), the hand /
// temp / board pieces, the deploy count. What the server derives from them (bonds, effects, the layer forecast, summons
// granted on a deployment, pieces an effect grants, stats) and what needs its RNG (the cards a refresh rolls) stays as it
// was until the server's state lands — one RTT later.
// An intent whose outcome this cannot tell for sure returns null and is not predicted (it still goes to the server), or
// only its payment is: a buy that completes a merge (the elite, its tile, the 晋升奖励 offer; a golden item), a sale whose
// returned equipment would not fit the hand or would merge, a move of a summon or of an operator with summons, a move
// onto a summon or a device.
//
// A piece bought by prediction has no server uid yet: it gets a negative placeholder uid (ui/prediction.js defers any
// intent naming it until the purchase is acknowledged and the real uid is known).

import { GEO } from '../../../../shared/constants.js';
import { handFull, completesMerge } from './shop.js';

/** The intents predicted here (the server acknowledges the same set: shared/protocol.js ACKED_INTENTS). */
export const PREDICTABLE = Object.freeze(['g.buy', 'g.sell', 'g.move', 'g.freeze', 'g.levelUp', 'g.refresh']);
const PREDICT_SET = new Set(PREDICTABLE);
export const isPredictable = (t) => PREDICT_SET.has(t);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const DIRS = new Set(['UP', 'RIGHT', 'DOWN', 'LEFT']);

/** A copy of the parts of m.private an intent may change (pieces are replaced, never edited in place). */
function cloneView(priv) {
  const shop = isObj(priv.shop) ? { ...priv.shop, slots: list(priv.shop.slots).slice() } : priv.shop;
  return { ...priv, shop, hand: list(priv.hand).slice(), temp: list(priv.temp).slice(), board: list(priv.board).slice() };
}

/** Where piece `uid` is: { area: 'hand'|'temp'|'board', idx, piece } or null. */
export function findPiece(priv, uid) {
  for (const area of ['hand', 'temp', 'board']) {
    const arr = list(priv?.[area]);
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].uid === uid) return { area, idx: i, piece: arr[i] };
  }
  return null;
}

/** Every piece uid of a view (hand, temp, board and the equipment on them). */
export function pieceUids(priv) {
  const out = new Set();
  for (const area of ['hand', 'temp', 'board']) {
    for (const p of list(priv?.[area])) {
      if (!p) continue;
      out.add(p.uid);
      for (const it of list(p.items)) if (it) out.add(it.uid);
    }
  }
  return out;
}

const hasTokens = (priv, uid) => ['hand', 'temp', 'board'].some((a) => list(priv?.[a]).some((p) => p && p.kind === 'token' && p.ownerUid === uid));
/** server/match/board.js freeSlot: the LAST free index (stow fills the hand from the right). */
function lastFree(arr, size = arr.length) {
  for (let i = Math.min(arr.length, size) - 1; i >= 0; i--) if (arr[i] == null) return i;
  return -1;
}
/** A hand / temp copy of a piece (container pieces carry no tile or facing). */
function benchCopy(p) {
  const { row, col, dir, ...rest } = p; // eslint-disable-line no-unused-vars
  return rest;
}
/** server boardOrder: bottom row first, left to right. */
const sortBoard = (board) => board.sort((a, b) => b.row - a.row || a.col - b.col);
const boardIdx = (board, row, col) => board.findIndex((p) => p && p.row === row && p.col === col);
const chessCount = (board) => board.filter((p) => p && p.kind === 'chess').length;

/**
 * The piece a prediction puts in the hand for a bought chess (the server's pieceView shape; `predicted` marks it).
 * @param {number} uid negative placeholder
 * @param {string} id chess id
 * @param {any} rec chess record or null
 * @param {any} priv the view it joins (its skin choices)
 */
function boughtPiece(uid, id, rec, priv, kind = 'chess') {
  const p = { uid, kind, id, golden: !!rec?.isGolden, tier: Number.isInteger(rec?.tier) ? rec.tier : null, items: [], count: 1, ownerUid: null, predicted: true };
  const skin = kind === 'chess' && rec?.charId && isObj(priv?.skins) ? priv.skins[rec.charId] : null;
  if (typeof skin === 'string' && skin) p.skinId = skin;
  return p;
}

function buy(priv, { slot }, L, ph) {
  const s = list(priv.shop?.slots)[slot];
  if (!isObj(s) || s.sold) return null;
  const price = Number(s.price) || 0;
  const funds = Number(priv.funds) || 0;
  if (price > funds || handFull(priv)) return null;
  const next = cloneView(priv);
  next.funds = funds - price;
  next.shop.slots[slot] = { ...s, sold: true };
  const kind = s.kind === 'item' ? 'item' : 'chess';
  const rec = kind === 'item' ? L.getItem(s.id) : L.getChess(s.id);
  // a copy that completes a merge (acquireChess / acquireItem): the elite / golden item and where it goes are the server's
  if (!rec || completesMerge(priv, s, L)) return { priv: next };
  const idx = lastFree(next.hand, GEO.HAND_SIZE);
  if (idx < 0) return null;
  next.hand[idx] = boughtPiece(ph, s.id, rec, priv, kind);
  return { priv: next, made: { uid: ph, area: 'hand', idx, id: s.id, kind } };
}

function sell(priv, { uid }, L) {
  const loc = findPiece(priv, uid);
  if (!loc || loc.piece.kind !== 'chess') return null;
  const piece = loc.piece;
  const next = cloneView(priv);
  next[loc.area][loc.idx] = null;
  // its summons leave with it (removeTokensOf)
  for (const area of ['hand', 'temp', 'board']) next[area] = next[area].map((p) => (p && p.kind === 'token' && p.ownerUid === uid ? null : p));
  next.board = next.board.filter(Boolean);
  // its equipment goes back to the hand (stow); an item that would overflow or merge is the server's to place
  for (const it of list(piece.items)) {
    if (!it) continue;
    if (completesMerge(next, { kind: 'item', id: it.id }, L)) return null;
    const j = lastFree(next.hand, GEO.HAND_SIZE);
    if (j < 0) return null;
    const irec = L.getItem(it.id);
    next.hand[j] = { uid: it.uid, kind: 'item', id: it.id, golden: !!irec?.isGolden, tier: Number.isInteger(irec?.tier) ? irec.tier : null, items: [], count: 1, ownerUid: null };
  }
  const rec = L.getChess(piece.id);
  // gd.sellPrice: the record's own price (an effect's onSold change arrives with the server's state) [ASSUMED]
  const gain = Number.isFinite(rec?.sellPrice) && rec.sellPrice >= 0 ? Math.trunc(rec.sellPrice) : 1;
  next.funds = (Number(priv.funds) || 0) + gain;
  next.deployCount = chessCount(next.board);
  return { priv: next };
}

function move(priv, { uid, to, dir }) {
  const loc = findPiece(priv, uid);
  if (!loc || !isObj(to)) return null;
  const piece = loc.piece;
  if (piece.kind !== 'chess' || hasTokens(priv, uid)) return null;
  const next = cloneView(priv);
  const d = DIRS.has(dir) ? dir : 'RIGHT';
  if (to.area === 'board') {
    const { row, col } = to;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    const oi = boardIdx(next.board, row, col);
    const occ = oi >= 0 ? next.board[oi] : null;
    if (occ && occ.uid === uid) {
      if (!DIRS.has(dir) || occ.dir === dir) return { priv: next };
      next.board[oi] = { ...occ, dir };
      return { priv: next };
    }
    if (occ && (occ.kind !== 'chess' || hasTokens(priv, occ.uid))) return null;
    if (loc.area === 'board') {
      // board → board: move or swap (the occupant keeps its own facing)
      const src = next.board[loc.idx];
      if (occ) next.board[oi] = { ...occ, row: src.row, col: src.col };
      next.board[loc.idx] = { ...src, row, col, dir: d };
      sortBoard(next.board);
      return { priv: next };
    }
    // hand / temp → board: a chess occupant goes back to the source slot (_putBack)
    if (!occ && (Number(priv.deployCount) || 0) >= (Number(priv.deployCap) || 0)) return null;
    next[loc.area][loc.idx] = occ ? benchCopy(occ) : null;
    if (oi >= 0) next.board.splice(oi, 1);
    next.board.push({ ...benchCopy(piece), row, col, dir: d });
    sortBoard(next.board);
    next.deployCount = chessCount(next.board);
    return { priv: next };
  }
  if (to.area === 'hand') {
    const idx = to.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= GEO.HAND_SIZE) return null;
    const occ = next.hand[idx] || null;
    if (occ && occ.uid === uid) return { priv: next };
    if (loc.area === 'board') {
      const src = next.board[loc.idx];
      if (!occ) {
        next.board.splice(loc.idx, 1);
        next.hand[idx] = benchCopy(src);
      } else if (occ.kind === 'chess') {
        // withdraw onto a bench card: it takes the tile with that tile's facing
        if (hasTokens(priv, occ.uid)) return null;
        next.board[loc.idx] = { ...benchCopy(occ), row: src.row, col: src.col, dir: src.dir || 'RIGHT' };
        next.hand[idx] = benchCopy(src);
        sortBoard(next.board);
      } else {
        const j = lastFree(next.hand, GEO.HAND_SIZE);
        if (j < 0) return null;
        next.board.splice(loc.idx, 1);
        next.hand[j] = benchCopy(src);
      }
      next.deployCount = chessCount(next.board);
      return { priv: next };
    }
    // hand / temp → hand slot: move or swap (_swapContainers)
    next[loc.area][loc.idx] = occ;
    next.hand[idx] = piece;
    return { priv: next };
  }
  return null;
}

function freeze(priv) {
  if (!isObj(priv.shop)) return null;
  const next = cloneView(priv);
  const on = !priv.shop.frozen;
  next.shop.frozen = on;
  next.shop.slots = next.shop.slots.map((s) => (isObj(s) && !s.sold ? { ...s, frozen: on } : s));
  return { priv: next };
}

function levelUp(priv) {
  const shop = priv.shop;
  if (!isObj(shop)) return null;
  const level = Number(shop.level) || 1, max = Number(shop.maxLevel) || 6;
  if (level >= max) return null;
  // shop.next (views.js): what this level-up opens and costs next — without it (a second level-up before the first is
  // acknowledged) the outcome is the server's
  const nx = shop.next;
  if (!isObj(nx) || !isObj(nx.layout) || !Number.isInteger(nx.layout.chess) || !Number.isInteger(nx.layout.item)) return null;
  const price = Math.max(0, Number(shop.upgradePrice) || 0);
  const funds = Number(priv.funds) || 0;
  if (funds < price) return null;
  const next = cloneView(priv);
  next.funds = funds - price;
  next.shop.level = level + 1;
  next.shop.upgradePrice = Math.max(0, Number(nx.upgradePrice) || 0);
  next.shop.next = null;
  // _openLevelSlots: the new slots open empty, operators before the equipment column
  const lay = isObj(shop.layout) && Number.isInteger(shop.layout.chess) ? shop.layout : { chess: next.shop.slots.length, item: 0 };
  if (nx.layout.chess > lay.chess || nx.layout.item > lay.item) {
    const chess = next.shop.slots.slice(0, lay.chess), items = next.shop.slots.slice(lay.chess);
    while (chess.length < nx.layout.chess) chess.push(null); // loop-cap: shopSlots chess max 8
    while (items.length < nx.layout.item) items.push(null); // loop-cap: shopSlots item max 4
    next.shop.slots = [...chess, ...items];
    next.shop.layout = { chess: chess.length, item: items.length };
  }
  return { priv: next };
}

function refresh(priv) {
  const shop = priv.shop;
  if (!isObj(shop)) return null;
  const freeLeft = Number(shop.freeRefreshes) || 0;
  const price = freeLeft > 0 ? 0 : Number(shop.refreshPrice) || 0;
  const funds = Number(priv.funds) || 0;
  if (freeLeft <= 0 && funds < price) return null;
  const next = cloneView(priv);
  if (freeLeft > 0) next.shop.freeRefreshes = freeLeft - 1;
  else next.funds = funds - price;
  // the new cards need the server's RNG: the slots stand empty (`rolling`) until its state lands; a manual refresh
  // cancels the freeze
  next.shop.frozen = false;
  next.shop.slots = next.shop.slots.map(() => null);
  next.shop.rolling = true;
  return { priv: next };
}

/**
 * The view after one intent, or null when its outcome cannot be predicted for sure (see the header).
 * @param {any} priv m.private (authoritative or already predicted)
 * @param {{ t: string, fields?: any }} op
 * @param {{ getChess: (id: string) => any, getItem: (id: string) => any }} L data lookups
 * @param {number} [ph] the placeholder uid a predicted purchase gives its piece
 * @returns {{ priv: any, made?: { uid: number, area: string, idx: number, id: string } } | null}
 */
export function predictIntent(priv, op, L, ph = -1) {
  if (!isObj(priv) || !op) return null;
  const f = op.fields || {};
  switch (op.t) {
    case 'g.buy': return buy(priv, f, L, ph);
    case 'g.sell': return sell(priv, f, L);
    case 'g.move': return move(priv, f);
    case 'g.freeze': return freeze(priv);
    case 'g.levelUp': return levelUp(priv);
    case 'g.refresh': return refresh(priv);
    default: return null;
  }
}

/**
 * Every pending intent in order over an authoritative view. `ops[i].id` keys the placeholder each purchase made (its
 * uid is -id).
 * @param {any} auth
 * @param {{ id: number, t: string, fields?: any }[]} ops
 * @param {{ getChess: Function, getItem: Function }} L
 * @returns {{ priv: any, made: Map<number, { uid: number, area: string, idx: number, id: string }>, applied: Set<number> }}
 */
export function replayIntents(auth, ops, L) {
  let v = auth;
  const made = new Map(), applied = new Set();
  for (const op of ops) {
    const r = predictIntent(v, op, L, -op.id);
    if (!r) continue;
    v = r.priv;
    applied.add(op.id);
    if (r.made) made.set(op.id, r.made);
  }
  return { priv: v, made, applied };
}

/**
 * The server uid of a predicted purchase's piece, once a state that contains the purchase arrived: the new piece of the
 * same kind and id in the hand slot the prediction used, else the only new chess of that id anywhere; null when there is none
 * or more than one (a merge consumed it, or two such purchases landed together).
 * @param {any} auth the new authoritative view
 * @param {Set<number>} before the piece uids of the previous authoritative view
 * @param {{ idx: number, id: string }} made
 * @returns {number | null}
 */
export function resolveBought(auth, before, made) {
  const kind = made.kind || 'chess';
  const fresh = (p) => p && p.kind === kind && p.id === made.id && !before.has(p.uid);
  const at = list(auth?.hand)[made.idx];
  if (fresh(at)) return at.uid;
  const found = ['hand', 'temp', 'board'].flatMap((a) => list(auth?.[a]).filter(fresh));
  return found.length === 1 ? found[0].uid : null;
}
