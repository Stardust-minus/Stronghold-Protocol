// Match info — the bonds and banned operators of a match (research 06 §4.1 "1/2 确认本局信息", research 01 A2 / 06
// addendum D), one implementation for every place that shows them, so they never drift:
//   * the INFO_CHECK briefing's right column (screens/briefing.js);
//   * the strategy draft's 本局信息 dialog (screens/bandDraft.js; GitHub issue #8 item 1 "选策略时没法返回查看禁用的干员和盟约":
//     players choose a strategy partly by the bonds and operators the match leaves them);
//   * the data of the in-game 本局信息 tab (ui/enemyDrawer.js InfoTab, its own compact chips and avatars).
// matchInfoModel (pure) derives everything from m.public and the static data: the two kinds of greyed bonds
// (gameLogic disabledBondSets over config.modes[modeId].inactiveBondIds — the drawn set D "部分盟约所含干员阵容不完整",
// still activatable through other bonds' operators or items, and the mode's static inactive bonds "本局禁用", e.g.
// 标准模拟's 10), every bond in the briefing order (bondOrder, then identifier) split into 核心 / 附加, the banned
// operators (m.public bannedChess, known chess only) sorted by tier, the banned-member count per bond (gameLogic
// bannedPerBond) and — from the viewer's own m.private — its slotted 自选 pieces left out of the shop because all their
// bonds are off (gameLogic diyBannedPieces; 0.2.0). The blocks are hookless (unit-tested by calling them): the 核心盟约 /
// 附加盟约 rows of bond discs —
// greyed with the ✕, the red banned-member badge, the briefingBondTip tooltip — the legend and the 本局禁用干员 grid.
// MatchInfoDialog shows the same blocks read-only in a components.js Modal (关闭, a tap outside or Esc close it) with a
// status line from its caller (the draft's turn and countdown, so the running clock stays in view).
// Styles: css/screens/briefing.css (.brief-*), css/screens/draft.css (.minfo-dlg).

import { html, Button, Icon, MicroLabel, BondDisc, Tooltip, Modal } from './components.js';
import { UnitThumb, Img } from './gameComponents.js';
import { bannedMembersByBond, disabledBondSets, briefingBondTip, diyBannedPieces, factionTypes } from './gameLogic.js';
import { bondIconUrl, factionIconUrl } from './assetUrls.js';
import { data } from '../data.js';
import { t, dn } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * @typedef {{ sets: { drawn: Set<string>, off: Set<string> }, stateOf: (bondId: string) => 'off'|'drawn'|null,
 *   bonds: any[], core: any[], addon: any[], banned: string[], perBond: Map<string, number>,
 *   perBondMembers: Map<string, string[]>,
 *   diyBanned: Array<{ slotId: string, charId: string, name: string }> }} MatchInfoModel
 */

/**
 * Everything the match-info blocks show.
 * @param {any} pub m.public (drawnDisabledBonds / disabledBonds, bannedChess)
 * @param {{ bonds?: any[], chess?: (id: string) => any, mode?: any, priv?: any, diyData?: any }} [src]
 *   bonds: bonds.json records (data.list('bonds')); chess: the chess lookup; mode: config.json modes[pub.modeId]; priv: the
 *   viewer's m.private (its 自选 pieces out of the shop, diyBanned) with diyData (`{ chess, backups }`: data.get('chess') /
 *   data.get('backups')) to name them
 * @returns {MatchInfoModel}
 *   stateOf: 'off' = the mode never activates the bond (本局禁用), 'drawn' = in the drawn set D (阵容不完整), null = normal;
 *   banned: the banned chess ids the data knows, by tier (ties keep the server's order); perBond: bondId → how many of
 *   them the bond can no longer field; perBondMembers: bondId → those ids themselves (the grouped 本局禁用干员 block)
 */
export function matchInfoModel(pub, { bonds = [], chess = () => null, mode = null, priv = null, diyData = null } = {}) {
  const sets = disabledBondSets(pub, mode?.inactiveBondIds);
  const stateOf = (id) => (sets.off.has(id) ? 'off' : sets.drawn.has(id) ? 'drawn' : null);
  const list = (Array.isArray(bonds) ? bonds : []).filter((b) => !!b && typeof b === 'object' && typeof b.bondId === 'string')
    .sort((a, b) => (a.bondOrder ?? 0) - (b.bondOrder ?? 0) || (a.identifier ?? 0) - (b.identifier ?? 0));
  const tierOf = (id) => chess(id)?.tier ?? 0;
  const banned = (Array.isArray(pub?.bannedChess) ? pub.bannedChess : []).filter((id) => typeof id === 'string' && !!chess(id))
    .sort((a, b) => tierOf(a) - tierOf(b));
  const perBondMembers = bannedMembersByBond(list, banned);
  const perBond = new Map();
  for (const [bondId, ids] of perBondMembers) perBond.set(bondId, ids.length);
  return {
    sets, stateOf, bonds: list, core: list.filter((b) => b.isCore), addon: list.filter((b) => !b.isCore),
    banned, perBond, perBondMembers,
    diyBanned: priv && diyData ? diyBannedPieces(priv, chess, diyData) : [],
  };
}

/**
 * The viewer's 自选 pieces out of the shop this match (MatchInfoModel `diyBanned`): one line under 本局禁用干员, or nothing.
 * @param {{ model: MatchInfoModel, class?: string }} props
 */
export function DiyBannedLine({ model, class: cls = 'brief-banned__diy' }) {
  const list = model?.diyBanned || [];
  if (!list.length) return null;
  return html`<p class=${cls} data-testid="diy-banned"><span class="diybanned__tag">${t('自选')}</span>
    ${t('{names}的盟约本局全部禁用，不会出现在你的商店', { names: list.map((x) => dn(x.name)) })}</p>`;
}

/**
 * The box beside a bond's tooltip: its banned members (the badge's count), each with avatar, name and bonds (the hovered
 * one highlighted); null when none are banned.
 * @param {any} bond @param {MatchInfoModel} model @param {Set<string>} banned
 */
function BondBannedAside(bond, model, banned) {
  const ids = (Array.isArray(bond.visibleMembers) ? bond.visibleMembers : []).filter((id) => banned.has(id));
  if (!ids.length) return null;
  const nameOf = new Map(model.bonds.map((b) => [b.bondId, b.name]));
  return html`<div class="brief-bantip">
    <div class="brief-bantip__h">${t('本局禁用干员')}</div>
    ${ids.map((id) => {
      const c = data.lookup('chess', id);
      const bonds = (Array.isArray(c?.bonds) ? c.bonds : []).filter((b) => nameOf.has(b));
      return html`<div key=${id} class="brief-bantip__op" data-chess=${id}>
        <${UnitThumb} kind="chess" id=${id} size="xs" showTier=${false} />
        <div class="brief-bantip__txt"><b>${c?.name || id}</b>
          <span>${bonds.map((b, i) => html`${i ? ' · ' : ''}<span class=${cx(b === bond.bondId && 'is-this')}>${nameOf.get(b)}</span>`)}</span></div>
      </div>`;
    })}
  </div>`;
}

/**
 * One row of bond discs (核心盟约 / 附加盟约): a greyed disc (✕) for a bond in the drawn set D or one the mode never
 * activates, the red badge with its banned members, a red ring on an enabled bond that lost members; the tooltip says
 * which (briefingBondTip). A bond with banned members lists them in a second box beside the tooltip (BondBannedAside).
 * @param {{ title: string, micro: string, bonds: any[], model: MatchInfoModel }} props
 */
export function MatchBondRow({ title, micro, bonds, model }) {
  const m = data.get('assets');
  const banned = new Set(model.banned);
  return html`<div class="brief-bonds">
    <h3 class="brief-h"><span>${title}</span><${MicroLabel}>${micro}</${MicroLabel}></h3>
    <div class="brief-bonds__row">
      ${bonds.map((b) => {
        const state = model.stateOf(b.bondId);
        const off = !!state;
        const bannedN = model.perBond.get(b.bondId) || 0;
        return html`<${Tooltip} key=${b.bondId} text=${briefingBondTip(b.name, state, bannedN)}
          aside=${bannedN > 0 ? BondBannedAside(b, model, banned) : null}>
          <div class=${cx('brief-bond', off && 'is-off', state === 'drawn' && 'is-incomplete', !off && bannedN > 0 && 'is-partial')} data-bond=${b.bondId}>
            <${BondDisc} name=${b.name} icon=${bondIconUrl(m, b.bondId)} active=${!off} disabled=${off} tier=${off ? 0 : (b.thresholds?.length || 1)}
              maxTier=${Math.max(1, b.thresholds?.length || 1)} size="md" />
            ${bannedN > 0 ? html`<span class="brief-bond__ban num"><${Icon} name="user" />${bannedN}</span>` : null}
          </div>
        <//>`;
      })}
    </div>
  </div>`;
}

/**
 * The legend under the bond rows ("或本模式禁用" only when the mode switches bonds off).
 * @param {{ model: MatchInfoModel }} props
 */
export function MatchLegend({ model }) {
  return html`<p class="brief-legend"><span class="brief-legend__off"></span>${t('灰色：部分盟约所含干员阵容不完整（仍可通过其他盟约的干员或装备激活）')}${model.sets.off.size ? t('，或本模式禁用') : ''} · <span class="brief-legend__ban"><${Icon} name="user" /></span>${t('该盟约中无法出现的干员数')}</p>`;
}

/**
 * 本局禁用干员, **按盟约分组** (maintenance 2026-10-16): one line per bond — its disc, its name, how many of its members are
 * banned and those members' avatars. A member carrying several bonds appears under each one (that is the point of the
 * grouping); the count in the header stays the DE-DUPLICATED total. The avatars are the plain (原皮) chess records: no
 * entry of the block ever passes a skinId, so a skin worn in the match cannot leak in here (the layout also relies on it).
 * @param {{ model: MatchInfoModel }} props
 */
export function BannedOperators({ model }) {
  const { banned } = model;
  const m = data.get('assets');
  const groups = model.bonds
    .map((b) => ({ bond: b, ids: model.perBondMembers.get(b.bondId) || [] }))
    .filter((g) => g.ids.length);
  return html`<div class="brief-banned">
    <h3 class="brief-h"><span>${t('本局禁用干员')}</span><${MicroLabel}>BANNED OPERATORS</${MicroLabel}><b class="num brief-banned__n">${banned.length}</b></h3>
    ${banned.length ? html`<div class="brief-banned__groups">
      ${groups.map((g) => {
        const state = model.stateOf(g.bond.bondId);
        const off = !!state;
        return html`<div key=${g.bond.bondId} class="brief-banned__group" data-bond=${g.bond.bondId}>
          <div class="brief-banned__ghead">
            <${Tooltip} text=${briefingBondTip(g.bond.name, state, g.ids.length)}>
              <${BondDisc} name=${g.bond.name} icon=${bondIconUrl(m, g.bond.bondId)} active=${!off} disabled=${off}
                tier=${off ? 0 : (g.bond.thresholds?.length || 1)} maxTier=${Math.max(1, g.bond.thresholds?.length || 1)} size="sm" />
            <//>
            <span class="brief-banned__gname">${g.bond.name}</span>
            <b class="num brief-banned__gcount">${g.ids.length}</b>
          </div>
          <div class="brief-banned__grid">
            ${g.ids.map((id) => html`<${UnitThumb} key=${id} kind="chess" id=${id} size="sm" class="is-banned" />`)}
          </div>
        </div>`;
      })}
    </div>` : html`<p class="t-dim">${t('本局没有禁用干员')}</p>`}
    <${DiyBannedLine} model=${model} />
  </div>`;
}

/**
 * 本局特训敌人 (the mode's enemy types, config.modes[].factions): the round icons of the briefing, shared with the strategy
 * draft's 本局信息 dialog (experimental flag `briefingSpecialEnemies`, **on unless the room switched it off** — the owner's
 * default of 2026-10-16). The description rides in the tooltip; the empty state says the match has none.
 * @param {{ types: string[], factions: Record<string, any>, assets: any }} props types: factionTypes(pub.factions);
 *   factions: gd.factions.types; assets: gd.m (the manifest the icons resolve against)
 */
export function SpecialEnemies({ types, factions, assets }) {
  return html`<div class="brief-factions">
    ${types.length ? types.map((ty) => html`<${Tooltip} key=${ty} text=${factions[ty]?.desc || null}>
      <div class="brief-faction" tabindex="0">
        <span class="brief-faction__icon"><${Img} src=${factionIconUrl(assets, factions[ty]?.icon)} /></span>
        <b class="brief-faction__name">${factions[ty]?.name || ty}</b>
      </div>
    <//>`) : html`<p class="t-dim">${t('本局没有特训敌人')}</p>`}
  </div>`;
}

/**
 * The briefing's bonds and banned operators: 核心盟约, 附加盟约, the legend, 本局禁用干员.
 * @param {{ model: MatchInfoModel }} props
 */
export function MatchInfo({ model }) {
  return html`<${MatchBondRow} title=${t('核心盟约')} micro="CORE BONDS" bonds=${model.core} model=${model} />
    <${MatchBondRow} title=${t('附加盟约')} micro="ADD-ON BONDS" bonds=${model.addon} model=${model} />
    <${MatchLegend} model=${model} />
    <${BannedOperators} model=${model} />`;
}

/**
 * The read-only match-info dialog (the strategy draft's 本局信息): MatchInfo in a Modal that 关闭, a tap outside or Esc
 * closes. `status` (the caller's line, e.g. the draft's turn and countdown) sits left of 关闭. 本局特训敌人 goes on top
 * (read from `pub`), **on unless the room set `briefingSpecialEnemies: false`** (the owner's default of 2026-10-16), and the
 * match's boss is named beside the heading. A room that switched it off sees exactly the old dialog.
 * @param {{ open: boolean, onClose: Function, model: MatchInfoModel|null, status?: any, pub?: any }} props
 */
export function MatchInfoDialog({ open, onClose, model, status = null, pub = null }) {
  // 策略阶段看特训敌人 is on unless the room turned it off (`briefingSpecialEnemies: false`).
  const special = pub?.experimental?.briefingSpecialEnemies === false ? [] : factionTypes(pub?.factions);
  const factions = data.get('factions')?.types || {};
  // The boss of this match, named next to the tiles (the briefing names it in its own 本局遭遇敌方 block). Plain lookups,
  // not the game-data hook: the block stays hookless and unit-testable, like the rest of this file.
  const bossRec = pub?.bossId ? data.lookup('bosses', pub.bossId) : null;
  const bossName = bossRec?.name || (bossRec?.enemyKey ? data.lookup('enemies', bossRec.enemyKey)?.name : null) || null;
  return html`<${Modal} open=${open && !!model} onClose=${onClose} title=${t('本局信息')} micro="MATCH INFO // BONDS & BANNED OPERATORS" class="minfo-dlg"
    actions=${html`${status ? html`<div class="minfo-dlg__status" data-testid="match-info-status">${status}</div>` : null}
      <${Button} variant="secondary" icon="close" data-autofocus data-testid="match-info-close" onClick=${onClose}>${t('关闭')}<//>`}>
    ${open && model ? html`${special.length ? html`<section class="brief-sec brief-sec--special">
      <h3 class="brief-h"><span>${t('本局特训敌人')}</span><${MicroLabel}>SPECIAL ENEMIES</${MicroLabel}>${bossName ? html`<span class="brief-h__boss" data-testid="match-info-boss">${t('敌方领袖')} ${bossName}</span>` : null}</h3>
      <${SpecialEnemies} types=${special} factions=${factions} assets=${data.get('assets')} />
    </section>` : null}
      <${MatchInfo} model=${model} />` : null}
  <//>`;
}
