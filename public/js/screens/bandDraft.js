// Band draft — BAND_DRAFT "2/2 选择策略" (research 06 §4.2, D1): left = draft order (avatar, name, state:
// … waiting / ⌛ 决策中 / chosen band ✓), current picker highlighted; centre = grid of every band allowed
// for the mode type (icon, name, LP); a band a teammate already picked carries the picker's avatar and is marked
// 队友已选 — it cannot be chosen again unless the server enables allowRepeat for an expanded-capacity mode; right =
// detail pane (icon, 初始生命值, name, effect name + rich description) with 跳过 (co-op, once) and 确认选择.
// One countdown (user playtest #4 item 4): every turn has the same clock (Match BAND_TURN_SECONDS, m.public.draft
// turnSeconds) and the step header counts it down — m.public.deadline IS the turn's end, the same number as the
// current picker's row. The highlighted band (the detail pane's) is what a turn that runs out takes: every change of it
// is reported (g.bandFocus) and the server assigns it while it is free, else 「华法琳」, else the first free strategy
// (timeoutBand). It starts on that default, so the tip under the order list always names what a timeout gives.
// Solo, and a co-op match with a single human (the server's soloUntimed: draft.untimed): no clock at all.
// A strategy built around a bond the mode switches off (bands.json bondIds ∩ the mode's inactive bonds — 标准: 潘格尼尼
// 拉特兰, 克莱门莎 阿戈尔, 玛恩纳 卡西米尔; the bot never picks one) reads 本局禁用 on its card and in the detail pane
// (BandOffTag / BandOffNote, DESIGN §21.26, §21.7's look); it stays selectable — information only.
// 本局信息 (GitHub issue #8 item 1, "选策略时没法返回查看禁用的干员和盟约"): the header's 本局信息 opens the briefing's bond
// rows, legend and 本局禁用干员 again, read-only (ui/matchInfo.js MatchInfoDialog — the very blocks of the briefing). The draft runs on underneath: its status line repeats the current turn and the countdown (draftInfoStatus),
// a turn change (a pick, a skip, a turn that runs out, an AI pick) closes it, the end of the draft unmounts it, and it
// never touches the highlighted band or the buttons.
// AI 指定策略: a strategy the room host set for an AI teammate (room.setBotBand; m.public draft.reserved, bandId → that AI)
// reads like a teammate's pick — its avatar on the card, 已指定给 AI 队友 — until the AI takes it on its turn.
// 预选盟约 (ui/bondPlan.js): each order row shows the player's planned bond; 预选盟约 under the list opens the picker.
// 2026-10-14 (the event's pre-game, video 6:29–7:51; the UI package by 雨千代chiyo, ported onto this fork's draft): the
// header says whose turn it is (👆 请选择策略 with 跳过选择 / 无法跳过, X 正在选择策略…, 策略选择完成 · 正在进入模拟…) and
// carries 本局信息; the order rows are name cards (名片底图 or the doctor's 名片干员 art — room.state seats[].card,
// ui/seatArt.js — avatar, trophy level, name, state, 预选盟约) with the strategy box beside them (⌛ 决策中, •••, or the
// pick with 🔍 — it opens that strategy) and ✓ outside; the grid is a 4-wide wall of portraits (队友已选 / AI 已指定
// across a taken one, the pickers' avatars, an orange mark on a strategy this browser has cleared a run with —
// ui/stats.js); the detail pane slides in only once a portrait is tapped (the order list narrows); after the pick the
// grid gives way to 已选定策略 and a beam runs along the picker's row. Each time a pick becomes the player's, the
// 「请选择策略」 band sweeps across (ui/matchIntro.js TurnBanner).

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, useTicker, secondsLeft } from '../ui/components.js';
import { useGameData, BandIcon, RichText, PlayerAvatar, Sprite } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { plannableBonds, bondPlanOpen, bondPlanHolders, BondPlanTag, BondPlanPicker } from '../ui/bondPlan.js';
import { MatchInfoDialog, matchInfoModel } from '../ui/matchInfo.js';
import { TurnBanner } from '../ui/matchIntro.js';
import { useRise } from '../ui/transitions.js';
import { NameCardLayer } from '../ui/namecards.js';
import { TrophyBadge } from '../ui/trophies.js';
import { cardOperators, seatPortrait } from '../ui/seatArt.js';
import { useMyCard } from '../ui/playerCard.js';
import { aggregateStats, peekStatsRecords } from '../ui/stats.js';
import { actions, act } from '../ui/gameActions.js';
import { normalizeDraft, sortedPlayers, draftMyTurn } from '../ui/gameLogic.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { audio } from '../audio.js';
import { modeOffBonds, bandOffBonds, bandOffLine } from '../ui/gameLogic.js';
import { t, tParts, tName } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** 本局禁用 on a strategy card whose bonds `names` the mode switches off (bandOffBonds); nothing otherwise. */
export function BandOffTag({ names = [] }) {
  return names.length ? html`<span class="dband__off" title=${bandOffLine(names)}>${t('本局禁用')}</span>` : null;
}

/** The detail pane's note for such a strategy: "本局禁用【拉特兰】盟约，此策略效果可能无法发挥" (the bond names struck through). */
export function BandOffNote({ names = [] }) {
  if (!names.length) return null;
  return html`<p class="draft-detail__off" role="note" aria-label=${bandOffLine(names)}><${Icon} name="info" /><span>${tParts('本局禁用{names}盟约，此策略效果可能无法发挥', { names: names.map((n, i) => html`<span key=${i}>${tParts('【{name}】', { name: html`<s class="draft-detail__offname">${n}</s>` })}</span>`) })}</span></p>`;
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
export function draftTip({ timed, turnSeconds = null, autoName = null, selected = true, concurrent = false }) {
  // a concurrent draft (everybody at once, expanded rooms): no skip, one clock for the step
  const skip = concurrent ? t('所有博士同时选择') : t('联合模拟在选择策略时可以进行一次跳过');
  if (!timed) return t('{skip}；本局不限时', { skip });
  const clock = Number(turnSeconds) > 0 ? t(concurrent ? '限时 {n} 秒' : '每位博士有 {n} 秒', { n: Math.round(turnSeconds) }) : t('每位博士限时决策');
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
export function draftInfoStatus({ myPick = null, pickName = null, myTurn, turnName = null, secs = null, waiting = false }) {
  if (myPick) return { text: `${t('已选择「{name}」', { name: pickName || '' })}${waiting ? t('，等待其他博士') : ''}`, secs: null, tone: 'mint' };
  const s = Number.isFinite(secs) ? Math.max(0, Math.round(secs)) : null;
  const tone = s != null && s <= 10 ? 'warn' : 'gold';
  if (myTurn) return { text: t('轮到你决策'), secs: s, tone };
  return { text: turnName ? t('{turnName} 决策中', { turnName }) : t('等待轮到你'), secs: s, tone: s != null ? tone : 'dim' };
}

/** 已通过模拟 N 次: the runs this browser won with each strategy (ui/stats.js) — bandId → wins. */
function clearedByBand() {
  try {
    const bands = aggregateStats(peekStatsRecords()).bands || {};
    return Object.fromEntries(Object.entries(bands).map(([id, b]) => [id, b.wins | 0]).filter(([, n]) => n > 0));
  } catch { return {}; }
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
function OrderRow({ p, i, picked, cur, self, solo, art, card, gd, onPeek }) {
  const flash = useRise(!!picked, 1100);
  const pband = picked ? gd.band(picked) : null;
  const nc = !p.isBot && card?.bg ? card.bg : null;
  return html`<div class=${cx('dorder', cur && 'is-cur', picked && 'is-done', self && 'is-self', flash && 'is-flash')} style=${`--i:${i}`}>
    <div class=${cx('dorder__card', nc && 'has-nc')}>
      ${nc ? html`<${NameCardLayer} card=${nc} />` : null}
      ${art && !nc ? html`<span class="dorder__art" style=${`background-image:url("${art}")`} aria-hidden="true"></span>` : null}
      <span class="dorder__face"><${PlayerAvatar} player=${p} self=${self} prefer="avatar" />${self ? html`<span class="dorder__me" title=${t('我')}><${Icon} name="user" /></span>` : null}</span>
      <div class="dorder__text">
        <b class="dorder__name">${p.isBot ? null : html`<${TrophyBadge} count=${Number.isSafeInteger(card?.trophies) ? card.trophies : null} class="tbadge--inline" />`}<span>${p.name || t('博士')}</span>${p.isBot ? html`<span class="dorder__ai">AI</span>` : null}</b>
        <span class="dorder__state">${picked ? html`<span class="t-mint">${pband?.name || t('已选择')}</span>`
          : cur ? html`<span class="t-gold">${t('决策中')}</span>` : html`<span class="t-dim">${t('等待中')}</span>`}</span>
        ${!solo && p.bondPlan ? html`<${BondPlanTag} bondId=${p.bondPlan} gd=${gd} class="dorder__plan" />` : null}
      </div>
    </div>
    ${picked ? html`<button type="button" class="dorder__box is-band" onClick=${() => onPeek(picked)} title=${t('查看「{name}」', { name: pband?.name || '' })}>
        <${BandIcon} bandId=${picked} size="md" /><${Icon} name="search" class="dorder__zoom" />
      </button>`
      : cur ? html`<span class="dorder__box is-cur">${p.isBot ? null : html`<${Icon} name="hourglass" />`}<span>${t('决策中')}</span></span>`
      : html`<span class="dorder__box is-wait"><${Icon} name="dots" /></span>`}
    <span class="dorder__check" aria-hidden="true">${picked ? html`<${Icon} name="check" />` : null}</span>
  </div>`;
}

/** BAND_DRAFT screen. */
export function BandDraftScreen() {
  const pub = useStore((s) => s.match.public);
  const priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const roomSolo = useStore((s) => s.room?.mode === 'solo');
  const roomSeats = useStore((s) => s.room?.seats);
  const gd = useGameData();
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(false);   // the detail pane: only once a portrait (or a row's pick) is tapped
  const [peek, setPeek] = useState(null);    // a teammate's / my own pick opened from its row (read-only)
  const [busy, setBusy] = useState(null);
  const [exit, setExit] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [banner, setBanner] = useState(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);

  const mode = gd.config?.modes?.[pub?.modeId];
  const offBonds = modeOffBonds(mode); // the bonds this mode never activates (标准: 10 of 23)
  const solo = roomSolo || mode?.type === 'SINGLE' || String(pub?.modeId || '').includes('single');
  const disableDuckLord = !solo && pub?.playerCapacity > 4 && pub?.experimental?.disableDuckLord === true;
  const bands = useMemo(() => allowedBands(gd.list('bands'), mode?.type || (solo ? 'SINGLE' : 'MULTI'), disableDuckLord), [gd.ready, mode?.type, solo, disableDuckLord, data.locale()]);
  const players = sortedPlayers(pub);
  const draft = normalizeDraft(pub?.draft, players);
  // an expanded room's draft: every seat picks at once (server MatchPhases.concurrentDraft) — no turn, no skip
  const concurrent = !solo && draft.concurrent === true;
  const myPick = draft.picks.get(myId) || priv?.bandId || null;
  const myTurn = !myPick && draftMyTurn(draft, myId, solo);
  const inOrder = solo || draft.order.includes(myId);
  const skipsLeft = draft.skipsLeft.has(myId) ? draft.skipsLeft.get(myId) : (skipped ? 0 : 1);
  const canSkip = !solo && !concurrent && myTurn && skipsLeft > 0 && draft.order.filter((pid) => !draft.picks.has(pid)).length > 1;
  const taken = solo ? new Map() : teammateBands(draft.picks, myId, draft.allowRepeat);
  const reserved = solo ? new Map() : reservedBands(pub?.draft, draft.picks, myId);
  for (const [bid, pid] of reserved) if (!taken.has(bid)) taken.set(bid, [pid]);
  const pickers = new Map(); // bandId → players
  for (const [pid, bid] of [...draft.picks, ...[...reserved].map(([bid, pid]) => [pid, bid])]) {
    const p = players.find((x) => x.playerId === pid);
    if (!pickers.has(bid)) pickers.set(bid, []);
    pickers.get(bid).push(p || { playerId: pid, name: '?' });
  }
  // 预选盟约: my plan, the others', and whether it can still change
  const planBonds = useMemo(() => plannableBonds(gd.list('bonds')), [gd.ready, data.locale()]);
  const myPlan = players.find((p) => p.playerId === myId)?.bondPlan ?? null;
  const canPlan = !solo && draft.order.includes(myId) && bondPlanOpen(pub);
  const pickPlan = async (bondId) => {
    if (planBusy) return;
    setPlanBusy(true);
    const ok = await act('g.bondPlan', { bondId }, { sfx: 'confirm' });
    setPlanBusy(false);
    if (ok) setPlanOpen(false);
  };

  // default selection: my pick, else what a timeout gives me (华法琳 while free); when my turn comes while the selected
  // band has been taken by a teammate meanwhile (队友已选), move the selection back to that default
  const defaultId = gd.config?.bandDraft?.timeoutBandId || DEFAULT_TIMEOUT_BAND;
  const takenKey = [...taken.keys()].sort().join(',');
  useEffect(() => {
    const next = draftSelection(sel, { bands, taken, myPick, myTurn, defaultId });
    if (next !== sel) setSel(next);
  }, [bands.length, myPick, myTurn, takenKey]);
  // "your turn" cue: the sound and the 「请选择策略」 band (a peeked strategy gives way to the grid)
  useEffect(() => {
    if (!myTurn) return;
    if (!solo) audio.sfx('yourTurn');
    setBanner(`${draft.turnPid || 'self'}|${Date.now()}`);
    setPeek(null);
  }, [myTurn]);
  // the 本局信息 dialog never outlives the turn it was opened in: a turn change (a pick, a skip, a turn that ran out, an
  // AI pick) or my pick closes it, so whoever's turn begins sees the draft
  const turnKey = `${draft.turnPid || ''}|${myPick || ''}`;
  useEffect(() => { setInfoOpen(false); }, [turnKey]);

  // one countdown (user playtest #4 item 4): the current turn's — m.public.deadline, the same clock as the picker's row
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
  const autoId = autoPickBand(sel, { bands, taken, myPick, defaultId });
  const autoName = (autoId && gd.band(autoId)?.name) || gd.band(defaultId)?.name || tName('华法琳');

  const band = sel ? gd.band(sel) : null;
  const selTaken = !!band && taken.has(band.bandId);
  const confirm = async () => {
    if (!band || busy || !myTurn || selTaken) return;
    setBusy('pick');
    await actions.band(band.bandId);
    setBusy(null);
  };
  const skip = async () => {
    if (busy || !canSkip) return;
    setBusy('skip');
    if (await actions.bandSkip()) setSkipped(true);
    setBusy(null);
  };
  const turnName = players.find((p) => p.playerId === draft.turnPid)?.name;
  useTicker(clock ? 250 : 0);
  const turnSecs = clock ? secondsLeft(clock.deadline) : null;
  const turnLen = Number(pub?.draft?.turnSeconds) > 0 ? Math.round(pub.draft.turnSeconds) : null;
  // 本局信息: the briefing's blocks (built only while the dialog is open) and the draft's state under it
  const info = infoOpen ? matchInfoModel(pub, { bonds: gd.list('bonds'), chess: gd.chess, mode, priv, diyData: { chess: data.get('chess'), backups: data.get('backups') } }) : null;
  const infoStatus = infoOpen ? draftInfoStatus({ myPick, pickName: myPick ? gd.band(myPick)?.name : null, myTurn, turnName, secs: turnSecs,
    waiting: !solo && !draft.done }) : null;

  const pickTile = (id) => { setSel(id); setOpen(true); setPeek(null); audio.sfx('tab', { volume: 0.5 }); };
  const peekBand = (id) => { setPeek(id); setOpen(true); audio.sfx('tab', { volume: 0.5 }); };

  // 名片 of the order rows (screens/room.js): 名片底图 / trophies from room.state seats[].card (mine from this browser),
  // else the 名片干员 art (the doctor's pick, else one chosen by the player id)
  const myCard = useMyCard();
  const cardList = useMemo(() => cardOperators(data.list('chess')), [gd.ready]);
  const portraits = useMemo(() => ({
    pool: cardList.filter((c) => (c.rarity ?? 0) >= 5).sort((a, b) => (a.charId < b.charId ? -1 : 1)),
    byChar: new Map(cardList.map((c) => [c.charId, c])), m: data.get('assets'), myId, myCard: myCard.charId,
  }), [cardList, myId, myCard.charId]);
  const seatOf = (pid) => (Array.isArray(roomSeats) && roomSeats.find((x) => x && x.playerId === pid)) || null;
  const cardOf = (p) => (p.playerId === myId ? myCard : seatOf(p.playerId)?.card || null);
  const artOf = (p) => (p.isBot ? null : seatPortrait(seatOf(p.playerId) || { playerId: p.playerId }, portraits));
  const cleared = useMemo(clearedByBand, []);

  // what the right side shows: 已选定策略 after my pick, a peeked pick, the detail pane once opened, else only the wall
  const allPicked = !!draft.done;
  const view = peek ? 'detail' : inOrder && myPick ? 'done' : open && band ? 'detail' : 'grid';
  const shownBand = peek ? gd.band(peek) : band;
  const rows = solo ? players.filter((p) => p.playerId === myId) : draft.order.map((pid) => players.find((p) => p.playerId === pid)).filter(Boolean);

  const head = allPicked ? html`<div class="dturn is-done"><span class="dturn__txt"><b>${t('策略选择完成')}</b><span>${t('正在进入模拟…')}</span></span><${Icon} name="hourglass" class="dturn__glass" /></div>`
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

  return html`<div class=${cx('screen draft', `draft--${view}`)} data-allow-repeat=${draft.allowRepeat === true ? 'true' : undefined}>
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${2} of=${2} title=${t('选择策略')} micro="STRATEGY // BAND CHECK" pub=${clock ? { ...pub, deadline: clock.deadline } : { ...pub, deadline: 0 }}
      total=${clock ? clock.total : null} onExit=${() => setExit(true)}
      extra=${html`<button type="button" class="stephead__info" data-testid="match-info-open" aria-haspopup="dialog" onClick=${() => setInfoOpen(true)}
        title=${t('查看禁用盟约与干员')}><${Icon} name="search" /><span>${t('本局信息')}</span></button>`}
      status=${head} />
    <main class="draft__main">
      <aside class="draft-order">
        <div class="draft-order__deco" aria-hidden="true"><i></i><i></i><span>STRONGHOLD PROTOCOL<br />${solo ? 'SINGLE OPERATOR' : 'COLLABORATIVE SYSTEM'}</span></div>
        <div class="draft-order__rows">
          ${rows.map((p, i) => {
            const picked = draft.picks.get(p.playerId) || (p.playerId === myId ? myPick : p.bandId) || null;
            const cur = !picked && !allPicked && (solo || concurrent || draft.turnPid === p.playerId);
            return html`<${OrderRow} key=${p.playerId} p=${p} i=${i} picked=${picked} cur=${cur} self=${p.playerId === myId} solo=${solo}
              art=${artOf(p)} card=${cardOf(p)} gd=${gd} onPeek=${peekBand} />`;
          })}
        </div>
        ${canPlan ? html`<${Button} variant="secondary" icon="users" block=${true} class="draft-order__plan" data-testid="bond-plan-open"
          aria-haspopup="dialog" onClick=${() => setPlanOpen(true)}>${myPlan ? t('预选盟约：{name}', { name: gd.bond(myPlan)?.name || myPlan }) : t('预选盟约')}<//>` : null}
        ${!solo ? html`<p class="draft-order__tip" data-testid="draft-tip">${draftTip({ timed, turnSeconds: turnLen, autoName: myPick ? null : autoName, selected: open && autoId === sel, concurrent })}</p>` : null}
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
        <section class="draft-grid" role="listbox" aria-label=${t('策略')}>
          ${bands.map((b, i) => {
            const who = pickers.get(b.bandId) || [];
            const isTaken = taken.has(b.bandId);
            const isReserved = isTaken && reserved.has(b.bandId) && !draft.picks.has(reserved.get(b.bandId));
            const offNames = bandOffBonds(b, offBonds).map((id) => gd.bond(id)?.name || id); // 本局禁用 (still selectable)
            const on = view === 'detail' && !peek && sel === b.bandId;
            const wins = cleared[b.bandId] || 0;
            return html`<button key=${b.bandId} type="button" role="option" aria-selected=${on ? 'true' : 'false'} data-band=${b.bandId}
                aria-disabled=${isTaken ? 'true' : 'false'} title=${isReserved ? t('已指定给 AI 队友') : isTaken ? t('队友已选') : offNames.length ? bandOffLine(offNames) : b.name}
                class=${cx('dband', on && 'is-sel', myPick === b.bandId && 'is-mine', isTaken && 'is-taken', offNames.length && 'is-off')} style=${`--n:${Math.min(i, 15)}`}
                onClick=${() => pickTile(b.bandId)}>
              <span class="dband__frame"><${BandIcon} bandId=${b.bandId} size="lg" /></span>
              <span class="dband__name">${b.name}</span>
              ${wins ? html`<span class="dband__medal" title=${t('已通过模拟{n}次', { n: wins })}><${Icon} name="rook" /></span>` : null}
              <${BandOffTag} names=${offNames} />
              ${who.length ? html`<span class="dband__who" title=${who.map((p) => p.name).join('、')}>${who.slice(0, 4).map((p) => html`<${PlayerAvatar} key=${p.playerId} player=${p} size="sm" />`)}${who.length > 4 ? html`<span class="dband__more num">+${who.length - 4}</span>` : null}</span>` : null}
              ${isTaken ? html`<span class="dband__taken">${isReserved ? t('AI 已指定') : t('队友已选')}</span>` : null}
              ${on ? html`<span class="dband__selmark" aria-hidden="true">SELECTED</span>` : null}
            </button>`;
          })}
        </section>
        ${view === 'detail' && shownBand ? html`<aside class="draft-detail" key="detail">
          <div class="draft-detail__body" key=${shownBand.bandId}>
            <div class="draft-detail__art"><${BandIcon} bandId=${shownBand.bandId} size="xl" /></div>
            ${cleared[shownBand.bandId] ? html`<span class="draft-detail__medal">${t('已通过模拟{n}次', { n: cleared[shownBand.bandId] })}</span>` : null}
            <div class="draft-detail__hp">${t('初始生命值')}<b class="num">${shownBand.totalHp ?? '--'}</b></div>
            <span class="draft-tag">STRATEGY</span>
            <h2 class="draft-detail__name">${shownBand.name}</h2>
            <${BandOffNote} names=${bandOffBonds(shownBand, offBonds).map((id) => gd.bond(id)?.name || id)} />
            <span class="draft-tag">INTRO</span>
            <div class="draft-detail__eff"><${BandText} band=${shownBand} class="draft-detail__desc" /></div>
          </div>
          <div class="draft-detail__actions">
            ${peek ? html`<p class="draft-detail__status"><${Icon} name="search" />${peek === myPick ? t('你选择的策略') : t('{names} 选择的策略', { names: (pickers.get(peek) || []).map((x) => x.name).join('、') || t('博士') })}</p>
              <div class="draft-detail__btns"><${Button} variant="secondary" size="lg" icon="chevronLeft" onClick=${() => setPeek(null)}>${t('返回')}<//></div>`
            : html`${selTaken ? html`<p class="draft-detail__status draft-detail__status--taken"><${Icon} name="close" />${t('队友已选，请选择其他策略')}</p>`
                : !myTurn ? html`<p class="draft-detail__status"><${Icon} name="hourglass" />${!inOrder ? t('观战中') : turnName ? t('{turnName} 正在决策…', { turnName }) : t('等待轮到你')}</p>` : null}
              <div class="draft-detail__btns">
                <${Button} variant="primary" size="lg" icon="check" class="draft-confirm" disabled=${!myTurn || !band || selTaken} loading=${busy === 'pick'} onClick=${confirm}>${selTaken ? t('队友已选') : t('确认选择')}<//>
              </div>`}
          </div>
        </aside>` : null}`}
    </main>
    ${banner ? html`<${TurnBanner} key=${banner} text=${t('请选择策略')} onDone=${() => setBanner(null)} />` : null}
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
    <${BondPlanPicker} open=${planOpen && canPlan} onClose=${() => setPlanOpen(false)} bonds=${planBonds} value=${myPlan}
      holders=${bondPlanHolders(players, myId)} off=${offBonds} busy=${planBusy} onPick=${pickPlan} />
    <${MatchInfoDialog} open=${infoOpen} onClose=${() => setInfoOpen(false)} model=${info} pub=${pub}
      status=${infoStatus ? html`<span class=${cx('minfo-dlg__turn', `is-${infoStatus.tone}`)}>
        <${Icon} name=${infoStatus.tone === 'mint' ? 'check' : 'hourglass'} />${infoStatus.text}${infoStatus.secs != null ? html`<b class="num">${infoStatus.secs}s</b>` : null}
      </span>` : null} />
  </div>`;
}
