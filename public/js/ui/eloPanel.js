// ui/eloPanel.js — ELO's own panel (docs/history/0.4.0.md §37.275, the owner 2026-11-20: every player sees their own
// win rate and the expected impact before ELO affects them; nobody sees anybody else's). Everything here is this
// browser's: the counts ui/eloRecords.js takes from the local records — the very counts room.elo sends — go through
// shared/elo.js eloImpact, the function the server's tilt reads too (server/match/tilt.js), so the panel says what the
// server does. Shown in the host's reminder as the option goes on (ui/experimental.js confirmElo), once to every other
// seated player as they meet the option in a room (screens/room.js EloNotice), and in short in the room's rule list
// (ExperimentalDetails, eloBrief). Styles: the elo-* rules of css/components.css.

import { useMemo } from '../../vendor/hooks.module.js';
import { html, Button, Icon, alertDialog } from './components.js';
import { t } from '../../../shared/i18n.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { ELO_LEVELS, ELO_MAP, eloEntriesOf, eloImpact, eloSummary } from '../../../shared/elo.js';
import { eloRecords } from './eloRecords.js';
import { peekStatsRecords } from './stats.js';

const pct = (v) => Math.round(v * 100);
/** A weighted count: one decimal, none when whole (26.4 / 30). */
const num1 = (v) => String(Math.round(v * 10) / 10);
const scopeOf = (mode, difficulty) => {
  const d = { difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : String(difficulty ?? '') };
  return mode === 'solo' ? t('独立·{difficulty}', d) : t('同盟·{difficulty}', d);
};

/**
 * This browser's own ELO numbers for a room of `mode` and `difficulty` — eloSummary of the very list room.elo sends and
 * the server reads (eloImpact) —, with the scope.
 * @param {string} mode @param {string} difficulty @param {() => any[]} [records]
 */
export function eloMine(mode, difficulty, records = peekStatsRecords) {
  const impact = eloImpact(eloSummary(eloEntriesOf(eloRecords(records()), mode, difficulty)));
  return { ...impact, scope: scopeOf(mode, difficulty), mode, difficulty };
}

/** 帮 · 2 级 / 不调 / 压 · 3 级. @param {{ dir: string, level: number }} x */
export const eloLevelText = (x) => (x.dir === 'help' ? t('帮 · {n} 级', { n: x.level }) : x.dir === 'hinder' ? t('压 · {n} 级', { n: x.level }) : t('不调'));

/** What changes for the player, in plain words (no per-draw odds). @param {{ dir: string, level: number }} x */
export function eloEffectText(x) {
  if (x.dir === 'help') {
    return [t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会略微更容易刷到。'),
      t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会更容易刷到。'),
      t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会明显更容易刷到。')][x.level - 1];
  }
  if (x.dir === 'hinder') {
    return [t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会略微更难刷到。'),
      t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会更难刷到。'),
      t('凑精锐的第三张、差一两名就升档的盟约成员、本命盟约成员和转职装备会明显更难刷到。'),
      t('凑精锐的第三张、差一名就升档的盟约成员、本命盟约成员和转职装备几乎刷不到，其他相关的牌也更难刷到。')][x.level - 1];
  }
  return t('你的商店与卡池照常，不做调整。');
}

/** The line of the rule list (ExperimentalDetails): 你 · 胜率 60% · 压 · 2 级 / 你 · 记录不足. @param {ReturnType<typeof eloMine>} x */
export const eloBrief = (x) => (x.key === 'few' ? t('你：折算后不足 {n} 局，暂不调整', { n: ELO_MAP.minGames })
  : t('你：近期胜率 {rate}% · {level}', { rate: pct(x.raw), level: eloLevelText(x) }));

/**
 * The panel: 此功能仅为娱乐, the own record and rate (shrunk), the direction and level, what changes, the measured estimate,
 * the co-op and rescue notes, and that it counts and updates.
 * @param {{ mode: string, difficulty: string, revival?: boolean, mine?: ReturnType<typeof eloMine> }} props
 */
export function EloPanel({ mode, difficulty, revival = false, mine = null }) {
  const x = mine || eloMine(mode, difficulty);
  const m = ELO_LEVELS.measured;
  return html`<div class=${`elo-panel elo-panel--${x.dir}`} data-testid="elo-panel" data-dir=${x.dir} data-level=${x.level}>
    <p class="elo-panel__fun"><${Icon} name="info" /><strong>${t('此功能仅为娱乐')}</strong></p>
    <p class="elo-panel__rate" data-testid="elo-rate">${x.n
      ? t('最近 {n} 局{scope}：{wins} 胜 {losses} 负，胜率 {rate}%', { n: x.n, scope: x.scope, wins: x.wins, losses: x.losses, rate: pct(x.raw) })
      : t('本机还没有{scope}的对局记录', { scope: x.scope })}</p>
    ${x.n ? html`<p class="elo-panel__shrunk" data-testid="elo-weighted">${t('早期失利按通过的回合折算（通过 {r} 回合算 1 局），按 {games} 局计', { r: ELO_MAP.lossRounds, games: num1(x.games) })}</p>` : null}
    ${x.key === 'few' ? html`<p class="elo-panel__few" data-testid="elo-few">${t('折算后不足 {n} 局，暂不调整', { n: ELO_MAP.minGames })}</p>`
      : html`<p class="elo-panel__shrunk">${t('按 +{k} 胜 +{k} 负向 50% 折算：{rate}%', { k: ELO_MAP.prior, rate: pct(x.w) })}</p>`}
    <p class="elo-panel__dir" data-testid="elo-level"><span>${t('预计影响')}</span><b>${eloLevelText(x)}</b></p>
    <p class="elo-panel__what">${eloEffectText(x)}</p>
    ${x.dir !== 'none' ? html`<p class="elo-panel__what">${x.dir === 'help' ? t('机变超时自动选卡、独立模拟的机变卡组和随机赠送也会偏向对你有利的一方。')
      : t('机变超时自动选卡、独立模拟的机变卡组和随机赠送也会偏向对你不利的一方。')}</p>` : null}
    ${x.dir !== 'none' && x.measured.at != null ? html`<p class="elo-panel__est" data-testid="elo-estimate">${t('按实测（{scope}，AI 代打 {games} 局）：胜率约 {from}% → {to}%。', {
      scope: t(m.label), games: m.games, from: m.off, to: x.measured.at })}</p>` : null}
    ${mode !== 'solo' && x.dir !== 'none' ? html`<p class="elo-panel__est">${t('同盟中的胜负还取决于队友，实际影响因队伍而异。')}</p>` : null}
    ${mode !== 'solo' && revival && x.dir === 'hinder' ? html`<p class="elo-panel__est" data-testid="elo-rescue">${x.rescue > 0
      ? t('队友复活：AI 队友约有 {p}% 的可能救你。', { p: pct(x.rescue) }) : t('队友复活：AI 队友不会救你。')}</p>` : null}
    <p class="elo-panel__note">${t('开启 ELO 的对局照常计入成就；胜率在每局结束后按本机记录更新。')}</p>
  </div>`;
}

/** The full panel in a dialog (screens/room.js: a player who meets the option in a room; 详情). */
export function showEloPanel({ mode, difficulty, revival = false }, dialog = alertDialog) {
  return dialog({ title: t('ELO：你的情况'), micro: 'ELO', text: html`<${EloPanel} mode=${mode} difficulty=${difficulty} revival=${revival} />`, okText: t('知道了') });
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
  // the local records change only as a match ends: read again then (not at every room.state)
  const x = useMemo(() => (seated ? eloMine(room.mode, room.difficulty) : null), [seated, room.mode, room.difficulty, room.inMatch, room.code]);
  return html`<div class="elo-notice" role="note" data-testid="elo-notice">
    <${Icon} name="info" class="elo-notice__icon" />
    <span><strong>${t('本房间已开启 ELO · 此功能仅为娱乐')}</strong>
      <small data-testid="elo-notice-brief">${x ? eloBrief(x) : t('每位博士按自己的近期胜率调整，各自只看得到自己的情况。')}</small></span>
    ${x ? html`<${Button} size="sm" variant="ghost" class="elo-notice__more" data-testid="elo-notice-more"
      onClick=${() => showEloPanel({ mode: room.mode, difficulty: room.difficulty, revival })}>${t('详情')}<//>` : null}
  </div>`;
}
