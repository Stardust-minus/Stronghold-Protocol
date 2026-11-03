// 调控台 (feedback #125; the main assistant's review of 2026-11-03): the body of ui/testConsole.js in a console match
// (shared/experimental.js isConsoleRoom) — an upstream test room keeps its own body. No raw id is typed or shown: every
// pick is a native <select> of localized names (value = the id; 干员 and 装备 grouped by tier), with a 搜索 field above a
// list longer than SEARCH_MIN that filters by name; 召唤物 lists the placeable summons of a piece the player holds, picked
// by name. 盟约 sets the absolute layers, prefilled with the player's own and never lower (the server refuses a decrease),
// plus the optional 额外人数; 加入敌人 (bounty) adds 1–20 of an enemy to the player's next battle (the match's leaders left
// out). The match-wide controls (timers, phase jumps, 回合, 领袖生命, 队伍生命) only for the match's only human (the server
// checks the same). 下一轮商店 and 机变 take raw ids upstream and are left out here [ASSUMED: the owner did not ask for them].
// The audit log reads in words (consoleLogText). Option builders and texts are hookless (tests).

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { data } from '../data.js';
import { t, N_ } from '../../../shared/i18n.js';
import { TEST_BOUNTY_MAX, TEST_BOUNTY_BATTLE_MAX } from '../../../shared/testMode.js';
import { matchClock, explainTestDetail } from './testAudit.js';
import { ERR_TEXT } from '../../../shared/constants.js';

/** A list longer than this gets a 搜索 field. */
export const SEARCH_MIN = 20;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
const defaultName = (rec, id) => (typeof rec?.name === 'string' && rec.name ? rec.name : id || '');
const num = (raw) => (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null);

/** The command labels (msgids). */
export const CONSOLE_LABELS = Object.freeze({
  funds: N_('资金'), chess: N_('干员'), item: N_('装备'), token: N_('召唤物'), lp: N_('目标生命'), hp: N_('领袖生命'), teamLp: N_('队伍生命'),
  round: N_('回合'), phase: N_('阶段'), shop: N_('下一轮商店'), timers: N_('计时'), bond: N_('盟约'), strategy: N_('策略'),
  level: N_('升级调度中心'), bounty: N_('加入敌人'), choice: N_('机变'),
});
const PHASE_LABELS = Object.freeze({ advance: N_('继续被暂停的阶段'), battleCheck: N_('结束策略选择'), prep: N_('进入休整'), sp: N_('进入机变'), combat: N_('开始作战') });
/** The commands this body offers, in order; the match-wide ones only with `shared`. */
export function consoleCommands(shared) {
  return ['funds', 'chess', 'item', 'token', 'bond', 'bounty', 'strategy', 'lp', 'level', ...(shared ? ['round', 'hp', 'teamLp'] : [])];
}

/**
 * 干员: the in-pool normal forms (not elite, not 自选 slots, not hidden), by tier (group) and shop order; the player's own
 * slotted 自选 pieces (m.private `diy`: slot id → pick) under their operator's name in their tier — the server grants a
 * slotted slot through the player's data view.
 * @param {any} chess data/chess.json @param {{ diy?: any, backups?: any, name?: (rec: any, id: string) => string }} [o]
 */
export function chessOptions(chess, { diy = null, backups = null, name = defaultName } = {}) {
  const out = [];
  for (const [id, r] of Object.entries(isObj(chess) ? chess : {})) {
    if (!isObj(r) || r.isGolden || r.isDiy || r.isHidden === true || !Number.isInteger(r.tier)) continue;
    out.push({ value: id, name: name(r, id), group: r.tier, sort: Number(r.shopSortId) || 0 });
  }
  for (const [slotId, pick] of Object.entries(isObj(diy) ? diy : {})) {
    const slot = chess?.[slotId], unit = backups?.units?.[pick?.charId];
    if (!isObj(slot) || !slot.isDiy || !Number.isInteger(slot.tier) || !isObj(unit)) continue;
    out.push({ value: slotId, name: t('{name}（自选）', { name: name(unit, pick.charId) }), group: slot.tier, sort: Number.MAX_SAFE_INTEGER });
  }
  return out.sort((a, b) => a.group - b.group || a.sort - b.sort || byName(a, b));
}

/** 装备: every item but the merged (elite) forms, by tier and shop order. @param {any} items data/items.json */
export function itemOptions(items, { name = defaultName } = {}) {
  const out = [];
  for (const [id, r] of Object.entries(isObj(items) ? items : {})) {
    if (!isObj(r) || r.isGolden || !Number.isInteger(r.tier)) continue;
    out.push({ value: id, name: name(r, id), group: r.tier, sort: Number(r.shopSortId) || 0 });
  }
  return out.sort((a, b) => a.group - b.group || a.sort - b.sort || byName(a, b));
}

/** 盟约: the bonds the match's mode does not switch off (config modes[].inactiveBondIds), in bond order. */
export function bondOptions(bonds, inactive = [], { name = defaultName } = {}) {
  const off = new Set(Array.isArray(inactive) ? inactive : []);
  return Object.entries(isObj(bonds) ? bonds : {}).filter(([id, r]) => isObj(r) && !off.has(id))
    .map(([id, r]) => ({ value: id, name: name(r, id), sort: Number(r.bondOrder) || 0 }))
    .sort((a, b) => a.sort - b.sort || byName(a, b));
}

/** 策略: the strategies of the match's mode type (bands.json modeTypeList), in their order. */
export function bandOptions(bands, modeType = null, { name = defaultName } = {}) {
  return Object.entries(isObj(bands) ? bands : {})
    .filter(([, r]) => isObj(r) && (!modeType || !Array.isArray(r.modeTypeList) || r.modeTypeList.includes(modeType)))
    .map(([id, r]) => ({ value: id, name: name(r, id), sort: Number(r.sortId) || 0 }))
    .sort((a, b) => a.sort - b.sort || byName(a, b));
}

/**
 * 加入敌人: the enemies of the match data but its leaders (data/bosses.json enemyKey — the server refuses them), the mode's
 * inactive ones and the summon-only units (tokenOnly) [ASSUMED: spawned alone they are no target practice], by name.
 */
export function enemyOptions(enemies, bosses, inactive = [], { name = defaultName } = {}) {
  const leaders = new Set(Object.values(isObj(bosses) ? bosses : {}).map((b) => b?.enemyKey).filter(Boolean));
  const off = new Set(Array.isArray(inactive) ? inactive : []);
  return Object.entries(isObj(enemies) ? enemies : {})
    .filter(([id, r]) => isObj(r) && !leaders.has(id) && !off.has(id) && r.tokenOnly !== true)
    .map(([id, r]) => ({ value: id, name: name(r, id) })).sort(byName);
}

/** The chess pieces the player holds (hand, temp, board) by name — a repeated name numbered. @param {any} priv m.private */
export function ownedPieces(priv, chess, { name = defaultName } = {}) {
  const list = [...(priv?.hand || []), ...(priv?.temp || []), ...(priv?.board || []).map((x) => x?.piece || x)]
    .filter((p) => p?.kind === 'chess' && Number.isInteger(p.uid));
  const seen = new Map();
  return list.map((p) => {
    const base = name(chess?.[p.id], p.id);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { value: String(p.uid), name: n > 1 ? `${base} (${n})` : base, id: p.id };
  });
}

/** The placeable summons of a held piece (its record's `tokens`). */
export function tokenOptions(chessId, chess, tokens, { name = defaultName } = {}) {
  return (chess?.[chessId]?.tokens || []).filter((id) => tokens?.[id]?.kind === 'summon' && tokens[id].placeable === true)
    .map((id) => ({ value: id, name: name(tokens[id], id) }));
}

/** The options a 搜索 query leaves (name substring, case-insensitive) and the value the select holds among them. */
export function pickModel(options, query, value) {
  const q = String(query || '').trim().toLowerCase();
  const shown = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  return { shown, value: shown.some((o) => o.value === value) ? value : shown[0]?.value ?? '' };
}

/** The player's layers of a bond (m.private bonds). */
export const currentLayers = (priv, bondId) => (Array.isArray(priv?.bonds) ? priv.bonds.find((b) => b?.bondId === bondId)?.layers ?? 0 : 0) | 0;

/**
 * One audit row's command in words: 「资金 → 777」「干员 能天使」「加入敌人 源石虫 ×13」「盟约 炎 → 10 层」. `names` resolves an
 * id of a table to its localized name. A refused shape ({ rejected }) is the label alone.
 * @param {any} entry @param {(table: string, id: string) => string} names
 */
export function consoleCommandText(entry, names) {
  const e = entry || {};
  const label = t(CONSOLE_LABELS[e.cmd] || '指令');
  const a = isObj(e.args) && !e.args.rejected ? e.args : null;
  if (!a) return label;
  switch (e.cmd) {
    case 'funds': return t('{label} → {value}', { label, value: a.amount });
    case 'lp': case 'hp': case 'teamLp': return t('{label} → {value}', { label, value: a.value });
    case 'round': return t('{label} → {value}', { label, value: a.round });
    case 'chess': return t('{label} {name}', { label, name: names('chess', a.id) });
    case 'item': return t('{label} {name}', { label, name: names('items', a.id) });
    case 'token': return t('{label} {name}', { label, name: names('tokens', a.id) });
    case 'strategy': return t('{label} {name}', { label, name: names('bands', a.id) });
    case 'bounty': return t('{label} {name} ×{n}', { label, name: names('enemies', a.enemyKey), n: a.count ?? 1 });
    case 'bond': {
      const text = t('{label} {name} → {n} 层', { label, name: names('bonds', a.id), n: a.layers });
      return Number.isInteger(a.count) ? `${text} · ${t('额外人数 {n}', { n: a.count })}` : text;
    }
    case 'timers': return t('{label} → {value}', { label, value: a.on ? t('开启') : t('关闭') });
    case 'phase': return t('{label} {name}', { label, name: t(PHASE_LABELS[a.name] || a.name || '') });
    default: return label;
  }
}

/** One audit line in console mode: number, actor, clock, the command in words, the translated result. */
export function consoleLogText(entry, who, names) {
  const e = entry || {};
  const result = e.ok ? t('成功') : (explainTestDetail(e.detail) || (e.code && Object.hasOwn(ERR_TEXT, e.code) ? t(ERR_TEXT[e.code]) : (e.code || '')));
  return `${e.seq} ${who || e.playerId || ''} ${matchClock(e.at)} ${consoleCommandText(e, names)} ${result}`;
}

/** A labelled native select (+ 搜索 above a long list). `model` = pickModel(...). */
function Pick({ id, label, options, model, query, onQuery, onValue, grouped = false }) {
  const groups = [];
  if (grouped) for (const o of model.shown) { const g = groups.at(-1); if (g && g.key === o.group) g.items.push(o); else groups.push({ key: o.group, items: [o] }); }
  const opt = (o) => html`<option key=${o.value} value=${o.value}>${o.name}</option>`;
  return html`<div class="testconsole__pick">
    ${options.length > SEARCH_MIN ? html`<label class="testconsole__field testconsole__search">${t('搜索')}
      <input value=${query} onInput=${(e) => onQuery(e.target.value)} data-testid=${`${id}-search`} placeholder=${t('输入名称筛选')} /></label>` : null}
    <label class="testconsole__field">${label}
      <select value=${model.value} onChange=${(e) => onValue(e.target.value)} data-testid=${id} disabled=${!model.shown.length}>
        ${!model.shown.length ? html`<option value="">${t('没有匹配的项')}</option>`
          : grouped ? groups.map((g) => html`<optgroup key=${g.key} label=${t('{tier}阶', { tier: g.key })}>${g.items.map(opt)}</optgroup>`)
            : model.shown.map(opt)}
      </select></label>
  </div>`;
}

/**
 * The console-mode body. `send(cmd, args)` sends g.test (refusals toast); `runRef.current` is set to the run of the shown
 * command (Enter in a field runs it, ui/testConsole.js).
 * @param {{ pub: any, priv: any, shared: boolean, send: (cmd: string, args?: object) => any, runRef: { current: any },
 *   toastBad: () => void }} props
 */
export function ConsoleBody({ pub, priv, shared, send, runRef, toastBad }) {
  const [cmd, setCmd] = useState('funds');
  const [amount, setAmount] = useState('0');
  const [round, setRound] = useState('1');
  const [layers, setLayers] = useState('0');
  const [extra, setExtra] = useState('');
  const [count, setCount] = useState('1');
  const [sel, setSel] = useState({});
  const [query, setQuery] = useState({});
  // the log: about six rows on a desktop; on a phone its newest two until opened (css/screens/game.css)
  const [logOpen, setLogOpen] = useState(false);
  const name = (rec, id) => data.localeName(defaultName(rec, id));
  const chess = data.get('chess') || {}, tokens = data.get('tokens') || {};
  const mode = data.get('config')?.modes?.[pub?.modeId] || null;
  const lists = {
    chess: () => chessOptions(chess, { diy: priv?.diy, backups: data.get('backups'), name }),
    item: () => itemOptions(data.get('items'), { name }),
    bond: () => bondOptions(data.get('bonds'), mode?.inactiveBondIds, { name }),
    strategy: () => bandOptions(data.get('bands'), mode?.type ?? null, { name }),
    bounty: () => enemyOptions(data.get('enemies'), data.get('bosses'), mode?.inactiveEnemyKeys, { name }),
    owner: () => ownedPieces(priv, chess, { name }),
  };
  const opts = {};
  const model = (key, list) => {
    opts[key] = list;
    return pickModel(list, query[key], sel[key]);
  };
  const commands = consoleCommands(shared);
  const shownCmd = commands.includes(cmd) ? cmd : 'funds';
  const listKey = shownCmd === 'token' ? 'owner' : shownCmd;
  const main = lists[listKey] ? model(listKey, lists[listKey]()) : null;
  const ownerId = shownCmd === 'token' ? opts.owner.find((o) => o.value === main.value)?.id : null;
  const tok = shownCmd === 'token' ? model('token', tokenOptions(ownerId, chess, tokens, { name })) : null;
  const bondId = shownCmd === 'bond' ? main.value : null;
  const cur = currentLayers(priv, bondId);
  // 盟约: the layers field starts at the player's own count of the picked bond
  useEffect(() => { if (shownCmd === 'bond') setLayers(String(cur)); }, [shownCmd, bondId]);
  const nLayers = num(layers);
  const pick = (key) => (value) => setSel((s) => ({ ...s, [key]: value }));
  const search = (key) => (q) => setQuery((s) => ({ ...s, [key]: q }));

  runRef.current = () => {
    switch (shownCmd) {
      case 'funds': case 'lp': case 'hp': case 'teamLp': {
        const n = num(amount);
        return n == null ? toastBad() : send(shownCmd, { [shownCmd === 'funds' ? 'amount' : 'value']: n });
      }
      case 'chess': case 'item': case 'strategy': return main.value ? send(shownCmd, { id: main.value }) : toastBad();
      case 'token': return main.value && tok.value ? send('token', { id: tok.value, ownerUid: Number(main.value) }) : toastBad();
      case 'bond': {
        const n2 = extra.trim() === '' ? null : num(extra);
        if (!main.value || nLayers == null || (extra.trim() !== '' && n2 == null)) return toastBad();
        return send('bond', { id: main.value, layers: nLayers, ...(n2 == null ? {} : { count: n2 }) });
      }
      case 'bounty': {
        const n = num(count);
        if (!main.value || n == null || n < 1 || n > TEST_BOUNTY_MAX) return toastBad();
        return send('bounty', { enemyKey: main.value, ...(n !== 1 ? { count: n } : {}) });
      }
      case 'round': { const n = num(round); return n == null ? toastBad() : send('round', { round: n }); }
      case 'level': return send('level', {});
      default: return null;
    }
  };

  const label = { chess: t('干员'), item: t('装备'), bond: t('盟约'), strategy: t('策略'), bounty: t('敌人'), owner: t('所属棋子') }[listKey];
  const names = (table, id) => name((data.get(table) || {})[id], id);
  const who = new Map((pub?.players || []).map((p) => [p.playerId, p.name]));
  const log = Array.isArray(pub?.testLog) ? pub.testLog.slice().reverse() : [];
  return html`<div class="testconsole__console" data-testid="console-body">
    <label class="testconsole__field">${t('指令')}
      <select value=${shownCmd} onChange=${(e) => setCmd(e.target.value)} data-testid="console-cmd">
        ${commands.map((c) => html`<option key=${c} value=${c}>${t(CONSOLE_LABELS[c])}</option>`)}
      </select>
    </label>
    <div class="testconsole__mid">
    <div class="testconsole__row">
      ${main ? html`<${Pick} id=${`console-${listKey}`} label=${label} options=${opts[listKey]} model=${main} query=${query[listKey] || ''}
        onQuery=${search(listKey)} onValue=${pick(listKey)} grouped=${listKey === 'chess' || listKey === 'item'} />` : null}
      ${tok ? html`<${Pick} id="console-token" label=${t('召唤物')} options=${opts.token} model=${tok} query=${query.token || ''}
        onQuery=${search('token')} onValue=${pick('token')} />` : null}
      ${shownCmd === 'funds' || shownCmd === 'lp' || shownCmd === 'hp' || shownCmd === 'teamLp' ? html`<label class="testconsole__field">${t(CONSOLE_LABELS[shownCmd])}
        <input value=${amount} onInput=${(e) => setAmount(e.target.value)} inputmode="numeric" data-testid="console-amount" /></label>` : null}
      ${shownCmd === 'round' ? html`<label class="testconsole__field">${t('回合')}
        <input value=${round} onInput=${(e) => setRound(e.target.value)} inputmode="numeric" data-testid="console-round" /></label>` : null}
      ${shownCmd === 'bond' ? html`<label class="testconsole__field testconsole__num">${t('层数')}
          <input value=${layers} onInput=${(e) => setLayers(e.target.value)} inputmode="numeric" data-testid="console-layers" /></label>
        <label class="testconsole__field testconsole__num">${t('额外人数')}
          <input value=${extra} onInput=${(e) => setExtra(e.target.value)} inputmode="numeric" placeholder=${t('可不填')} data-testid="console-extra" /></label>
        ${nLayers != null && nLayers < cur ? html`<small class="testconsole__warn" data-testid="console-layers-low">${t('不能低于当前层数 {n}', { n: cur })}</small>`
          : html`<small class="testconsole__hint t-dim">${t('当前 {n} 层', { n: cur })}</small>`}` : null}
      ${shownCmd === 'bounty' ? html`<label class="testconsole__field testconsole__num">${t('数量')}
          <input value=${count} onInput=${(e) => setCount(e.target.value)} inputmode="numeric" data-testid="test-console-bounty-count" /></label>
        <small class="testconsole__hint t-dim">${t('加入你的下一场战斗；每场最多 {max} 个，不含领袖', { max: TEST_BOUNTY_BATTLE_MAX })}</small>` : null}
      ${shownCmd === 'token' && !opts.owner.length ? html`<small class="testconsole__hint t-dim">${t('先持有带召唤物的干员')}</small>` : null}
      <button type="button" class="testconsole__run" data-testid="console-run" onClick=${() => runRef.current()}>${t('执行')}</button>
    </div>
    ${shared ? html`<div class="testconsole__row testconsole__shared">
        <button type="button" onClick=${() => send('timers', { on: false })}>${t('关闭计时')}</button>
        <button type="button" onClick=${() => send('timers', { on: true })}>${t('开启计时')}</button>
        <span class="t-dim">${pub.testTimers === false ? t('计时已关闭') : t('计时进行中')}</span>
        <button type="button" onClick=${() => send('phase', { name: 'advance' })}>${t('继续被暂停的阶段')}</button>
        <button type="button" onClick=${() => send('phase', { name: 'battleCheck' })}>${t('结束策略选择')}</button>
        <button type="button" onClick=${() => send('phase', { name: 'prep' })}>${t('进入休整')}</button>
        <button type="button" onClick=${() => send('phase', { name: 'sp' })}>${t('进入机变')}</button>
        <button type="button" onClick=${() => send('phase', { name: 'combat' })}>${t('开始作战')}</button>
      </div>`
      : html`<p class="testconsole__row t-dim" data-testid="test-console-shared-off">${t('有其他博士在场时，跳过阶段、回合与计时等影响整局的指令不可用')}</p>`}
    </div>
    <div class=${`testconsole__logbox${logOpen ? ' is-open' : ''}`}>
      ${log.length > 2 ? html`<button type="button" class="testconsole__logtoggle" data-testid="console-log-toggle" aria-expanded=${logOpen ? 'true' : 'false'}
        onClick=${() => setLogOpen(!logOpen)}>${logOpen ? t('收起记录') : t('全部记录（{n}）', { n: log.length })}</button>` : null}
      <ul class="testconsole__log" data-testid="console-log">
        ${log.length ? log.map((e) => html`<li key=${e.seq} class=${e.ok ? 'is-ok' : 'is-bad'}>${consoleLogText(e, who.get(e.playerId), names)}</li>`)
          : html`<li class="t-dim">${t('尚无调控台指令')}</li>`}
      </ul>
    </div>
  </div>`;
}
