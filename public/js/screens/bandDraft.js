// Band draft — BAND_DRAFT "2/2 选择策略" (research 06 §4.2, D1): left = draft order (avatar, name, state:
// … waiting / ⌛ 决策中 / chosen band ✓), current picker highlighted; centre = grid of every band allowed
// for the mode type (icon, name, LP); a band a teammate already picked carries the picker's avatar and is marked
// 队友已选 — it cannot be chosen again unless the server enables allowRepeat for an expanded-capacity mode; right =
// detail pane (icon, 初始生命值, name, effect name + rich description) with 跳过 (co-op, once) and 确认选择.
// One countdown (user playtest #4 item 4): every turn has the same clock (Match BAND_TURN_SECONDS, m.public.draft
// turnSeconds) and the step header counts it down — m.public.deadline IS the turn's end; the order rows carry no
// seconds of their own. The highlighted band (the detail pane's) is what a turn that runs out takes: every change of it
// is reported (g.bandFocus) and the server assigns it while it is free, else 「华法琳」, else the first free strategy
// (timeoutBand). It starts on that default, so the tip under the order list always names what a timeout gives.
// Solo, and a co-op match with a single human (the server's soloUntimed: draft.untimed): no clock at all.
// The left column heads with this match's battlefield (ui/stagePreview.js, #65) and, in an experimental room, groups the
// doctors by chess pool (#66).
// A strategy built around a bond switched off this match (bands.json bondIds ∩ gameLogic matchOffBonds: the mode's
// inactive bonds — 标准: 潘格尼尼 拉特兰, 克莱门莎 阿戈尔, 玛恩纳 卡西米尔; the bot never picks one — and, since rel34, the
// match's drawn set D, the briefing's grey bonds: the owner's 「选择策略阶段也可以标注一下本家盟约被禁用的策略」) reads 「X盟约禁用」
// on its card (本局禁用 until rel34 — the owner: 「不应该显示本局禁用，可能导致歧义」, it read as the strategy's own) and is
// explained in the detail pane (BandOffTag / BandOffNote, DESIGN §21.26, §21.7's look); it stays selectable —
// information only. Since 2026-11-16 (the owner: 「把xxx盟约禁用简化为一个红色角标」) the card carries the client's own red
// corner mark instead of that text (AutoChessBandChooseBandItemView _panelBannedMark: team_list_banned_icon in the
// portrait's top-left corner); which bond is off is the card's tooltip and the detail pane's note, drawn as the client's
// banned tip (bg_banned_tips + icon_banned).
// Corner badges (the client's _panelVictorMark / _panelMasterMark, from this browser's records — ui/stats.js): gold
// (team_list_victor_team) once the strategy's clears reach its victorCount (3), the colourful one 规程 added
// (team_list_master_team_bg + team_list_master_team) in its place at masterVictorCount (6); the detail pane's
// 已通过模拟 N 次 takes the matching plate (pass_time_back + pass_time_icon / master_title_bg).
// Search (2026-11-16, 「再加一个搜索框，可以输入搜索对应策略」): a box in the step header, over the wall, filters it by name,
// effect name, bond and, in Chinese, pinyin initials (ui/bandSearch.js); the wall keeps its size while it filters.
// Size (「策略整体放大一点，不要出现省略号」): a narrower order column and tighter gaps give the portraits about a tenth more;
// a name wraps at a size taken from its tile, never ending in an ellipsis.
// 本局信息 (GitHub #8 item 1 and #484): the step header's entry beside the difficulty opens the briefing's leader, battlefield,
// special enemies (ui/matchEnemies.js), bond rows, legend and 本局禁用干员 again, read-only (MatchInfoDialog).
// The draft runs on underneath: its status line repeats the current turn and the countdown (draftInfoStatus),
// a turn change (a pick, a skip, a turn that runs out, an AI pick) closes it, the end of the draft unmounts it, and it
// never touches the highlighted band or the buttons.
// AI 指定策略: a strategy the room host set for an AI teammate (room.setBotBand; m.public draft.reserved, bandId → that AI)
// reads like a teammate's pick — its avatar on the card, 已指定给 AI 队友 — until the AI takes it on its turn.
// 预选盟约 (ui/bondPlan.js): each order row shows the player's plan (主盟约 and 副盟约); 预选盟约 under the list opens the
// picker (BondPlanDialog).
// 2026-10-14 (the event's pre-game, video 6:29–7:51; the UI package by 雨千代chiyo, ported onto this fork's draft): the
// header says whose turn it is (👆 请选择策略 with 跳过选择 / 无法跳过, X 正在选择策略…, 策略选择完成 · 正在进入模拟…) and
// carries 本局信息; the order rows are name cards (名片底图 or the doctor's 名片干员 art — room.state seats[].card,
// ui/seatArt.js — avatar, trophy level, name, state, 预选盟约) with the strategy box beside them (⌛ 决策中, •••, or the
// pick with 🔍 — it opens that strategy) and ✓ outside; the grid is a 4-wide wall of portraits (队友已选 / AI 已指定
// across a taken one, the pickers' avatars, an orange mark on a strategy this browser has cleared a run with —
// ui/stats.js); the detail pane slides in only once a portrait is tapped (the order list narrows); after the pick the
// grid gives way to 已选定策略 and a beam runs along the picker's row. Each time a pick becomes the player's, the
// 「请选择策略」 band sweeps across (ui/turnBanner.js, the official art; none without it).
// After the draft screens/game.js keeps this screen on 已选定策略 for a moment (`held`, DRAFT_HOLD_MS), inert, before 协议启动！.
// The free draft (the owner, 2026-11-05; server MatchPhases.freeDraft, m.public draft.free / holds): every co-op match
// with two or more humans drafts at once under the step's one countdown. Tapping a strategy and 选择 holds it
// (g.bandHold) — its card then carries my avatar and reads 已被选择 for the others —; 改选此策略 moves the hold, 取消选择 drops
// it (g.bandCancel) and 锁定 makes it final (g.bandLock, in the detail pane or the header) — the right side turns to
// 已选定策略. Each order row shows the doctor's hold (未锁定) or lock (✓). When the countdown ends every hold is fixed and a
// doctor holding nothing gets the highlighted strategy while free, else the default (the tip says which). Every doctor
// locked ends the step early.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, useTicker, secondsLeft } from '../ui/components.js';
import { useGameData, BandIcon, RichText, PlayerAvatar, Sprite, LocalSprite } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { bondPlanOpen, playerPlan, planLine, BondPlanTags, BondPlanDialog } from '../ui/bondPlan.js';
import { MatchInfoDialog, matchInfoModel, MatchBondDialog, regulationCoreAbsent } from '../ui/matchInfo.js';
import { useRise } from '../ui/transitions.js';
import { useFitBox, fitTileBox, fitRowBox } from '../ui/fitGrid.js';
import { NameCardLayer } from '../ui/namecards.js';
import { MatchName } from '../ui/ownerName.js';
import { TrophyBadge } from '../ui/trophies.js';
import { cardOperators, seatPortrait } from '../ui/seatArt.js';
import { rosterPools } from '../ui/teamLayout.js';
import { useMyCard } from '../ui/playerCard.js';
import { MatchEnemies, stagePoolLine } from '../ui/matchEnemies.js';
import { StageMiniMap } from '../ui/stagePreview.js';
import { actions, act } from '../ui/gameActions.js';
import { normalizeDraft, sortedPlayers, draftMyTurn, pregameStepCount, pregameStepIndex } from '../ui/gameLogic.js';
import { useStore } from '../store.js';
import { data, useData, localAsset } from '../data.js';
import { uiUrl } from '../ui/assetUrls.js';
import { audio } from '../audio.js';
import { TurnBanner, TURN_BANNER_LATE_MS } from '../ui/turnBanner.js';
import { onBootArt, preloadBootArt } from '../ui/protocolBoot.js';
import { reducedMotion } from '../ui/device.js';
import { aggregateStats, peekStatsRecords, strategyBadgeIds, strategyMasterIds, strategyClearCounts } from '../ui/stats.js';
import { bandSearchIndex, searchBands } from '../ui/bandSearch.js';
import { matchOffBonds, bandOffBonds, bandOffLine } from '../ui/gameLogic.js';
import { t, tParts, tName, N_ } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** 规程's strategy sections (activity_table bandDataListDict bandType) in the draft grid, with the official captions. */
const BAND_SECTIONS = Object.freeze({
  GENERAL: Object.freeze({ id: 'general', name: N_('泛用型策略'), icon: 'crown' }),
  BONDRELEVANT: Object.freeze({ id: 'bond', name: N_('盟约型策略'), icon: 'link' }),
});


/**
 * The red corner mark on a strategy card whose bonds `names` are off this match (bandOffBonds; the owner, 2026-11-16:
 * 「把xxx盟约禁用简化为一个红色角标」): the client's team_list_banned_icon in the portrait's top-left corner, as its
 * AutoChessBandChooseBandItemView draws it when the band's relateBondList holds a bond banned for the player
 * (_HasBannedBond). No text on it — which bond is off is its label, the card's tooltip and the detail pane's note.
 * Without the local art: a red corner with the bond glyph. Nothing when no bond is off.
 */
export function BandOffTag({ names = [] }) {
  if (!names.length) return null;
  const line = bandOffLine(names);
  return html`<span class="dband__off" role="img" aria-label=${line} title=${line} data-testid="band-off">
    <${LocalSprite} group="ui/outer" name="team_list_banned_icon" class="dband__off-art"
      fallback=${html`<span class="dband__off-mark"><${Icon} name="users" /></span>`} /></span>`;
}

/**
 * The detail pane's note for such a strategy: "本局禁用【拉特兰】盟约，此策略效果可能无法发挥" (the bond names struck
 * through) on the client's banned tip — the red bg_banned_tips with icon_banned (its img_banned_tips; the client's own
 * line 「对应盟约无法组成完整阵容」 names no bond, and the card no longer does).
 */
export function BandOffNote({ names = [] }) {
  if (!names.length) return null;
  const bg = localAsset('ui/outer', 'bg_banned_tips');
  return html`<p class=${cx('draft-detail__off', bg && 'has-art')} role="note" aria-label=${bandOffLine(names)} style=${bg ? `--off-bg:url("${bg}")` : undefined}>
    <${LocalSprite} group="ui/outer" name="icon_banned" class="draft-detail__off-icon" fallback=${html`<${Icon} name="info" />`} />
    <span>${tParts('本局禁用{names}盟约，此策略效果可能无法发挥', { names: names.map((n, i) => html`<span key=${i}>${tParts('【{name}】', { name: html`<s class="draft-detail__offname">${n}</s>` })}</span>`) })}</span></p>`;
}

/**
 * The corner badge a strategy earned in this browser's records (draftRecords): 'victor' — the client's gold
 * team_list_victor_team (its clears reached victorCount); 'master' — 规程's colourful one in its place,
 * team_list_master_team_bg over the portrait and team_list_master_team in the corner (masterVictorCount). Placed as the
 * client's band item places them on its 140-px tile (css/screens/draft.css). Without the local art the gold one falls
 * back to the stats page's sprite, then to a rook in a box.
 * @param {{ tier: 'victor'|'master'|null }} props
 */
export function BandBadge({ tier }) {
  if (tier === 'master') {
    return html`<span class="dband__badge dband__badge--master" data-testid="band-badge" data-tier="master" aria-hidden="true">
      <${LocalSprite} group="ui/outer" name="team_list_master_team_bg" class="dband__master-bg" />
      <${LocalSprite} group="ui/outer" name="team_list_master_team" class="dband__master-icon"
        fallback=${html`<span class="dband__medal dband__medal--master"><${Icon} name="rook" /></span>`} /></span>`;
  }
  if (tier === 'victor') {
    return html`<span class="dband__badge" data-testid="band-badge" data-tier="victor" aria-hidden="true">
      <${LocalSprite} group="ui/outer" name="team_list_victor_team" class="dband__badge-art"
        fallback=${html`<${Sprite} k="statistics/strategyBadge" class="dband__badge-web" fallback=${html`<span class="dband__medal"><${Icon} name="rook" /></span>`} />`} /></span>`;
  }
  return null;
}

/**
 * 已通过模拟 N 次 in the detail pane on the client's plate for the badge: the gold pass_time_back with pass_time_icon
 * (group_win_times, orange text), the colourful master_title_bg at masterVictorCount (group_master, white text).
 * @param {{ n: number, tier: 'victor'|'master'|null }} props
 */
function BandMedal({ n, tier }) {
  if (!n) return null;
  const m = data.get('assets');
  const art = tier === 'master' ? localAsset('ui/outer', 'master_title_bg') : uiUrl(m, 'bandChoose/pass_time_back');
  return html`<span class=${cx('draft-detail__medal', tier === 'master' ? 'is-master' : 'is-victor', art && 'has-art')} data-tier=${tier || 'won'}
      style=${art ? `--medal-bg:url("${art}")` : undefined}>
    ${tier === 'master' ? null : html`<${Sprite} k="bandChoose/pass_time_icon" class="draft-detail__medal-icon" fallback=${null} />`}
    <span>${t('已通过模拟{n}次', { n })}</span></span>`;
}

/**
 * Bands selectable in a mode (modeTypeList contains the mode's type), sorted by sortId.
 * @param {any[]} bands
 * @param {string|null} modeType 'SINGLE'|'MULTI'
 */
export function allowedBands(bands, modeType, disableDuckLord = false) {
  const sid = (b) => (Number.isFinite(b.sortId) ? b.sortId : 99);
  return (Array.isArray(bands) ? bands : [])
    .filter((b) => b && !(disableDuckLord === true && b.bandId === 'band_ducklord') && (!modeType || !Array.isArray(b.modeTypeList) || b.modeTypeList.includes(modeType)))
    .sort((a, b) => sid(a) - sid(b) || (a.bandId < b.bandId ? -1 : a.bandId > b.bandId ? 1 : 0));
}

/**
 * The wall's portrait size (rem): 2.3 at most, as small as .96 before the wall scrolls (ui/fitGrid.js); 规程's section
 * headers (BAND_SECTIONS) take their own rows and are no tiles. 2026-11-16 (the owner: 「策略整体放大一点」): 1.9 / .9
 * before, with a wider order column and wider gaps around the wall (css/screens/draft.css).
 */
export const DRAFT_TILE_REM = Object.freeze({ min: 0.96, max: 2.3, head: '.draft-grid__sec' });
/** … on a short screen (≤ 520 px tall: a landscape phone, where 1rem is 40 px): 1.12rem (45 px) at least, then it scrolls. */
export const DRAFT_TILE_REM_SHORT = Object.freeze({ ...DRAFT_TILE_REM, min: 1.12 });
const shortScreen = () => !!globalThis.matchMedia?.('(max-height: 520px)').matches;
/** An order row's height (rem): the design's 1.26 at most; .96 keeps its three lines (name, state, 预选盟约). */
export const DRAFT_ROW_REM = Object.freeze({ rowSel: '.dorder', min: 0.96, max: 1.26 });

/** The official default strategy of an automatic assignment (data/config.json bandDraft.timeoutBandId). */
export const DEFAULT_TIMEOUT_BAND = 'band_bldsk';

/**
 * The strategy the server assigns me when my turn times out (server/match/match/phases.js defaultBand): the official default
 * 「华法琳」 while no teammate holds it, else the first free strategy in draft order (sortId) — never one a teammate
 * already picked (队友已选).
 * @param {any[]} bands allowedBands(...) (sortId order)
 * @param {Map<string, any>} taken teammateBands(...)
 * @param {string} [defaultId]
 * @returns {string|null}
 */
export function timeoutBand(bands, taken, defaultId = DEFAULT_TIMEOUT_BAND) {
  const list = Array.isArray(bands) ? bands : [];
  const has = (id) => !!(taken && typeof taken.has === 'function' && taken.has(id));
  if (defaultId && !has(defaultId) && (!list.length || list.some((b) => b.bandId === defaultId))) return defaultId;
  return list.find((b) => !has(b.bandId))?.bandId || defaultId || null;
}

/**
 * Strategies the room host reserved for AI teammates (m.public draft.reserved: bandId → the AI's playerId) that the AI
 * has not taken yet — and never one reserved for the viewer.
 * @param {any} rawDraft m.public draft
 * @param {Map<string, string>} picks normalizeDraft(...).picks
 * @param {string} myId
 * @returns {Map<string, string>} bandId → playerId
 */
export function reservedBands(rawDraft, picks, myId) {
  const out = new Map();
  const r = rawDraft && typeof rawDraft.reserved === 'object' && rawDraft.reserved ? rawDraft.reserved : {};
  for (const [bid, pid] of Object.entries(r)) {
    if (typeof pid !== 'string' || pid === myId || (picks instanceof Map && picks.has(pid))) continue;
    out.set(bid, pid);
  }
  return out;
}

/**
 * Bands taken by teammates (队友已选): bandId → the picking players (never the viewer).
 * @param {Map<string, string>} picks normalizeDraft(...).picks (playerId → bandId)
 * @param {string} myId
 */
export function teammateBands(picks, myId, allowRepeat = false) {
  const out = new Map();
  if (allowRepeat === true) return out;
  for (const [pid, bid] of picks instanceof Map ? picks : []) {
    if (pid === myId || typeof bid !== 'string') continue;
    if (!out.has(bid)) out.set(bid, []);
    out.get(bid).push(pid);
  }
  return out;
}

/**
 * The band the detail pane shows (= the highlighted band a turn that runs out takes): the current one, else my pick,
 * else the band a timeout would give me (timeoutBand: 「华法琳」 while free, else the first free one). When it is my
 * turn and the shown band was taken meanwhile (队友已选), that default instead (confirm would be disabled).
 * @param {string|null} sel
 * @param {{ bands: any[], taken: Map<string, any>, myPick: string|null, myTurn: boolean, defaultId?: string }} o
 */
export function draftSelection(sel, { bands, taken, myPick, myTurn, defaultId = DEFAULT_TIMEOUT_BAND }) {
  if (!Array.isArray(bands) || !bands.length) return sel;
  const free = timeoutBand(bands, taken, defaultId) || bands[0].bandId;
  if (!sel) return myPick || free;
  if (!myPick && myTurn && taken.has(sel)) return free;
  return sel;
}

/**
 * The strategy a turn that runs out assigns me (server Match.timeoutBand): the highlighted band while it is one of
 * the mode's and no teammate holds it, else timeoutBand. Null after my pick.
 * @param {string|null} sel the highlighted band
 * @param {{ bands: any[], taken: Map<string, any>, myPick?: string|null, defaultId?: string }} o
 */
export function autoPickBand(sel, { bands, taken, myPick = null, defaultId = DEFAULT_TIMEOUT_BAND }) {
  if (myPick) return null;
  const list = Array.isArray(bands) ? bands : [];
  const has = (id) => !!(taken && typeof taken.has === 'function' && taken.has(id));
  if (sel && !has(sel) && list.some((b) => b.bandId === sel)) return sel;
  return timeoutBand(list, taken, defaultId);
}

/**
 * The tip under the co-op draft order: the one skip, the turn clock and what a turn that runs out assigns me (the
 * highlighted band while free — autoPickBand). Untimed drafts (a single human) name no clock.
 * @param {{ timed: boolean, turnSeconds?: number|null, autoName?: string|null, selected?: boolean, concurrent?: boolean }} o
 *   selected: the auto pick is the highlighted band (not the default standing in for a band a teammate holds);
 *   concurrent: every seat picks at once (m.public draft.concurrent) — no skip, `turnSeconds` is the step's
 */
export function draftTip({ timed, turnSeconds = null, autoName = null, selected = true, concurrent = false, free = false }) {
  // a concurrent draft (everybody at once, expanded rooms): no skip, one clock for the step
  const skip = concurrent || free ? t('所有博士同时选择') : t('联合模拟在选择策略时可以进行一次跳过');
  // a free draft (m.public draft.free): a choice can be cancelled or switched until it is locked; the countdown fixes it
  if (free && timed) {
    const clock = Number(turnSeconds) > 0 ? t('限时 {n} 秒', { n: Math.round(turnSeconds) }) : t('每位博士限时决策');
    return autoName ? t('{skip}；{clock}，锁定前可以取消或改选；倒计时结束时仍未选择将自动选择「{autoName}」', { skip, clock, autoName })
      : t('{skip}；{clock}，锁定前可以取消或改选；倒计时结束时固定当前选择', { skip, clock });
  }
  if (!timed) return t('{skip}；本局不限时', { skip });
  const n = Math.round(turnSeconds);
  const clock = Number(turnSeconds) > 0 ? (concurrent ? t('限时 {n} 秒', { n }) : t('每位博士有 {n} 秒', { n })) : t('每位博士限时决策');
  if (!autoName) return t('{skip}；{clock}', { skip, clock });
  return selected ? t('{skip}；{clock}，超时将自动选择当前选中的「{autoName}」', { skip, clock, autoName })
    : t('{skip}；{clock}，超时将自动选择「{autoName}」', { skip, clock, autoName });
}

/**
 * The step header's countdown during the draft: the current turn's (m.public.deadline = draft.turnDeadline) with a
 * turn's length as the gauge total — null when the draft is untimed.
 * @param {any} pub m.public
 * @returns {{ deadline: number, total: number|null } | null}
 */
export function draftClock(pub) {
  const d = pub && typeof pub.draft === 'object' ? pub.draft : null;
  if (!d || d.untimed) return null;
  const deadline = Number(pub.deadline) > 0 ? Number(pub.deadline) : Number(d.turnDeadline) || 0;
  if (!(deadline > 0)) return null;
  return { deadline, total: Number(d.turnSeconds) > 0 ? Number(d.turnSeconds) : null };
}

/**
 * The status line of the 本局信息 dialog: what the draft does while the dialog covers it — my pick, else whose turn it is
 * with the turn's seconds left (the step header's number; none when untimed), warning at ≤ 10 s like the countdown.
 * @param {{ myPick?: string|null, pickName?: string|null, myTurn: boolean, turnName?: string|null, secs?: number|null,
 *   waiting?: boolean }} o waiting: teammates still have to pick after my pick
 * @returns {{ text: string, secs: number|null, tone: 'mint'|'gold'|'warn'|'dim' }}
 */
export function draftInfoStatus({ myPick = null, pickName = null, myTurn, turnName = null, secs = null, waiting = false, heldName = null }) {
  if (myPick) return { text: `${t('已选择「{name}」', { name: pickName || '' })}${waiting ? t('，等待其他博士') : ''}`, secs: null, tone: 'mint' };
  const s = Number.isFinite(secs) ? Math.max(0, Math.round(secs)) : null;
  const tone = s != null && s <= 10 ? 'warn' : 'gold';
  // a free draft: my choice held, not locked yet
  if (heldName) return { text: t('已选择「{name}」，尚未锁定', { name: heldName }), secs: s, tone };
  if (myTurn) return { text: t('轮到你决策'), secs: s, tone };
  return { text: turnName ? t('{turnName} 决策中', { turnName }) : t('等待轮到你'), secs: s, tone: s != null ? tone : 'dim' };
}

/**
 * What the detail pane offers for the shown strategy in a free draft (m.public draft.free): 'taken' — a teammate holds
 * or locked it (队友已选); 'held' — it is my hold (取消选择 / 锁定); 'switch' — I hold another one (改选此策略); 'hold' —
 * nothing held yet (选择); 'locked' — my choice is final; 'none' — nothing shown or I am not drafting (a spectator).
 * @param {{ sel: string|null, myHold: string|null, myPick: string|null, taken: Map<string, any>, drafting: boolean }} o
 * @returns {'taken'|'held'|'switch'|'hold'|'locked'|'none'}
 */
export function freeBandAction({ sel, myHold = null, myPick = null, taken, drafting }) {
  if (myPick) return 'locked';
  if (!sel || !drafting) return 'none';
  if (myHold === sel) return 'held';
  if (taken instanceof Map && taken.has(sel)) return 'taken';
  return myHold ? 'switch' : 'hold';
}

/** Nothing known yet (before the records are read, or none). */
const NO_RECORDS = Object.freeze({ won: Object.freeze({}), badges: new Set(), masters: new Set(), trophies: 0 });

/**
 * What the wall shows from this browser's records (ui/stats.js): `won` bandId → runs won with it (the detail pane's
 * 已通过模拟 N 次), `badges` the strategies with the official corner badge — strategyBadgeIds, the stats page's rule: the
 * band's own victorCount (3 for all 40 in activity_table / data/bands.json) of clears, quit, test and 入门协议 runs left
 * out —, `masters` those whose clears also reached masterVictorCount (规程's colourful badge, which replaces the gold one:
 * strategyMasterIds) and `trophies` for the name card's medal.
 * @param {any[]} records peekStatsRecords()
 * @param {Record<string, any>|any[]} bands data.get('bands')
 * @returns {{ won: Record<string, number>, badges: Set<string>, masters: Set<string>, trophies: number }}
 */
export function draftRecords(records, bands) {
  try {
    const agg = aggregateStats(records);
    const won = Object.fromEntries(Object.entries(agg.bands || {}).map(([id, b]) => [id, b.wins | 0]).filter(([, n]) => n > 0));
    const clears = strategyClearCounts(records);
    return { won, badges: new Set(strategyBadgeIds(records, bands, clears)), masters: new Set(strategyMasterIds(records, bands, clears)), trophies: agg.trophies || 0 };
  } catch { return NO_RECORDS; }
}

/** A strategy's corner badge from draftRecords: 'master' (the colourful one), 'victor' (gold) or null. */
export function badgeTier(local, bandId) {
  return local?.masters?.has(bandId) ? 'master' : local?.badges?.has(bandId) ? 'victor' : null;
}

/** 「【effect】 description」 of a strategy (the data's description usually opens with the 【effect】 already). */
function BandText({ band, class: cls }) {
  const text = band.descRaw || band.desc || '';
  const head = band.effectName && !String(text).includes(`【${band.effectName}】`) ? `【${band.effectName}】` : '';
  return html`<p class=${cls}>${head}<${RichText} text=${text} /></p>`;
}

/**
 * One doctor of the draft order: the name card (名片底图 when the doctor set one, else the 名片干员 art; avatar, trophy
 * level, name, state, 预选盟约), the strategy box (⌛ 决策中 / ••• / the pick with 🔍, which opens it) and ✓ outside it; a
 * beam runs along the row when the pick lands (useRise).
 * @param {{ p: any, i: number, picked: string|null, cur: boolean, self: boolean, solo: boolean, art: string|null,
 *   card: any, gd: any, onPeek: (bandId: string) => void }} props
 */
function OrderRow({ p, i, picked, cur, self, solo, art, card, gd, onPeek, held = null, onOpen = null }) {
  const flash = useRise(!!picked, 1100);
  const pband = picked ? gd.band(picked) : null;
  // a free draft: the doctor's choice not locked yet (my own opens its detail pane, a teammate's is peeked)
  const hband = !picked && held ? gd.band(held) : null;
  const nc = !p.isBot && card?.bg ? card.bg : null;
  return html`<div class=${cx('dorder', cur && 'is-cur', picked && 'is-done', self && 'is-self', flash && 'is-flash')} style=${`--i:${i}`}>
    <div class=${cx('dorder__card', nc && 'has-nc')}>
      ${nc ? html`<${NameCardLayer} card=${nc} y=${card?.bgY} x=${card?.bgX} zoom=${card?.bgZoom} />` : null}
      ${art && !nc ? html`<span class="dorder__art" style=${`background-image:url("${art}")`} aria-hidden="true"></span>` : null}
      <span class="dorder__face"><${PlayerAvatar} player=${p} self=${self} />${self ? html`<span class="dorder__me" title=${t('我')}><${Icon} name="user" /></span>` : null}</span>
      <div class="dorder__text">
        <b class="dorder__name">${p.isBot ? null : html`<${TrophyBadge} count=${Number.isSafeInteger(card?.trophies) ? card.trophies : null} class="tbadge--inline" />`}<${MatchName} player=${p} name=${p.name || t('博士')} />${p.isBot ? html`<span class="dorder__ai">AI</span>` : null}</b>
        <span class="dorder__state">${picked ? html`<span class="t-mint">${pband?.name || t('已选择')}</span>`
          : hband ? html`<span class="t-gold">${t('{name} · 未锁定', { name: hband.name })}</span>`
          : cur ? html`<span class="t-gold">${t('决策中')}</span>` : html`<span class="t-dim">${t('等待中')}</span>`}</span>
        ${!solo ? html`<${BondPlanTags} player=${p} gd=${gd} class="dorder__plan" />` : null}
      </div>
    </div>
    ${picked ? html`<button type="button" class="dorder__box is-band" onClick=${() => onPeek(picked)} title=${t('查看「{name}」', { name: pband?.name || '' })}>
        <${BandIcon} bandId=${picked} size="md" /><${Icon} name="search" class="dorder__zoom" />
      </button>`
      : hband ? html`<button type="button" class="dorder__box is-band is-held" data-testid="draft-held" onClick=${() => (self && onOpen ? onOpen(held) : onPeek(held))}
          title=${t('{name} · 未锁定', { name: hband.name })}>
        <${BandIcon} bandId=${held} size="md" /><span class="dorder__unlocked">${t('未锁定')}</span>
      </button>`
      : cur ? html`<span class="dorder__box is-cur">${p.isBot ? null : html`<${Icon} name="hourglass" />`}<span>${t('决策中')}</span></span>`
      : html`<span class="dorder__box is-wait"><${Icon} name="dots" /></span>`}
    <span class="dorder__check" aria-hidden="true">${picked ? html`<${Icon} name="check" />` : null}</span>
  </div>`;
}

/** An experimental room's pool header over its doctors (#66): 卡池 N, the seat count, 你的卡池 on the own one. */
function PoolHead({ pool }) {
  return html`<div class="draft-pool__head">
    <b>${pool.id == null ? t('其他') : t('卡池 {n}', { n: pool.id })}</b>
    <small class="num">${t('{n} 人', { n: pool.players.length })}</small>
    ${pool.mine ? html`<small class="draft-pool__mine">${t('你的卡池')}</small>` : null}
  </div>`;
}

/** BAND_DRAFT screen. */
export function BandDraftScreen({ held = null } = {}) {
  // `held`: the draft as it ended, while screens/game.js keeps this screen on 已选定策略 after the draft (heldDraftPub)
  const livePub = useStore((s) => s.match.public);
  const pub = held || livePub;
  const priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const roomSolo = useStore((s) => s.room?.mode === 'solo');
  const roomSeats = useStore((s) => s.room?.seats);
  const gd = useGameData();
  useData('local'); // the client's corner marks and plates (data/local-assets.json ui/outer): re-render once the manifest is in
  const [sel, setSel] = useState(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);   // the detail pane: only once a portrait (or a row's pick) is tapped
  const [peek, setPeek] = useState(null);    // a teammate's / my own pick opened from its row (read-only)
  const [busy, setBusy] = useState(null);
  const [exit, setExit] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [bondId, setBondId] = useState(null);
  useEffect(() => { setBondId(null); }, [infoOpen]);

  const mode = gd.config?.modes?.[pub?.modeId];
  const offBonds = matchOffBonds(pub, mode); // the mode's inactive bonds (标准: 10 of 23) ∪ the match's drawn set D
  const solo = roomSolo || mode?.type === 'SINGLE' || String(pub?.modeId || '').includes('single');
  const disableDuckLord = !solo && pub?.playerCapacity > 4 && pub?.experimental?.disableDuckLord === true;
  const bands = useMemo(() => allowedBands(gd.list('bands'), mode?.type || (solo ? 'SINGLE' : 'MULTI'), disableDuckLord), [gd.ready, mode?.type, solo, disableDuckLord, data.locale(), data.contentId()]);
  // the search box (ui/bandSearch.js): names, effect names, bonds, and in Chinese their pinyin initials
  const searchIndex = useMemo(() => bandSearchIndex(bands, (id) => gd.bond(id)?.name || null, { pinyin: /^zh/i.test(data.locale() || 'zh') }), [bands, gd]);
  const found = useMemo(() => searchBands(searchIndex, query), [searchIndex, query]);
  const players = sortedPlayers(pub);
  const draft = normalizeDraft(pub?.draft, players);
  // an expanded room's draft: every seat picks at once (server MatchPhases.concurrentDraft) — no turn, no skip
  const concurrent = !solo && draft.concurrent === true;
  // the owner's free draft (server MatchPhases.freeDraft): everybody at once, a tentative choice to cancel, switch or 锁定
  const free = concurrent && draft.free === true;
  const myPick = draft.picks.get(myId) || priv?.bandId || null;
  const myHold = free && !myPick ? draft.holds.get(myId) || null : null;
  const myTurn = !myPick && draftMyTurn(draft, myId, solo);
  const inOrder = solo || draft.order.includes(myId);
  const skipsLeft = draft.skipsLeft.has(myId) ? draft.skipsLeft.get(myId) : (skipped ? 0 : 1);
  // the last doctor still to pick cannot skip (no one to pass the turn to)
  const canSkip = !solo && !concurrent && myTurn && skipsLeft > 0 && draft.order.filter((pid) => !draft.picks.has(pid)).length > 1;
  const taken = solo ? new Map() : teammateBands(draft.picks, myId, draft.allowRepeat);
  // a free draft: a teammate's tentative choice is taken too (first come, first served)
  if (free && draft.allowRepeat !== true) for (const [pid, bid] of draft.holds) if (pid !== myId) { if (!taken.has(bid)) taken.set(bid, []); taken.get(bid).push(pid); }
  const reserved = solo ? new Map() : reservedBands(pub?.draft, draft.picks, myId);
  for (const [bid, pid] of reserved) if (!taken.has(bid)) taken.set(bid, [pid]);
  const pickers = new Map(); // bandId → players
  for (const [pid, bid] of [...draft.picks, ...draft.holds, ...[...reserved].map(([bid, pid]) => [pid, bid])]) {
    const p = players.find((x) => x.playerId === pid);
    if (!pickers.has(bid)) pickers.set(bid, []);
    pickers.get(bid).push(p || { playerId: pid, name: '?' });
  }
  // 预选盟约: my plan, the others', and whether it can still change
  const myPlan = playerPlan(players.find((p) => p.playerId === myId));
  const canPlan = !solo && draft.order.includes(myId) && bondPlanOpen(pub);

  // default selection: my pick, else what a timeout gives me (华法琳 while free); when my turn comes while the selected
  // band has been taken by a teammate meanwhile (队友已选), move the selection back to that default
  const defaultId = gd.config?.bandDraft?.timeoutBandId || DEFAULT_TIMEOUT_BAND;
  const takenKey = [...taken.keys()].sort().join(',');
  useEffect(() => {
    const next = draftSelection(sel, { bands, taken, myPick: myPick || myHold, myTurn, defaultId });
    if (next !== sel) setSel(next);
  }, [bands.length, myPick, myTurn, takenKey]);
  // "your turn" cue: the sound and the event's 请选择策略 band (ui/turnBanner.js) once its art is in — co-op and solo
  // alike; a peeked strategy gives way to the grid. The sprites are
  // fetched early (a room entered, the match screen, this screen's mount); a turn whose art is still loading plays the
  // band as soon as it arrives — never blocking input — up to TURN_BANNER_LATE_MS after the turn began, past which the
  // header's 请选择策略 says it alone.
  useEffect(() => { preloadBootArt(); }, []);
  const [turnBanner, setTurnBanner] = useState(0);
  useEffect(() => {
    if (!myTurn) return undefined;
    setPeek(null);
    audio.sfx('yourTurn');
    if (reducedMotion()) return undefined;
    const since = Date.now();
    return onBootArt(() => { if (Date.now() - since <= TURN_BANNER_LATE_MS) setTurnBanner((n) => n + 1); });
  }, [myTurn]);
  // the 本局信息 dialog never outlives the turn it was opened in: a turn change (a pick, a skip, a turn that ran out, an
  // AI pick) or my pick closes it, so whoever's turn begins sees the draft
  const turnKey = `${draft.turnPid || ''}|${myPick || ''}`;
  useEffect(() => { setInfoOpen(false); }, [turnKey]);
  // the held screen (inert) keeps no dialog open over it
  useEffect(() => { if (held) { setInfoOpen(false); setExit(false); } }, [!!held]);

  // one countdown (user playtest #4 item 4): the current turn's — m.public.deadline
  const clock = solo ? null : draftClock(pub);
  // the highlighted band is what a turn that runs out takes (Match.timeoutBand): report every change before my pick
  const timed = !solo && !!pub?.draft && !pub.draft.untimed;
  const focusSent = useRef(null);
  useEffect(() => {
    // (a spectator seat — community report #26 — is in no draft order: it never reports)
    if (!timed || myPick || !sel || focusSent.current === sel || !draft.order.includes(myId)) return;
    focusSent.current = sel;
    act('g.bandFocus', { bandId: sel }, { sfx: false, quiet: true });
  }, [sel, timed, myPick]);

  // what a timeout gives me: the highlighted band while free, else the default (never 队友已选 — match/phases.js timeoutBand)
  const autoId = autoPickBand(sel, { bands, taken, myPick: myPick || myHold, defaultId });
  const autoName = (autoId && gd.band(autoId)?.name) || gd.band(defaultId)?.name || tName('华法琳');

  const band = sel ? gd.band(sel) : null;
  const selTaken = !!band && taken.has(band.bandId);
  const confirm = async () => {
    if (!band || busy || !myTurn || selTaken) return;
    setBusy('pick');
    await actions.band(band.bandId);
    setBusy(null);
  };
  // a free draft: hold (or switch to) the shown strategy, cancel the hold, lock it
  const action = free ? freeBandAction({ sel: band?.bandId ?? null, myHold, myPick, taken, drafting: inOrder }) : 'none';
  const hold = async () => {
    if (!band || busy || (action !== 'hold' && action !== 'switch')) return;
    setBusy('hold');
    await actions.bandHold(band.bandId);
    setBusy(null);
  };
  const cancelHold = async () => {
    if (busy || !myHold) return;
    setBusy('cancel');
    await actions.bandCancel();
    setBusy(null);
  };
  const lock = async () => {
    if (busy || !myHold) return;
    setBusy('lock');
    await actions.bandLock();
    setBusy(null);
  };
  const skip = async () => {
    if (busy || !canSkip) return;
    setBusy('skip');
    if (await actions.bandSkip()) setSkipped(true);
    setBusy(null);
  };
  const pickTile = (id) => { setSel(id); setOpen(true); setPeek(null); audio.sfx('tab', { volume: 0.5 }); };
  // the search box's keys: Enter closes the keyboard (and opens the one strategy found), Esc clears the query, then leaves
  const onSearchKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (query) setQuery(''); else e.currentTarget.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
      if (found && found.ids.size === 1) pickTile([...found.ids][0]);
    }
  };
  const peekBand = (id) => { setPeek(id); setOpen(true); audio.sfx('tab', { volume: 0.5 }); };
  const turnName = players.find((p) => p.playerId === draft.turnPid)?.name;
  useTicker(clock ? 250 : 0);
  const turnSecs = clock ? secondsLeft(clock.deadline) : null;
  const turnLen = Number(pub?.draft?.turnSeconds) > 0 ? Math.round(pub.draft.turnSeconds) : null;
  // 本局信息: the briefing's blocks (built only while the dialog is open) and the draft's state under it
  const info = infoOpen ? matchInfoModel(pub, { bonds: gd.list('bonds'), chess: gd.chess, mode, priv, diyData: { chess: data.get('chess'), backups: data.get('backups') } }) : null;
  const infoStatus = infoOpen ? draftInfoStatus({ myPick, pickName: myPick ? gd.band(myPick)?.name : null, myTurn, turnName, secs: turnSecs,
    waiting: !solo && !draft.done, heldName: myHold ? gd.band(myHold)?.name || myHold : null }) : null;


  // 名片 of the order rows (screens/room.js): 名片底图 / trophies from room.state seats[].card (mine from this browser),
  // else the 名片干员 art (the doctor's pick, else one chosen by the player id)
  const myCard = useMyCard();
  const cardList = useMemo(() => cardOperators(gd.list('chess')), [gd.ready]);
  const portraits = useMemo(() => ({
    pool: cardList.filter((c) => (c.rarity ?? 0) >= 5 && !c.roster).sort((a, b) => (a.charId < b.charId ? -1 : 1)),
    byChar: new Map(cardList.map((c) => [c.charId, c])), m: data.get('assets'), myId, myCard: myCard.charId, myLook: myCard.look,
  }), [cardList, myId, myCard.charId, myCard.look]);
  const seatOf = (pid) => (Array.isArray(roomSeats) && roomSeats.find((x) => x && x.playerId === pid)) || null;
  const cardOf = (p) => (p.playerId === myId ? myCard : seatOf(p.playerId)?.card || null);
  const artOf = (p) => (p.isBot ? null : seatPortrait(seatOf(p.playerId) || { playerId: p.playerId }, portraits));
  // this browser's records (up to the stats store's size): read once, after the screen and its entry are up, not while
  // it mounts
  const [local, setLocal] = useState(NO_RECORDS);
  useEffect(() => {
    const later = globalThis.requestIdleCallback ? (fn) => globalThis.requestIdleCallback(fn, { timeout: 1200 }) : (fn) => setTimeout(fn, 300);
    const cancel = globalThis.cancelIdleCallback && globalThis.requestIdleCallback ? (id) => globalThis.cancelIdleCallback(id) : (id) => clearTimeout(id);
    const id = later(() => setLocal(draftRecords(peekStatsRecords(), data.get('bands'))));
    return () => cancel(id);
  }, []);

  // what the right side shows: 已选定策略 after my pick, a peeked pick, the detail pane once opened, else only the wall
  const allPicked = !!draft.done || (draft.order.length > 0 && draft.order.every((pid) => draft.picks.has(pid)));
  const view = peek ? 'detail' : inOrder && myPick ? 'done' : open && band ? 'detail' : 'grid';
  const shownBand = peek ? gd.band(peek) : band;
  const rows = solo ? players.filter((p) => p.playerId === myId) : draft.order.map((pid) => players.find((p) => p.playerId === pid)).filter(Boolean);

  // this match's battlefield: which strategy suits it depends on its lanes (#65)
  const stage = pub?.stageId ? gd.stage(pub.stageId) : null;
  const stagePool = stagePoolLine(mode);
  // an experimental room's chess pools, already here rather than only once the match starts (#66)
  const pools = solo ? null : rosterPools(pub, rows, myId);
  const orderRow = (p) => {
    const picked = draft.picks.get(p.playerId) || (p.playerId === myId ? myPick : p.bandId) || null;
    const cur = !picked && !allPicked && (solo || concurrent || draft.turnPid === p.playerId);
    return html`<${OrderRow} key=${p.playerId} p=${p} i=${rows.indexOf(p)} picked=${picked} cur=${cur} self=${p.playerId === myId} solo=${solo}
      art=${artOf(p)} card=${cardOf(p)} gd=${gd} onPeek=${peekBand} held=${picked ? null : draft.holds.get(p.playerId) || null} onOpen=${pickTile} />`;
  };

  const lockedN = draft.order.filter((pid) => draft.picks.has(pid)).length;
  const heldBand = myHold ? gd.band(myHold) : null;
  const head = allPicked ? html`<div class="dturn is-done"><span class="dturn__txt"><b>${t('策略选择完成')}</b><span>${t('正在进入模拟…')}</span></span><${Icon} name="hourglass" class="dturn__glass" /></div>`
    : free && inOrder && myPick ? html`<div class="dturn"><span class="dturn__txt"><b>${t('已锁定策略')}</b><span>${t('等待其他博士… {n}/{total} 已锁定', { n: lockedN, total: draft.order.length })}</span></span><${Icon} name="hourglass" class="dturn__glass" /></div>`
    : free && myHold ? html`<div class="dturn is-held" data-testid="draft-head-held"><span class="dturn__txt"><b>${t('已选择「{name}」', { name: heldBand?.name || '' })}</b><span>${t('锁定后不可更改 · {n}/{total} 已锁定', { n: lockedN, total: draft.order.length })}</span></span>
        <button type="button" class="draft-lockbtn" data-testid="draft-lock-head" disabled=${!!busy} aria-busy=${busy === 'lock' ? 'true' : undefined} onClick=${lock} title=${t('锁定「{name}」', { name: heldBand?.name || '' })}>
          <${Icon} name="lock" /><span>${t('锁定选择')}</span></button>
      </div>`
    : myTurn ? html`<div class="dturn is-turn">
        <span class="dturn__go"><${Sprite} k="bandChoose/youturn_finger" class="dturn__finger" fallback=${html`<${Icon} name="chevronLeft" class="dturn__finger" />`} />
          <b>${t('请选择策略')}</b></span>
        ${!solo && !concurrent ? html`<button type="button" class="draft-skip" data-testid="draft-skip" disabled=${!canSkip || !!busy} aria-busy=${busy === 'skip' ? 'true' : undefined} onClick=${skip}
            title=${skipsLeft > 0 ? t('跳过本轮，稍后再选') : t('跳过次数已用完')}>
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19v-5a7 7 0 0 1 7-7h7V3.5L22.5 9 17 14.5V11h-7a3 3 0 0 0-3 3v5z" /></svg>
          <span>${skipsLeft > 0 ? t('跳过选择') : t('无法跳过')}</span></button>` : null}
      </div>`
    : turnName ? html`<div class="dturn"><span class="dturn__txt"><b>${turnName}</b><span>${t('正在选择策略…')}</span></span><${Icon} name="hourglass" class="dturn__glass" /></div>`
    : concurrent ? html`<div class="dturn"><span class="dturn__txt"><b>${t('所有博士同时选择')}</b><span>${t('等待其他博士…')}</span></span><${Icon} name="hourglass" class="dturn__glass" /></div>`
    : null;

  // the search box (ui/bandSearch.js) in the step header's status, over the wall, while the wall is up: it takes no row
  // from the portraits
  const searchBox = view === 'done' || held ? null : html`<div class=${cx('draft-search', query && 'has-q')} role="search">
      <${Icon} name="search" class="draft-search__icon" />
      <input type="search" class="draft-search__input" data-testid="band-search" value=${query} enterkeyhint="search" autocomplete="off" spellcheck=${false}
        placeholder=${t('搜索策略或盟约')} aria-label=${t('搜索策略')} title=${t('可输入策略名、效果名、盟约名或拼音首字母')}
        onInput=${(e) => setQuery(e.currentTarget.value)} onKeyDown=${onSearchKey} />
      ${query ? html`<button type="button" class="draft-search__clear" data-testid="band-search-clear" aria-label=${t('清除搜索')} title=${t('清除搜索')}
          onClick=${() => setQuery('')}><${Icon} name="close" /></button>` : null}
      ${found ? html`<span class=${cx('draft-search__count', !found.ids.size && 'is-none')} data-testid="band-search-count" aria-live="polite">${found.ids.size
        ? html`${found.byDesc ? html`<small>${t('按效果描述')}</small>` : null}<b class="num">${found.ids.size}</b><span class="num">/${bands.length}</span>`
        : t('没有找到相关策略')}</span>` : null}
    </div>`;

  // no scrolling (the owner, 2026-11-05): the wall's portraits and the order rows take the size that shows them all in
  // the space they have (ui/fitGrid.js; css/screens/draft.css --dcols / --dtile, --drh); the grid only before the pick.
  // A short screen (a landscape phone) keeps the portraits a little larger and scrolls 规程's 61 instead
  // (DRAFT_TILE_REM_SHORT).
  const gridRef = useRef(null);
  const rowsRef = useRef(null);
  useFitBox(gridRef, (el) => fitTileBox(el, shortScreen() ? DRAFT_TILE_REM_SHORT : DRAFT_TILE_REM), [view === 'done', bands.length]);
  // a tapped strategy stays in view when the detail pane narrows the wall (规程's 61 scroll then), and what a search finds
  // shows from the top
  useEffect(() => {
    if (view !== 'detail' || peek || !sel) return undefined;
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => gridRef.current?.querySelector(`[data-band="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' })); });
    return () => cancelAnimationFrame(id);
  }, [view, sel, peek]);
  useEffect(() => { if (gridRef.current) gridRef.current.scrollTop = 0; }, [query]);
  useFitBox(rowsRef, (el) => fitRowBox(el, DRAFT_ROW_REM), [rows.length, pools ? pools.length : 0]);

  // held after the draft (the server is already in BATTLE_CHECK): only to look at — 离开, 本局信息 and the 🔍 boxes would
  // open dialogs the match screen tears down a moment later
  return html`<div class=${cx('screen draft', `draft--${view}`, held && 'is-held', head && 'has-status')} inert=${held ? true : undefined} aria-busy=${held ? 'true' : undefined}
      data-allow-repeat=${draft.allowRepeat === true ? 'true' : undefined}>
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${pregameStepIndex(gd.config, 'BAND_CHECK')} of=${pregameStepCount(gd.config)} title=${t('选择策略')} micro="STRATEGY // BAND CHECK" pub=${clock ? { ...pub, deadline: clock.deadline } : { ...pub, deadline: 0 }}
      total=${clock ? clock.total : null} onExit=${() => setExit(true)}
      extra=${html`<button type="button" class="stephead__info" data-testid="match-info-open" aria-haspopup="dialog" onClick=${() => setInfoOpen(true)}
        title=${t('本局信息')}><${Icon} name="search" /><span>${t('本局信息')}</span></button>`}
      status=${searchBox ? html`<div class="draft-headbar">${searchBox}${head}</div>` : head} />
    <main class="draft__main">
      <aside class="draft-order">
        <div class="draft-order__deco" aria-hidden="true"><i></i><i></i><span>STRONGHOLD PROTOCOL<br />${solo ? 'SINGLE OPERATOR' : 'COLLABORATIVE SYSTEM'}</span></div>
        ${stage ? html`<div class="draft-map" data-testid="draft-map" title=${stage.name}>
          <${StageMiniMap} stage=${stage} />
          <div class="draft-map__text">
            <span class="draft-tag">BATTLEFIELD</span>
            <b>${stage.name}</b>
            ${stagePool ? html`<small>${stagePool}</small>` : null}
          </div>
        </div>` : null}
        <div class="draft-order__rows" ref=${rowsRef}>
          ${pools ? pools.map((pool) => html`<div key=${pool.id ?? 'rest'} class=${cx('draft-pool', pool.mine && 'is-mine')} data-testid="draft-pool">
            <${PoolHead} pool=${pool} />
            ${pool.players.map(orderRow)}
          </div>`) : rows.map(orderRow)}
        </div>
        ${canPlan ? html`<${Button} variant="secondary" icon="users" block=${true} class="draft-order__plan" data-testid="bond-plan-open"
          aria-haspopup="dialog" onClick=${() => setPlanOpen(true)}>${myPlan.main || myPlan.sub.length ? t('预选盟约：{name}', { name: planLine(myPlan, (id) => gd.bond(id)?.name || id) }) : t('预选盟约')}<//>` : null}
        ${!solo ? html`<p class="draft-order__tip" data-testid="draft-tip">${draftTip({ timed, turnSeconds: turnLen, autoName: myPick || myHold ? null : autoName, selected: open && autoId === sel, concurrent, free })}</p>` : null}
        ${draft.allowRepeat === true ? html`<p class="draft-order__tip draft-order__tip--repeat" data-testid="draft-repeat">${t('可重复选择，每人只能选择一次')}</p>` : null}
      </aside>
      <i class="draft__link" aria-hidden="true"></i>

      ${view === 'done' ? (() => {
        const mine = gd.band(myPick);
        return html`<section class="draft-done" key=${myPick} aria-live="polite">
          <div class="draft-done__art"><${BandIcon} bandId=${myPick} size="xl" /></div>
          <div class="draft-done__head">
            <span class="draft-tag">STRATEGY</span>
            <h2 class="draft-done__title">${t('已选定策略')}</h2>
            <b class="draft-done__name">${mine?.name || ''}</b>
          </div>
          <div class="draft-done__hp">${t('初始生命值')}<b class="num">${mine?.totalHp ?? '--'}</b></div>
          ${mine ? html`<${BandText} band=${mine} class="draft-done__desc" />` : null}
          <p class="draft-detail__status t-mint"><${Icon} name="check" />${t('已选择「{name}」', { name: mine?.name || '' })}${!solo && !allPicked ? t('，等待其他博士') : ''}</p>
        </section>`;
      })() : html`
        <section class=${cx('draft-grid', found && 'is-search')} ref=${gridRef} role="listbox" aria-label=${t('策略')}>
          ${bands.flatMap((b, i) => {
            // 规程 sorts its strategies into 泛用型策略 (bandType GENERAL) and 盟约型策略 (BONDRELEVANT), each under a header,
            // as the official draft shows them (BV11NW869ELq part 4 0:28, BV13LWM6BEvY match 1 1:36); a version without
            // bandType has no header. A search hides what it does not find (the header too when its section has nothing
            // left) but keeps it in the wall, so the portraits keep their size (ui/fitGrid.js counts them all).
            const sec = BAND_SECTIONS[b.bandType];
            const head = sec && bands[i - 1]?.bandType !== b.bandType
              ? [html`<div key=${`sec-${b.bandType}`} class="draft-grid__sec" role="presentation" data-testid=${`band-section-${sec.id}`}
                  hidden=${found && !bands.some((x) => x.bandType === b.bandType && found.ids.has(x.bandId)) ? true : undefined}><${Icon} name=${sec.icon} /><span>${t(sec.name)}</span></div>`] : [];
            const who = pickers.get(b.bandId) || [];
            const isTaken = taken.has(b.bandId);
            const isReserved = isTaken && reserved.has(b.bandId) && !draft.picks.has(reserved.get(b.bandId));
            const offNames = bandOffBonds(b, offBonds).map((id) => gd.bond(id)?.name || id); // 本局禁用 (still selectable)
            const on = view === 'detail' && !peek && sel === b.bandId;
            const tier = badgeTier(local, b.bandId); // (the count is the detail pane's 已通过模拟 N 次)
            return [...head, html`<button key=${b.bandId} type="button" role="option" aria-selected=${on ? 'true' : 'false'} data-band=${b.bandId}
                hidden=${found && !found.ids.has(b.bandId) ? true : undefined}
                aria-disabled=${isTaken ? 'true' : 'false'} title=${isReserved ? t('已指定给 AI 队友') : isTaken ? t('已被选择') : offNames.length ? bandOffLine(offNames) : b.name}
                class=${cx('dband', on && 'is-sel', (myPick === b.bandId || myHold === b.bandId) && 'is-mine', isTaken && 'is-taken', offNames.length && 'is-off', tier && `has-${tier}`)} style=${`--n:${Math.min(i, 15)}`}
                onClick=${() => pickTile(b.bandId)}>
              <span class="dband__frame"><${BandIcon} bandId=${b.bandId} size="lg" /></span>
              <span class="dband__name">${b.name}</span>
              <${BandBadge} tier=${tier} />
              <${BandOffTag} names=${offNames} />
              ${who.length ? html`<span class="dband__who" title=${who.map((p) => p.name).join('、')}>${who.slice(0, 4).map((p) => html`<${PlayerAvatar} key=${p.playerId} player=${p} size="sm" />`)}${who.length > 4 ? html`<span class="dband__more num">+${who.length - 4}</span>` : null}</span>` : null}
              ${isTaken ? html`<span class="dband__taken">${isReserved ? t('AI 已指定') : t('已被选择')}</span>` : null}
              ${on ? html`<span class="dband__selmark" aria-hidden="true">SELECTED</span>` : null}
            </button>`];
          })}
        </section>
        ${view === 'detail' && shownBand ? html`<aside class="draft-detail" key="detail">
          <div class="draft-detail__body" key=${shownBand.bandId}>
            <div class="draft-detail__art"><${BandIcon} bandId=${shownBand.bandId} size="xl" /></div>
            <${BandMedal} n=${local.won[shownBand.bandId] || 0} tier=${badgeTier(local, shownBand.bandId)} />
            <div class="draft-detail__hp">${t('初始生命值')}<b class="num">${shownBand.totalHp ?? '--'}</b></div>
            <span class="draft-tag">STRATEGY</span>
            <h2 class="draft-detail__name">${shownBand.name}</h2>
            <${BandOffNote} names=${bandOffBonds(shownBand, offBonds).map((id) => gd.bond(id)?.name || id)} />
            <span class="draft-tag">INTRO</span>
            <div class="draft-detail__eff"><${BandText} band=${shownBand} class="draft-detail__desc" /></div>
          </div>
          <div class="draft-detail__actions">
            ${peek ? html`<p class="draft-detail__status"><${Icon} name="search" />${myPick === peek ? t('你选择的策略') : t('{names} 选择的策略', { names: (pickers.get(peek) || []).map((x) => x.name).join('、') || t('博士') })}</p>
              <div class="draft-detail__btns"><${Button} variant="secondary" size="lg" icon="chevronLeft" onClick=${() => setPeek(null)}>${t('返回')}<//></div>`
            : free ? html`${action === 'taken' ? html`<p class="draft-detail__status draft-detail__status--taken"><${Icon} name="close" />${t('队友已选，请选择其他策略')}</p>`
                : action === 'held' ? html`<p class="draft-detail__status draft-detail__status--held"><${Icon} name="check" />${t('已选择，锁定前可以取消或改选')}</p>`
                : action === 'switch' ? html`<p class="draft-detail__status"><${Icon} name="info" />${t('当前选择「{name}」', { name: heldBand?.name || '' })}</p>`
                : action === 'none' && !inOrder ? html`<p class="draft-detail__status"><${Icon} name="hourglass" />${t('观战中')}</p>` : null}
              <div class="draft-detail__btns">
                ${action === 'held' ? html`
                  <${Button} variant="secondary" size="lg" icon="close" class="draft-cancel" data-testid="draft-cancel" disabled=${!!busy} loading=${busy === 'cancel'} onClick=${cancelHold}>${t('取消选择')}<//>
                  <${Button} variant="primary" size="lg" icon="lock" class="draft-lock" data-testid="draft-lock" disabled=${!!busy} loading=${busy === 'lock'} onClick=${lock}>${t('锁定选择')}<//>`
                : html`<${Button} variant="primary" size="lg" icon="check" class="draft-confirm" data-testid="draft-hold" disabled=${(action !== 'hold' && action !== 'switch') || !!busy} loading=${busy === 'hold'} onClick=${hold}>${action === 'taken' ? t('已被选择') : action === 'switch' ? t('改选此策略') : t('选择')}<//>`}
              </div>`
            : html`${selTaken ? html`<p class="draft-detail__status draft-detail__status--taken"><${Icon} name="close" />${t('队友已选，请选择其他策略')}</p>`
                : !myTurn ? html`<p class="draft-detail__status"><${Icon} name="hourglass" />${!inOrder ? t('观战中') : turnName ? t('{turnName} 正在决策…', { turnName }) : t('等待轮到你')}</p>` : null}
              <div class="draft-detail__btns">
                <${Button} variant="primary" size="lg" icon="check" class="draft-confirm" disabled=${!myTurn || !band || selTaken} loading=${busy === 'pick'} onClick=${confirm}>${selTaken ? t('已被选择') : t('确认选择')}<//>
              </div>`}
          </div>
        </aside>` : null}`}
    </main>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
    <${BondPlanDialog} open=${planOpen && canPlan} onClose=${() => setPlanOpen(false)} pub=${pub} myId=${myId} gd=${gd} />
    <${MatchInfoDialog} open=${infoOpen} onClose=${() => setInfoOpen(false)} model=${info} onBond=${setBondId}
      enemies=${infoOpen ? html`<${MatchEnemies} pub=${pub} gd=${gd} idScope="minfo" />` : null}
      status=${infoStatus ? html`<span class=${cx('minfo-dlg__turn', `is-${infoStatus.tone}`)}>
        <${Icon} name=${infoStatus.tone === 'mint' ? 'check' : 'hourglass'} />${infoStatus.text}${infoStatus.secs != null ? html`<b class="num">${infoStatus.secs}s</b>` : null}
      </span>` : null} />
    <${MatchBondDialog} bondId=${infoOpen ? bondId : null} onClose=${() => setBondId(null)} priv=${priv} banned=${info?.banned} off=${!!info?.sets.off.has(bondId)} coreAbsent=${regulationCoreAbsent(info, bondId)} />
    ${turnBanner ? html`<${TurnBanner} key=${turnBanner} onDone=${() => setTurnBanner(0)} />` : null}
  </div>`;
}
