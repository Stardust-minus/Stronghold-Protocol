// Single views follow the bond strip's owner; shared 联防/Boss fields show their actual participants separately.
import { useMemo } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Icon, Tooltip } from './components.js';
import { Img, GIcon } from './gameComponents.js';
import { chessAvatarUrl } from './assetUrls.js';
import { data, getChess, useData } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { appearanceRecord } from './skinAssets.js';

export function damageNumber(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1e8) return t('{0}亿', { 0: (n / 1e8).toFixed(2) });
  if (n >= 1e4) return t('{0}万', { 0: (n / 1e4).toFixed(2) });
  return String(Math.round(n));
}

export function acceptDamageSnapshot(current, next, matchId) {
  if (!matchId || next?.matchId !== matchId || !Number.isInteger(next.round) || next.round < 1
    || !['live', 'frozen'].includes(next.status) || !Array.isArray(next.owners)) return current;
  if (current?.matchId === matchId) {
    if (next.round < current.round) return current;
    if (next.round === current.round && current.status === 'frozen' && next.status === 'live') return current;
  }
  return next;
}

export function damageRows(snapshot, ownerId) {
  if (snapshot?.available === false) return { available: false, total: 0, rows: [] };
  const owner = snapshot?.owners?.find(p => p?.playerId === ownerId);
  if (!owner) return { available: false, total: 0, rows: [] };
  const rows = (Array.isArray(owner.operators) ? owner.operators : [])
    .filter(row => row && Number.isFinite(row.damage) && row.damage >= 0)
    .map((row, i) => ({ key: typeof row.key === 'string' ? row.key : `uid:${row.uid}:${i}`, uid: row.uid, defId: row.defId, damage: row.damage, other: false }));
  if (Number.isFinite(owner.otherDamage) && owner.otherDamage > 0) {
    rows.push({ key: 'other', uid: null, defId: null, damage: owner.otherDamage, other: true });
  }
  rows.sort((a, b) => b.damage - a.damage || a.key.localeCompare(b.key));
  const sum = rows.reduce((total, row) => total + row.damage, 0);
  return { available: true, total: Number.isFinite(owner.total) && owner.total >= 0 ? owner.total : sum, rows };
}

export function damageShare(damage, total) {
  return Number.isFinite(damage) && damage >= 0 && Number.isFinite(total) && total > 0
    ? Math.min(100, damage / total * 100) : 0;
}

/** Only actual 联防 participants: the current field, plus completed relay helpers in the authority's round ledger. */
export function uniteDamageOwners({ pub, fieldId, field = null } = {}) {
  if (![PHASE.UNITE, PHASE.SETTLE].includes(pub?.phase) || !['u', 'u:2'].includes(fieldId)) return null;
  const listed = Array.isArray(pub.fields) ? pub.fields.find(f => f?.fieldId === fieldId) : null;
  if (listed && listed.kind !== 'unite') return null;
  const meta = field?.fieldId === fieldId ? field : null;
  // SETTLE may already have retired public fields; retain the displayed field's actual members, not a guessed team.
  if (!listed && meta?.round != null && meta.round !== pub.round) return null;
  const members = Array.isArray(listed?.players) ? listed.players : Array.isArray(meta?.players) ? meta.players : [];
  if (!fieldDamageOwners(pub, members)) return null;
  const rounds = pub.phase === PHASE.SETTLE ? pub.uniteResult?.rounds : pub.unite?.rounds;
  const relay = pub.uniteRounds === 2 || Array.isArray(rounds);
  if (!relay) return fieldId === 'u' ? fieldDamageOwners(pub, members) : null;
  const completed = (Array.isArray(rounds) ? rounds : []).filter(row => row
    && (row.round === 1 || row.round === 2) && row.fieldId === (row.round === 1 ? 'u' : 'u:2')
    && Array.isArray(row.helpers) && row.helpers.length <= 2).flatMap(row => row.helpers);
  const final = pub.phase === PHASE.SETTLE && Array.isArray(pub.uniteResult?.helpers) ? pub.uniteResult.helpers : [];
  return fieldDamageOwners(pub, [...completed, ...members, ...final], 4);
}

/** Boss ownership comes only from the displayed current public field, never the other pair or stale field meta. */
export function bossDamageOwners({ pub, fieldId } = {}) {
  const kind = pub?.phase === PHASE.FINAL_ASSAULT ? 'boss' : pub?.phase === PHASE.HIDDEN_CORE ? 'hidden' : null;
  if (!kind || typeof fieldId !== 'string' || !fieldId) return null;
  const listed = Array.isArray(pub.fields) ? pub.fields.find(f => f?.fieldId === fieldId) : null;
  if (listed?.kind !== kind || !Array.isArray(listed.players)) return null;
  return fieldDamageOwners(pub, listed.players);
}

function fieldDamageOwners(pub, members, limit = 2) {
  const known = new Map((Array.isArray(pub.players) ? pub.players : []).filter(p => p?.playerId).map(p => [p.playerId, p]));
  const ids = [...new Set(members.filter(id => typeof id === 'string' && known.has(id)))];
  if (!ids.length || ids.length > limit) return null;
  return ids.map(playerId => ({ playerId, name: known.get(playerId).name || t('队友') }));
}

/** Per-player groups keep identical operator/other keys isolated and never label missing data as zero. */
export function damageGroups(snapshot, owners) {
  const seen = new Set();
  const groups = (Array.isArray(owners) ? owners : []).filter(owner => {
    if (!owner || typeof owner.playerId !== 'string' || !owner.playerId || seen.has(owner.playerId)) return false;
    seen.add(owner.playerId); return true;
  }).map(owner => ({ playerId: owner.playerId, name: owner.name || t('队友'), ...damageRows(snapshot, owner.playerId) }));
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  return { groups, shared: groups.length > 1, available: !!groups.length && groups.every(group => group.available) && Number.isFinite(total), total };
}

export function damageAppearance(chess, row, ownerId, units = []) {
  const unit = units.find(u => u?.ownerId === ownerId && u.defId === row.defId && u.uid === row.uid && u.kind === 'op');
  if (!chess || !unit?.skinId) return chess;
  return appearanceRecord({ ...chess, charId: unit.spine, assets: { ...chess.assets, avatar: unit.avatar } }, unit.skinId);
}

export function DamageBoard({ snapshot, ownerId, ownerName, uniteOwners = null, uniteRelay = false, bossOwners = null, bossHidden = false, open = false, onToggle, units = [] }) {
  useData('chess', 'assets');
  const boss = Array.isArray(bossOwners) && bossOwners.length > 0;
  const owners = boss ? bossOwners : Array.isArray(uniteOwners) && uniteOwners.length ? uniteOwners : [{ playerId: ownerId, name: ownerName || t('当前视角') }];
  const ownersKey = JSON.stringify(owners);
  const score = useMemo(() => open ? damageGroups(snapshot, owners) : null, [open, snapshot, ownersKey]);
  const frozen = snapshot?.status === 'frozen';
  const label = snapshot?.round > 0 ? t('第 {round} 回合 · {1}', { round: snapshot.round, 1: frozen ? t('结算冻结') : t('实时累计') }) : t('尚无战斗记录');
  const manifest = data.get('assets');
  const sharedTitle = boss ? bossHidden ? t('隐藏 Boss 输出') : t('Boss 输出') : t('联防输出');
  const sharedScope = boss ? t('同场玩家本轮累计') : uniteRelay ? t('各自行动 + 接力联防') : t('各自行动 + 联防');
  const heading = score?.shared ? t('{sharedTitle} · {n} 人', { sharedTitle, n: score.groups.length }) : score?.groups[0]?.name || ownerName || t('当前视角');
  return html`<aside class=${`damage-board${open ? ' is-open' : ''}`} aria-label=${t('干员输出统计')}>
    <button type="button" class="gm__gear tapx damage-board__toggle" aria-label=${t('输出统计')} title=${t('输出统计')} aria-controls="damage-report"
      aria-expanded=${String(open)} onClick=${() => onToggle?.(!open)}>
      <${Icon} name="sword" />
    </button>
    ${open ? html`<section id="damage-report" class="damage-board__panel" aria-label=${t('{heading}的伤害排行', { heading })}>
      <header>
        <div class="damage-board__heading"><span class="damage-board__eyebrow">DAMAGE REPORT</span><strong>${heading}</strong></div>
        <span class="damage-board__status"><${Icon} name=${frozen ? 'snow' : 'sword'} />${frozen ? t('已结算') : t('实时')}</span>
        <button type="button" class="damage-board__close" aria-label=${t('收起输出统计')} onClick=${() => onToggle?.(false)}><${Icon} name="close" /></button>
      </header>
      <div class="damage-board__summary">
        <div><span>${score.shared ? score.groups.length > 2 ? t('参与者本轮合计') : t('双方本轮合计') : t('累计伤害')}</span><strong class="damage-board__total">${score.available ? damageNumber(score.total) : '—'}</strong></div>
        <p class="damage-board__phase" role="status">${label}<small>${score.shared ? sharedScope : frozen ? t('保留至下一轮开战') : t('随当前视角同步')}</small></p>
      </div>
      <div class="damage-board__columns" aria-hidden="true"><span>${score.shared ? t('干员 / 本人占比') : t('干员 / 伤害占比')}</span><span>${t('实际伤害')}</span></div>
      ${score.shared ? html`<div class="damage-board__groups">
        ${score.groups.map(group => html`<section key=${group.playerId} class="damage-board__group" data-player-id=${group.playerId} aria-label=${t('{name}的输出', { name: group.name })}>
          <header class="damage-board__group-heading"><strong title=${group.name}>${group.name}</strong>
            <span>${t('小计')} <b class="num">${group.available ? damageNumber(group.total) : '—'}</b></span></header>
          <${DamageRows} score=${group} manifest=${manifest} ownerName=${group.name} shared=${true} units=${units} />
        </section>`)}
      </div>` : html`<${DamageRows} score=${score.groups[0]} manifest=${manifest} units=${units} />`}
      <details class="damage-board__rules"><summary>${t('统计口径')}</summary><p>${score.shared ? boss ? t('仅展示当前 Boss 战场的参与者，分别统计本轮累计；占比以该玩家小计计算，不等同于全队共享 Boss 血池扣血。') : t('按场上参与者分别展示本轮累计（各自行动 + 联防），占比以该玩家小计计算。') : ''}${t('只计实际扣除的生命值。召唤物归所属干员；装置与无干员归属伤害单列；过量伤害、护盾吸收与友方伤害不计。')}</p></details>
    </section>` : null}
  </aside>`;
}

function DamageRows({ score = { available: false, rows: [], total: 0 }, manifest, ownerName, shared = false, units = [] }) {
  return html`<ol class="damage-board__rows">
    ${score.rows.length ? score.rows.map((row, index) => {
      const chess = row.other ? null : damageAppearance(getChess(row.defId), row, score.playerId, units);
      const name = row.other ? t('装置 / 其他') : chess?.name || row.defId || t('干员');
      const share = damageShare(row.damage, score.total);
      const detail = t('{0}{name} · 实际伤害 {2} · {3} {4}%', { 0: shared ? `${ownerName} · ` : '', name, 2: row.damage.toLocaleString('zh-CN', { maximumFractionDigits: 2 }), 3: shared ? t('本人占比') : t('占比'), 4: share.toFixed(1) });
      return html`<li key=${row.key}>
        <${Tooltip} text=${detail} block class="damage-board__tip">
          <div class="damage-board__row" tabIndex="0" aria-label=${detail}>
            <span class="damage-board__portrait" aria-hidden="true">
              ${row.other ? html`<${GIcon} name="gear" />` : html`<${Img} src=${chessAvatarUrl(manifest, chess)} fallbackSrc=${chessAvatarUrl(manifest, chess && { ...chess, skinId: null })}
                fallback=${html`<span class="damage-board__initial">${Array.from(name)[0]}</span>`} />`}
              <span class="damage-board__rank num">${index + 1}</span>
            </span>
            <span class="damage-board__row-body">
              <span class="damage-board__row-label"><span class="damage-board__name">${name}</span><span class="damage-board__value num">${damageNumber(row.damage)}</span></span>
              <span class="damage-board__row-meter"><span class="damage-board__bar" aria-hidden="true"><i style=${`transform:scaleX(${share / 100})`}></i></span><span class="damage-board__share num">${share.toFixed(1)}%</span></span>
            </span>
          </div>
        <//>
      </li>`;
    }) : html`<li class="damage-board__empty"><${Icon} name="sword" /><strong>${score.available ? t('本轮尚未造成伤害') : t('暂无此视角的战斗记录')}</strong><span>${t('开战后自动记录干员输出')}</span></li>`}
  </ol>`;
}
