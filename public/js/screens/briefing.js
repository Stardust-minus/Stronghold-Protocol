// Briefing — INFO_CHECK 「确认本局信息」 (research 06 §4.1, D1), one layout for every version (the owner, 2026-11-21:
// one UI — 规程's briefing, made more compact, for 盟约 too; the official 1/3 screenshot of 2026-11-21 as the reference).
// Left, one scroll: 核心盟约 (solo 规程: the two groups side by side, the picked one lit), 附加盟约 (its header chip is the
// legend: grey = 阵容不完整, the red badge = the members that cannot appear), 本局禁用干员 grouped by bond (ui/matchInfo.js
// BannedByBond: each bond that lost members, then the banned portraits with the official 禁用 corner). Under it, pinned:
// the dock with 自选上场 (feedback #114 / #127: 盟约's 候补, ui/diyChoice.js; 规程 never has one).
// Right, fixed: the stage preview (ui/stagePreview.js: the 3D thumbnail, the magnifier opens the large map), 敌方领袖
// (name; round, abilities and battlefield in its tooltip), one row per 特训敌人, 重刷本局 (consent stays visible beside the
// information being confirmed; one line until a vote), 干员调配, 已就绪 x/N and 准备就绪.
// The version tag and the unofficial mark sit in the step header beside the mode.
// The bond discs, the legend and the banned blocks are the ones the strategy draft's 本局信息 dialog shows too
// (ui/matchInfo.js), so they never drift. Styles: css/screens/briefing.css.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from '../ui/components.js';
import { useGameData } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { MatchBondGroups, MatchBondRow, BannedByBond, matchInfoModel, MatchBondDialog, regulationCoreAbsent, RegulationHead } from '../ui/matchInfo.js';
import { MatchEnemies, stagePoolLine } from '../ui/matchEnemies.js';
import { StagePreview, stagePreviewChoice } from '../ui/stagePreview.js';
import { LoadoutButton } from './loadout.js';
import { UnofficialMark, VersionTag } from '../ui/pluginTag.js';
import { SetupReroll } from '../ui/setupReroll.js';
import { DiyChoice } from '../ui/diyChoice.js';
import { actions } from '../ui/gameActions.js';
import { sortedPlayers, phaseTotalSeconds, pregameStepCount, pregameStepIndex } from '../ui/gameLogic.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** INFO_CHECK screen. */
export function BriefingScreen() {
  const pub = useStore((s) => s.match.public);
  const priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const solo = useStore((s) => s.room?.mode === 'solo') || String(pub?.modeId || '').includes('single');
  // gameplay plugins (DESIGN §32.6): the briefing says the match is unofficial
  const room = useStore((s) => s.room);
  const gd = useGameData();
  const [exit, setExit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bondId, setBondId] = useState(null);
  if (!pub) return null;

  const players = sortedPlayers(pub);
  const me = players.find((p) => p.playerId === myId);
  const readyN = players.filter((p) => p.ready).length;
  const mode = gd.config?.modes?.[pub.modeId];
  // (+ the own 自选 pieces this match leaves out of the shop: m.private.diyBanned)
  const info = matchInfoModel(pub, { bonds: gd.list('bonds'), chess: gd.chess, mode, priv, diyData: { chess: data.get('chess'), backups: data.get('backups') } });
  const stage = pub.stageId && gd.stage ? gd.stage(pub.stageId) : null;
  const localGroups = data.get('local')?.groups || null;
  const hold = !me || !!me.ready || !!pub.rerollVote;

  const ready = async () => {
    if (busy || me?.ready) return;
    setBusy(true);
    await actions.infoReady(pub.setupRevision ?? 0);
    setBusy(false);
  };

  const pickGroup = async (idx) => {
    if (busy || !me || pub.rerollVote) return;
    setBusy(true);
    try { await actions.bondGroup(idx, pub.setupRevision ?? 0); }
    finally { setBusy(false); }
  };

  const tags = html`<span class="brief__tags"><${UnofficialMark} room=${room} class="brief__modmark" /><${VersionTag} room=${room} class="brief__vertag" /></span>`;
  return html`<div class="screen brief" data-layout="one">
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${pregameStepIndex(gd.config, 'INFO_CHECK')} of=${pregameStepCount(gd.config)} title=${t('确认本局信息')} micro="BRIEFING // INFO CHECK" pub=${pub}
      total=${phaseTotalSeconds(pub, gd.config)} onExit=${() => setExit(true)} extra=${tags} />
    <div class="brief__split">
      <div class="brief__left">
        <div class="brief__scroll">
          <section class="brief-sec brief-sec--core" style="--i:1">
            <${MatchBondGroups} panels=${true} model=${info} onPick=${pickGroup} onBond=${setBondId} disabled=${hold} busy=${busy} />
          </section>
          <section class="brief-sec brief-sec--addon" style="--i:2">
            <${MatchBondRow} title=${t('附加盟约')} micro="ADD-ON BONDS" bonds=${info.addon} model=${info} onBond=${setBondId}
              head=${html`<${RegulationHead} title=${t('附加盟约')} model=${info} legend=${true} />`} />
          </section>
          <section class="brief-sec brief-sec--banned" style="--i:3">
            <${BannedByBond} model=${info} onBond=${setBondId} />
          </section>
        </div>
        ${priv?.diyChoice ? html`<div class="brief__dock">
          <${DiyChoice} priv=${priv} onChoose=${actions.diyChoose} disabled=${!me} dock=${true} ready=${!!me?.ready} />
        </div>` : null}
      </div>
      <aside class="brief__side">
        <${StagePreview} stage=${stage} choice=${stagePreviewChoice({ ui: gd.m?.ui, localGroups }, pub.stageId)} name=${stage?.name || pub.stageId || '—'}
          pool=${stagePoolLine(mode)} stageId=${pub.stageId || ''} localGroups=${localGroups} seat=${me?.seat ?? null} />
        <${MatchEnemies} pub=${pub} gd=${gd} layout="regulation" />
        <${SetupReroll} pub=${pub} compact=${true} />
        <${LoadoutButton} from="briefing" size="md" class="brief-loadout" />
        <div class="brief__foot">
          <div class="brief-ready">
            <span class="brief-ready__txt">${t('已就绪')}<b class="num">${readyN}</b><span class="num">/${players.length}</span></span>
            <span class="brief-ready__pips">${players.map((p) => html`<i key=${p.playerId} class=${cx(p.ready && 'on', p.playerId === myId && 'me')} title=${p.name}><${Icon} name="user" /></i>`)}</span>
          </div>
          <${Button} variant="primary" size="xl" class="brief-go" icon=${me?.ready ? 'check' : me ? 'play' : 'eye'} active=${!!me?.ready} loading=${busy}
            disabled=${!!me?.ready || !me || !!pub.rerollVote || info.choice?.picked === null} onClick=${ready}>${me?.ready ? t('已就绪') : me ? t('准备就绪') : t('观战中')}<//>
        </div>
      </aside>
    </div>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
    <${MatchBondDialog} bondId=${bondId} onClose=${() => setBondId(null)} priv=${priv} banned=${info.banned} off=${info.sets.off.has(bondId)} coreAbsent=${regulationCoreAbsent(info, bondId)} />
  </div>`;
}
