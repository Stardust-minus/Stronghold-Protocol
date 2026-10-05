// The board follows the bond strip's owner and displays accepted combat statistics, never estimated hit events.
import { useMemo, useState } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel } from './components.js';
import { getChess, useData } from '../data.js';

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

export function DamageBoard({ snapshot, ownerId, ownerName }) {
  const [open, setOpen] = useState(false);
  useData('chess');
  const score = useMemo(() => open ? damageRows(snapshot, ownerId) : null, [open, snapshot, ownerId]);
  const label = snapshot?.round > 0 ? `第 ${snapshot.round} 回合 · ${snapshot.status === 'frozen' ? '结算冻结' : '实时累计'}` : '尚无战斗记录';
  return html`<aside class=${`damage-board${open ? ' is-open' : ''}`} aria-label="干员输出统计">
    <button type="button" class="damage-board__toggle" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
      <${Icon} name="sword" /><span>输出统计</span><${Icon} name=${open ? 'chevronDown' : 'chevronUp'} />
    </button>
    ${open ? html`<section class="damage-board__panel">
      <header><div><${MicroLabel} tone="mint">DAMAGE REPORT<//><strong>${ownerName || '当前视角'}</strong></div>
        <span class="damage-board__total num">${score.available ? damageNumber(score.total) : '—'}</span></header>
      <p class="damage-board__phase" role="status">${label}</p>
      <ol class="damage-board__rows">
        ${score.rows.length ? score.rows.map((row, index) => html`<li key=${row.key}>
          <div class="damage-board__row"><span class="damage-board__rank num">${index + 1}</span>
            <span class="damage-board__name">${row.other ? '装置 / 其他' : getChess(row.defId)?.name || row.defId || '干员'}</span>
            <span class="damage-board__value num">${damageNumber(row.damage)}</span></div>
          <div class="damage-board__bar" aria-hidden="true"><i style=${`transform:scaleX(${score.total > 0 ? Math.min(1, row.damage / score.total) : 0})`}></i></div>
        </li>`) : html`<li class="damage-board__empty">${score.available ? '本轮尚未造成伤害' : '暂无此视角的战斗记录'}</li>`}
      </ol>
      <small>实际扣除的生命值 · 召唤物归召唤者 · 过量伤害与护盾吸收不计</small>
    </section>` : null}
  </aside>`;
}
