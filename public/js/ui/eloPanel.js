// ui/eloPanel.js — ELO's own panel (docs/history/0.4.0.md §37.275, the owner 2026-11-20: every player sees their own
// win rate and the expected impact before ELO affects them; nobody sees anybody else's; 「文字太多，需要精简，分段分点」:
// one short line per fact, in two sections). Everything here is this browser's: the counts ui/eloRecords.js takes from
// the local records — the very counts room.elo sends — go through shared/elo.js eloImpact, the function the server's
// tilt reads too (server/match/tilt.js), so the panel says what the server does; the measured change is the room's own
// version's row of shared/elo.js ELO_MEASURED. Shown in the host's reminder as the option goes on (ui/experimental.js
// confirmElo), once to every other seated player as they meet the option in a room (screens/room.js EloNotice), and in
// short in the room's rule list (ExperimentalDetails, eloBrief). Styles: the elo-* rules of css/components.css.
// Receipts (§37.276): the numbers are those of the list the server takes — shared/elo.js eloTrusted over this identity's
// receipts (ui/receipts.js) and the local records: help only from receipts, the local records only make it harder —, and
// one line says which. Every place shows the same rate: the round-weighted, shrunk one of the room's version the tilt
// uses (eloSummary `w`), never the raw wins / games.

import { useMemo } from '../../vendor/hooks.module.js';
import { useStore, store } from '../store.js';
import { roomVersion, shownVersion, versionLabel } from '../versions.js';
import { html, Button, Icon, Tooltip, alertDialog } from './components.js';
import { t, tParts } from '../../../shared/i18n.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { ELO_MAP, eloImpact, eloKey, eloMeasured, eloSummary, eloTrusted } from '../../../shared/elo.js';
import { eloRecords } from './eloRecords.js';
import { eloReceiptList, receiptRev } from './receipts.js';
import { InfoTip } from './receiptViews.js';
import { peekStatsRecords } from './stats.js';

const pct = (v) => Math.round(v * 100);
/** A weighted count: one decimal, none when whole (26.4 / 30). */
const num1 = (v) => String(Math.round(v * 10) / 10);
/** Percentage points with their sign: +5 / −9.4 / ±0. @param {number} v */
const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '±0');
const scopeOf = (mode, difficulty) => {
  const d = { difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : String(difficulty ?? '') };
  return mode === 'solo' ? t('独立·{difficulty}', d) : t('同盟·{difficulty}', d);
};

/**
 * This browser's own ELO numbers for a room of `mode` and `difficulty` — eloSummary of the very list room.elo sends and
 * the server reads (eloImpact) —, with the scope (the version's name first).
 * @param {string} mode @param {string} difficulty @param {() => any[]} [records] @param {string | null} [sub] @param {string} [version]
 */
export function eloMine(mode, difficulty, records = peekStatsRecords, sub = undefined, version = shownVersion(store.get())) {
  const recs = records();
  // each official version its own (the owner, 2026-11-20): the room's — the version shown — and no other; the room's one
  // list taken directly, as room.elo sends it (ui/loadoutSync.js installEloSync) — eloEntriesOf checks the whole object
  // against room.elo's ELO_LIMITS.keys, and a browser with records in more mode × difficulty × version lists than that
  // got 「记录不足」 here while the server tilted it (the owner, 2026-11-21: 修)
  const own = eloRecords(recs)[eloKey(mode, difficulty, version)] || [];
  // receipts (§37.276): the list the server takes — this identity's receipts, or the local records when they hinder more
  const trusted = eloTrusted(own, eloReceiptList(recs, mode, difficulty, version, sub));
  const impact = eloImpact(trusted.summary);
  return { ...impact, scope: t('{version}·{scope}', { version: versionLabel(version), scope: scopeOf(mode, difficulty) }), mode, difficulty, version,
    source: trusted.source, verified: trusted.verified, ownN: eloSummary(own).n };
}

/** 帮 · 2 级 / 不调 / 压 · 3 级. @param {{ dir: string, level: number }} x */
export const eloLevelText = (x) => (x.dir === 'help' ? t('帮 · {n} 级', { n: x.level }) : x.dir === 'hinder' ? t('压 · {n} 级', { n: x.level }) : t('不调'));

/** What changes for the player, in plain words (no per-draw odds): one short line each. @param {{ dir: string, level: number }} x */
export function eloEffectLines(x) {
  if (x.dir === 'help') {
    return [[t('略微更容易刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备'),
      t('更容易刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备'),
      t('明显更容易刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备')][x.level - 1],
    t('机变和随机赠送也偏向有利')];
  }
  if (x.dir === 'hinder') {
    return [...[[t('略微更难刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备')],
      [t('更难刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备')],
      [t('明显更难刷到：凑精锐的第三张、快升档的盟约成员、本命盟约成员、转职装备')],
      [t('几乎刷不到：凑精锐的第三张、差一名就升档的盟约成员、本命盟约成员、转职装备'), t('其他相关的牌也更难刷到')]][x.level - 1],
    t('机变和随机赠送也偏向不利')];
  }
  return [t('商店与卡池照常')];
}

/** The line of the rule list (ExperimentalDetails): 你：近期胜率 60% · 压 · 2 级 / 你：记录不足. @param {ReturnType<typeof eloMine>} x */
export const eloBrief = (x) => (x.key !== 'few' ? t('你：近期胜率 {rate}% · {level}', { rate: pct(x.w), level: eloLevelText(x) })
  : x.n < ELO_MAP.minGames ? t('你：记录不足 {n} 局，暂不调整', { n: ELO_MAP.minGames }) : t('你：折算后不足 {n} 局，暂不调整', { n: ELO_MAP.minGames }));

/**
 * The measured line (eloMeasured): the change in points, 在误差内 when its interval holds 0; a co-op room's note that it is
 * the solo measurement. @param {NonNullable<ReturnType<typeof eloMeasured>>} est @param {string} mode
 */
function estimateText(est, mode) {
  const pp = { pp: signed(est.pp) };
  if (mode === 'solo') return est.noise ? t('实测：胜率约 {pp} 个百分点，在误差内（AI 代打）', pp) : t('实测：胜率约 {pp} 个百分点（AI 代打）', pp);
  return est.noise ? t('实测：胜率约 {pp} 个百分点，在误差内（AI 代打独立模拟，同盟另看队友）', pp) : t('实测：胜率约 {pp} 个百分点（AI 代打独立模拟，同盟另看队友）', pp);
}

/** An ⓘ whose tooltip (hover, or a tap) carries the detail of a line. @param {{ text: string, testid: string }} props */
const Detail = ({ text, testid }) => html`<${Tooltip} tap=${true} placement="bottom" within=".modal__box" text=${text}>
  <button type="button" class="elo-panel__i" data-testid=${testid} aria-label=${text}><${Icon} name="info" /></button>
<//>`;

/**
 * The panel, in two sections of short lines: 此功能仅为娱乐; 近期胜率 (the own record and the rate the server uses, or 记录不足
 * and nothing more); 预计影响 and its level, what changes, the rescue (队友复活 on, hindered) and the measured change of the
 * room's own version (ELO_MEASURED, in percentage points); a one-line footer.
 * @param {{ mode: string, difficulty: string, version?: string|null, revival?: boolean, mine?: ReturnType<typeof eloMine> }} props
 */
export function EloPanel({ mode, difficulty, version = null, revival = false, mine = null }) {
  const x = mine || eloMine(mode, difficulty, undefined, undefined, version || undefined);
  const few = x.key === 'few';
  const r = { scope: x.scope, n: x.n, wins: x.wins, losses: x.losses };
  // the ⓘ explains the line: the weighting and the shrink; it stays with the rate the server uses (→ 66%), never alone
  const why = x.n ? html`<${Detail} testid="elo-rate-i" text=${t('早期失利按通过的回合折算（通过 {r} 回合算 1 局），共按 {games} 局计；折算后满 {min} 局才调整，胜率再加 {k} 胜 {k} 负向 50% 拉近。', {
    r: ELO_MAP.lossRounds, games: num1(x.games), min: ELO_MAP.minGames, k: ELO_MAP.prior })} />` : null;
  const w = few ? null : html`<span class="elo-panel__w">→ ${pct(x.w)}% ${why}</span>`;
  const rate = !x.n ? (x.ownN ? t('还没有已核验的{scope}对局', r) : t('{scope}：本机还没有记录', r))
    : few ? [t('{scope} 最近 {n} 局：{wins} 胜 {losses} 负', r), ' ', why]
    : x.games < x.n ? tParts('{scope} 最近 {n} 局：{wins} 胜 {losses} 负（早期失利按回合折算）{rate}', { ...r, rate: w })
    : tParts('{scope} 最近 {n} 局：{wins} 胜 {losses} 负 {rate}', { ...r, rate: w });
  const est = few ? null : eloMeasured(x.version ?? version, x.dir, x.level);
  return html`<div class=${`elo-panel elo-panel--${x.dir}`} data-testid="elo-panel" data-dir=${x.dir} data-level=${x.level}>
    <p class="elo-panel__fun"><${Icon} name="info" /><strong>${t('此功能仅为娱乐')}</strong></p>
    <h5 class="elo-panel__h">${t('近期胜率')}</h5>
    <ul class="elo-panel__list">
      <li data-testid="elo-rate">${rate}</li>
      ${x.source ? html`<li class="elo-panel__src" data-testid="elo-source">${x.source === 'own' ? t('按本机记录计：本机记录只会让调整更压')
        : t('按已核验的对局计：帮助只看已核验的对局')}<${InfoTip} id="elo-verified-tip" text=${t('已核验：对局结束时服务器签发了凭证的对局。导入的对局要身份相同才计入。')} /></li>` : null}
      ${few ? html`<li class="elo-panel__few" data-testid="elo-few">${x.n < ELO_MAP.minGames ? t('记录不足 {n} 局，暂不调整', { n: ELO_MAP.minGames })
        : t('折算后不足 {n} 局，暂不调整', { n: ELO_MAP.minGames })}</li>` : null}
    </ul>
    ${few ? null : html`<p class="elo-panel__dir" data-testid="elo-level"><span>${t('预计影响')}</span><b>${eloLevelText(x)}</b></p>
    <ul class="elo-panel__list">
      ${eloEffectLines(x).map((line) => html`<li>${line}</li>`)}
      ${mode !== 'solo' && revival && x.dir === 'hinder' ? html`<li data-testid="elo-rescue">${x.rescue > 0
        ? t('AI 队友不一定救你（约 {p}%）', { p: pct(x.rescue) }) : t('AI 队友不会救你')}</li>` : null}
      ${est ? html`<li class="elo-panel__est" data-testid="elo-estimate">${estimateText(est, mode)} <${Detail} testid="elo-estimate-i"
        text=${t('{version}·{where}，AI 代打 {games} 局：不开 ELO 胜率 {off}%，此级 {at}%（变化的 95% 区间 {lo}…{hi}）', {
        version: versionLabel(est.version), where: t(est.where), games: est.games, off: est.off, at: est.at, lo: signed(est.lo), hi: signed(est.hi) })} /></li>` : null}
    </ul>`}
    <p class="elo-panel__note">${t('计入成就 · 每局结束后更新')}</p>
  </div>`;
}

/** The full panel in a dialog (screens/room.js: a player who meets the option in a room; 详情). */
export function showEloPanel({ mode, difficulty, version = null, revival = false }, dialog = alertDialog) {
  return dialog({ title: t('ELO：你的情况'), micro: 'ELO', text: html`<${EloPanel} mode=${mode} difficulty=${difficulty} version=${version} revival=${revival} />`, okText: t('知道了') });
}

/** Room codes whose panel this page has shown (the host's reminder, a joiner's dialog): shown once per room. */
const seen = new Set();
/** @param {string|null|undefined} code */
export const markEloSeen = (code) => { if (code) seen.add(code); };
/** @param {string|null|undefined} code */
export const eloSeen = (code) => !!code && seen.has(code);

/**
 * The room's notice while ELO is on (screens/room.js): 此功能仅为娱乐 and, for a seated player, the own level in short and
 * 详情 (the full panel). A spectator is never tilted: the notice only says the room has it.
 * @param {{ room: any, seated?: boolean }} props
 */
export function EloNotice({ room, seated = true }) {
  const revival = room?.experimental?.revivalEnabled === true;
  // the local records change only as a match ends: read again then (not at every room.state), and when the receipts do
  const rev = useStore((s) => s.rev, Object.is, receiptRev);
  const x = useMemo(() => (seated ? eloMine(room.mode, room.difficulty, undefined, undefined, roomVersion(room)) : null), [seated, room.mode, room.difficulty, roomVersion(room), room.inMatch, room.code, rev]);
  return html`<div class="elo-notice" role="note" data-testid="elo-notice">
    <${Icon} name="info" class="elo-notice__icon" />
    <span><strong>${t('本房间已开启 ELO · 此功能仅为娱乐')}</strong>
      <small data-testid="elo-notice-brief">${x ? eloBrief(x) : t('每位博士按自己的近期胜率调整，各自只看得到自己的情况。')}</small></span>
    ${x ? html`<${Button} size="sm" variant="ghost" class="elo-notice__more" data-testid="elo-notice-more"
      onClick=${() => showEloPanel({ mode: room.mode, difficulty: room.difficulty, version: room.version ?? null, revival })}>${t('详情')}<//>` : null}
  </div>`;
}
