// The settlement flow of a match on screen (the event video 11:39–12:32; the 2026-10-14 UI package by 雨千代chiyo, ported
// 2026-10-14 with the fork's own pieces kept): a radar intro, then two pages.
//   个人战报 (SelfPage): my own outcome (模拟完成, or 模拟中断 when the team lost or I was out before the end), the rounds I
//     passed, the leaders I helped defeat, my final lineup (ten slots: tier, elite level and gear of each operator), my
//     bonds and their layers, my plate with the trophies, and the level settlement (the LV bar filling with this match's
//     experience) — then 下一步. The official 卫戍认证 / 每日防卫目标 strip is left out: the owner's servers have no such
//     currency (2026-10-13).
//   同盟 (TeamPage): one card per seat (its ace operator's art, the 评语, the rounds passed, the player plate with its
//     名片底图 and trophy level — room.state seats[].card, ui/playerCard.js — and the trophies this match brought), the
//     team's outcome and rounds, the match time and date, 数据详情 (the full report: screens/result.js ResultView) and
//     返回同盟 / 返回大厅. The package's 加好友 / 点赞 and #编号 need its accounts service: left out (no accounts here,
//     the owner, 2026-10-14).
// The LV is counted from this browser's match records (ui/stats.js, like 成就统计). A match's experience is its
// settlement row's `reward`; 300 a level, LV 60 at most. Everything is drawn here (SVG / CSS);
// only the data's own art (operator portraits, item / bond / title / enemy icons, avatars) comes from the resource pack.
// A spectator seat (no row of its own) opens on the team page. The stats page re-views a stored match with ResultView.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, DifficultyTag } from '../ui/components.js';
import { useGameData, Img, Sprite, PromotionIcon, PlayerAvatar, BondGlyph, BandIcon } from '../ui/gameComponents.js';
import { normalizeResult, diyRecordFor, cardStandIn, standInForText } from '../ui/gameLogic.js';
import { data } from '../data.js';
import { itemIconUrl, enemyIconUrl, titleIconUrl } from '../ui/assetUrls.js';
import { store, useStore, emptyMatch } from '../store.js';
import { audio } from '../audio.js';
import { sentText } from '../ui/lang.js';
import { TrophyBadge } from '../ui/trophies.js';
import { reducedMotion } from '../ui/device.js';
import { recordId, selfRowOf, peekStatsRecords, recordsOfSeason } from '../ui/stats.js';
import { NameCardLayer } from '../ui/namecards.js';
import { useMyCard } from '../ui/playerCard.js';
import { appearanceRecord } from '../ui/skinAssets.js';
import { VersionTag } from '../ui/pluginTag.js';
import { shownVersion, seasonOf } from '../versions.js';
import { ResultView, resultBonds } from './result.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const pad2 = (n) => String(Math.max(0, Math.trunc(n) || 0)).padStart(2, '0');
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

/** Experience a level and the top level of the LV bar. */
export const LV_EXP = 300;
export const LV_MAX = 60;
/** The radar intro, and the page change after 下一步. */
export const INTRO_MS = 1500;
const LEAVE_MS = 380;

/** LV of an experience total: `exp` is the progress into the level (the full bar at the top level). */
export function levelOf(total) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const lv = Math.min(LV_MAX, 1 + Math.floor(n / LV_EXP));
  return lv >= LV_MAX ? { lv: LV_MAX, exp: LV_EXP, max: true } : { lv, exp: n % LV_EXP, max: false };
}

/**
 * This match's LV bar from the local records (ui/stats.js, any order; the match's own record — `id` — and anything after
 * it left out). A match's experience is the settlement's per-player `reward` (server/match/results.js rewardFor: the
 * rounds passed × the difficulty and mode factors). Returns the totals before and after this match and my trophies so far.
 * @param {any[]} records
 * `season` (DESIGN §35.23): only the records of that activity count (null: every record).
 * @param {{ id?: string|null, exp?: number, trophies?: number, at?: number, season?: string|null }} cur
 */
export function levelProgress(records, { id = null, exp = 0, trophies = 0, at = Date.now(), season = null } = {}) {
  const int = (v) => Math.max(0, Math.round(Number(v) || 0));
  records = recordsOfSeason(records, season);
  let total = 0;
  let cups = 0;
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || rec.id === id || !Number.isFinite(rec.t) || rec.t > at) continue;
    const row = selfRowOf(rec);
    total += int(row?.reward);
    cups += int(row?.trophies);
  }
  const gain = int(exp);
  return { gain, before: total, after: total + gain, trophies: cups + int(trophies) };
}

// ---- small facts --------------------------------------------------------------------------------------------------------

/** Read the resolved chess / backup form, including the active version or plugin's status (#811). */
export function opLevel(rec) {
  return { phase: rec?.status?.phase, level: rec?.status?.level ?? '—' };
}

/** The ace of a lineup — the team card's art: the highest tier, elite first, the earliest on the board. */
export function aceOf(lineup) {
  let best = null;
  (Array.isArray(lineup) ? lineup : []).forEach((u) => {
    if (!u || u.kind === 'token') return;
    const s = (Number(u.tier) || 0) * 2 + (u.golden ? 1 : 0);
    if (!best || s > best.s) best = { u, s };
  });
  return best ? best.u : null;
}

/** 00时42分24秒 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return t('{h}时{m}分{s}秒', { h: pad2(s / 3600), m: pad2((s % 3600) / 60), s: pad2(s % 60) });
}

/** 2025/12/11 07:51 (local time) */
export function fmtDate(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Whether a settlement row cleared the match: the server's per-row `victory` (team won AND still in), else derived. */
export function rowCleared(raw, row, victory) {
  if (typeof raw?.victory === 'boolean') return raw.victory;
  return !!victory && row?.alive !== false && !row?.left;
}

// ---- hooks ------------------------------------------------------------------------------------------------------------

/** A number counting from `from` to `to` (ease-out) once `run` holds; timers, not frames, so a hidden tab still ends. */
function useCountUp(to, { ms = 700, delay = 0, from = 0, run = true } = {}) {
  const target = Math.round(Number(to) || 0);
  const start = Math.round(Number(from) || 0);
  const [v, setV] = useState(() => (reducedMotion() ? target : start));
  useEffect(() => {
    if (!run) return undefined;
    if (reducedMotion() || target === start) { setV(target); return undefined; }
    const t0 = Date.now() + delay;
    const id = setInterval(() => {
      const k = Math.min(1, Math.max(0, (Date.now() - t0) / ms));
      setV(Math.round(start + (target - start) * (1 - (1 - k) ** 3)));
      if (k >= 1) clearInterval(id);
    }, 32);
    return () => clearInterval(id);
  }, [target, start, run]);
  return v;
}

/** Scale the 1920×1080 stage (19.2rem × 10.8rem) to fit the screen: sets --k on the element. */
function useStageFit(ref) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 100;
      const k = Math.min(el.clientWidth / (19.2 * rem), el.clientHeight / (10.8 * rem));
      el.style.setProperty('--k', String(Math.max(0.3, Math.min(1, k || 1))));
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    addEventListener('resize', fit);
    return () => { ro?.disconnect(); removeEventListener('resize', fit); };
  }, []);
}

// ---- drawn pieces (original shapes) ---------------------------------------------------------------------------------

function Logo() {
  return html`<div class="slogo" aria-hidden="true">
    <${Sprite} k="entry/season_logo_settle" class="slogo__img" fallback=${html`<svg class="slogo__mark" viewBox="0 0 60 60">
      <rect x="1" y="1" width="58" height="58" fill="none" stroke="currentColor" stroke-width="2" />
      <path d="M30 10 50 46H10z" fill="none" stroke="currentColor" stroke-width="3" /><path d="M30 22 40 40H20z" fill="currentColor" /></svg>`} />
    <span class="slogo__txt"><svg viewBox="0 0 40 30" class="slogo__knot"><path d="M8 4h10v8H8zM22 4h10v8H22zM8 18h10v8H8zM22 18h10v8H22z" fill="none" stroke="currentColor" stroke-width="2.4" /><path d="M2 2v26M38 2v26" stroke="currentColor" stroke-width="2" /></svg>
      <b>STRONGHOLD<br />PROTOCOL</b></span>
  </div>`;
}

const CLOCK = 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2.2a7.8 7.8 0 1 0 0 15.6 7.8 7.8 0 0 0 0-15.6zM11 6.5h2v5l3.6 2.1-1 1.7L11 12.6z';
const CALENDAR = 'M6 2h2v2h8V2h2v2h3v18H3V4h3zm-1 7v11h14V9zm2 2h4v4H7z';
const SvgPath = ({ d, cls }) => html`<svg class=${cx('sico', cls)} viewBox="0 0 24 24" aria-hidden="true"><path d=${d} fill-rule="evenodd" /></svg>`;

const AIM = [682, 345];
const RAYS = [[1057, 192], [1410, 312], [1080, 402], [960, 585], [1080, 697], [900, 735], [682, 615]];
const CROSSES = [[930, 240], [845, 640]];

/**
 * The page's terrain: noise land (teal; red-dark for 模拟中断), a hot zone round the target point, the target point and
 * the rays to the lineup. Stage coordinates (1920×1080), drawn wider so a wide screen's margins are covered.
 */
function SettleMap({ lose, seed }) {
  const s = Math.abs(Math.trunc(Number(seed) || 7)) % 997;
  const id = useMemo(() => `sm${Math.random().toString(36).slice(2, 8)}`, []);
  // the hillshade (a lit height noise) tinted: teal land and an orange zone, or slate and red for 模拟中断
  const land = lose ? '.12 0 0 0 .02  .26 0 0 0 .05  .27 0 0 0 .06  0 0 0 0 1' : '.1 0 0 0 0  .56 0 0 0 .05  .5 0 0 0 .06  0 0 0 0 1';
  const zone = lose ? '.82 0 0 0 .1  .12 0 0 0 .02  .1 0 0 0 .02  0 0 0 0 1' : '.86 0 0 0 .12  .5 0 0 0 .05  .08 0 0 0 0  0 0 0 0 1';
  const noise = (k, steps) => html`<filter id=${id + k} x="-640" y="-360" width="3200" height="1800" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.0016 0.0022" numOctaves="3" seed=${s} result="n" />
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.5 0 0 0 -.25" result="a" />
    <feComponentTransfer in="a" result="m"><feFuncA type="discrete" tableValues=${steps} /></feComponentTransfer>
    <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="5" seed=${s + 17} result="h" />
    <feDiffuseLighting in="h" surfaceScale="34" diffuseConstant="1.2" lighting-color="#fff" result="sh"><feDistantLight azimuth="235" elevation="28" /></feDiffuseLighting>
    <feColorMatrix in="sh" type="matrix" values=${k === 'l' ? land : zone} result="c" />
    <feComposite in="c" in2="m" operator="in" />
  </filter>`;
  return html`<svg class="smap" viewBox="-640 -360 3200 1800" aria-hidden="true">
    <defs>
      ${noise('l', '0 0 0 0 0 1 1 1 1 1')}
      ${noise('z', '0 0 0 0 0 0 1 1 1 1')}
      <radialGradient id=${`${id}g`} cx=${AIM[0] - 40} cy=${AIM[1] - 30} r="560" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff" /><stop offset=".55" stop-color="#fff" stop-opacity=".85" /><stop offset="1" stop-color="#fff" stop-opacity="0" />
      </radialGradient>
      <mask id=${`${id}k`} maskUnits="userSpaceOnUse" x="-640" y="-360" width="3200" height="1800"><rect x="-640" y="-360" width="3200" height="1800" fill=${`url(#${id}g)`} /></mask>
    </defs>
    <rect class="smap__sea" x="-640" y="-360" width="3200" height="1800" />
    <rect x="-640" y="-360" width="3200" height="1800" filter=${`url(#${id}l)`} />
    <g mask=${`url(#${id}k)`}><rect class="smap__zone" x="-640" y="-360" width="3200" height="1800" filter=${`url(#${id}z)`} /></g>
    <g class="smap__rays">
      ${RAYS.map(([x, y], i) => {
        const mx = AIM[0] + (x - AIM[0]) * 0.5, my = AIM[1] + (y - AIM[1]) * 0.5;
        const a = (Math.atan2(y - AIM[1], x - AIM[0]) * 180) / Math.PI;
        return html`<g key=${i} style=${`--i:${i}`}>
          <line x1=${AIM[0]} y1=${AIM[1]} x2=${x} y2=${y} pathLength="1" />
          <path class="smap__arrow" d="M-11 -8 9 0 -11 8z" transform=${`translate(${mx} ${my}) rotate(${a + 180})`} />
          <circle class="smap__end" cx=${x} cy=${y} r="13" />
        </g>`;
      })}
      ${lose ? CROSSES.map(([x, y], i) => html`<path key=${`x${i}`} class="smap__x" d=${`M${x - 14} ${y - 14}l28 28M${x + 14} ${y - 14}l-28 28`} />`) : null}
    </g>
    <g class="smap__aim" transform=${`translate(${AIM[0]} ${AIM[1]})`}>
      <circle class="smap__glow" r="190" />
      <circle class="smap__ring smap__ring--o" r="118" />
      <circle class="smap__ring" r="72" />
      <circle class="smap__core" r="40" />
      ${lose ? html`<path class="smap__tri" d="M0 -22 20 14H-20z" /><path class="smap__tri-in" d="M0 -9 9 7H-9z" />`
        : html`<circle class="smap__dot" r="16" /><path class="smap__stripe" d="M-14 -4h28M-14 4h28" />`}
      <path class="smap__pin" d="M-102 0l14-9v18zM102 0l-14-9v18z" />
    </g>
    <g class="smap__label" transform=${`translate(${AIM[0] + 32} ${AIM[1] - 128})`}>
      <rect x="0" y="0" width="128" height="26" /><text x="64" y="18">TARGET POINT</text>
      <text class="smap__sub" x="0" y="52">STRONGHOLD PROTOCOL</text>
    </g>
  </svg>`;
}

// ---- the radar intro -------------------------------------------------------------------------------------------------

const SEAT_BOX = [[640, 355], [1145, 355], [640, 640], [1145, 640]];

function SettleIntro({ players, myId, lose, onDone }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const id = setTimeout(() => done.current(), INTRO_MS);
    const skip = (e) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done.current(); } };
    addEventListener('keydown', skip);
    return () => { clearTimeout(id); removeEventListener('keydown', skip); };
  }, []);
  // four boxes: the own group's four seats in a bigger room (an experimental one of up to 20, seats in groups of four),
  // numbered by their seats
  const mine = players.find((p) => p.playerId === myId);
  const base = Number.isInteger(mine?.seat) ? Math.floor(mine.seat / 4) * 4 : 0;
  const seats = SEAT_BOX.map((xy, i) => ({ xy, seat: base + i, p: players.find((p) => p.seat === base + i) || null }));
  return html`<div class=${cx('sintro', lose && 'is-lose')} data-testid="settle-intro" onClick=${() => done.current()}>
    <div class="settle__stage">
      <svg class="sintro__svg" viewBox="0 0 1920 1080" aria-hidden="true">
        <g class="sintro__frame">
          ${[[150, 160], [1770, 160], [150, 940], [1770, 940]].map(([x, y], i) => html`<path key=${i} d=${`M${x - 26} ${y}h52M${x} ${y - 26}v52`} />`)}
          <path d="M270 380v330M262 380h16M262 710h16M1650 380v330M1642 380h16M1642 710h16M0 540h270M1650 540h270" />
        </g>
        <circle class="sintro__ring" cx="960" cy="540" r="500" pathLength="1" />
        <path class="sintro__cross" d="M960 40v300M960 740v300" />
        <path class="sintro__bracket" d="M845 430h230M845 650h230M845 430v10M1075 430v10M845 650v-10M1075 650v-10" />
        ${seats.map(({ xy: [x, y], seat, p }, i) => html`<g key=${i} class=${cx('sintro__seat', !p && 'is-empty', p && (p.playerId === myId) && 'is-me', p && p.alive === false && 'is-out', p && p.left && 'is-left')} style=${`--i:${i}`}>
          <rect x=${x} y=${y} width="135" height="135" /><text x=${x + 14} y=${y + 40}>${pad2(seat + 1)}</text>
          <path class="sintro__hatch" d=${`M${x + 70} ${y + 135}l65-65M${x + 98} ${y + 135}l37-37M${x + 40} ${y + 135}l95-95`} />
        </g>`)}
        ${[[480, 200], [1310, 200], [480, 750], [1310, 750]].map(([x, y], i) => html`<g key=${`g${i}`} class="sintro__ghost" style=${`--i:${i}`}>
          <rect x=${x} y=${y} width="130" height="130" /><path d=${`M${x + 92} ${y + 104}h12v12h-12zM${x + 108} ${y + 104}h12v12h-12z`} /></g>`)}
        <g class="sintro__core"><rect x="892" y="472" width="136" height="136" /><text x="906" y="512">00</text></g>
        <text class="sintro__foot" x="960" y="985">RHODES ISLAND STRONGHOLD PROTOCOL</text>
      </svg>
      <${Logo} />
    </div>
  </div>`;
}

// ---- 个人战报 ----------------------------------------------------------------------------------------------------------

/** One unit of a lineup as the cards draw it (自选 pick / 补位 stand-in resolved as on the report's thumbnails). */
function unitView(u, gd) {
  const chess = u.kind === 'token' ? null : gd.chess(u.id);
  const dr = u.diy && chess ? diyRecordFor(chess, u.diy, { chess: data.get('chess'), backups: data.get('backups') }) : null;
  const si = !dr && chess ? cardStandIn(chess, { unit: u, backups: gd.backups }) : null;
  const rec = appearanceRecord(dr || si || chess, u.skinId);
  const tier = Math.max(0, Math.min(6, Number(u.tier) || Number(rec?.tier) || 0));
  return {
    rec,
    si,
    tier,
    golden: !!(u.golden ?? rec?.isGolden),
    name: rec?.name || '',
    title: si ? t('{name}（{note}）', { name: si.name, note: standInForText(chess.name) }) : (rec?.name || ''),
    items: (Array.isArray(u.items) ? u.items : []).map((id) => data.lookup('items', id)).filter(Boolean),
  };
}

function NoInfo() {
  return html`<span class="sop__noinfo"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M3 10h14" /></svg><small>NO INFO</small></span>`;
}

/** One lineup slot as a tall card (also the 成就统计 panel's 战果纪录, ui/achievements.js); `u` null = an empty slot. */
export function OpCard({ u, gd, i }) {
  if (!u) {
    return html`<div class="sop is-empty" style=${`--i:${i}`}>
      <span class="sop__art"><small>NO INFO</small></span>
      <span class="sop__slots"><i class="sop__slot"></i><i class="sop__slot"></i></span>
    </div>`;
  }
  const v = unitView(u, gd);
  const src = v.art || v.avatar;
  const lv = opLevel(v.rec);
  return html`<div class=${cx('sop', v.tier && `sop--t${v.tier}`, v.golden && 'is-golden')} style=${`--i:${i}`} title=${v.title}>
    <span class="sop__art"><${Img} src=${src} class=${v.art ? 'is-portrait' : 'is-avatar'} fallback=${html`<span class="sop__glyph">${[...(v.name || '?')][0]}</span>`} /></span>
    ${v.tier ? html`<b class="sop__tier">${ROMAN[v.tier]}</b>` : null}
    <span class="sop__lv"><${PromotionIcon} m=${gd.m} phase=${lv.phase} class="selite" /><b class="num">${lv.level}</b></span>
    ${v.si ? html`<span class="sop__si" data-standin=${v.si.charId}>${t('替补')}</span>` : null}
    <span class="sop__slots">${[0, 1].map((k) => {
      const it = v.items[k];
      return html`<i key=${k} class=${cx('sop__slot', it && 'has-item')} title=${it?.name || ''}>${it
        ? html`<${Img} src=${itemIconUrl(gd.m, it)} fallback=${html`<b>${[...(it.name || '?')][0]}</b>`} />` : html`<${NoInfo} />`}</i>`;
    })}</span>
  </div>`;
}

function BondBar({ bonds, gd }) {
  const list = resultBonds(bonds, (id) => gd.bond(id));
  const ref = useRef(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => { const el = ref.current; if (el) setMore(el.scrollWidth > el.clientWidth + 2); }, [list.length]);
  return html`<div class="sbonds">
    <span class="sbonds__mark" aria-hidden="true"><svg viewBox="0 0 64 40"><path d="M23 7h-7a13 13 0 0 0 0 26h7v-6h-7a7 7 0 0 1 0-14h7zM41 7h7a13 13 0 0 1 0 26h-7v-6h7a7 7 0 0 0 0-14h-7zM21 17h22v6H21z" /></svg><small>BONDS</small></span>
    <div class="sbonds__list" ref=${ref}>
      ${list.length ? list.map((b, i) => html`<span key=${b.bondId} class=${cx('sbond', b.active && 'is-on')} style=${`--i:${i}`} title=${gd.bond(b.bondId)?.name || b.bondId}>
        <span class="sbond__disc"><${BondGlyph} bondId=${b.bondId} /></span>${b.hideLayers ? html`<b class="num">—</b>` : html`<b class="num">${b.layers ?? 0}</b>`}</span>`)
        : html`<span class="sbonds__none">NO INFO</span>`}
    </div>
    ${more ? html`<button type="button" class="sbonds__more" aria-label=${t('更多')} onClick=${() => ref.current?.scrollBy({ left: 300, behavior: 'smooth' })}><${Icon} name="chevronRight" /></button>` : null}
  </div>`;
}

function ModePill({ r }) {
  return html`<span class="smode">
    ${r.difficulty ? html`<${DifficultyTag} difficulty=${r.difficulty} size="lg" />` : null}
  </span>`;
}

/** The level settlement: LV, the bar filling with this match's experience (LEVEL UP! / MAX), the experience gained. */
function LevelStrip({ prog }) {
  const gain = useCountUp(prog.gain, { ms: 650, delay: 300 });
  const total = useCountUp(prog.after, { ms: 1300, delay: 700, from: prog.before });
  const lv0 = levelOf(prog.before);
  const lv = levelOf(total);
  return html`<div class=${cx('slv', lv.max && 'is-max')} title=${t('等级：每局按通过回合与难度获得经验（本机记录）')}>
    <span class="slv__lv"><small>LV.</small><b class="num">${lv.lv}</b></span>
    <div class="slv__track">
      ${lv.lv > lv0.lv ? html`<span class="slv__up">LEVEL UP!</span>` : null}
      ${lv.max ? html`<span class="slv__max">MAX</span>` : null}
      <span class="slv__bar"><i style=${`width:${(lv.exp / LV_EXP) * 100}%`}></i></span>
      <span class="slv__meta"><span class="slv__gain">${t('本局经验')}<b class="num">+${gain}</b></span>
        ${lv.max ? null : html`<span class="slv__exp num"><b>${lv.exp}</b>/${LV_EXP}</span>`}</span>
    </div>
  </div>`;
}

function SelfPage({ r, raw, self, gd, prog, seed, onNext, version = null }) {
  const cleared = rowCleared(raw, self, r.victory);
  const [leaving, setLeaving] = useState(false);
  const nextRef = useRef(null);
  const rounds = useCountUp(self.roundsPassed, { ms: 700, delay: 350 });
  const boss = cleared && r.bossId ? gd.boss(r.bossId) : null;
  const hidden = cleared && r.hiddenReached && r.hiddenBossId ? gd.boss(r.hiddenBossId) : null;
  const medals = [boss && { kind: 'boss', rec: boss, done: true }, hidden && { kind: 'hidden', rec: hidden, done: r.hiddenCleared }].filter(Boolean);
  const slots = Array.from({ length: 10 }, (_, i) => self.lineup[i] || null);
  const card = useMyCard();
  useEffect(() => {
    audio.sfx(cleared ? 'settlementSucceed' : 'settlementFail');
    const sign = medals.length ? setTimeout(() => audio.sfx('settlementBossSign'), 900) : null;
    const focus = setTimeout(() => nextRef.current?.focus({ preventScroll: true }), 1800);
    return () => { clearTimeout(sign); clearTimeout(focus); };
  }, []);
  const next = () => {
    if (leaving) return;
    if (reducedMotion()) { onNext(); return; }
    setLeaving(true);
    setTimeout(onNext, LEAVE_MS);
  };
  return html`<section class=${cx('sself', cleared ? 'is-win' : 'is-lose', leaving && 'is-leaving')} data-testid="settle-self">
    <div class="settle__stage">
      <${SettleMap} lose=${!cleared} seed=${seed} />
      <div class="smap__fx" aria-hidden="true"></div>
      <${Logo} />
      <div class="sself__band">${self.bandId ? html`<${BandIcon} bandId=${self.bandId} size="lg" />` : html`<${PlayerAvatar} player=${self} self=${true} />`}<i aria-hidden="true"></i></div>
      <div class="sself__mode"><${ModePill} r=${r} /><${VersionTag} version=${version} class="sself__vertag" /></div>
      <h1 class="sself__title">${cleared ? t('模拟完成') : t('模拟中断')}</h1>
      <div class="sself__rounds"><span>${t('通过回合')}</span><b class="num">${rounds}</b></div>
      ${medals.length ? html`<div class="sself__medals">${medals.map((m, i) => html`<span key=${m.kind} class=${cx('smedal', `smedal--${m.kind}`, m.done ? 'is-done' : 'is-miss')} style=${`--i:${i}`}
          title=${m.kind === 'boss' ? t('敌方领袖') : t('隐秘核心')}>
        <${Img} src=${enemyIconUrl(gd.m, m.rec.enemyKey)} fallback=${html`<${Icon} name="crown" class="smedal__glyph" />`} />
        <i class="smedal__check"><${Icon} name=${m.done ? 'check' : 'close'} /></i></span>`)}</div>` : null}
      <div class="splate">
        <${PlayerAvatar} player=${self} self=${true} class="splate__ava" />
        <div class=${cx('splate__info', card.bg && 'has-nc')}>
          <${NameCardLayer} card=${card.bg} y=${card.bgY} />
          <b class="splate__name">${self.name}</b>
          <span class="splate__rank" title=${t('累计奖杯')}><${TrophyBadge} count=${prog.trophies} /><small><${Icon} name="crown" />${prog.trophies}</small></span>
          <span class="splate__gain"><small><${Icon} name="crown" />${t('获得奖杯')}</small><b class="num">${self.trophies}</b></span>
        </div>
      </div>
      <div class="sops">
        <div class="sops__row sops__row--1">${slots.slice(0, 5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} ownerId=${self.playerId} i=${i} />`)}</div>
        <div class="sops__row sops__row--2">${slots.slice(5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} ownerId=${self.playerId} i=${i + 5} />`)}</div>
      </div>
      <${BondBar} bonds=${self.bonds} gd=${gd} />
      <div class="settle__barbg" aria-hidden="true"></div>
      <${LevelStrip} prog=${prog} />
      <button type="button" ref=${nextRef} class="settle__next" onClick=${next}>
        <span class="settle__nexticon"><${Icon} name="exit" /></span><span>${t('下一步')}</span>
      </button>
    </div>
  </section>`;
}

// ---- 同盟 --------------------------------------------------------------------------------------------------------------

function titleView(p, gd) {
  if (!p.title) return null;
  const titles = Array.isArray(gd.config?.titles) ? gd.config.titles : [];
  const rec = titles.find((x) => x.id === p.title.id) || null;
  const rawRec = (data.getRaw('config')?.titles || []).find((x) => x && x.id === p.title.id) || null;
  const name = sentText(p.title?.name, rawRec?.name, rec?.name) || rec?.name || null;
  if (!name) return null;
  return {
    name,
    text: rec?.text || p.title?.text || '',
    icon: titleIconUrl(gd.m, rec?.picId || p.title?.picId || String(p.title.id || '').replace('comment_', 'comment_icon_')),
  };
}

/** A seat's room.card (名片底图, trophies) as room.state last told it; my own from this browser (ui/playerCard.js). */
function useSeatCard(playerId, self) {
  const mine = useMyCard();
  const seat = useStore((s) => (Array.isArray(s.room?.seats) ? s.room.seats.find((x) => x && x.playerId === playerId)?.card : null) || null);
  return self ? mine : seat && typeof seat === 'object' ? seat : null;
}

function TeamCard({ p, i, gd, self, victory, raw }) {
  const ace = aceOf(p.lineup);
  const v = ace ? unitView(ace, gd) : null;
  const title = titleView(p, gd);
  const cleared = rowCleared(raw, p, victory);
  const band = p.bandId ? gd.band(p.bandId) : null;
  const card = useSeatCard(p.playerId, self);
  return html`<article class=${cx('tcard', self && 'is-self', p.alive === false && 'is-dead', p.left && 'is-left', cleared ? 'is-clear' : 'is-fail')} style=${`--i:${i}`}>
    <header class="tcard__head" aria-hidden="true"><i class="tcard__pin"></i><span class="tcard__code"><i></i><i></i><i></i>STRONGHOLD PROTOCOL</span><span class="tcard__seat num">${pad2(p.seat + 1)}</span></header>
    <div class="tcard__art">
      <${Img} src=${v?.art || v?.avatar} class=${cx('tcard__img', v?.art ? 'is-portrait' : 'is-avatar')} fallback=${html`<span class="tcard__glyph">${[...(p.name || '?')][0]}</span>`} />
      ${p.left ? html`<span class="tcard__cut">${t('中断连接')}</span>` : null}
      ${title ? html`<div class="tcard__title" title=${title.text}>
        <${Img} src=${title.icon} class="tcard__ticon" fallback=${html`<${Icon} name="crown" class="tcard__ticon" />`} /><b>${title.name}</b></div>` : null}
      <div class="tcard__rounds"><span>${t('通过回合')}</span><b class="num">${p.roundsPassed}</b></div>
    </div>
    <div class=${cx('tcard__plate', !p.isBot && card?.bg && 'has-nc')}>
      ${p.isBot ? null : html`<${NameCardLayer} card=${card?.bg} y=${card?.bgY} />`}
      ${self ? html`<i class="tcard__me" aria-hidden="true"><${Icon} name="user" /></i>` : null}
      <${PlayerAvatar} player=${p} self=${self} class="tcard__ava" />
      <span class="tcard__who">
        <b class="tcard__name">${p.isBot ? null : html`<${TrophyBadge} count=${Number.isSafeInteger(card?.trophies) ? card.trophies : null} class="tbadge--inline" />`}<span>${p.name}</span>${p.isBot ? html`<span class="tcard__ai">AI</span>` : null}</b>
        ${band ? html`<span class="tcard__band"><${BandIcon} bandId=${band.bandId} size="xs" /><span>${band.name}</span></span>` : null}
      </span>
    </div>
    <div class="tcard__chips">
      <span class="tchip tchip--cup" title=${t('获得奖杯')}><${Icon} name="crown" /><b class="num">+${p.trophies}</b></span>
    </div>
  </article>`;
}

function TeamPage({ r, res, gd, myId, at, backLabel, onBack, onDetail, version = null }) {
  const rounds = useCountUp(r.roundsPassed, { ms: 900, delay: 450 });
  const backRef = useRef(null);
  const rowRef = useRef(null);
  const rawOf = (pid) => (Array.isArray(res?.players) ? res.players.find((x) => x && x.playerId === pid) : null) || null;
  useEffect(() => {
    audio.sfx('settlementTeam');
    const id = setTimeout(() => backRef.current?.focus({ preventScroll: true }), 900);
    return () => clearTimeout(id);
  }, []);
  // more than four doctors (an experimental room of up to 20, the owner's report of 2026-10-15: the cards ran off both
  // edges): the row scrolls sideways — it opens on the own card, and a mouse wheel scrolls it
  const wide = r.players.length > 4;
  useEffect(() => {
    const row = rowRef.current;
    if (!wide || !row) return undefined;
    const me = row.querySelector('.tcard.is-self');
    if (me) row.scrollLeft = me.offsetLeft - (row.clientWidth - me.offsetWidth) / 2;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
      row.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, [wide]);
  return html`<section class=${cx('steam', r.victory ? 'is-win' : 'is-lose')} data-testid="settle-team">
    <div class="settle__stage">
      <div class="steam__bg" aria-hidden="true"></div>
      <${Logo} />
      <div ref=${rowRef} class=${cx('steam__cards', wide && 'is-wide')} style=${`--n:${r.players.length}`}>
        ${r.players.length ? r.players.map((p, i) => html`<${TeamCard} key=${p.playerId} p=${p} i=${wide ? Math.min(i, 7) : i} gd=${gd} self=${p.playerId === myId} victory=${r.victory} raw=${rawOf(p.playerId)} />`)
          : html`<p class="steam__none">${t('暂无结算数据')}</p>`}
      </div>
      <div class="settle__barbg steam__barbg" aria-hidden="true"></div>
      <div class="steam__outcome"><${ModePill} r=${r} /><${VersionTag} version=${version} /><b class="steam__title">${r.victory ? t('模拟完成') : t('模拟中断')}</b></div>
      <div class="steam__rounds"><span>${t('同盟通过回合')}</span><b class="num">${rounds}</b></div>
      <div class="steam__when">
        <span class="steam__row"><${SvgPath} d=${CLOCK} />${fmtDuration(r.durationMs)}</span>
        <span class="steam__row"><${SvgPath} d=${CALENDAR} />${fmtDate(at)}</span>
      </div>
      <button type="button" class="sbtn sbtn--ghost steam__detail" onClick=${onDetail}><${Icon} name="chart" /><span>${t('数据详情')}</span></button>
      <button type="button" ref=${backRef} class="sbtn sbtn--primary settle__back" onClick=${onBack}>
        <span class="sbtn__mark" aria-hidden="true"><svg viewBox="0 0 40 30"><path d="M8 4h10v8H8zM22 4h10v8H22zM8 18h10v8H8zM22 18h10v8H22z" fill="none" stroke="currentColor" stroke-width="2.6" /><path d="M2 2v26M38 2v26" stroke="currentColor" stroke-width="2.4" /></svg></span>
        <span>${backLabel}</span></button>
    </div>
  </section>`;
}

// ---- the flow ----------------------------------------------------------------------------------------------------------

/**
 * The settlement of one m.result: intro → 个人战报 → 同盟; 数据详情 opens the full report over it.
 * @param {{ res: any, pub?: any, myId?: string|null, backLabel: string, onBack: () => void }} props
 */
export function SettleFlow({ res, pub = null, myId = null, backLabel, onBack, version = null }) {
  const gd = useGameData();
  const r = normalizeResult(res, pub);
  const self = r.players.find((p) => p.playerId === myId) || null;
  const rawSelf = self && Array.isArray(res?.players) ? res.players.find((x) => x && x.playerId === myId) || null : null;
  const [page, setPage] = useState(() => (!self ? 'team' : reducedMotion() ? 'self' : 'intro'));
  const [detail, setDetail] = useState(false);
  const ctx = useMemo(() => {
    // this browser's records (read only; m.result is recorded as it arrives — levelProgress leaves this match's own
    // record out and adds its row)
    let records;
    try { records = peekStatsRecords(); } catch { records = []; }
    const id = recordId(res, myId);
    const own = records.find((x) => x && x.id === id);
    const at = own?.t || Date.now();
    return { at, prog: self ? levelProgress(records, { id, exp: self.reward, trophies: self.trophies, at, season: seasonOf(version) }) : null };
  }, []);
  const rootRef = useRef(null);
  useStageFit(rootRef);
  const lose = self ? !rowCleared(rawSelf, self, r.victory) : !r.victory;
  return html`<div ref=${rootRef} class=${cx('screen', 'result', 'settle', `settle--${page}`)} data-testid="settle">
    ${page === 'intro' ? html`<${SettleIntro} players=${r.players} myId=${myId} lose=${lose} onDone=${() => setPage('self')} />` : null}
    ${page === 'self' ? html`<${SelfPage} r=${r} raw=${rawSelf} self=${self} gd=${gd} prog=${ctx.prog} seed=${res?.seed} version=${version} onNext=${() => setPage('team')} />` : null}
    ${page === 'team' ? html`<${TeamPage} r=${r} res=${res} gd=${gd} myId=${myId} at=${ctx.at} version=${version} backLabel=${backLabel} onBack=${onBack} onDetail=${() => setDetail(true)} />` : null}
    ${detail ? html`<div class="settle__detail" data-testid="settle-detail">
      <${ResultView} res=${res} pub=${pub} myId=${myId} quiet=${true} version=${version} backLabel=${t('返回')} onBack=${() => setDetail(false)} /></div>` : null}
  </div>`;
}

/** RESULT screen of the match on screen: reads the store; 返回同盟 / 返回大厅 drops the match. */
export function ResultScreen() {
  const res = useStore((s) => s.match.result);
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const hasRoom = useStore((s) => !!s.room);
  // the official version the match played (DESIGN §35.23): the room's, or the last room's once it is gone
  const version = useStore(shownVersion);
  const back = () => store.set({ match: emptyMatch() });
  return html`<${SettleFlow} res=${res} pub=${pub} myId=${myId} version=${version} backLabel=${hasRoom ? t('返回同盟') : t('返回大厅')} onBack=${back} />`;
}
