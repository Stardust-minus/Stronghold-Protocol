// 确定自选编队 — CUSTOM_CHECK, after the strategy draft on a season that has diyBringLimits (规程: 0–2 per tier).
// The roster itself stays the lobby's 自选编队. This screen only chooses which of those slots enter the match.
// Laid out after the official 3/3 (2026-11-21 screenshot; the owner: rebuilt, cards like 干员调配): on the left the
// doctors (the strategy each took, 已确认 once their squad is in), a bracket, then one row per tier — its cards, then the
// tier's tall NO. mark (screens/loadout.js TierMark, the art of the 干员调配 deck) with 已选 n/上限. A card is the
// 干员调配 deck card (screens/loadout.js DeckCard's markup and css/screens/loadout.css .lo-op): tier, levels, portrait
// with the branch icon, the slot's skill and module, name, bonds. A card the match bans (the server's diyBanned: since
// §37.211 a member of a core bond only when all its cores are grey, one with add-ons only when all those are) is grey
// with 本局禁用 and those bonds struck. Confirming none is 不带入自选. The screen opens with the timeout default checked
// [ASSUMED]: the first legal slots of each tier, in data order, up to the cap.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, TierChip } from '../ui/components.js';
import { useGameData, Img, PlayerAvatar, BandIcon, PromotionIcon } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { actions } from '../ui/gameActions.js';
import { sortedPlayers, phaseTotalSeconds, pregameStepCount, pregameStepIndex, disabledBondSets } from '../ui/gameLogic.js';
import { chessAvatarUrl, portraitChain, chainProps, subProfIconUrl, bondIconUrl } from '../ui/assetUrls.js';
import { ownAppearance } from '../ui/skinAssets.js';
import { MatchName } from '../ui/ownerName.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { slotRecord } from '../ui/diyModel.js';
import { TierMark } from './loadout.js';
import { SkillIcon, ModuleGlyph } from './loadoutSections.js';
import { defaultDiyBring, diyBringCap } from '../../../shared/diyBring.js';
import { diySlot, diySlotIds } from '../../../shared/diy.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const bundle = () => ({ chess: data.get('chess'), backups: data.get('backups') });

/**
 * The bonds that keep a banned card out (server gamedata bondsExclude, §37.211 core priority): its core bonds when it
 * has one, else its add-ons — all grey this match. With `grey` (the match's grey bonds) the reason names them.
 * @param {any} rec @param {Set<string>} grey
 */
export function diyBanBonds(rec, grey) {
  const bonds = Array.isArray(rec?.bonds) ? rec.bonds : [];
  const table = data.get('bonds') || {};
  const core = bonds.filter((b) => table[b]?.isCore);
  const deciding = core.length ? core : bonds;
  return { core: core.length > 0, ids: deciding.filter((b) => grey.has(b)) };
}

/** One 自选 card, the 干员调配 deck card's markup (css .lo-op); a button that toggles it. */
function DiyCard({ m, id, pick, pack, on, banned, ban, disabled, onToggle, skins }) {
  const rec = slotRecord(id, pick, pack);
  const elite = slotRecord(id, pick, pack, { elite: true });
  const tier = diySlot(id, pack)?.tier ?? rec?.tier ?? 5;
  if (!rec) return null;
  const mod = elite?.module?.active ? elite.module : null;
  const names = (ids) => ids.map((b) => data.lookup('bonds', b)?.name || b).join(' · ');
  return html`<button type="button" class=${cx('lo-op', `lo-op--t${tier}`, 'diyc__card', on && 'is-sel', banned && 'is-banned')}
      data-testid="diy-check-card" data-slot=${id} disabled=${disabled || banned} aria-pressed=${on ? 'true' : 'false'}
      title=${banned ? `${t('本局禁用')}：${names(ban.ids)}` : rec.name} onClick=${onToggle}>
    <span class="lo-op__card">
      <span class="lo-op__rail">
        <${TierChip} tier=${tier} size="sm" class="lo-op__tier" />
        <span class="lo-op__lv">
          <span class="lo-op__lvrow"><${PromotionIcon} m=${m} phase=${rec.status?.phase} class="lo-op__phase" /><b class="num">${rec.status?.level ?? '—'}</b></span>
          ${elite ? html`<span class="lo-op__lvrow is-elite"><${PromotionIcon} m=${m} phase=${elite.status?.phase} class="lo-op__phase" /><b class="num">${elite.status?.level ?? '—'}</b></span>` : null}
        </span>
      </span>
      <span class="lo-op__pick">
        <span class="lo-op__art">
          <${Img} ...${chainProps([...portraitChain(m, [ownAppearance(elite || rec, { skins }), elite || rec]), chessAvatarUrl(m, rec)].filter(Boolean))}
            fallback=${html`<span class="lo-op__glyph">${[...(rec.name || '?')][0]}</span>`} />
        </span>
        <${Img} src=${subProfIconUrl(m, rec)} class="lo-op__sub" />
        <span class="lo-op__kit">
          <span class="lo-op__slot"><${SkillIcon} m=${m} rec=${rec.skill} index=${rec.skill?.index} size="q" /></span>
          <span class="lo-op__slot">${mod ? html`<${ModuleGlyph} m=${m} rec=${mod} id=${mod.id} size="q" />` : null}</span>
        </span>
        ${banned ? html`<span class="diyc__ban"><span class="diyc__banmark"><${Icon} name="minus" /></span><b>${t('本局禁用')}</b></span>` : null}
      </span>
      <span class="lo-op__meta"><span class="lo-op__name">${rec.name}</span></span>
      <span class="lo-op__bonds">${(rec.bonds || []).map((b) => html`<span key=${b} class=${cx('lo-op__bond', banned && ban.ids.includes(b) && 'is-off')}
        title=${data.lookup('bonds', b)?.name || b}><${Img} src=${bondIconUrl(m, b)} fallback=${html`<i class="lo-bond__dot"></i>`} /></span>`)}</span>
    </span>
  </button>`;
}

/** 确定自选编队 screen. */
export function DiyCheckScreen() {
  const pub = useStore((s) => s.match.public);
  const priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const solo = useStore((s) => s.room?.mode === 'solo') || String(pub?.modeId || '').includes('single');
  const gd = useGameData();
  const [exit, setExit] = useState(false);
  const [busy, setBusy] = useState(false);
  // null = the player has not touched the list, so the shown selection is the server's timeout default.
  const [picked, setPicked] = useState(null);
  if (!pub) return null;

  const m = gd.m;
  const roster = priv?.diy && typeof priv.diy === 'object' ? priv.diy : {};
  const banned = new Set(Array.isArray(priv?.diyBanned) ? priv.diyBanned : []);
  const limits = pub.diyCheck?.limits || null;
  const pack = bundle();
  const order = diySlotIds(pack);
  const tierOf = (id) => diySlot(id, pack)?.tier ?? null;
  const defaults = defaultDiyBring(order, { roster, banned: [...banned], limits, tierOf });
  const picks = pub.diyCheck?.picks;
  const inMap = !!(picks && Object.hasOwn(picks, myId));
  const mine = inMap ? picks[myId] : undefined;
  const confirmed = Array.isArray(mine) ? mine : null;
  const shown = confirmed ?? (picked ?? defaults);
  const canEdit = inMap && confirmed == null && !busy;
  const selected = new Set(shown);
  const sets = disabledBondSets(pub, gd.config?.modes?.[pub.modeId]?.inactiveBondIds);
  const grey = new Set([...sets.drawn, ...sets.off]);

  const groups = [];
  for (const id of order) {
    if (!roster[id]) continue;
    const tier = tierOf(id);
    let g = groups.find((x) => x.tier === tier);
    if (!g) { g = { tier, ids: [] }; groups.push(g); }
    g.ids.push(id);
  }
  groups.sort((a, b) => a.tier - b.tier);

  const caps = limits ? Object.values(limits).filter((v) => Number.isInteger(v)) : [];
  const n = caps.length && caps.every((c) => c === caps[0]) ? caps[0] : (caps[0] ?? 2);

  const toggle = (id) => {
    if (!canEdit || banned.has(id)) return;
    const cur = picked ?? defaults;
    if (cur.includes(id)) { setPicked(cur.filter((x) => x !== id)); return; }
    const tier = tierOf(id);
    const cap = diyBringCap(limits, tier);
    const count = cur.filter((x) => tierOf(x) === tier).length;
    if (cap != null && count >= cap) return;
    setPicked([...cur, id]);
  };

  const confirm = async (slots) => {
    if (!canEdit) return;
    setBusy(true);
    setPicked(slots);
    await actions.diyBring(slots);
    setBusy(false);
  };

  const players = sortedPlayers(pub);
  const done = (p) => Array.isArray(picks?.[p.playerId]);
  const readyN = players.filter(done).length;

  return html`<div class="screen brief diyc" data-testid="diy-check">
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${pregameStepIndex(gd.config, 'CUSTOM_CHECK')} of=${pregameStepCount(gd.config)} title=${t('确定自选编队')} micro="SQUAD // CUSTOM CHECK" pub=${pub}
      total=${phaseTotalSeconds(pub, gd.config)} onExit=${() => setExit(true)} />
    <main class="diyc__main">
      <aside class="diyc__side">
        <div class="draft-order__deco" aria-hidden="true"><i></i><i></i><span>STRONGHOLD PROTOCOL<br />${solo ? 'SINGLE OPERATOR' : 'COLLABORATIVE SYSTEM'}</span></div>
        <div class="diyc__players">
          ${players.map((p, i) => {
            const self = p.playerId === myId;
            const ok = done(p);
            return html`<div key=${p.playerId} class=${cx('dorder', 'diyc__player', ok ? 'is-done' : 'is-cur', self && 'is-self')} style=${`--i:${i}`}>
              <div class="dorder__card">
                <span class="dorder__face"><${PlayerAvatar} player=${p} self=${self} /></span>
                <div class="dorder__text">
                  <b class="dorder__name"><span class="dorder__nm"><${MatchName} player=${p} name=${p.name || t('博士')} /></span>${p.isBot ? html`<span class="dorder__ai">AI</span>` : null}</b>
                  <span class="dorder__state">${ok ? html`<span class="t-mint">${t('已确认')}</span>` : html`<span class="t-gold">${t('决策中')}</span>`}</span>
                </div>
              </div>
              ${p.bandId ? html`<span class="dorder__box is-band"><${BandIcon} bandId=${p.bandId} size="md" /></span>`
                : html`<span class="dorder__box is-cur"><${Icon} name="hourglass" /></span>`}
              <span class="dorder__check" aria-hidden="true">${ok ? html`<${Icon} name="check" />` : null}</span>
            </div>`;
          })}
        </div>
      </aside>
      <i class="draft__link diyc__link" aria-hidden="true"></i>
      <section class="diyc__panel">
        <p class="diyc__lead">${t('每阶至多带入 {n} 名，未选择的干员不会进入本次模拟', { n })}</p>
        <div class="diyc__rows">
          ${groups.length === 0 ? html`<p class="diyc__empty">${t('尚未编入自选干员')}</p>` : groups.map((g) => {
            const cap = diyBringCap(limits, g.tier);
            const got = g.ids.filter((id) => selected.has(id)).length;
            return html`<section key=${g.tier} class=${cx('diyc__row', `tier--${g.tier}`)} data-tier=${g.tier}>
              <div class="diyc__cards">
                ${g.ids.map((id) => {
                  const pick = roster[id];
                  const rec = slotRecord(id, pick, pack);
                  return html`<${DiyCard} key=${id} m=${m} id=${id} pick=${pick} pack=${pack} on=${selected.has(id)} banned=${banned.has(id)}
                    ban=${diyBanBonds(rec, grey)} disabled=${!canEdit} skins=${priv?.skins || {}} onToggle=${() => toggle(id)} />`;
                })}
              </div>
              <div class="diyc__mark">
                <${TierMark} m=${m} tier=${g.tier} count="" />
                ${cap != null ? html`<span class="diyc__count num"><b>${got}</b>/${cap}</span>` : null}
              </div>
            </section>`;
          })}
        </div>
        <footer class="diyc__foot">
          ${!pub.diyCheck?.untimed ? html`<p class="diyc__hint"><${Icon} name="info" />${t('超时未确认时，按槽位顺序自动带入')}</p>` : html`<span></span>`}
          <div class="brief-ready">
            <span class="brief-ready__txt">${t('已就绪')}<b class="num">${readyN}</b><span class="num">/${players.length}</span></span>
            <span class="brief-ready__pips">${players.map((p) => html`<i key=${p.playerId} class=${cx(done(p) && 'on', p.playerId === myId && 'me')} title=${p.name}><${Icon} name="user" /></i>`)}</span>
          </div>
          <${Button} variant="ghost" size="lg" class="diyc__none" data-testid="diy-check-none" disabled=${!canEdit} onClick=${() => confirm([])}>${t('不带入自选')}<//>
          <${Button} variant="primary" size="xl" class="brief-go" data-testid="diy-check-confirm" icon=${confirmed ? 'check' : inMap ? 'play' : 'eye'}
            active=${!!confirmed} loading=${busy} disabled=${!canEdit}
            onClick=${() => confirm(shown)}>${confirmed ? t('已就绪') : inMap ? t('确认编队') : t('观战中')}<//>
        </footer>
      </section>
    </main>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
  </div>`;
}
