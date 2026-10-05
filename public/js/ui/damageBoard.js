// The board follows the bond strip's owner and displays accepted combat statistics, never estimated hit events.
import { useMemo } from '../../vendor/hooks.module.js';
import { html, Icon, Tooltip } from './components.js';
import { Img, GIcon } from './gameComponents.js';
import { chessAvatarUrl } from './assetUrls.js';
import { data, getChess, useData } from '../data.js';

export function damageNumber(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
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

export function DamageBoard({ snapshot, ownerId, ownerName, open = false, onToggle }) {
  useData('chess', 'assets');
  const score = useMemo(() => open ? damageRows(snapshot, ownerId) : null, [open, snapshot, ownerId]);
  const frozen = snapshot?.status === 'frozen';
  const label = snapshot?.round > 0 ? `第 ${snapshot.round} 回合 · ${frozen ? '结算冻结' : '实时累计'}` : '尚无战斗记录';
  const manifest = data.get('assets');
  return html`<aside class=${`damage-board${open ? ' is-open' : ''}`} aria-label="干员输出统计">
    <button type="button" class="damage-board__toggle" aria-label="输出统计" title="输出统计" aria-controls="damage-report"
      aria-expanded=${String(open)} onClick=${() => onToggle?.(!open)}>
      <${Icon} name="sword" /><span>输出统计</span><${Icon} name=${open ? 'chevronDown' : 'chevronUp'} />
    </button>
    ${open ? html`<section id="damage-report" class="damage-board__panel" aria-label=${`${ownerName || '当前视角'}的伤害排行`}>
      <header>
        <div class="damage-board__heading"><span class="damage-board__eyebrow">DAMAGE REPORT</span><strong>${ownerName || '当前视角'}</strong></div>
        <span class="damage-board__status"><${Icon} name=${frozen ? 'snow' : 'sword'} />${frozen ? '已结算' : '实时'}</span>
        <button type="button" class="damage-board__close" aria-label="收起输出统计" onClick=${() => onToggle?.(false)}><${Icon} name="close" /></button>
      </header>
      <div class="damage-board__summary">
        <div><span>累计伤害</span><strong class="damage-board__total">${score.available ? damageNumber(score.total) : '—'}</strong></div>
        <p class="damage-board__phase" role="status">${label}<small>${frozen ? '保留至下一轮开战' : '随当前视角同步'}</small></p>
      </div>
      <div class="damage-board__columns" aria-hidden="true"><span>干员 / 伤害占比</span><span>实际伤害</span></div>
      <ol class="damage-board__rows">
        ${score.rows.length ? score.rows.map((row, index) => {
          const chess = row.other ? null : getChess(row.defId);
          const name = row.other ? '装置 / 其他' : chess?.name || row.defId || '干员';
          const share = damageShare(row.damage, score.total);
          const detail = `${name} · 实际伤害 ${row.damage.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} · 占比 ${share.toFixed(1)}%`;
          return html`<li key=${row.key}>
            <${Tooltip} text=${detail} block class="damage-board__tip">
              <div class="damage-board__row" tabIndex="0" aria-label=${detail}>
                <span class="damage-board__portrait" aria-hidden="true">
                  ${row.other ? html`<${GIcon} name="gear" />` : html`<${Img} src=${chessAvatarUrl(manifest, chess)}
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
        }) : html`<li class="damage-board__empty"><${Icon} name="sword" /><strong>${score.available ? '本轮尚未造成伤害' : '暂无此视角的战斗记录'}</strong><span>开战后自动记录干员输出</span></li>`}
      </ol>
      <details class="damage-board__rules"><summary>统计口径</summary><p>只计实际扣除的生命值。召唤物归所属干员；装置与无干员归属伤害单列；过量伤害、护盾吸收与友方伤害不计。</p></details>
    </section>` : null}
  </aside>`;
}
