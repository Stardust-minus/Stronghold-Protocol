// Left team panel (research 06 §11.1, research 09 §3.1): one row per seat — avatar (the picked 头像, else the band icon), name, LP
// tower, status glyph (… acting / ✓ ready / ⌛ deciding / ⚔ combat / door left / ✕ dead), AI badge, "you" marker, the
// field being watched (eye badge), the 预选盟约 glyph (ui/bondPlan.js) and emote bubbles. In a boss round the viewer's pair
// is framed in green from the round's start (gameLogic teamFrameIds; community report of 2026-10-06, item 51).
// Observing (client-side combat, `observe` prop — the official flow): tapping a teammate's avatar expands a mint
// "前往查看" button under the row (when that teammate can be observed now; otherwise the reason is toasted through
// onWatch); while observing, the own row shows a "返回战场" button. Without `observe` (server-run combat) a click
// watches that player's field at once, and a click while that field is already on screen does not ask again.
// 联防 / 最终攻势 (`halves`, battle/observe.js avatarLayer; the owner's request, 2026-10-14 — both combat modes since
// 2026-10-15): the avatar of a player on a half of the field on screen — the own one included — goes to that half at
// once, without 前往查看 (an observer's tap picks that player the way 前往查看 does: screens/game.js); the avatar of the
// player whose half is on screen goes back to 全景.
// In PHASE.PREP a double-click on a teammate's avatar opens their field (GitHub #131, the 「前往查看」 shortcut).
// It does not open a field the teammate does not have, and it does not open one the click already opened.
// Boss-prep phases (最终攻势 / 隐秘核心) are not PHASE.PREP, so they still use 「前往查看」.
// Live LP (user playtest #3 item 2): during a normal round's battle each row's tower shows lp − the loss that player's
// leaks so far will cost (red, −N): the own row the top bar's live value (`self`, ui/hud.js liveLp), a teammate's row
// m.public players[].pendingLp (server/match/match/views.js, ~1 Hz). 联防 (user playtest #6 item 7): a leaker's row adds the
// runner tag ×N — its enemies still standing on the 联防 field, uncapped and live (falling as the helpers kill them,
// rising when one splits) — next to lp − min(lpCapPerRound, N): the own row the top bar's value, a teammate's row the
// local 联防 replica's count while it is on screen (`uniteLocal`: the battle runner's state().uniteLeft, the same battle
// the player watches, so the number moves with the kills on screen), else m.public players[].uniteLeft (the authority's
// report, ~1 Hz).
// Layout (ui/teamLayout.js, css/screens/team.css): 'classic' — the official column, desktop with at most four seats, open
// by default, emote bubbles beside the rows; 'list' — compact one-line rows in a bounded scroller, phones and rooms of more
// than four, folded by default (on a phone the open list is a drawer over the shop bar). The layout follows the screen
// (rotation, resize across the phone breakpoint) and refolds when it changes. Emotes of a folded roster or a list fly as
// danmaku (ui/danmaku.js). An experimental room's rows are grouped by chess pool (m.public poolGroups) so teammates can
// check who draws from the same pool.
// 投票移出 (ui/kickVote.js, GitHub feedback #12): the row of a teammate the AI plays because they stayed offline has a
// 投票移出 button in SP_DRAFT / PREP; the open vote is shown in the notice slot above the rows.

import { useEffect, useReducer, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Icon, Tooltip } from './components.js';
import { PlayerAvatar, LpTower, GIcon, LocalSprite } from './gameComponents.js';
import { EmoteBubble } from './emotes.js';
import { STATUS_META, sortedPlayers, teamFrameIds, activeBubbles } from './gameLogic.js';
import { MissTag, uniteRemaining } from './hud.js';
import { data, localAsset } from '../data.js';
import { ReviveAction, RevivalNotice } from './revival.js';
import { KickAction, KickVoteNotice } from './kickVote.js';
import { t } from '../../../shared/i18n.js';
import { uniteRelayKey } from '../battle/observe.js';
import { PHONE_QUERY, rosterPools, rosterStartsOpen, teamDensity, teamEmoteMode, teamPanelLayout } from './teamLayout.js';
import { useMedia } from './device.js';
import { useStore } from '../store.js';
import { BondPlanTag } from './bondPlan.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Official status glyphs (ui/battle) per m.public players[].status; CSS glyph fallback. */
const STATUS_SPRITE = { ready: 'icon_ready', deciding: 'icon_waiting', done: 'icon_complete', dead: 'icon_dead' };

/**
 * A row's LP tower: the settled LP and the pending loss of the round's battle (0 outside COMBAT / UNITE). The own row
 * takes the top bar's live value when there is one (its m.private lp: the same number as the top bar). `left`: during
 * 联防 a leaker's enemies still standing (the ×N tag), else null — for a teammate the local 联防 replica's count when
 * one is given (`uniteLocal`, the runner's state().uniteLeft: { [playerId]: n }, absent = none left; the pending loss
 * is then min(cap, left)), else m.public players[].uniteLeft / pendingLp.
 * @param {any} p m.public players[] entry @param {any} pub m.public
 * @param {{ lp?: number|null, pending: number, unite: boolean, left?: number|null } | null} [self] the own live value (only for the own row)
 * @param {{ uniteLocal?: Record<string, number> | null, cap?: number }} [opts]
 * @returns {{ lp: number|null, pending: number, unite: boolean, left: number|null }}
 */
export function rowLp(p, pub, self = null, { uniteLocal = null, cap = 10 } = {}) {
  const pubLp = Number.isFinite(p?.lp) ? p.lp : null;
  if ((pub?.phase !== PHASE.COMBAT && pub?.phase !== PHASE.UNITE) || p?.alive === false) return { lp: pubLp, pending: 0, unite: false, left: null };
  const lp = self && Number.isFinite(self.lp) ? self.lp : pubLp;
  const leaker = pub.phase === PHASE.UNITE && Array.isArray(pub.unite?.leakers) && pub.unite.leakers.includes(p.playerId);
  const local = !self && leaker && uniteLocal && typeof uniteLocal === 'object' ? uniteRemaining(uniteLocal[p.playerId] ?? 0, null) : null;
  const rawLeft = pub.phase !== PHASE.UNITE ? null : self ? self.left : local != null ? local : p.uniteLeft;
  const left = Number.isFinite(rawLeft) && rawLeft >= 0 ? Math.trunc(rawLeft) : null;
  if (lp == null) return { lp, pending: 0, unite: false, left };
  const raw = self ? self.pending : local != null ? Math.min(cap, local) : p.pendingLp;
  const pending = Math.min(lp, Math.max(0, Math.trunc(Number(raw) || 0)));
  return { lp, pending, unite: (pending > 0 || left != null) && (self ? !!self.unite : pub.phase === PHASE.UNITE), left };
}

/** True when `watching` is already this teammate's field (their live field, or the prep scout `n:<id>`). */
export function teammateFieldShown(watching, player) {
  if (!watching || !player) return false;
  return watching === player.fieldId || watching === `n:${player.playerId}`;
}

/**
 * A single click on a teammate avatar calls onWatch only in server-run combat (no `observe`), and only when
 * that field is not already on screen. A double-click fires click first; the second click, and any later click
 * while the view is already theirs, must not open it again. Client combat never watches from the avatar click.
 * `askedRecently`: this avatar's click already called onWatch in the last moment (the other click of a double-click,
 * before `watching` has re-rendered).
 * @param {{ observe?: unknown, watching?: string|null, player?: { playerId?: string, fieldId?: string }|null, askedRecently?: boolean }} [o]
 * @returns {boolean}
 */
export function teammateClickWatches(o = {}) {
  if (o.observe || o.askedRecently) return false;
  if (teammateFieldShown(o.watching, o.player)) return false;
  return !!o.player;
}

/**
 * Double-click in PHASE.PREP opens a teammate's field, skipping 「前往查看」. False — do not call onWatch — when
 * the phase is not PREP, the row is your own, there is no client-combat `observe` (the click already watched),
 * `canObserve` has no field (do not force a view; the click toasts), or that field is already open.
 * @param {{ phase?: string, self?: boolean, observe?: { canObserve?: (p: any) => { fieldId?: string }|null }|null,
 *   watching?: string|null, player?: any, askedRecently?: boolean }} [o]
 * @returns {boolean}
 */
export function prepDblClickWatches(o = {}) {
  if (o.phase !== PHASE.PREP || o.self || !o.player || !o.observe) return false;
  if (o.askedRecently || teammateFieldShown(o.watching, o.player)) return false;
  const view = (typeof o.observe.canObserve === 'function' ? o.observe.canObserve(o.player) : null) || {};
  return !!view.fieldId;
}

/** How long the second click of a double-click counts as "already asked" before `watching` re-renders. */
const AVATAR_CLICK_GAP_MS = 500;

/**
 * Tooltip of a row's LP tower with a pending loss (null without one).
 * @param {{ lp: number|null, pending: number, unite: boolean, left: number|null } | null} lp rowLp(...)
 * @param {number} [cap] lpCapPerRound
 */
export function rowLpTip(lp, cap = 10) {
  if (!lp || !(lp.pending > 0)) return null;
  if (lp.unite && lp.left != null) return t('目标生命值 {lp}，联防中：漏过的敌人还剩 {left} 个，按现在结算扣除 {pending} 点（每回合至多 {cap} 点）', { lp: lp.lp, left: lp.left, pending: lp.pending, cap });
  return lp.unite ? t('目标生命值 {lp}，联防中，结算时扣除至多 {pending} 点', { lp: lp.lp, pending: lp.pending })
    : t('目标生命值 {lp}，结算时扣除 {pending} 点', { lp: lp.lp, pending: lp.pending });
}


/**
 * The roster's layout and fold state for `count` seats (the match screen asks, since it also places the danmaku): the
 * density follows the screen, and a change of density refolds (a list starts folded, the classic column open).
 * @param {number} count
 * @returns {{ phone: boolean, density: 'classic'|'list', open: boolean, setOpen: (fn: boolean|((on: boolean) => boolean)) => void, emotes: 'bubble'|'danmaku' }}
 */
export function useRoster(count) {
  const phone = useMedia(PHONE_QUERY);
  const density = teamDensity({ count, phone });
  const [state, setState] = useState(() => ({ density, open: rosterStartsOpen(density) }));
  const open = state.density === density ? state.open : rosterStartsOpen(density);
  useEffect(() => { if (state.density !== density) setState({ density, open }); }, [density]);
  const setOpen = (fn) => setState((s) => {
    const cur = s.density === density ? s.open : rosterStartsOpen(density);
    return { density, open: typeof fn === 'function' ? fn(cur) : !!fn };
  });
  return { phone, density, open, setOpen, emotes: teamEmoteMode({ density, open }) };
}

/** The newest emote per seat within `ttl` (bubbles beside the rows), re-rendering this panel alone when one expires. */
function useEmoteBubbles(ttl, on) {
  const emotes = useStore((s) => (on ? s.emotes : null));
  const [, expire] = useReducer((c) => c + 1, 0);
  const bubbles = on ? activeBubbles(emotes, Date.now(), ttl) : null;
  const next = bubbles && bubbles.size ? Math.min(...[...bubbles.values()].map((b) => (Number(b.at) || 0) + ttl)) : null;
  useEffect(() => {
    if (next == null) return undefined;
    const id = setTimeout(expire, Math.max(50, next - Date.now() + 20));
    return () => clearTimeout(id);
  }, [next]);
  return bubbles;
}

/**
 * Avatar clicks: server-run combat watches at once (not again for a field already on screen or the other click of a
 * double-click); client combat toggles 「前往查看」 under the row (`openPid`), the own row goes back to the own battle; in
 * PHASE.PREP a double-click opens the teammate's field.
 */
function useAvatarClicks({ pub, watching, onWatch, observe, halves }) {
  const [openPid, setOpenPid] = useState(null);
  // the playerId whose avatar just called onWatch, so the other click of a double-click does not open the view again
  const askedAt = useRef(/** @type {{ id: string|null, at: number }} */ ({ id: null, at: 0 }));
  const phaseKey = `${pub?.phase}:${pub?.round}:${uniteRelayKey(pub) || ''}`;
  useEffect(() => { setOpenPid(null); }, [phaseKey, watching, observe?.observing]);
  const askedRecently = (p) => askedAt.current.id === p?.playerId && Date.now() - askedAt.current.at < AVATAR_CLICK_GAP_MS;
  const noteAsked = (p) => { askedAt.current = { id: p.playerId, at: Date.now() }; };
  const click = (p, self) => {
    const half = halves?.half?.(p) || null;
    if (half) { setOpenPid(null); halves.onHalf(half, p); return; }
    if (!observe) {
      // your own row still goes home; a teammate already on screen (or just opened by this double-click) does not
      if (self || teammateClickWatches({ watching, player: p, askedRecently: askedRecently(p) })) {
        if (!self) noteAsked(p);
        onWatch(p);
      }
      return;
    }
    if (self) { if (observe.observing) observe.onBack(); setOpenPid(null); return; }
    const view = observe.canObserve(p) || {};
    if (!view.fieldId) {
      setOpenPid(null);
      if (!askedRecently(p)) { noteAsked(p); onWatch(p); } // the game screen toasts the reason; a double-click toasts once
      return;
    }
    setOpenPid((cur) => (cur === p.playerId ? null : p.playerId));
  };
  const dblClick = (e, p, self) => {
    if (!prepDblClickWatches({ phase: pub?.phase, self, observe, watching, player: p, askedRecently: askedRecently(p) })) return;
    e.preventDefault();
    setOpenPid(null);
    noteAsked(p);
    onWatch(p);
  };
  return { openPid, setOpenPid, click, dblClick };
}

/** Status glyph: the official ui/battle sprite (offline / ready / deciding / done / dead), else the CSS glyph. */
function RowStatus({ status, meta, offline }) {
  const sprite = offline ? 'icon_lost_connect' : STATUS_SPRITE[status];
  return html`<${Tooltip} text=${offline ? t('连接已断开') : t(meta.text)} placement="right">
    <span class=${cx('team__status', `is-${meta.tone}`, offline && 'is-offline', sprite && localAsset('ui/battle', sprite) && 'has-sprite')} aria-label=${t(meta.text)}>
      ${offline ? html`<${LocalSprite} name="icon_lost_connect" fallback=${html`<${Icon} name="wifiOff" />`} />`
        : STATUS_SPRITE[status] ? html`<${LocalSprite} name=${STATUS_SPRITE[status]} fallback=${html`<${GIcon} name=${meta.glyph} />`} />`
        : html`<${GIcon} name=${meta.glyph} />`}
    </span>
  <//>`;
}

/** One seat. `bubble`: its emote beside the row (classic roster), else null. */
function TeamRow({ p, pub, myId, watching, onWatch, observe, halves, clicks, selfLive, cap, uniteLocal, team, frameArt, list, bubble, spMark = null }) {
  const self = p.playerId === myId;
  const status = p.pendingDeath ? 'rescue' : p.alive === false ? 'dead' : p.status;
  const meta = p.pendingDeath ? { ...STATUS_META.deciding, text: t('等待救援') } : STATUS_META[status] || STATUS_META.acting;
  // a player on a half of the 联防 / 最终攻势 field on screen: the tap switches the camera ('ALL': their half is shown)
  const half = halves?.half?.(p) || null;
  const watched = teammateFieldShown(watching, p);
  const offline = p.connected === false && !p.isBot;
  const open = !!observe && clicks.openPid === p.playerId && !self;
  const back = !!observe && self && observe.observing;
  const title = half ? (half === 'ALL' ? t('返回全景') : self ? t('查看自己的半场') : t('查看 {name} 的半场', { name: p.name }))
    : observe ? (self ? (observe.observing ? t('返回战场') : t('你自己')) : t('查看 {name} 的战场', { name: p.name })) : (self ? t('查看自己的阵地') : t('查看 {name} 的阵地', { name: p.name }));
  const lp = rowLp(p, pub, self ? selfLive : null, { uniteLocal, cap });
  const inTeam = team.has(p.playerId);
  const band = p.bandId ? data.lookup('bands', p.bandId)?.name : null; // the avatar no longer shows it (#100)
  const { click, dblClick } = clicks;
  return html`<div data-seat=${p.seat} class=${cx('team__row', self && 'is-self', inTeam && 'is-team', watched && 'is-watched', p.alive === false && !p.pendingDeath && 'is-dead', p.pendingDeath && 'is-pending', open && 'is-open', offline && 'is-offline')}>
    <button type="button" class="team__btn" onClick=${() => click(p, self)} onDblClick=${(e) => dblClick(e, p, self)} title=${[title, inTeam && !self ? t('与你在同一战场') : null, band].filter(Boolean).join(' · ')} aria-label=${title} aria-expanded=${observe && !self && !half ? String(open) : undefined}>
      <${PlayerAvatar} player=${p} self=${self} />
      ${inTeam ? html`<span class=${cx('team__frame', !frameArt && 'team__frame--plain')} style=${frameArt ? `--frame:url("${frameArt}")` : undefined} aria-hidden="true"></span>` : null}
      <span class="team__seat num">P${(p.seat ?? 0) + 1}</span>
      ${p.isBot ? html`<span class="team__ai">AI</span>` : null}
      ${self ? html`<span class="team__you"><${Icon} name="user" /></span>` : null}
      ${spMark === 'done' ? html`<span class="team__spmark is-done" title=${t('已完成选择')}><${Icon} name="check" /></span>`
        : spMark === 'turn' ? html`<span class="team__spmark is-turn" title=${t('正在决策…')}><i></i><i></i><i></i></span>` : null}
    </button>
    <div class="team__info">
      <span class="team__name" title=${p.name || t('博士')}>${p.name || t('博士')}</span>
      <div class="team__line">
        <${LpTower} value=${lp.lp} size="sm" tone=${Number.isFinite(lp.lp) && lp.lp - lp.pending <= 5 ? 'danger' : null} pending=${lp.pending}
          tip=${rowLpTip(lp, cap)} />
        ${lp.left != null ? html`<${MissTag} n=${lp.left} name=${self ? null : p.name || t('博士')} />` : null}
        <${RowStatus} status=${status} meta=${meta} offline=${offline} />
        ${p.bondPlan ? html`<${BondPlanTag} bondId=${p.bondPlan} compact=${true} class="team__plan" />` : null}
        ${watched && !self ? html`<span class="team__eye" title=${t('正在查看')}><${GIcon} name="eye" /></span>` : null}
      </div>
      <${ReviveAction} pub=${pub} myId=${myId} target=${p} compact=${list} />
      <${KickAction} pub=${pub} myId=${myId} target=${p} compact=${list} />
      ${open ? html`<button type="button" class="btn btn--primary btn--sm team__ob"
        onClick=${() => { clicks.setOpenPid(null); onWatch(p); }}><span class="btn__label">${t('前往查看')}</span></button>` : null}
      ${back ? html`<button type="button" class="btn btn--secondary btn--sm team__back"
        onClick=${() => observe.onBack()}><span class="btn__label">${t('返回战场')}</span></button>` : null}
    </div>
    ${bubble ? html`<${EmoteBubble} key=${bubble.seq} id=${bubble.id} at=${bubble.at} class="team__bubble" />` : null}
  </div>`;
}

/** An experimental room's pool header: 卡池 N, its seat count, 你的卡池 on the own one. */
function PoolHead({ pool }) {
  return html`<div class=${cx('team__pool-head', pool.mine && 'is-mine')}>
    <span class="team__pool-name">${pool.id == null ? t('其他') : t('卡池 {n}', { n: pool.id })}</span>
    <small class="num">${t('{n} 人', { n: pool.players.length })}</small>
    ${pool.mine ? html`<small class="team__pool-mine">${t('你的卡池')}</small>` : null}
  </div>`;
}

/**
 * @param {{ pub:any, myId:string, watching:string|null, onWatch:(p:any)=>void, roster: ReturnType<typeof useRoster>,
 *   emoteTtl?: number, teamLp?: number|null, self?: { lp?: number|null, pending: number, unite: boolean, left?: number|null } | null,
 *   cap?: number, uniteLocal?: Record<string, number> | null,
 *   observe?: null | { canObserve: (p:any) => { fieldId?: string, reason?: string|null, back?: boolean }, observing: boolean, onBack: () => void },
 *   halves?: null | { half: (p:any) => 'L'|'ALL'|'R'|null, onHalf: (layer: string, p: any) => void } }} props
 *   halves.half: the ‹ › layer a tap on that player's avatar switches to (battle/observe.js avatarLayer), null = the usual flow
 *   spMarks: the shared 机变 draft's pick order on the portraits (ui/choiceOverlay.js spMarks: ✓ picked, ••• deciding)
 *   uniteLocal: the local 联防 replica's per-leaker counts while it is on screen (battle runner state().uniteLeft), else null
 */
export function TeamPanel({ pub, myId, watching, onWatch, roster, emoteTtl = 3000, observe = null, halves = null, self: selfLive = null, cap = 10, uniteLocal = null, spMarks = null }) {
  const players = sortedPlayers(pub);
  const { density, open: rosterOpen, setOpen: setRosterOpen, phone } = roster;
  const list = density === 'list';
  const bubbles = useEmoteBubbles(emoteTtl, roster.emotes === 'bubble');
  const clicks = useAvatarClicks({ pub, watching, onWatch, observe, halves });
  const pools = list ? rosterPools(pub, players, myId) : null;
  const panelRef = useRef(null);
  const noticeRef = useRef(null);
  const headerRef = useRef(null);
  const [layout, setLayout] = useState(() => teamPanelLayout(players.length, 0));
  // a desktop list takes a second column when its seats do not fit the height (phones: one column, the drawer scrolls)
  const measured = list && rosterOpen && !phone;
  useEffect(() => {
    if (!measured) return undefined;
    const panel = panelRef.current;
    const measure = () => {
      if (!panel) return;
      const css = getComputedStyle(panel);
      const notice = noticeRef.current?.getBoundingClientRect().height || 0;
      const header = headerRef.current?.getBoundingClientRect().height || 0;
      const height = panel.clientHeight - (parseFloat(css.paddingTop) || 0) - (parseFloat(css.paddingBottom) || 0) - notice - header;
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 40;
      // the widest the panel may grow (css/screens/team.css --team-w2)
      const width = Math.min(innerWidth * 0.32, Math.max(520, root * 5.2)) - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
      const next = teamPanelLayout(players.length, height, root, width, document.documentElement.classList.contains('sp-coarse'), pools ? pools.length * 30 : 0);
      setLayout(prev => prev.columns === next.columns && prev.rows === next.rows && prev.rowHeight === next.rowHeight ? prev : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (panel) observer?.observe(panel);
    if (noticeRef.current) observer?.observe(noticeRef.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [measured, players.length, pools ? pools.length : 0, pub?.revival?.windowOpen, !!pub?.kickVote]);
  if (!players.length) return null;
  // a boss round: the viewer's pair framed in green from the round's start (item 51 — the official bg_team_border,
  // tinted like the official green; a plain green ring without the local art)
  const team = teamFrameIds(pub, myId);
  const frameArt = team.size ? localAsset('ui/battle', 'bg_team_border') : null;
  const columns = measured ? layout.columns : 1;
  const style = list ? `--team-columns:${columns};--team-rows:${Math.ceil(players.length / columns)}` : undefined;
  const row = (p) => html`<${TeamRow} key=${p.playerId} p=${p} pub=${pub} myId=${myId} watching=${watching} onWatch=${onWatch} observe=${observe} halves=${halves} clicks=${clicks} spMark=${spMarks?.get(p.playerId) || null}
    selfLive=${selfLive} cap=${cap} uniteLocal=${uniteLocal} team=${team} frameArt=${frameArt} list=${list} bubble=${bubbles?.get(p.playerId) || null} />`;
  return html`<aside ref=${panelRef} class=${cx('team', `team--${density}`, list && columns > 1 && 'team--wide', pools && 'team--pools', !rosterOpen && 'is-folded', rosterOpen && 'is-open')} style=${style} aria-label=${t('同盟成员')}>
    <div ref=${headerRef} class="team__header">
      <button type="button" class="team__toggle" aria-expanded=${String(rosterOpen)} aria-controls="team-roster" onClick=${() => setRosterOpen(on => !on)}>
        <${Icon} name="users" /><span>${t('同盟成员')}</span><b class="num">${players.length}</b><${Icon} name="chevronRight" />
      </button>
    </div>
    <div ref=${noticeRef} class="team__notice"><${RevivalNotice} pub=${pub} /><${KickVoteNotice} pub=${pub} /></div>
    <div class="team__players" id="team-roster" hidden=${!rosterOpen}>${pools
      ? pools.map((pool) => html`<section key=${pool.id ?? 'rest'} class=${cx('team__pool', pool.mine && 'is-mine')}><${PoolHead} pool=${pool} />${pool.players.map(row)}</section>`)
      : players.map(row)}</div>
  </aside>`;
}
