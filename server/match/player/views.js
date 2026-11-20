// server/match/player/views.js — PlayerState methods: the views — pieceView, effectsView (the effects column: 策略 / 机变 /
// 悬赏 …) and m.private (privateView).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { itemProgress } from '../itemProgress.js';
import { itemShowTags, garrisonShowTags } from '../showTags.js';
import { PHASE } from '../../../shared/constants.js';
import { boardOrder, pieceDir } from '../board.js';
import { bondList, offBondCounts } from '../bondsMeta.js';
import { bountyText, bountyCard } from '../choices.js';
import { layerForecast } from '../layerForecast.js';
import { poolCountsView } from '../pool.js';
import { bandProgressView } from '../bandProgress.js';
import { commandBondOverrides, commandView, commandDraftView } from '../bandCommands.js';
import { commandDisplayEffects } from '../../../shared/commandDisplay.js';

export class PlayerViews {
  pieceView(p, rc = null) {
    const rec = p.kind === 'item' ? this.gd.item(p.id) : p.kind === 'token' ? this.gd.token(p.id) : this.gd.chess(p.id);
    const v = {
      uid: p.uid,
      kind: p.kind,
      id: p.id,
      golden: !!(rec && rec.isGolden),
      tier: rec && Number.isInteger(rec.tier) ? rec.tier : null,
      items: p.kind === 'chess' ? (p.items || []).map((it) => ({ uid: it.uid, id: it.id, ...this._itemProgressView(it) })) : [],
      ...(p.kind === 'item' ? this._itemProgressView(p) : {}),
      // the live numbers of the record's {showtag_value_N} texts (§37.201, showTags.js) — only 规程 records carry them
      ...(p.kind === 'chess' ? this._garrisonTagsView(p) : {}),
      count: p.kind === 'token' ? (p.count || 1) : 1,
      ownerUid: p.kind === 'token' ? p.ownerUid ?? null : null,
      // Only an effect-resolved price. The table price stays on the chess record, so a default view omits this.
      ...(p.meta && typeof p.meta.sellPrice === 'number' && Number.isFinite(p.meta.sellPrice)
        ? { sellPrice: Math.max(0, Math.trunc(p.meta.sellPrice)) } : {}),
    };
    const skinId = p.kind === 'chess' ? this.skinIdFor(rec) : null;
    if (skinId) v.skinId = skinId;
    if (rc) { v.row = rc[0]; v.col = rc[1]; v.dir = pieceDir(p); }
    return v;
  }

  bandProgressView() {
    return bandProgressView(this);
  }

  effectsView() {
    const out = [];
    const band = this.bandId ? this.gd.band(this.bandId) : null;
    const legacyBand = () => ({ id: band.effectId || band.bandId, name: band.effectName || band.name, desc: band.desc || '', iconKind: 'band', iconId: band.iconId || band.bandId, ...this.bandProgressView() });
    if (band?.skills?.length) {
      const command = commandView(this);
      // Current command, then the replacement effects the battle uses, then a retained opening passive.
      // A chain that cannot be resolved keeps the single strategy row, so the column does not go blank.
      const rows = command && commandDisplayEffects({
        bands: this.gd.raw.bands,
        originalBandId: this.bandId,
        commandEffectId: command.effectId,
        effectOf: (id) => this.gd.effect(id),
        progress: this.bandProgressView(),
        commandType: command.type,
        bonds: this.gd.raw.bonds,
        bondStates: this.bondsView(),
        effectOverrides: commandBondOverrides(this),
      });
      if (rows?.length) out.push(...rows);
      else out.push(legacyBand());
    } else if (band) {
      out.push(legacyBand());
    }
    for (const e of this.effects) {
      if (e.hidden) continue;
      const v = { id: e.id, name: e.name || e.id, desc: e.desc || '', iconKind: e.iconKind || 'choice', iconId: e.iconId || e.id };
      if (e.counter != null) v.counter = e.counter;
      out.push(v);
    }
    for (const b of this.bounties) {
      // the battles the bounty's enemies still come for (an official multi-round card: every battle, no counter) and
      // the card's official rich text (blue "下场作战" / "两场作战", red "每场"; a multi-round card reads as long as it
      // lasts — choices.js bountyText, MULTI_ROUND_BOUNTY_BATTLES) — user playtest #6 item 4
      const left = b.roundsLeft >= 90 ? null : b.roundsLeft;
      const eff = b.card.effectId ? this.gd.effect(b.card.effectId) : null;
      out.push({
        id: b.id, name: b.card.name || '悬赏', desc: bountyText((eff && eff.descRaw) || b.card.desc || '', b.card), iconKind: 'choice', iconId: b.card.effectId || 'bounty', // i18n-ignore: a data-less card's fallback name
        counter: left, counterText: left == null ? '之后的每场作战' : `还剩 ${left} 场作战`, // i18n-ignore: older clients (ui/effectsList.js builds it from counter)
      });
    }
    return out;
  }

  /** Whether the AFK rule removes this seat at the end of its next prep without a substantive intent before it. */
  afkWarned() {
    const limit = this.m.afkRemoveRounds;
    return limit > 1 && !this.isBot && !this.left && !this.botControlled && !this.afkActed && this.afkRounds >= limit - 1
      && this.afkCanAct();
  }

  /**
   * 挂机移出 (feedback #164): whether this seat could make a substantive prep intent (common.js AFK_ACTIONS) now — a prep
   * where it cannot is not an idle round (Match _checkIdle). Anything it owns (board, hand, 暂存: g.move / g.sell /
   * g.equip / g.destroy), a queued reward offer (g.reward) or a personal choice (g.choice), or funds for a shop card
   * (g.buy, its onPrice price), a refresh (a free one, or the refresh price: g.refresh) or a level-up (g.levelUp), or a
   * 规程 指令 it could use now (g.command: an ACTIVE command, off cooldown, with uses, funds and a target — commandView's
   * reason, not its `usable`, which a readied seat never is). g.freeze is always open and does not count (the owner's
   * decision of 2026-11-16). 老鲤【得闲饮茶】 holds back the funds of rounds 1–2 and owns nothing before round 3 (its 规程
   * 指令 is passive): those preps leave the seat nothing to do.
   */
  afkCanAct() {
    if (this.board.size || this.hand.some(Boolean) || this.temp.some(Boolean)) return true;
    if (this.offers.length || this.personalChoice) return true;
    const cmd = this.command ? commandView(this) : null;
    if (cmd && !cmd.reason && cmd.targets.length) return true;
    const funds = this.funds;
    if (this.shop.freeRefreshes > 0 || funds >= this.gd.refreshPrice) return true;
    if (this.shop.level < this.gd.maxShopLevel && funds >= Math.max(0, this.shop.upgradePrice)) return true;
    return this.shop.slots.some((s) => s && !s.sold && this.priceOf(s) <= funds);
  }

  privateView() {
    const slots = this.shop.slots.map((s) => (s ? { kind: s.kind, id: s.id, price: this.priceOf(s), basePrice: s.basePrice, sold: !!s.sold, frozen: !!s.frozen } : null));
    const offer = this.offers[0] || null;
    const free = this.shop.freeRefreshes > 0;
    const board = [];
    for (const { r, c, piece } of boardOrder(this.board)) board.push(this.pieceView(piece, [r, c]));
    // a boss round's prep: the partner's board on its half of the boss field (Match.bossMateView, item 51)
    const bossMate = typeof this.m.bossMateView === 'function' ? this.m.bossMateView(this) : null;
    // 预计叠层 (PREP only, the own seat only): the layers the own <休整期结束时> effects add at the deadline
    const forecast = layerForecast(this.m, this);
    // 卡池剩余 (feedback #160): the copies left in the stock this seat shares (pool.js poolCountsView; connected alive humans)
    const poolLeft = !this.isBot && this.alive && !this.left && this.connected !== false ? poolCountsView(this.m, this) : null;
    return {
      t: 'm.private',
      playerId: this.playerId,
      // client-side prediction (rel26): the rid of the latest prep intent of this seat the match handled on this socket
      // (platform.js; 0 = none yet). Always present: it also tells the browser that this server acknowledges intents.
      ack: Number.isInteger(this.intentAck) && this.intentAck > 0 ? this.intentAck : 0,
      ...(Number.isInteger(this.aiTakeoverRound) ? { aiTakeoverRound: this.aiTakeoverRound } : {}),
      seat: this.seat,
      alive: this.alive,
      pendingDeath: this.pendingDeath,
      revivalUnavailableReason: this.revivalUnavailableReason,
      // eliminated while the match goes on: its 个人战报 of that moment (server/match/results.js buildOutResult, feedback #111)
      ...(this.outResult && !this.alive ? { out: this.outResult } : {}),
      lp: this.lp,
      funds: this.funds,
      bandId: this.bandId,
      ...(this.command ? { command: commandView(this), commandDraft: commandDraftView(this) } : {}),
      ready: this.ready,
      canReady: this.alive && this.tempEmpty && !this.personalChoice && !this.commandDrafts.length && this.m.phase === PHASE.PREP,
      // a concurrent 机变 draft (Match concurrentDraft): the cards this seat's own equipment stock cannot give
      ...(this.m.phase === PHASE.SP_DRAFT && this.m.sp?.concurrent
        ? { spBlocked: this.m.sp.cards.filter((c) => !this.m.spCardAvailable(c, this)).map((c) => c.idx) } : {}),
      // 挂机移出: one more idle prep removes this seat (Match _checkIdle) — until a substantive intent clears it
      ...(this.afkWarned() ? { afkWarn: true } : {}),
      personalChoice: this.personalChoice ? {
        id: this.personalChoice.id,
        round: this.personalChoice.round,
        sourceItemId: this.personalChoice.sourceItemId,
        cards: this.personalChoice.cards.map((c) => bountyCard(this.gd, c)),
      } : null,
      shop: {
        level: this.shop.level,
        maxLevel: this.gd.maxShopLevel,
        upgradePrice: this.shop.level >= this.gd.maxShopLevel ? 0 : this.shop.upgradePrice,
        refreshPrice: free ? 0 : this.gd.refreshPrice,
        freeRefreshes: this.shop.freeRefreshes,
        frozen: this.shop.frozen,
        layout: { ...(this.shop.layout || this.gd.shopSlots(this.shop.level)) },
        // what the next level-up gives at once (economy.js levelUp / _openLevelSlots): its slot layout (the new slots
        // open empty) and the base price of the level after it — public game data, so the browser can show a
        // level-up before the server answers (client-side prediction, rel26); null at the top level
        next: this.shop.level >= this.gd.maxShopLevel ? null : {
          layout: this.gd.shopSlots(this.shop.level + 1),
          upgradePrice: this.shop.level + 1 >= this.gd.maxShopLevel ? 0 : (this.gd.upgradeBase(this.shop.level + 1) ?? 0),
        },
        slots,
        // `source` 'merge' = the promotion reward (晋升奖励); any other offer (a strategy, an item, a 特质) carries the
        // `label` the bar shows instead; `queued` = offers waiting behind it (player report #6 after 0.1.0)
        rewardOffer: offer ? { tier: offer.tier, source: offer.source === 'merge' ? 'merge' : 'special', label: offer.label || null, queued: this.offers.length - 1, slots: offer.slots.map((s) => ({ kind: s.kind === 'item' ? 'item' : 'chess', id: s.id, price: s.price, sold: !!s.sold })) } : null,
      },
      hand: this.hand.map((p) => (p ? this.pieceView(p) : null)),
      temp: (this.equipHand ? this.temp.slice(0, this.gd.tempSize) : this.temp).map((p) => (p ? this.pieceView(p) : null)),
      ...(this.equipHand ? { stashCount: this.tempPieces().length } : {}),
      board,
      // The stage's 外勤医疗 reserve medic is present during prep, but is not a draggable board piece.
      prepMapChars: this.m.prepMapChars(this),
      deployCap: this.deployCap,
      deployCount: this.deployCount,
      // + the mode-off bonds it has members of (`off: true`, the strip's grey 本局禁用 discs — bondsMeta.offBondCounts)
      bonds: bondList(this.gd, this.bondsView(), { full: true, tempLayers: this.tempLayers, off: offBondCounts(this.gd, this), effectOverrides: commandBondOverrides(this) }),
      effects: this.effectsView(),
      nextEnemies: this.m.nextEnemiesFor(this),
      // DESIGN §16: the effective operator loadout ({ [baseChessId]: { skill, module } }; chess not listed use defaults)
      loadout: this.loadout,
      // Private preference map; public/scouting DTOs carry only each visible piece's resolved skinId.
      skins: this.skins,
      // 0.2.2: the effective per-operator 潜能 / 练度 ({ [charId]: { potential, cultivate } }; operators not listed: 潜能 6,
      // 精英2 Lv.60) — the client's cards compose the numbers from it (shared/potential.js)
      ops: this.ops,
      // 0.2.0 补位: the base chess ids this player fields as their stand-ins in this match (the not-owned list the seat had
      // at the match start; [] = every operator owned) — the client shows these as their stand-ins (cards, pieces, the
      // detail card, with a small 「替补」 mark)
      standIns: this.standIns,
      // 0.2.0 自选编队: this player's 自选 picks in this match ({ [slotBaseId]: { charId, skillIndex, uniEquipId } } — the seat's
      // when the match started; {} = none) — the client composes the operator's record for its own cards and pieces
      // (shared/diy.js diyRecord); `diyBanned`: the slotted slots out of the shop this match (every bond of the operator
      // switched off)
      diy: this.diy,
      diyBanned: this.diyBanned,
      // 自选候补 (feedback #114, player/diy.js diyChoiceView): during the briefing, for a preset with more candidates than
      // slots — per tier its candidates (`off`: every bond banned this match), the ones fielded now and whether the
      // player chose; absent otherwise
      ...(this.m.phase === PHASE.INFO_CHECK && this.hasDiyChoice() ? { diyChoice: this.diyChoiceView(this.m.diyOff?.() ?? new Set()) } : {}),
      // 选择自编: omitted on a season without the step, so those private views stay byte-identical.
      // null = not confirmed yet; an array (possibly empty) is the confirmation.
      ...(this.m.gd.diyBringLimits ? { diyBring: this.diyBring != null ? [...this.diyBring] : null } : {}),
      // 最终攻势 / 隐秘核心 prep (community report of 2026-10-06, item 51): `{ playerId, side, units }` — the pair partner's
      // board pieces as UnitInfo on its half of the boss field (mirrored on the right half, as the battle places them);
      // the own prep view draws them beside the own half, read-only. Absent otherwise.
      ...(bossMate ? { bossMate } : {}),
      // 预计叠层 (feedback #25, server/match/layerForecast.js): during PREP `{ bonds: { [bondId]: { n, sources: [{ kind,
      // id, n }] } }, random, randomSources: [{ kind, id }], partial }` — the layers this player's own prep-end effects add if the
      // prep ended now; random sources are left out (`random` true when one would add layers). Absent outside PREP.
      ...(forecast ? { layerForecast: forecast } : {}),
      // 卡池剩余 (feedback #160, server/match/pool.js poolCountsView): `{ chess: { [baseChessId]: n }, items: { [baseItemId]: n } }`
      // — the copies left in the chess pool / equipment stock this seat shares with the rest of its pool group, AI seats
      // included. Absent when nothing is shared (单人, 独立卡池, a one-seat pool group) and for bots, eliminated or
      // disconnected seats; effect-only equipment and the private 自选 stock are never listed. Messaging.flush re-sends it to
      // the group when another seat's purchase moves it.
      ...(poolLeft ? { poolLeft } : {}),
      stats: {
        dmgDealt: Math.round(this.stats.dmgDealt), kills: this.stats.kills, leaks: this.stats.leaks, gold: this.stats.gold,
        refreshes: this.stats.refreshes, merges: this.stats.merges,
      },
    };
  }

  _itemProgressView(item) {
    const progress = itemProgress(this, item);
    const showTag = itemShowTags(this, item);
    return { ...(progress ? { progress } : {}), ...(showTag ? { showTag } : {}) };
  }

  _garrisonTagsView(piece) {
    const garrisonTags = garrisonShowTags(this, piece);
    return garrisonTags ? { garrisonTags } : {};
  }
}
