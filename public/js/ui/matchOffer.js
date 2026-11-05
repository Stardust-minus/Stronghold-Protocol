// 确认入场 — the public queue's offer as a full-screen takeover (2026-11-05, the user: 「匹配到人之后需要添加动效和音效。重写现在
// 的静态确认页面」; on a first version in the side column: 「感觉有点小丑」 — bigger, the whole screen, with the feel of the genre's
// match-found screens 「可以整体参考瓦洛兰特（无畏契约）和卡拉比丘」, as conventions only; docs/history/0.3.3.md 「匹配成功确认页」).
// Mounted once at the app root (main.js App), so it covers whatever is up when an offer arrives — 同盟集结 in the lobby, a
// friend room's party queue (screens/room.js), a dialog. Every drawing and motion is original, mint on dark:
//   arrival   — the page dims and blurs behind a fine grid; a mint block snaps open sideways from the centre, split by a
//               glitch line, and collapses into the heavy 匹配成功 headline as the arrival impact lands (OFFER_RISE_S after
//               the cue starts, ui/offerSynth.js) with a 2 px shake; the angled plate above reads 队友已集结 · PUBLIC
//               MATCHMAKING; the seat slots rise into one straight row in a staggered wave while particles drift in;
//   seats     — one tall slim slot per doctor the game needs (`required`; one row on a desktop — 20 make one narrow row —,
//               two rows on a phone for more than 8): mine carries my 名片 background and avatar (this browser's card,
//               ui/playerCard.js), 你 and an outline; the others a dim silhouette. A slot flashes to bright mint-white with a
//               frame highlight as an acceptance arrives (the server sends counts, never who — they light in order);
//   countdown — big numerals under the row and a thin bar draining with the window (offerWindow), amber and pulsing for
//               the last OFFER_URGENT_S seconds while I have not confirmed;
//   actions   — 确认入场, wide, right under the numerals (a slow glow, a shine; it has the focus), 退出本次匹配 quieter under
//               it (重试取消 after a failed cancellation); once I confirmed: 剩余 N 秒 · 等待其他博士;
//   info      — the chip line at the bottom: difficulty, seats (不自动补 AI), the friend party, the rules summary, 完整规则;
//   found     — everyone in (allocationPending, or the count full): the slots flash in sequence, 搜寻成功！ slams in, a
//               line-art emblem draws itself while 全员已确认，正在连接游戏节点; kept OFFER_FOUND_MS over the room once matched;
//   broken    — the offer fell apart (the ticket waits again, or I am out with the server's reason): 本次匹配未成立 and the
//               reason, the slots drop, kept OFFER_BROKEN_MS and closed by a reverse wipe; leaving by choice wipes out at once.
// The sounds are ui/offerCues.js's (one store listener). Under reduced motion (device.js reducedMotion,
// html.sp-reduced-motion) nothing moves, and only 本次匹配未成立 (its reason) is kept on screen.
// What is shown comes from queue.state (server/matchmaking.js state(): offerId, deadline, acceptedCount, accepted, required,
// difficulty, partySize, experimental, allocationPending, reason) through one tracker the store drives (installOfferStage,
// main.js), so the moments after an offer ends survive the screen change underneath. Styles: css/screens/match-offer.css.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS } from '../../../shared/constants.js';
import { isPlayerCapacity } from '../../../shared/playerCapacity.js';
import { html, Icon, Modal, Button, DifficultyIcon, AvatarFrame, useTicker } from './components.js';
import { experimentalSummary } from './experimental.js';
import { NameCardLayer } from './namecards.js';
import { CardAvatarLive } from './avatarLive.js';
import { cardAvatarUrl } from './seatArt.js';
import { useMyCard } from './playerCard.js';
import { reducedMotion } from './device.js';
import { queueTime, offerReasonText, MATCHING_RULES, EXPERIMENTAL_RULES } from './matchmaking.js';
import { useStore, serverNow, shallowEqual } from '../store.js';
import { data, useData } from '../data.js';
import { net } from '../net.js';
import { queueCancellation } from '../queueCancellation.js';
import { toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';

const cx = (...a) => a.filter(Boolean).join(' ');

/** The last seconds of the window that turn the countdown urgent (and tick, ui/offerCues.js). */
export const OFFER_URGENT_S = 5;
/** How long 本次匹配未成立 stays; 搜寻成功 over the room after matched; the cut-away after leaving by choice. */
export const OFFER_BROKEN_MS = 1700;
export const OFFER_FOUND_MS = 800;
export const OFFER_LEAVE_MS = 320;

/** Whether this page shows motion: neither the system setting nor the class device.js sets asks for less. */
export function offerMotion(doc = globalThis.document) {
  return !reducedMotion() && !doc?.documentElement?.classList?.contains('sp-reduced-motion');
}

/** The doctors an offer needs (queue.required), else 4. */
export const offerSize = (q) => (isPlayerCapacity(q?.required) ? q.required : 4);

/** Everyone in: the server prepares the game (allocationPending), or the count is full with mine among it. */
export function offerFull(q) {
  return q?.state === 'offered' && (q.allocationPending === true
    || (q.accepted === true && Number.isSafeInteger(q.acceptedCount) && q.acceptedCount >= offerSize(q)));
}

const windows = new Map();
/**
 * The confirmation window of an offer in seconds: what was left when this page first saw it (≥ 1), remembered per
 * offerId for the page's life (a re-mounted takeover or a reconnect keeps the bar where it was). Bounded: the 16 latest.
 * @param {any} offerId @param {number} remaining seconds left now
 */
export function offerWindow(offerId, remaining) {
  const left = Math.max(1, Math.ceil(Number(remaining) || 0));
  if (offerId == null) return left;
  const key = String(offerId);
  if (!windows.has(key)) {
    windows.set(key, left);
    while (windows.size > 16) windows.delete(windows.keys().next().value);
  }
  return Math.max(windows.get(key), left);
}

/**
 * The seat cards: `n` doctors, the first mine. Lit: mine once I confirmed; the others in order, as many as
 * acceptedCount holds besides me.
 * @param {number} n required @param {number} acceptedCount @param {boolean} mine queue.accepted
 * @returns {Array<{ me: boolean, lit: boolean }>}
 */
export function offerSeats(n, acceptedCount, mine) {
  const size = Math.max(1, Math.min(64, Number.isSafeInteger(n) ? n : 1));
  const count = Math.max(0, Math.min(size, Number.isSafeInteger(acceptedCount) ? acceptedCount : 0));
  const others = Math.max(0, Math.min(size - 1, count - (mine ? 1 : 0)));
  return Array.from({ length: size }, (_, i) => (i === 0 ? { me: true, lit: mine === true } : { me: false, lit: i <= others }));
}

/**
 * The countdown: seconds left, the share of the window still left (0..1), urgent for the last OFFER_URGENT_S seconds
 * before my accept.
 * @param {number} seconds queueTime of the offer @param {number} total offerWindow @param {boolean} accepted
 */
export function offerClock(seconds, total, accepted) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const all = Math.max(1, Number(total) || 1);
  return { seconds: s, frac: Math.max(0, Math.min(1, s / all)), urgent: !accepted && s > 0 && s <= OFFER_URGENT_S };
}

/**
 * The seat row's columns: one row on a desktop (20 make one narrow row); `compact` (a phone, landscape or portrait):
 * one row up to 8, two rows above (20 → 10 a row).
 * @param {number} n @param {boolean} [compact]
 */
export function offerColumns(n, compact = false) {
  return compact && n > 8 ? Math.ceil(n / 2) : n;
}

/**
 * One step of the tracker (pure but for `m`): the last offer seen (`m.offer`) and the moment kept after it ended
 * (`m.hold` = { stage, offerId, queue, reason, until }):
 *   matched                                        → 'found' (OFFER_FOUND_MS; none without motion)
 *   back in the queue, or out with a reason (not one's own 已取消匹配) → 'broken' (OFFER_BROKEN_MS; its reason)
 *   out by choice (idle, cancelled)                → 'leave' (OFFER_LEAVE_MS; none without motion)
 * A new offer drops a kept moment; a later queue update of the same waiting ticket keeps it.
 * @param {{ offer: any, hold: any }} m @param {any} queue store queue @param {number} now ms @param {boolean} motion
 */
export function offerTrack(m, queue, now, motion) {
  const st = queue?.state;
  if (st === 'offered' && queue.offerId != null) {
    if (m.hold && m.hold.offerId !== queue.offerId) m.hold = null;
    m.offer = queue;
    return m;
  }
  const last = m.offer;
  m.offer = null;
  if (!last) {
    if (st !== 'queued' && st !== 'idle') m.hold = null;
    return m;
  }
  const n = offerSize(last);
  if (st === 'matched') {
    m.hold = motion ? { stage: 'found', offerId: last.offerId, queue: { ...last, accepted: true, acceptedCount: n }, reason: null, until: now + OFFER_FOUND_MS } : null;
  } else if (st === 'queued' || (st === 'idle' && typeof queue.reason === 'string' && queue.reason !== 'cancelled')) {
    m.hold = { stage: 'broken', offerId: last.offerId, queue: last, reason: queue.reason ?? null, until: now + OFFER_BROKEN_MS };
  } else {
    m.hold = motion ? { stage: 'leave', offerId: last.offerId, queue: last, reason: null, until: now + OFFER_LEAVE_MS } : null;
  }
  return m;
}

/**
 * What the takeover shows now (pure): the standing offer ('offer', or 'found' once everyone is in), else the kept moment
 * while it lasts, else null.
 * @param {{ offer: any, hold: any }} m @param {any} queue @param {number} now
 * @returns {null|{ stage: 'offer'|'found'|'broken'|'leave', queue: any, reason: string|null, held?: boolean }}
 */
export function offerView(m, queue, now) {
  if (queue?.state === 'offered' && queue.offerId != null) return { stage: offerFull(queue) ? 'found' : 'offer', queue, reason: queue.reason ?? null };
  const h = m?.hold;
  return h && h.until > now ? { stage: h.stage, queue: h.queue, reason: h.reason, held: true } : null;
}

const track = { offer: null, hold: null };
const watchers = new Set();
let expiry = null;
const notify = () => { for (const fn of [...watchers]) fn(); };

/**
 * Drive the tracker from the store (main.js, once): every queue update in order, so a kept moment never depends on which
 * screen renders first. Returns the uninstaller.
 * @param {{ subscribe: Function, getState: () => any, motion?: () => boolean, now?: () => number }} deps
 */
export function installOfferStage({ subscribe, getState, motion = offerMotion, now = () => Date.now() }) {
  const step = (q) => {
    const before = track.hold;
    offerTrack(track, q, now(), motion());
    if (track.hold !== before) {
      clearTimeout(expiry);
      expiry = track.hold ? setTimeout(notify, Math.max(0, track.hold.until - now()) + 20) : null;
    }
  };
  step(getState().queue);
  const off = subscribe((s, prev) => { if (s.queue !== prev?.queue) step(s.queue); });
  return () => { off(); clearTimeout(expiry); track.offer = null; track.hold = null; };
}

/** The takeover's view, re-rendered when a kept moment runs out. */
export function useOfferView() {
  const queue = useStore((s) => s.queue);
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((x) => x + 1);
    watchers.add(fn);
    return () => watchers.delete(fn);
  }, []);
  return offerView(track, queue, Date.now());
}

/** The takeover (main.js App): nothing while no offer stands or is being left. */
export function OfferTakeover() {
  const view = useOfferView();
  if (!view) return null;
  return html`<${OfferScreen} key=${String(view.queue?.offerId ?? 'offer')} view=${view} />`;
}


/** A silhouette for a doctor not known yet (a head and shoulders, cut from the slot's own light). */
function Silhouette() {
  return html`<svg class="mo-seat__sil" viewBox="0 0 100 120" aria-hidden="true" focusable="false">
    <circle cx="50" cy="40" r="19" fill="currentColor" />
    <path d="M14 120c0-26 16-44 36-44s36 18 36 44z" fill="currentColor" />
  </svg>`;
}

/** The connecting motif: an original line-art emblem (an octagon, a crenellated tower, a base) that draws itself. */
function Emblem() {
  return html`<svg class="mo__emblem" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <path pathLength="1" style="--k:0" d="M50 4 82 18 96 50 82 82 50 96 18 82 4 50 18 18Z" />
    <path pathLength="1" style="--k:1" d="M34 72V46h6v-7h6v7h8v-7h6v7h6v26Z" />
    <path pathLength="1" style="--k:2" d="M24 79h52M30 85h40" />
    <path pathLength="1" style="--k:3" d="M10 50h12M78 50h12M50 10v8" />
  </svg>`;
}

/** One seat slot; `i` its place (the wave's offset), mine with this browser's 名片 and avatar. */
function SeatSlot({ seat, i, me, card, face, m }) {
  return html`<li class=${cx('mo-seat', seat.me && 'is-me', seat.lit && 'is-lit')} style=${`--i:${Math.min(i, 19)};--w:${(((i * 7) % 5) - 2)}`}
      title=${seat.me ? t('你') : seat.lit ? t('已确认') : t('等待确认')} data-testid=${seat.me ? 'offer-seat-me' : null}>
    <div class=${cx('mo-seat__body', seat.me && card?.bg && 'has-nc')}>
      ${seat.me && card?.bg ? html`<${NameCardLayer} card=${card.bg} y=${card.bgY} x=${card.bgX} zoom=${card.bgZoom} />` : null}
      <span class="mo-seat__face">${seat.me
        ? html`<${AvatarFrame} size="lg" name=${me.name} src=${face} seat=${0} self=${true}
            live=${html`<${CardAvatarLive} m=${m} avatar=${card?.avatar} look=${card?.avatarLook || ''} />`} />`
        : html`<${Silhouette} />`}</span>
      ${seat.me ? html`<span class="mo-seat__name">${me.name || t('博士')}</span>` : null}
      <span class="mo-seat__ok" aria-hidden="true"><${Icon} name="check" /></span>
    </div>
    ${seat.me ? html`<span class="mo-seat__you">${t('你')}</span>` : null}
  </li>`;
}

/** The particles: fixed places, so every render draws the same field; each drifts in towards the seat row. */
const DUST = Array.from({ length: 26 }, (_, k) => {
  const x = (k * 37 + 7) % 100, y = (k * 53 + 13) % 100;
  return { x, y, dx: (50 - x) * 0.45, dy: (52 - y) * 0.45, d: 3.2 + ((k * 7) % 9) * 0.45, s: ((k * 13) % 10) * 0.42, z: 1 + (k % 3) };
});

/**
 * The takeover's screen for one offer.
 * @param {{ view: { stage: 'offer'|'found'|'broken'|'leave', queue: any, reason: string|null, held?: boolean } }} props
 */
function OfferScreen({ view }) {
  useTicker(250);
  useData('assets');
  const { stage, queue } = view;
  const online = useStore((s) => s.connection.status === 'online');
  const me = useStore((s) => s.me, shallowEqual);
  const cancellation = useStore((s) => s.ui.queueCancel);
  const card = useMyCard();
  const [busy, setBusy] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const go = useRef(null);
  useEffect(() => () => { mounted.current = false; }, []);
  const live = stage === 'offer';
  const n = offerSize(queue);
  const mine = queue?.accepted === true || stage === 'found';
  const count = stage === 'found' ? n : Number.isInteger(queue?.acceptedCount) ? queue.acceptedCount : 0;
  const seconds = queue?.state === 'offered' ? queueTime(queue, serverNow()) : 0;
  const total = offerWindow(queue?.offerId, seconds);
  const clock = offerClock(seconds, total, mine);
  const seats = offerSeats(n, count, mine);
  const cancelling = live && cancellation?.ticketId === queue?.ticketId && ['sending', 'recovering', 'confirming'].includes(cancellation?.status);
  const cancelFailed = live && cancellation?.ticketId === queue?.ticketId && cancellation?.status === 'failed';
  // the bar drains on the compositor: one animation over the whole window, started where this offer stands (once per
  // offer, so the quarter-second re-renders never restart it)
  const drain = useMemo(() => `--mo-total:${total}s;--mo-start:${-(total - Math.max(0, Number(seconds) || 0))}s`, [queue?.offerId]);
  // the hero button has the focus while it is there: Enter / Space confirm
  useEffect(() => { if (live && !queue?.accepted) go.current?.querySelector?.('button')?.focus?.({ preventScroll: true }); }, [live, queue?.accepted]);
  const d = DIFFICULTIES.includes(queue?.difficulty) ? queue.difficulty : null;
  const act = async (kind) => {
    if (!live || !online || inFlight.current || cancelling || !queue?.ticketId || (kind === 'accept' && (queue.accepted || clock.seconds === 0))) return;
    if (kind === 'cancel') { queueCancellation.cancel(queue.ticketId); return; }
    inFlight.current = true;
    setBusy(kind);
    try {
      await net.request('queue.accept', { ticketId: queue.ticketId, offerId: queue.offerId });
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const head = stage === 'found' ? t('搜寻成功！') : stage === 'broken' ? t('本次匹配未成立') : t('匹配成功');
  const plate = stage === 'found' ? t('全员已确认') : stage === 'broken' ? null : t('队友已集结');
  const micro = stage === 'found' ? 'CONNECTING' : stage === 'broken' ? 'MATCH LOST' : 'PUBLIC MATCHMAKING';
  const reason = offerReasonText(view.reason);
  // the line under the countdown: once I confirmed the button gives way to the wait; the end states say what happens
  const wait = stage === 'found' ? t('全员已确认，正在连接游戏节点')
    : stage === 'broken' ? reason || t('本次匹配未成立')
    : queue?.accepted ? t('剩余 {seconds} 秒 · 等待其他博士', { seconds: clock.seconds }) : null;
  const note = !live ? null : cancelling ? t('正在确认取消，等待服务器同步…') : !online ? t('连接中断，重连后同步匹配状态')
    : queue?.accepted ? null : t('请在 {seconds} 秒内确认入场', { seconds: clock.seconds });
  const rules = [t('{n} 名真人按相同人数模式和难度匹配，不自动补 AI；好友小队保持整队。', { n }), t(MATCHING_RULES), t(EXPERIMENTAL_RULES)];
  const size = n <= 4 ? 's' : n <= 8 ? 'm' : 'l';
  const face = cardAvatarUrl(card.avatar, undefined, card.avatarLook);
  const screen = html`<div class=${cx('mo', `is-${stage}`, view.held && 'is-held', clock.urgent && live && 'is-urgent', queue?.accepted && 'is-accepted', !online && 'is-offline')}
      role="dialog" aria-modal="true" aria-label=${t('确认入场')} data-testid="match-offer" data-stage=${stage} data-player-capacity=${n} data-size=${size}
      style=${`${drain};--mo-n:${n};--mo-cols:${offerColumns(n)};--mo-cols-c:${offerColumns(n, true)};--d-color:${d ? DIFFICULTY_COLORS[d] : 'var(--mint-400)'}`}>
    <div class="mo__veil" aria-hidden="true"><i class="mo__grid"></i><i class="mo__lines"></i>
      <span class="mo__dust">${DUST.map((p, k) => html`<i key=${k} style=${`--x:${p.x}%;--y:${p.y}%;--dx:${p.dx}vw;--dy:${p.dy}vh;--dur:${p.d}s;--del:-${p.s}s;--z:${p.z}`}></i>`)}</span>
    </div>
    <i class="mo__out" aria-hidden="true"></i>
    <div class="mo__stage">
      <div class="mo__plate"><span class="mo__plate-tag">${micro}</span>${plate ? html`<b>${plate}</b>` : null}</div>
      <div class="mo__head">
        <i class="mo__block" key=${`block-${stage}`} aria-hidden="true"><i class="mo__glitch"></i><i class="mo__glitch mo__glitch--b"></i></i>
        <h2 class=${cx('mo__title', stage === 'broken' && 'mo__title--long')} aria-live="assertive"><span key=${stage}>${head}</span></h2>
      </div>
      <ol class="mo__seats" aria-label=${t('{acceptedCount} / {n} 位博士已确认', { acceptedCount: count, n })}>
        ${seats.map((s, i) => html`<${SeatSlot} key=${i} seat=${s} i=${i} me=${me} card=${card} face=${face} m=${data.get('assets')} />`)}
      </ol>
      <p class="mo__count num" data-testid="offer-count">${t('{acceptedCount} / {n} 已确认', { acceptedCount: count, n })}</p>
      <div class="mo__timer" role="timer" aria-label=${t('剩余{remain}秒', { remain: clock.seconds })}>
        ${stage === 'found' ? html`<${Emblem} />`
          : stage === 'broken' || stage === 'leave' ? html`<span class="mo__num mo__num--x num">--</span>`
          : html`<b class="mo__num num" key=${clock.urgent ? clock.seconds : 'n'}>${clock.seconds}</b>
            <i class="mo__bar" style=${`--frac:${clock.frac}`}><i></i></i>`}
      </div>
      <div class="mo__act">
        ${live && !queue?.accepted ? html`<span class="mo__go-wrap" ref=${go}><${Button} variant="primary" size="lg" class="mo__go" data-testid="offer-accept"
            disabled=${!online || !!busy || cancelling || clock.seconds === 0} loading=${busy === 'accept'} onClick=${() => act('accept')}>${t('确认入场')}<//></span>` : null}
        ${wait ? html`<p class=${cx('mo__wait', stage === 'broken' && 'is-bad')} role="status" data-testid=${queue?.accepted && live ? 'offer-done' : stage === 'broken' ? 'offer-reason' : null}>
          ${live && queue?.accepted ? html`<${Icon} name="check" />` : null}${wait}</p>` : null}
        ${note ? html`<p class="mo__note" role="status">${note}</p>` : null}
        ${cancelFailed ? html`<p class="mo__warn" role="status">${t('尚未确认取消，请恢复连接后重试；下方仍显示服务器最后确认的匹配状态。')}</p>` : null}
        ${live && reason ? html`<p class="mo__warn">${reason}</p>` : null}
        ${live ? html`<${Button} variant="ghost" size="md" class="mo__leave" data-testid="offer-cancel" disabled=${!online || !!busy || cancelling} loading=${cancelling}
          onClick=${() => act('cancel')}>${cancelFailed ? t('重试取消') : t('退出本次匹配')}<//>` : null}
      </div>
      <p class="mo__chips">
        ${d ? html`<span class="mo-chip mo-chip--diff"><${DifficultyIcon} difficulty=${d} />${t(DIFFICULTY_NAMES[d])}</span>` : null}
        <span class="mo-chip">${t('{n} 名真人 · 不自动补 AI', { n })}</span>
        ${queue?.partySize > 1 ? html`<span class="mo-chip">${t('{n} 人好友小队', { n: queue.partySize })}</span>` : null}
        <span class="mo-chip mo-chip--rules matchmaking__options">${experimentalSummary(queue?.experimental)}</span>
        ${live ? html`<button type="button" class="mo__link" onClick=${() => setRulesOpen(true)}>${t('完整规则')}</button>` : null}
      </p>
    </div>
  </div>`;
  // the rules dialog beside the takeover, never inside its transforms (the wipe, the shake)
  return html`${screen}${rulesOpen ? html`<${Modal} open=${true} title=${t('多人匹配规则')} micro="MATCHMAKING RULES"
      ariaLabel=${t('多人匹配规则')} trapFocus=${true} class="lobby-dialog mo-rules" onClose=${() => setRulesOpen(false)}
      actions=${html`<${Button} icon="close" onClick=${() => setRulesOpen(false)}>${t('关闭说明')}<//>`}>
    ${rules.map((p, i) => html`<p key=${i} class="modal__text">${p}</p>`)}
  <//>` : null}`;
}
