// 机变 draft overlay (research 06 §4.4 / §11.5): family title | description over "倒计时结束后仍未选定将自动分配",
// whose turn ("当前轮到你决策" / name over "正在决策…") with countdown — the pick order as ✓ / ••• on the team panel's
// portraits (spMarks) — and a 3×2 grid (solo: 3 cards) of cards in the official layout (the official 悬赏 / 机密商店 / 战术 screenshots): a
// framed icon at the top-left with the bold name beside it (tags under the name), the effect text across the card under
// both, left-aligned; the tier chip on the icon's corner and the taker's round avatar alone at the top-right (their
// name is its tooltip and part of the card's accessible name; a taken card's name wraps before it). The effect text
// is the official rich text of the item / effect (items.json / effects.json `descRaw` — the detail card's text — while it
// says what the server card's plain `desc` says: cardText), clamped by lines, and it fits the card on phones too (user
// playtest #6 item 6: at 756×366 it used to sit below a large centred icon, clipped away). Picking takes two taps, like
// buying in the shop (user playtest #4 item 2 — extra enemies, items and tactics were picked by a slip of the finger;
// research 09 §5 EventOnFirstClick → EventOnConfirm): the first tap on an available card selects it (it lifts with a
// white frame and a ☑ 确认选择 · 再次点击 strip; the header shows 确认选择), a second tap on the same card — or 确认选择 —
// sends g.choice; a tap on another card moves the selection, a tap elsewhere or Esc drops it. Cards are buttons (Tab /
// Enter work the same way). While the pick is in flight the card shows a "选择中" strip with a sweeping bar (never a
// spinner over its text — user playtest #3 item 9), dropped as soon as the pick shows in m.public (spBusy itself resets
// when the request settles, ≤ 8 s, or the phase moves on). Untimed drafts (solo, a single-human match: sp.untimed) show
// no countdown and say so. The 轮到你选 cue (its sound, and the official disc or a theme's banner) is screens/game.js's
// alone (upstream 0.4.0); this overlay emits none. The selected card's frame and its ☑ 确认选择 strip are white, as in the
// event's video (10:16).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { useSettings } from './settings.js';
import { usePrefabPack } from './prefab/view.js';
import { RegDeadlineCountdown } from './prefab/hud.js';
import { html, Icon, TierChip, Countdown, Button } from './components.js';
import { Img, RichText, PlayerAvatar, GIcon, LocalSprite } from './gameComponents.js';
import { itemIconUrl, enemyIconUrl, uiUrl } from './assetUrls.js';
import { richTextPlain } from './richText.js';
import { sortedPlayers, draftMyTurn } from './gameLogic.js';
import { data, localAsset } from '../data.js';
import { t, tc, tName } from '../../../shared/i18n.js';
import { sentText } from './lang.js';
import { MatchName } from './ownerName.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const bare = (t) => String(t || '').replace(/\s+/g, '');

/**
 * A card's effect text: the card's own rich text, else the data's rich text (highlighted numbers, 下场作战, set bonuses,
 * line breaks — the detail card's text) while it says what the server's plain `desc` says, else that plain text (a
 * server-side wording the data does not have wins). The server's texts are Chinese: `rawRich` is the record's Chinese
 * rich text they are compared with, `rich` the same record in the current language (the two are one text in Chinese).
 * @param {{ descRaw?: string, desc?: string }} card @param {string} rich items.json / effects.json descRaw
 * @param {string} [rawRich] its Chinese text (data.lookupRaw)
 */
export function cardText(card, rich, rawRich = rich) {
  if (card.descRaw) return rich && card.descRaw === rawRich ? rich : card.descRaw;
  if (rich && (!card.desc || bare(richTextPlain(rawRich || rich)) === bare(card.desc))) return rich;
  return card.desc || rich || '';
}

/**
 * Resolve an sp card to display fields.
 * @param {any} card normalised card ({ idx, takenBy, effectId?, itemId?, id?, name?, desc?, descRaw?, tier?, team?, enemyKey? })
 * @param {string|null} family 'bounty'|'supply'|'shop'|'tactic'
 */
export function resolveSpCard(card, family) {
  const choices = data.get('choices');
  const byEffect = (list, id) => (Array.isArray(list) && id ? list.find((x) => x && x.effectId === id) : null);
  const effectId = card.effectId || (!card.itemId && typeof card.id === 'string' && data.lookup('effects', card.id) ? card.id : null);
  const eff = effectId ? data.lookup('effects', effectId) : null;
  const itemId = card.itemId || (!effectId && typeof card.id === 'string' && data.lookup('items', card.id) ? card.id : null);
  const item = itemId ? data.lookup('items', itemId) : null;
  const rawRich = (itemId && data.lookupRaw('items', itemId)?.descRaw) || (effectId && data.lookupRaw('effects', effectId)?.descRaw) || '';
  const bounty = byEffect(choices?.cards?.bounty, effectId);
  const tactic = byEffect(choices?.cards?.tactic, effectId);
  const m = data.get('assets');
  const kind = card.kind === 'item' || item ? 'item' : card.kind === 'bounty' || bounty || family === 'bounty' ? 'bounty' : 'tactic';
  const enemyKey = card.enemyKey || bounty?.enemyKey || eff?.params?.enemy_id || null;
  const team = card.team ?? tactic?.team ?? (eff?.decoIconId === 'icon_team_buff');
  let icon = null;
  if (item) icon = itemIconUrl(m, item);
  else if (kind === 'bounty' && enemyKey) icon = enemyIconUrl(m, enemyKey);
  else if ((card.tacticKind || tactic?.kind) === 'terrain') icon = uiUrl(m, 'buffIcon/icon_stage_buff');
  else if ((card.tacticKind || tactic?.kind) === 'enemyDebuff') icon = uiUrl(m, 'buffIcon/icon_enemy_debuff');
  else icon = uiUrl(m, `buffIcon/${team ? 'icon_team_buff' : 'icon_player_buff'}`);
  return {
    kind,
    name: tName(card.name) || item?.name || eff?.name || bounty?.name || tactic?.name || t('机变'),
    desc: cardText(card, item?.descRaw || eff?.descRaw || '', rawRich) || item?.desc || eff?.desc || bounty?.desc || tactic?.desc || '',
    tier: Number.isFinite(card.tier) ? card.tier : item?.tier ?? bounty?.tier ?? null,
    icon,
    team: !!team,
    coin: card.coin ?? bounty?.coin ?? eff?.enemyPrice ?? null,
  };
}

/**
 * Whether a card shows the in-flight pick (g.choice sent, no answer yet): only until the pick lands in m.public — the
 * player's pick is known (or an exclusive card is taken) — so it can never outlive the request's effect.
 * @param {number|null} busyIdx @param {{ idx: number, takenBy?: string|null }} card @param {number|null|undefined} mine
 * @param {boolean} [allowRepeat] strict server flag; another player's pick does not finish my pending request
 */
export function pickBusy(busyIdx, card, mine, allowRepeat = false) {
  return busyIdx != null && !!card && busyIdx === card.idx && mine == null && (allowRepeat === true || !card.takenBy);
}

/**
 * Whether I may pick a card right now: my turn (solo: always), no pick of mine yet, the card free and no pick in flight.
 * @param {any} sp normalizeSp(...) @param {{ idx: number, takenBy?: string|null, soldOut?: boolean } | null | undefined} card
 * @param {{ myId: string, solo: boolean, busyIdx?: number|null }} o
 */
export function cardPickable(sp, card, { myId, solo, busyIdx = null }) {
  if (!sp || !card) return false;
  const myTurn = draftMyTurn(sp, myId, solo);
  return myTurn && sp.pickOf.get(myId) == null && (sp.allowRepeat === true || !card.takenBy) && !card.soldOut && busyIdx == null;
}

/**
 * Two-tap step of a card tap (like the shop's first tap → confirm): tapping an available card selects it, tapping the
 * selected card again confirms it. A card that cannot be picked changes nothing.
 * @param {number|null} armed the selected card's idx
 * @param {number} idx the tapped card
 * @param {boolean} pickable cardPickable(...) of the tapped card
 * @returns {{ armed: number|null, pick: number|null }} the new selection and the card to send (g.choice) or null
 */
export function spTap(armed, idx, pickable) {
  if (!pickable || !Number.isInteger(idx)) return { armed, pick: null };
  if (armed === idx) return { armed: null, pick: idx };
  return { armed: idx, pick: null };
}

/**
 * The selected card while it can still be picked (my turn, not taken, nothing in flight), else null — a selection
 * never outlives the state that allowed it.
 * @param {number|null} armed @param {any} sp @param {{ myId: string, solo: boolean, busyIdx?: number|null }} o
 */
export function armedCard(armed, sp, o) {
  if (armed == null || !sp) return null;
  const card = sp.cards.find((c) => c && c.idx === armed);
  return cardPickable(sp, card, o) ? armed : null;
}

/**
 * 收起 / 展开 of one pending choice (feedback #162: 「…那个界面会挡住商店和这回合的怪…加个隐藏，这样能看一眼商店和怪再选」):
 * hidden only while the stored key is the current choice's, so a new choice — another key — opens expanded again without
 * an effect. The key names the choice (screens/game.js: the round and family of a 机变 draft, a 教鞭 / 更换指令 id).
 * @param {string|null} key
 * @returns {[boolean, (hidden: boolean) => void]}
 */
export function usePeek(key) {
  const [hiddenKey, setHiddenKey] = useState(null);
  return [!!key && hiddenKey === key, (hidden) => setHiddenKey(hidden && key ? key : null)];
}

/**
 * The overlay: keeps the two-tap selection and renders ChoiceView. `onPick(idx)` sends the confirmed card (g.choice).
 * `collapsed` / `onCollapsedChange` (screens/game.js usePeek): 收起 hands the screen back — the shop, the board and its
 * enemy preview, the top bar with 敌方情报, the bond strip — while the countdown runs on in the 展开 button; the choice stays
 * pending and the selected card stays selected. Without them the overlay keeps its own state.
 * @param {{ pub:any, sp:any, myId:string, solo:boolean, personal?:boolean, onPick:(idx:number)=>void, busyIdx?:number|null, total?:number|null,
 *   collapsed?: boolean, onCollapsedChange?: (collapsed: boolean) => void }} props
 */
export function ChoiceOverlay(props) {
  const { pub, sp, myId, solo, personal = false, busyIdx = null, total = null, onPick, onCollapsedChange = null } = props;
  const [sel, setSel] = useState(null);
  const orderRef = useRef(null);
  // 收起 (the official 机变 panel's btn_close — autochess_battle_effect_choose_panel, its part_close / part_show states; the
  // 机密商店 at the right edge, BV13LWM6BEvY match 9 29:44): the board shows through until 展开; a new draft opens expanded
  const [ownCollapsed, setOwnCollapsed] = usePeek(sp ? `${personal ? 'p' : 's'}|${sp.id ?? ''}|${sp.family}|${sp.cards?.length ?? 0}` : null);
  const controlled = typeof onCollapsedChange === 'function';
  const collapsed = controlled ? props.collapsed === true : ownCollapsed;
  const setCollapsed = controlled ? onCollapsedChange : setOwnCollapsed;
  const armed = armedCard(sel, sp, { myId, solo, busyIdx });
  useEffect(() => {
    orderRef.current?.querySelector('.is-cur')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [sp?.turnPid]);
  // a selection whose card cannot be picked any more (taken, the turn moved on, a pick in flight) is dropped
  useEffect(() => { if (sel != null && armed == null) setSel(null); }, [sel, armed]);
  // (while hidden, Esc belongs to the screen — closing 敌方情报 or a detail card — and the selection is kept)
  useEffect(() => {
    if (armed == null || collapsed) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, collapsed]);
  // The pack also draws its official 机变 countdown. The shared your-turn cue is owned by screens/game.js so a theme
  // banner and its sound are emitted once from the same place.
  const settings = useSettings();
  const pack = usePrefabPack(data.get('local')?.groups, settings?.uiTheme);
  if (!sp) return null;
  const tap = (idx) => {
    const card = sp.cards.find((c) => c && c.idx === idx);
    const r = spTap(armed, idx, cardPickable(sp, card, { myId, solo, busyIdx }));
    setSel(r.armed);
    if (r.pick != null) onPick(r.pick);
  };
  // the 展开 button carries the choice's own clock: a timed draft's (pub.deadline), a 教鞭 choice's prep deadline
  const timed = personal ? pub?.deadline > 0 : !solo && !sp.untimed;
  if (collapsed) {
    return html`<${ChoicePill} sp=${sp} myId=${myId} solo=${solo} personal=${personal} deadline=${timed ? pub?.deadline : null} total=${total}
      armed=${armed != null} onExpand=${() => setCollapsed(false)} />`;
  }
  return html`<${ChoiceView} ...${props} orderRef=${orderRef} armed=${armed} onTap=${tap} pfPack=${pack} pfStill=${settings?.themeMotion === false}
    onConfirm=${() => { if (armed != null) tap(armed); }} onDisarm=${() => setSel(null)} onCollapse=${() => setCollapsed(true)} />`;
}

/**
 * The 展开 button of a hidden choice (PeekPill): the official part_show — the mint btn_open square with its glow — at the
 * right edge, with the choice's name, its countdown and 展开; it pulses while the viewer still has to choose (`turn`).
 * `armed`: a card is still selected (「已选中」 under the name). [ASSUMED] the official hidden state was not on screen in
 * the recordings; its prefab keeps btn_close at the panel's right of centre and dims the field (group_hide), which we do
 * not: the player hid the panel to look at the shop.
 * @param {{ name: string, turn?: boolean, deadline?: number|null, total?: number|null, armed?: boolean, onExpand: () => void, testId?: string }} props
 */
export function PeekPill({ name, turn = false, deadline = null, total = null, armed = false, onExpand, testId = 'sp-expand' }) {
  return html`<button type="button" class=${cx('spov-pill', 'tapx', turn && 'is-turn')} data-testid=${testId} onClick=${onExpand}
      aria-label=${t('展开{name}', { name })} title=${t('展开{name}', { name })}>
    <span class="spov-pill__art"><${LocalSprite} name="btn_open" class="spov-pill__img"
      fallback=${html`<span class="spov-pill__box" aria-hidden="true"><${Icon} name="expand" /></span>`} /><b class="spov-pill__act">${t('展开')}</b></span>
    <span class="spov-pill__meta">
      <span class="spov-pill__name">${name}</span>
      ${armed ? html`<span class="spov-pill__armed" data-testid="sp-armed-kept">${t('已选中')}</span>` : null}
      ${deadline > 0 ? html`<${Countdown} deadline=${deadline} total=${total ?? undefined} size="sm" label=${null} gauge=${false} class="spov-pill__clock" />` : null}
    </span>
  </button>`;
}

/**
 * The collapsed draft (PeekPill): the family's name; it pulses while it is the viewer's turn and they have not picked.
 * @param {{ sp: any, myId: string, solo: boolean, personal?: boolean, deadline?: number|null, total?: number|null, armed?: boolean, onExpand: () => void }} props
 */
export function ChoicePill({ sp, myId, solo, personal = false, deadline = null, total = null, armed = false, onExpand }) {
  if (!sp) return null;
  const fam = data.get('choices')?.families?.[sp.family] || null;
  const rawFam = data.getRaw('choices')?.families?.[sp.family] || null;
  const name = personal ? sp.name || t('教鞭选择') : sentText(sp.name, rawFam?.name, fam?.name) || fam?.name || t('机变');
  const myTurn = (personal || solo || sp.turnPid === myId || sp.concurrent === true) && !sp.pickOf?.has?.(myId);
  return PeekPill({ name, turn: myTurn, deadline, total, armed, onExpand }); // a plain call: the pill is the button (test/ui renders it)
}

/**
 * The pick order as the team panel shows it during a shared draft (the official 悬赏决策: ✓ beside who has picked, •••
 * beside who is deciding): playerId → 'done' | 'turn'. Empty for solo and personal picks.
 * @param {any} sp normalizeSp(...) @param {{ solo: boolean }} o
 * @returns {Map<string, 'done'|'turn'>}
 */
export function spMarks(sp, { solo }) {
  const out = new Map();
  if (!sp || solo || !Array.isArray(sp.order)) return out;
  for (const pid of sp.order) {
    if (sp.pickOf.has(pid)) out.set(pid, 'done');
    else if (sp.concurrent === true || sp.turnPid === pid) out.set(pid, 'turn');
  }
  return out;
}

/**
 * The overlay's view (pure: no hooks — test/ui renders it as a function).
 * @param {{ pub:any, sp:any, myId:string, solo:boolean, personal?:boolean, busyIdx?:number|null, total?:number|null, armed?:number|null,
 *   onTap?:(idx:number)=>void, onConfirm?:()=>void, onDisarm?:()=>void, pfPack?: any, pfStill?: boolean }} props
 *   pfPack: 规程's official pack — 乌萨斯齐心团 draws its own 机变 countdown (panel_countdown_effect_choose)
 */
export function ChoiceView({ pub, sp, myId, solo, personal = false, busyIdx = null, total = null, armed = null, onTap = () => {}, onConfirm = () => {}, onDisarm = () => {}, orderRef = null, onCollapse = null, pfPack = null, pfStill = false }) {
  if (!sp) return null;
  const fam = data.get('choices')?.families?.[sp.family] || null;
  const rawFam = data.getRaw('choices')?.families?.[sp.family] || null;
  const players = new Map(sortedPlayers(pub).map((p) => [p.playerId, p]));
  const myTurn = draftMyTurn(sp, myId, solo);
  const mine = sp.pickOf.get(myId);
  const turnName = players.get(sp.turnPid)?.name || t('队友');
  const special = /_s$/.test(String(sp.family || ''));
  const timed = personal ? pub?.deadline > 0 : !solo && !sp.untimed;
  const armedCardRec = armed != null ? sp.cards.find((c) => c && c.idx === armed) : null;
  const armedName = armedCardRec ? resolveSpCard(armedCardRec, sp.family).name : null;
  const order = personal || solo ? [] : sp.order;
  // a press anywhere but a card or the confirm button drops the selection
  const onDown = (e) => {
    if (armed == null) return;
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.spcard, .spov__confirm, .spov__collapse')) return;
    onDisarm();
  };
  // the official header (the event's 悬赏决策, video 9:59): 「悬赏决策 |」 with the description and the timing line stacked
  // beside the bar; on the right the player deciding (name over 正在决策…, an hourglass) or 当前轮到你决策, then the
  // countdown. The pick order also shows on the team panel (✓ / ••• on the portraits, ui/teamPanel.js spMarks); the
  // strip below keeps each teammate's pick (the fork's, 2026-10)
  return html`<div class=${cx('spov', armed != null && 'has-armed', personal && 'spov--personal', (sp.cards.length > 6 || order.length > 4) && 'spov--expanded')} data-allow-repeat=${sp.allowRepeat === true ? 'true' : undefined} role="dialog" aria-label=${personal ? t('教鞭选择') : t('机变阶段')} onPointerDown=${onDown}>
    <div class="spov__veil" aria-hidden="true"></div>
    <div class="spov__inner">
      <header class="spov__head">
        <div class="spov__titles">
          <i class="spov__deco" aria-hidden="true"></i>
          <h2 class=${cx('spov__title', special && 'is-special')}><span class="spov__name">${sentText(sp.name, rawFam?.name, fam?.name) || fam?.name || t('机变')}</span><span class="spov__bar">|</span><span class="spov__desc"><${RichText} text=${sentText(sp.desc, rawFam?.desc, fam?.desc) || fam?.desc || t('选择一项')} /></span></h2>
          <p class="spov__sub">${timed ? (personal ? t('休整期结束时未选择将自动选定') : t('倒计时结束后仍未选定将自动分配')) : t('选择一项（无时间限制）')}${mine == null && myTurn ? t(' · 点击卡牌选中，再次点击确认') : ''}</p>
          ${sp.allowRepeat === true ? html`<p class="spov__repeat" data-testid="sp-repeat">${sp.concurrent === true ? t('所有博士同时选择，可重复选择，每人只能选择一次') : t('可重复选择，每人只能选择一次')}</p>` : null}
        </div>
        <div class="spov__turn">
          ${personal ? html`<span class="spov__turntxt is-mine">${t('从候选中选择一项战术特训')}</span>`
            : mine != null ? html`<span class="spov__turntxt is-done"><${Icon} name="check" />${t('已完成选择')}</span>`
            : myTurn ? html`<span class="spov__turntxt is-mine">${sp.concurrent === true ? t('选择一项') : t('当前轮到你决策')}</span>`
            : sp.concurrent === true ? html`<span class="spov__turntxt is-other"><span class="spov__tw"><small>${t('其他博士正在决策…')}</small></span><${Icon} name="hourglass" /></span>`
            : html`<span class="spov__turntxt is-other"><span class="spov__tw"><b>${turnName}</b><small>${t('正在决策…')}</small></span><${Icon} name="hourglass" /></span>`}
          ${armed != null ? html`<${Button} variant="primary" size="lg" icon="check" class="spov__confirm" data-testid="sp-confirm"
              title=${armedName ? t('确认选择「{armedName}」（再次点击卡牌亦可）', { armedName }) : t('确认选择')} onClick=${onConfirm}>${t('确认选择')}<//>` : null}
          ${timed ? (pfPack?.doc?.prefabs?.panel_countdown_effect_choose
            ? html`<${RegDeadlineCountdown} pack=${pfPack} deadline=${pub?.deadline} total=${total ?? null} still=${pfStill} prefabKey="panel_countdown_effect_choose" />`
            : html`<${Countdown} deadline=${pub?.deadline} total=${total ?? undefined} size="md" />`) : null}
        </div>
      </header>
      ${order.length ? html`<div class=${cx('spov__order', onCollapse && 'spov__order--collapse')} ref=${orderRef} aria-label=${t('决策顺序')}>
        ${order.map((pid, i) => {
          const p = players.get(pid);
          const pick = sp.cards.find((c) => c.idx === sp.pickOf.get(pid));
          const picked = !!pick;
          const pickName = pick ? resolveSpCard(pick, sp.family).name : null;
          const cur = (sp.concurrent === true || sp.turnPid === pid) && !picked;
          const left = p?.status === 'left';
          return html`<div key=${pid} class=${cx('spov__who', cur && 'is-cur', picked && 'is-done', pid === myId && 'is-self')}>
            <span class="spov__idx num">${i + 1}</span>
            <${PlayerAvatar} player=${p || { name: '?' }} size="sm" self=${pid === myId} />
            <span class="spov__wtext"><${MatchName} player=${p || { playerId: pid }} name=${p?.name || t('博士')} class="spov__wname" />
              ${pickName ? html`<span class="spov__wpick" data-picked-idx=${pick.idx} title=${pickName}>${pickName}</span>` : null}
            </span>
            <span class="spov__wstate">${left ? html`<${Icon} name="exit" />` : picked ? html`<${Icon} name="check" />` : cur ? html`<${Icon} name="hourglass" />` : html`<${Icon} name="dots" />`}</span>
          </div>`;
        })}
      </div>` : null}
      ${onCollapse ? html`<button type="button" class=${cx('spov__collapse', 'tapx', localAsset('ui/battle', 'btn_close') && 'has-art')} data-testid="sp-collapse" onClick=${onCollapse} title=${t('收起，查看战场')}>
        <span class="spov__cart" aria-hidden="true"><${LocalSprite} name="btn_close" class="spov__cimg" fallback=${html`<${Icon} name="collapse" />`} /></span><span>${t('收起')}</span></button>` : null}
      <div class=${cx('spov__grid', sp.cards.length <= 3 && 'spov__grid--3', onCollapse && 'spov__grid--collapse')}>
        ${sp.cards.map((card) => {
          const r = resolveSpCard(card, sp.family);
          const taken = sp.allowRepeat !== true && !!card.takenBy;
          const taker = taken ? players.get(card.takenBy) : null;
          const isMine = sp.allowRepeat === true ? mine === card.idx : card.takenBy === myId;
          const can = cardPickable(sp, card, { myId, solo, busyIdx });
          const busy = pickBusy(busyIdx, card, mine, sp.allowRepeat);
          const isArmed = can && armed === card.idx;
          const pickers = sp.allowRepeat === true ? order.filter((pid) => sp.pickOf.get(pid) === card.idx && players.has(pid)).map((pid) => players.get(pid)) : [];
          const takerName = taker ? (card.takenBy === myId ? t('你') : taker.name) : pickers.length ? pickers.map((p) => p.name).join(tc('list', '、')) : null;
          return html`<button key=${card.idx} type="button" data-card-idx=${card.idx} class=${cx('spcard', `spcard--${r.kind}`, (taken || card.soldOut) && 'is-taken', isMine && 'is-mine', can && 'is-pickable', isArmed && 'is-armed', busy && 'is-busy')}
              aria-busy=${busy ? 'true' : undefined} aria-pressed=${can ? String(isArmed) : undefined} disabled=${!can} onClick=${() => can && onTap(card.idx)}
              aria-label=${isArmed ? t('{name}，已选中，再次点击确认', { name: r.name }) : takerName ? t('{name}，{takerName}已选择', { name: r.name, takerName }) : r.name} title=${`${r.name}\n${richTextPlain(r.desc)}`}>
            <span class="spcard__glow" aria-hidden="true"></span>
            <span class="spcard__head">
              <span class="spcard__icon"><${Img} src=${r.icon} fallback=${html`<${GIcon} name=${r.kind === 'bounty' ? 'target' : 'bolt'} />`} /></span>
              <span class="spcard__title">
                <b class="spcard__name">${r.name}</b>
                ${r.team || (r.kind === 'bounty' && r.coin) ? html`<span class="spcard__tags">
                  ${r.team ? html`<span class="spcard__tag spcard__tag--team">${t('全队获得')}</span>` : null}
                  ${r.kind === 'bounty' && r.coin ? html`<span class="spcard__tag spcard__tag--coin">${t('赏金 {coin}', { coin: r.coin })}</span>` : null}
                </span>` : null}
              </span>
            </span>
            <${RichText} text=${r.desc} class="spcard__desc" />
            ${card.soldOut && !taker ? html`<span class="spcard__busy" role="status">${t('全队库存已用完')}</span>` : null}
            ${r.tier ? html`<${TierChip} tier=${r.tier} size="md" class="spcard__tier" />` : null}
            ${taker ? html`<span class="spcard__taker" title=${t('{name} 已选择', { name: taker.name })}><${PlayerAvatar} player=${taker} size="sm" /></span>` : null}
            ${pickers.length ? html`<span class="spcard__pickers" data-picked-count=${pickers.length} title=${t('{name} 已选择', { name: takerName })}><${Icon} name="check" />${t('{name} 已选择', { name: takerName })}</span>` : null}
            ${isArmed ? html`<span class="spcard__confirm" role="status"><span class="spcard__cbox" aria-hidden="true"><${Icon} name="check" /></span><b>${t('确认选择')}</b><small>${t('再次点击')}</small></span>` : null}
            ${busy ? html`<span class="spcard__busy" role="status">${t('选择中')}</span>` : null}
          </button>`;
        })}
      </div>
    </div>
  </div>`;
}
