// tools/rl/spec.mjs — observation and action layout of the Stronghold RL environment (route B, plan §8).
// Every feature comes from what the seat's player sees: m.publicView(), ps.privateView() and the static catalogue a
// client loads too (ids, tiers, sell prices). The one derived number is the seat strategy's bountyKillChance for a
// 机变 bounty card — the estimate the external-AI digest also hands out (server/match/aiDigest.js).
import { createHash } from 'node:crypto';
import { LEGACY_BOT } from '../../server/match/botStrategyContract.js';
import { DEFAULT_VERSION } from '../../shared/versions.js';

export const SHOP = 10, HAND = 10, TEMP = 5, BOARD = 12, OWNED = HAND + TEMP + BOARD;
export const REWARDS = 6, PERSONAL = 5, CARDS = 8, ENEMIES = 8, MATES = 3;
export const CARD_BUCKETS = 1024, STAGE_BUCKETS = 64, KIND_BUCKETS = 16;
export const MAX_PREP_ACTIONS = 40;
export const BANDS = 40; // band-choice rows / actions (ppo3, the owner's call of 11-12): catalogue order, data/bands.json

// ---- actions (one flat discrete space, masked per decision) ----
export const ACT = Object.freeze({
  END: 0, REFRESH: 1, LEVEL: 2, FREEZE: 3,
  BUY: 4, SELL: 4 + SHOP, REWARD: 4 + SHOP + OWNED, PERSONAL: 4 + SHOP + OWNED + REWARDS,
  CARD: 4 + SHOP + OWNED + REWARDS + PERSONAL,
  BAND: 4 + SHOP + OWNED + REWARDS + PERSONAL + CARDS, // appended: every earlier action keeps its index
});
export const NUM_ACTIONS = ACT.BAND + BANDS;
export function actionName(a) {
  if (a === ACT.END) return 'end'; if (a === ACT.REFRESH) return 'refresh'; if (a === ACT.LEVEL) return 'level'; if (a === ACT.FREEZE) return 'freeze';
  if (a < ACT.SELL) return `buy${a - ACT.BUY}`; if (a < ACT.REWARD) return `sell${a - ACT.SELL}`;
  if (a < ACT.PERSONAL) return `reward${a - ACT.REWARD}`; if (a < ACT.CARD) return `personal${a - ACT.PERSONAL}`;
  if (a < ACT.BAND) return `card${a - ACT.CARD}`;
  return `band${a - ACT.BAND}`;
}
export const KIND = Object.freeze({ prep: 0, card: 1, band: 2 });
const DIFFS = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];

function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
const bucket = (s, n) => (s ? 1 + (fnv(String(s)) % (n - 1)) : 0);
/** A finite number or 0 (catalogue fields can be strings: a bounty's `payout` is a mode, e.g. 'perfect'). */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * A player's main core bond as every player sees it — bot.js mainCoreBond on the public bond strip: the core bond with
 * the most counted members, at least 2 (ties: data order); null while it builds none.
 */
export function mainCoreBondOf(gd, row) {
  const counts = new Map((row?.bonds || []).map((b) => [b.bondId, b.count || 0]));
  let top = null, topN = 1;
  for (const id of gd.bondIds) { const n = counts.get(id) || 0; if (n > topN && gd.bond(id)?.isCore) { topN = n; top = id; } }
  return top;
}

/** Whether a public seat row is a human: a real one (isBot false) or one the env marks so in training. */
export const isHumanRow = (row, humans) => row.isBot === false || !!humans?.has(row.playerId);

/**
 * The owner's AI-seat rules of 2026-11-11 (plan §8.3), each mask rule switchable, all on by default; they bind the
 * policy's AI seats only (a human seat — or one under AI 托管, which legacy drives — never).
 *   yieldMain  让盟约: no operator of a living same-pool human's main core bond or opening-strategy bonds, bought or taken
 *              as a reward
 *   yieldMerge 让合成: no copy of an operator a living same-pool human holds two unmerged copies of (prep scout: board,
 *              整备区, 临时整备区), bought or taken as a reward
 * Card pools: independent pools (disableSharedPool) switch both off; a pool plan (poolGroups) limits them to the humans of
 * the seat's own group. (Buying and selling the same operator within a prep is play, not a rule: the owner withdrew
 * that one; it is only measured — env.mjs round trips.)
 */
export const RULES = Object.freeze({ yieldMain: true, yieldMerge: true });
export const rulesOf = (r) => ({ ...RULES, ...(r || {}) });

/** The living human seats this seat shares a card pool with (rule 4). */
export function poolHumans(pub, selfId, humans) {
  if (pub.experimental?.disableSharedPool) return [];
  const group = pub.poolGroups?.find((g) => g.playerIds.includes(selfId));
  return (pub.players || []).filter((p) => p.playerId !== selfId && p.alive && isHumanRow(p, humans)
    && (!group || group.playerIds.includes(p.playerId)));
}

/** 让盟约: the bonds an AI seat leaves to those humans — main core bonds (mainCoreBondOf) and opening-strategy bonds. */
export function humanBonds(gd, pub, selfId, humans) {
  const out = new Set();
  for (const p of poolHumans(pub, selfId, humans)) {
    const main = mainCoreBondOf(gd, p); if (main) out.add(main);
    for (const id of gd.bandBondIds(p.bandId)) out.add(id);
  }
  return out;
}

/**
 * 让合成: base ids those humans hold two or more unmerged copies of — what the prep scout shows (m.prepFieldMeta: the
 * board, the 整备区 and the 临时整备区, every operator by its own id). The default reads the same pieces straight off the
 * seat (the scout's unit builder costs ~10× more); `{ scout: true }` builds the scout itself, and smoke.mjs checks that
 * both agree.
 */
export function humanPairs(m, pub, selfId, humans, { scout = false } = {}) {
  const gd = m.gd, out = new Set();
  for (const row of poolHumans(pub, selfId, humans)) {
    const ps = m.players.get(row.playerId); if (!ps) continue;
    const ids = [];
    if (scout) {
      let units;
      try { units = m.prepFieldMeta(ps)?.units || []; } catch { continue; }
      for (const u of units) if (u.ownerId === row.playerId && u.kind === 'op' && u.defId) ids.push(u.defId);
    } else {
      for (const p of ps.board.values()) if (p && p.kind === 'chess') ids.push(p.id);
      for (const p of ps.hand) if (p && p.kind === 'chess') ids.push(p.id);
      for (const p of ps.temp) if (p && p.kind === 'chess') ids.push(p.id);
    }
    const n = new Map();
    for (const id of ids) { if (gd.isGolden?.(id)) continue; const b = gd.baseIdOf(id); n.set(b, (n.get(b) || 0) + 1); }
    for (const [b, k] of n) if (k >= 2) out.add(b);
  }
  return out;
}

/**
 * Band-choice conflicts for seat `selfId` (public view only): bonds tied to the bands living humans picked, humans'
 * announced 主盟约 / 副盟约 (g.bondPlan), and bonds tied to bands earlier AI seats picked (aiPicks: playerIds).
 */
export function bandConflicts(gd, pub, selfId, humans, aiPicks) {
  const out = { humanBand: new Set(), humanMain: new Set(), humanSub: new Set(), aiPick: new Set() };
  for (const p of pub.players || []) {
    if (p.playerId === selfId || !p.alive) continue;
    if (isHumanRow(p, humans)) {
      if (p.bandId) for (const b of gd.bandBondIds(p.bandId)) out.humanBand.add(b);
      if (p.bondPlan) out.humanMain.add(p.bondPlan);
      for (const b of p.bondPlanSub || []) out.humanSub.add(b);
    } else if (p.bandId && (!aiPicks || aiPicks.has(p.playerId))) for (const b of gd.bandBondIds(p.bandId)) out.aiPick.add(b);
  }
  return out;
}

/** Whether chess `id` counts for any bond of `bonds` (its catalogue bonds). */
export function chessInBonds(gd, id, bonds) {
  if (!bonds.size) return false;
  const c = gd.chess(id);
  return !!c && Array.isArray(c.bonds) && c.bonds.some((b) => bonds.has(b));
}

/** Catalogue vocabularies (0 = none / unknown). The same data version gives the same codes in every process. */
export function buildVocab(gd, version = 3) {
  const raw = gd.raw;
  const pieces = [...new Set(Object.keys(raw.chess || {}).map((id) => gd.baseIdOf(id)))].sort();
  const items = Object.keys(raw.items || {}).sort();
  const tokens = Object.keys(raw.tokens || {}).sort();
  const piece = new Map([...pieces, ...items, ...tokens].map((id, i) => [id, i + 1]));
  const enemy = new Map(Object.keys(raw.enemies || {}).sort().map((id, i) => [id, i + 1]));
  const bandList = Object.keys(raw.bands || {}).sort().slice(0, BANDS);
  const band = new Map(bandList.map((id, i) => [id, i + 1]));
  const bondIds = Object.keys(raw.bonds || {}).sort();
  const boss = new Map(Object.keys(raw.bosses || {}).sort().map((id, i) => [id, i + 1])); // S5 (ppo3)
  const bond = new Map(bondIds.map((id, i) => [id, i]));
  // the observation's meaning depends on these id lists: a model trained on one hash reads another's codes wrongly
  // version 2 = the ppo1/ppo2 layout (its hash input unchanged, so the same dataId); 3 = S5 blocks + band choice (ppo3)
  const hash = createHash('sha256').update(JSON.stringify(version >= 3
    ? [DEFAULT_VERSION, [...piece.keys()], [...enemy.keys()], [...band.keys()], bondIds, [...boss.keys()], 'obs3']
    : [DEFAULT_VERSION, [...piece.keys()], [...enemy.keys()], [...band.keys()], bondIds]))
    .digest('hex').slice(0, 12);
  return { piece, enemy, band, bandList, bond, boss, bondIds, hash, dataId: `${DEFAULT_VERSION}-${hash}`, sizes: { piece: piece.size + 1, enemy: enemy.size + 1, band: band.size + 1,
    boss: boss.size + 1,
    card: CARD_BUCKETS, stage: STAGE_BUCKETS, kind: KIND_BUCKETS, bonds: bondIds.length, bond: bondIds.length + 1 } };
}

// ---- observation layout ----
const G = 38, FS = 13, FP = 13, FB = 5, FE = 8, FR = 8, FK = 9, FC = 12, FM = 11, FX = 8, FBD = 9;
const symlog = (x) => Math.sign(x) * Math.log1p(Math.abs(x)); // unbounded counts (S5 features only)
export function layout(vocab, version = 3) {
  const NB = vocab.sizes.bonds;
  const blocks = [['global', 1, G], ['shop', SHOP, FS], ['owned', OWNED, FP], ['bonds', NB, FB], ['enemies', ENEMIES, FE],
    ['rewards', REWARDS, FR], ['personal', PERSONAL, FK], ['cards', CARDS, FC], ['mates', MATES, FM]];
  // version 3 (ppo3), appended so every earlier offset stays: S5 (leaders, teammates' public bond bars and plans) and
  // the band choice (one row per band, catalogue order: the decision's options and their conflicts)
  if (version >= 3) blocks.push(['extra', 1, FX], ['mateBonds', MATES, 1 + 2 * NB + 3], ['bands', BANDS, FBD + NB]);
  const out = {}; let off = 0;
  for (const [name, n, f] of blocks) { out[name] = { offset: off, count: n, width: f }; off += n * f; }
  // integer-coded fields the network embeds: [block, field index within a row, vocabulary]
  const ids = [['global', 26, 'band'], ['global', 27, 'stage'], ['shop', 3, 'piece'], ['owned', 4, 'piece'], ['enemies', 1, 'enemy'],
    ['rewards', 2, 'piece'], ['personal', 1, 'kind'], ['personal', 2, 'card'], ['personal', 8, 'enemy'],
    ['cards', 2, 'kind'], ['cards', 3, 'card'], ['cards', 8, 'enemy'], ['mates', 5, 'band'],
    ['mates', 7, 'bond'], ['mates', 8, 'bond'], ['mates', 9, 'bond']];
  if (version >= 3) ids.push(['extra', 1, 'boss'], ['extra', 2, 'boss'], ['mateBonds', 1 + 2 * NB, 'bond'], ['mateBonds', 2 + 2 * NB, 'bond'],
    ['mateBonds', 3 + 2 * NB, 'bond'], ['bands', 1, 'band']);
  return { dim: off, blocks: out, ids };
}

/** Per-decision context the encoder needs beyond the views (env bookkeeping, never hidden game state). */
export class Encoder {
  constructor(gd, { version = 3 } = {}) {
    this.gd = gd; this.version = version; this.vocab = buildVocab(gd, version); this.lay = layout(this.vocab, version); this.dim = this.lay.dim;
    this.A = version >= 3 ? ACT.BAND + BANDS : ACT.BAND; // version 2: the 60 actions of ppo1/ppo2
  }

  spec() {
    return { dataId: this.vocab.dataId, version: this.version, dim: this.dim, actions: this.A, act: ACT, kinds: KIND, blocks: this.lay.blocks, ids: this.lay.ids,
      vocab: this.vocab.sizes, bonds: this.vocab.bondIds, limits: { SHOP, HAND, TEMP, BOARD, OWNED, REWARDS, PERSONAL, CARDS, ENEMIES, MATES, MAX_PREP_ACTIONS } };
  }

  pieceCode(id) { if (!id) return 0; return this.vocab.piece.get(this.gd.baseIdOf?.(id) ?? id) ?? this.vocab.piece.get(id) ?? 0; }

  /** Owned pieces in the action order: hand slots, temp slots, board (view order). */
  static owned(own) {
    const out = new Array(OWNED).fill(null);
    for (let i = 0; i < HAND; i++) out[i] = own.hand?.[i] || null;
    for (let i = 0; i < TEMP; i++) out[HAND + i] = own.temp?.[i] || null;
    const board = own.board || [];
    for (let i = 0; i < BOARD; i++) out[HAND + TEMP + i] = board[i] || null;
    return out;
  }

  /**
   * Fill obs (Float32Array view of `dim`) and mask (Uint8Array view of NUM_ACTIONS) for seat `ps` at a decision.
   * ctx: { kind: 'prep'|'card', actions, freezes, lp0, humans?: Set<playerId> marked human in training,
   *        rules?: { yieldMain, yieldMerge } (RULES), newUids?: Set (pieces gained this prep),
   *        soldBases?: Set (base ids sold this prep), cache?: object (per decision: the scout-derived pairs) }
   * Returns { pub, own, owned, protect, pairs } (the bonds / base ids this seat leaves to its human teammates).
   */
  encode(m, ps, ctx, obs, mask) {
    obs.fill(0); mask.fill(0);
    const gd = this.gd, L = this.lay.blocks;
    const pub = m.publicView(), own = ps.privateView();
    const shop = own.shop || {}, funds = own.funds || 0;
    const owned = Encoder.owned(own);
    const selfRow = (pub.players || []).find((p) => p.playerId === ps.playerId);
    const selfHuman = !!selfRow && isHumanRow(selfRow, ctx.humans);
    const rules = rulesOf(ctx.rules), bound = !selfHuman;
    const protect = humanBonds(gd, pub, ps.playerId, ctx.humans);
    const cache = ctx.cache || {};
    const pairs = cache.pairs ?? (cache.pairs = humanPairs(m, pub, ps.playerId, ctx.humans));
    const newUids = ctx.newUids || new Set(), soldBases = ctx.soldBases || new Set();
    const mainOn = bound && rules.yieldMain, mergeOn = bound && rules.yieldMerge;
    const blockedPiece = (id) => !!id && gd.chess(id) && ((mainOn && chessInBonds(gd, id, protect)) || (mergeOn && pairs.has(gd.baseIdOf(id))));
    const handFree = (own.hand || []).filter((p) => !p).length;
    // copies held per base id (a golden piece is three)
    const copies = new Map();
    for (const p of owned) if (p && p.kind === 'chess') { const b = gd.baseIdOf(p.id); copies.set(b, (copies.get(b) || 0) + (p.golden ? 3 : 1)); }
    // global
    let o = L.global.offset;
    obs[o] = (pub.round || 0) / 15;
    obs[o + 1 + (ctx.kind === 'card' ? 1 : 0)] = 1;
    const di = DIFFS.indexOf(pub.difficulty); if (di >= 0) obs[o + 4 + di] = 1;
    const mates = (pub.players || []).filter((p) => p.playerId !== ps.playerId);
    obs[o + 8] = mates.length ? 1 : 0;
    obs[o + 9] = ctx.lp0 ? (own.lp || 0) / ctx.lp0 : 0;
    obs[o + 10] = funds / 30; obs[o + 11] = (shop.level || 0) / 6; obs[o + 12] = (shop.upgradePrice || 0) / 20;
    obs[o + 13] = (shop.refreshPrice || 0) / 5; obs[o + 14] = (shop.freeRefreshes || 0) / 3; obs[o + 15] = shop.frozen ? 1 : 0;
    obs[o + 16] = (own.deployCap || 0) / 10; obs[o + 17] = (own.deployCount || 0) / 10;
    obs[o + 18] = (ctx.actions || 0) / MAX_PREP_ACTIONS; obs[o + 19] = ctx.freezes ? 1 : 0;
    obs[o + 20] = pub.round === pub.bossRound ? 1 : 0; obs[o + 21] = pub.round === pub.hiddenRound ? 1 : 0;
    obs[o + 22] = pub.spRound ? 1 : 0; obs[o + 23] = mates.filter((p) => p.alive).length / 3;
    obs[o + 24] = handFree / HAND; obs[o + 25] = (own.temp || []).filter(Boolean).length / TEMP;
    obs[o + 26] = this.vocab.band.get(own.bandId) || 0; obs[o + 27] = bucket(pub.stageId, STAGE_BUCKETS);
    obs[o + 28] = (own.lp || 0) / 50; obs[o + 29] = own.personalChoice ? 1 : 0; obs[o + 30] = own.canReady ? 1 : 0;
    obs[o + 31] = (pub.lastRound || 14) / 15;
    obs[o + 32] = selfHuman ? 1 : 0;
    obs[o + 33] = (pub.players || []).filter((p) => p.playerId !== ps.playerId && p.alive && isHumanRow(p, ctx.humans)).length / 3;
    obs[o + 34] = mainOn ? 1 : 0; obs[o + 35] = mergeOn ? 1 : 0; obs[o + 36] = 0; // 36: spare
    obs[o + 37] = pub.experimental?.disableSharedPool ? 1 : pub.poolGroups ? 0.5 : 0;
    // shop
    const slots = shop.slots || [];
    for (let i = 0; i < SHOP; i++) {
      const s = slots[i]; if (!s) continue;
      o = L.shop.offset + i * FS;
      obs[o] = 1; obs[o + 1] = s.kind === 'chess' ? 1 : 0; obs[o + 2] = s.kind === 'item' ? 1 : 0; obs[o + 3] = this.pieceCode(s.id);
      obs[o + 4] = gd.isGolden?.(s.id) ? 1 : 0; obs[o + 5] = (gd.tierOf?.(s.id) || 0) / 6; obs[o + 6] = (s.price || 0) / 10;
      obs[o + 7] = s.sold ? 1 : 0; obs[o + 8] = s.frozen ? 1 : 0;
      obs[o + 9] = s.kind === 'chess' ? (copies.get(gd.baseIdOf(s.id)) || 0) / 3 : 0;
      obs[o + 10] = s.kind === 'chess' && chessInBonds(gd, s.id, protect) ? 1 : 0;
      obs[o + 11] = s.kind === 'chess' && pairs.has(gd.baseIdOf(s.id)) ? 1 : 0;
      obs[o + 12] = s.kind === 'chess' && soldBases.has(gd.baseIdOf(s.id)) ? 1 : 0;
    }
    // owned
    for (let i = 0; i < OWNED; i++) {
      const p = owned[i]; if (!p) continue;
      o = L.owned.offset + i * FP;
      obs[o] = 1; obs[o + 1] = p.kind === 'chess' ? 1 : 0; obs[o + 2] = p.kind === 'item' ? 1 : 0; obs[o + 3] = p.kind === 'token' ? 1 : 0;
      obs[o + 4] = this.pieceCode(p.id); obs[o + 5] = p.golden ? 1 : 0; obs[o + 6] = (p.tier || 0) / 6;
      obs[o + 7] = (p.items?.length || 0) / 3;
      obs[o + (i < HAND ? 8 : i < HAND + TEMP ? 9 : 10)] = 1;
      obs[o + 11] = p.kind === 'chess' ? (copies.get(gd.baseIdOf(p.id)) || 0) / 3 : 0;
      obs[o + 12] = newUids.has(p.uid) ? 1 : 0;
    }
    // bonds (by catalogue index)
    const disabled = new Set(pub.disabledBonds || []);
    for (const b of own.bonds || []) {
      const k = this.vocab.bond.get(b.bondId); if (k === undefined) continue;
      o = L.bonds.offset + k * FB;
      obs[o] = (b.count || 0) / 6; obs[o + 1] = b.active ? 1 : 0; obs[o + 2] = (b.tier || 0) / 3; obs[o + 3] = (b.layers || 0) / 50;
    }
    for (const id of disabled) { const k = this.vocab.bond.get(id); if (k !== undefined) obs[L.bonds.offset + k * FB + 4] = 1; }
    // upcoming enemies (the visible wave preview)
    const en = own.nextEnemies || [];
    for (let i = 0; i < ENEMIES && i < en.length; i++) {
      const e = en[i]; o = L.enemies.offset + i * FE;
      obs[o] = 1; obs[o + 1] = this.vocab.enemy.get(e.enemyKey) || 0; obs[o + 2] = (e.count || 0) / 10;
      obs[o + 3] = e.fly ? 1 : 0; obs[o + 4] = e.elite ? 1 : 0; obs[o + 5] = e.boss ? 1 : 0; obs[o + 6] = e.gate === 'upper' ? 1 : 0;
      obs[o + 7] = (e.t || 0) / 60;
    }
    // reward offer
    const rw = shop.rewardOffer?.slots || [];
    for (let i = 0; i < REWARDS && i < rw.length; i++) {
      const s = rw[i]; if (!s) continue; o = L.rewards.offset + i * FR;
      obs[o] = 1; obs[o + 1] = s.kind === 'chess' ? 1 : 0; obs[o + 2] = this.pieceCode(s.id); obs[o + 3] = gd.isGolden?.(s.id) ? 1 : 0;
      obs[o + 4] = (s.price || 0) / 10; obs[o + 5] = s.sold ? 1 : 0;
      obs[o + 6] = s.kind === 'chess' && chessInBonds(gd, s.id, protect) ? 1 : 0;
      obs[o + 7] = s.kind === 'chess' && pairs.has(gd.baseIdOf(s.id)) ? 1 : 0;
    }
    // personal choice cards
    const pc = own.personalChoice?.cards || [];
    for (let i = 0; i < PERSONAL && i < pc.length; i++) this._card(obs, L.personal.offset + i * FK, pc[i], null, m, ps);
    // 机变 / draft cards (public)
    const sp = pub.sp;
    if (sp && ctx.kind === 'card') {
      for (let i = 0; i < CARDS && i < sp.cards.length; i++) {
        const c = sp.cards[i]; o = L.cards.offset + i * FC;
        this._card(obs, o, c, sp, m, ps);
      }
    }
    // teammates / opponents (public seat rows)
    for (let i = 0; i < MATES && i < mates.length; i++) {
      const p = mates[i]; o = L.mates.offset + i * FM;
      obs[o] = 1; obs[o + 1] = p.alive ? 1 : 0; obs[o + 2] = (p.lp || 0) / 50; obs[o + 3] = (p.shopLevel || 0) / 6;
      obs[o + 4] = (p.boardCount || 0) / 10; obs[o + 5] = this.vocab.band.get(p.bandId) || 0;
      if (isHumanRow(p, ctx.humans)) {
        obs[o + 6] = 1;
        const main = mainCoreBondOf(gd, p), bb = gd.bandBondIds(p.bandId);
        obs[o + 7] = main ? (this.vocab.bond.get(main) ?? -1) + 1 : 0;
        obs[o + 8] = bb[0] ? (this.vocab.bond.get(bb[0]) ?? -1) + 1 : 0; obs[o + 9] = bb[1] ? (this.vocab.bond.get(bb[1]) ?? -1) + 1 : 0;
      }
      const group = pub.poolGroups?.find((g) => g.playerIds.includes(ps.playerId));
      obs[o + 10] = !pub.experimental?.disableSharedPool && (!group || group.playerIds.includes(p.playerId)) ? 1 : 0;
    }
    // S5: leaders and teammates' bond bars (public view) — version 3 only
    if (L.extra) {
    o = L.extra.offset;
    obs[o] = 1; obs[o + 1] = this.vocab.boss.get(pub.bossId) || 0; obs[o + 2] = this.vocab.boss.get(pub.hiddenBossId) || 0;
    obs[o + 3] = pub.bossRound ? Math.max(0, pub.bossRound - (pub.round || 0)) / 15 : 0;
    const humansN = (pub.players || []).filter((p) => p.playerId !== ps.playerId && isHumanRow(p, ctx.humans)).length;
    obs[o + 4] = humansN / 3; obs[o + 5] = (mates.length - humansN) / 3; obs[o + 6] = ctx.kind === 'band' ? 1 : 0;
    obs[o + 7] = pub.draft?.concurrent ? 1 : 0;
    const NBk = this.vocab.sizes.bonds, bcode = (id) => (id ? (this.vocab.bond.get(id) ?? -1) + 1 : 0);
    for (let i = 0; i < MATES && i < mates.length; i++) {
      o = L.mateBonds.offset + i * L.mateBonds.width;
      obs[o] = 1;
      for (const b of mates[i].bonds || []) {
        const k = this.vocab.bond.get(b.bondId); if (k === undefined) continue;
        obs[o + 1 + 2 * k] = symlog(b.count || 0); obs[o + 2 + 2 * k] = (b.tier || 0) / 3;
      }
      // a teammate's announced plan (g.bondPlan: 主盟约 + up to two 副盟约 shown here), public
      obs[o + 1 + 2 * NBk] = bcode(mates[i].bondPlan); obs[o + 2 + 2 * NBk] = bcode(mates[i].bondPlanSub?.[0]); obs[o + 3 + 2 * NBk] = bcode(mates[i].bondPlanSub?.[1]);
    }
    // band choice rows: filled for band decisions only (absent elsewhere, so the forward skips them at no cost)
    const bc = bandConflicts(gd, pub, ps.playerId, ctx.humans, ctx.aiPicks);
    if (ctx.kind === 'band') this.vocab.bandList.forEach((id, j) => {
      o = L.bands.offset + j * L.bands.width;
      const allowed = gd.bandAllowed(id), rec = gd.band(id) || {}, tied = gd.bandBondIds(id);
      obs[o] = allowed ? 1 : 0; obs[o + 1] = this.vocab.band.get(id) || 0; obs[o + 2] = (Number(rec.totalHp) || 0) / 50;
      obs[o + 3] = tied.some((b) => gd.modeInactiveBonds?.has?.(b) || (pub.disabledBonds || []).includes(b)) ? 1 : 0;
      obs[o + 4] = m.bandTaken?.(id, ps.playerId) ? 1 : 0;
      obs[o + 5] = tied.some((b) => bc.humanBand.has(b)) ? 1 : 0; obs[o + 6] = tied.some((b) => bc.humanMain.has(b)) ? 1 : 0;
      obs[o + 7] = tied.some((b) => bc.humanSub.has(b)) ? 1 : 0; obs[o + 8] = tied.some((b) => bc.aiPick.has(b)) ? 1 : 0;
      for (const b of tied) { const k = this.vocab.bond.get(b); if (k !== undefined) obs[o + FBD + k] = 1; }
    });
    }
    // ---- mask ----
    if (ctx.kind === 'band' && L.bands) {
      const bc = bandConflicts(gd, pub, ps.playerId, ctx.humans, ctx.aiPicks);
      // available bands; hard masks (the owner's rules of 11-12): (a) tied bonds meeting a human's band bonds or 主盟约,
      // (b) tied bonds an earlier AI pick holds; when they leave nothing, every available band (the fallback)
      const avail = [], ok = [];
      this.vocab.bandList.forEach((id, j) => {
        if (!gd.bandAllowed(id) || m.bandTaken?.(id, ps.playerId) || !gd.bandIds().includes(id)) return;
        avail.push(j);
        const tied = gd.bandBondIds(id);
        if (tied.some((b) => bc.humanBand.has(b) || bc.humanMain.has(b) || bc.aiPick.has(b))) return;
        ok.push(j);
      });
      for (const j of (ok.length ? ok : avail)) mask[ACT.BAND + j] = 1;
      return { pub, own, owned, protect, pairs, bandFallback: !ok.length && avail.length > 0 };
    }
    if (ctx.kind === 'card') {
      if (sp) for (let i = 0; i < CARDS && i < sp.cards.length; i++) {
        const c = sp.cards[i];
        if (!c.soldOut && sp.taken?.[c.idx] == null) mask[ACT.CARD + i] = 1;
      }
      return { pub, own, owned, protect, pairs };
    }
    mask[ACT.END] = 1;
    if ((ctx.actions || 0) >= MAX_PREP_ACTIONS) return { pub, own, owned, protect, pairs };
    if ((shop.freeRefreshes || 0) > 0 || funds >= (shop.refreshPrice ?? Infinity)) mask[ACT.REFRESH] = 1;
    if ((shop.level || 0) < (shop.maxLevel || 0) && funds >= (shop.upgradePrice ?? Infinity)) mask[ACT.LEVEL] = 1;
    if (!ctx.freezes && slots.some((s) => s && !s.sold)) mask[ACT.FREEZE] = 1;
    if (handFree > 0) for (let i = 0; i < SHOP && i < slots.length; i++) {
      const s = slots[i];
      if (s && !s.sold && (s.price || 0) <= funds && !blockedPiece(s.id)) mask[ACT.BUY + i] = 1;
    }
    for (let i = 0; i < OWNED; i++) if (owned[i] && owned[i].kind === 'chess') mask[ACT.SELL + i] = 1;
    if (handFree > 0) for (let i = 0; i < REWARDS && i < rw.length; i++) {
      const s = rw[i];
      if (s && !s.sold && (s.price || 0) <= funds && !blockedPiece(s.id)) mask[ACT.REWARD + i] = 1;
    }
    for (let i = 0; i < PERSONAL && i < pc.length; i++) mask[ACT.PERSONAL + i] = 1;
    return { pub, own, owned, protect, pairs };
  }

  _card(obs, o, c, sp, m, ps) {
    if (!c) return;
    obs[o] = 1;
    obs[o + 1] = bucket(c.kind, KIND_BUCKETS); obs[o + 2] = bucket(c.id, CARD_BUCKETS);
    if (sp) { // draft card row: [present, available, kind, card, tier, coin, payout, rounds, enemy, count, killChance, team]
      obs[o + 1] = !c.soldOut && sp.taken?.[c.idx] == null ? 1 : 0;
      obs[o + 2] = bucket(c.kind, KIND_BUCKETS); obs[o + 3] = bucket(c.id, CARD_BUCKETS);
      // field 6: the payout mode (1 = only after a perfect battle, else on kills)
      obs[o + 4] = num(c.tier) / 6; obs[o + 5] = num(c.coin) / 10; obs[o + 6] = c.payout === 'perfect' ? 1 : 0; obs[o + 7] = num(c.rounds) / 5;
      obs[o + 8] = this.vocab.enemy.get(c.enemyKey) || 0; obs[o + 9] = num(c.count) / 10;
      obs[o + 10] = c.kind === 'bounty' ? killChance(m, ps, c) : 0; obs[o + 11] = c.team ? 1 : 0;
      return;
    }
    // personal row: [present, kind, card, tier, coin, payout, rounds, killChance, enemy]
    obs[o + 3] = num(c.tier) / 6; obs[o + 4] = num(c.coin) / 10; obs[o + 5] = c.payout === 'perfect' ? 1 : 0; obs[o + 6] = num(c.rounds) / 5;
    obs[o + 7] = c.kind === 'bounty' ? killChance(m, ps, c) : 0; obs[o + 8] = this.vocab.enemy.get(c.enemyKey) || 0;
  }
}

function killChance(m, ps, card) {
  try { const p = LEGACY_BOT.bountyKillChance(m, ps, card); return typeof p === 'number' && Number.isFinite(p) ? p : 0; } catch { return 0; }
}
