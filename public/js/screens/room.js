// Room screen (同盟等待室) — 2026-10-14: the room design by 雨千代chiyo (the event's room), adopted by the owner with this
// fork's own features kept. Tall seat cards side by side — a portrait per doctor (名片干员: the player's own pick, else an
// operator chosen from the player id, ui/seatArt.js), 创建者, 已就绪 / 准备中 / 失去信号, the name plate (名片底图, the trophy
// level, the 服主 mark — room.state seats[].card / .owner, ui/playerCard.js, ui/ownerName.js), the host's 移出; an AI seat
// names the strategy it takes in the draft (AI 指定策略: room.setBotBand; seats[].band, null = 自动选择 — the host's chip
// opens the picker, a strategy set for another AI is greyed out) and the host's ✕ removes it; an empty seat is 邀请
// (copies the alliance key) and, for the host, 添加 AI 队友. Expanded rooms (8–20 seats, 实验性选项) scroll sideways.
// Top: leave, the time waited, latency with the service load (ui/serverStatus.js), 统计 / 设置 / 玩法说明, the alliance
// key with 复制 / 链接. Bottom: 实验性选项 (left, as in the earlier room; marked when an option is changed), the status
// line, the difficulty | ⚙ pill (the host picks the difficulty in 选择模拟协议 over the room; ⚙ holds AI 队友最后选择
// and 实验性选项 again), 组队匹配 (host: the whole party joins the public
// queue — queue.join { party: true }; everybody sees the queue, ui/matchmaking.js QueueFlow) and 开始模拟 (host) or 准备就绪.
// Motion (css tr-*): the room comes up from black card by card and fades out when left; a doctor turning 已就绪 flashes
// green; 选择模拟协议 and ⚙ stay mounted while they fade out (ui/transitions.js).
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// Plugins (DESIGN §32 P1a): the tag under the title — 「原版」 or 「插件 ×N」 — opens the 插件 panel (ui/pluginPanel.js:
// the host switches the room's plugins, everybody else reads them). With gameplay plugins (§32.6: a content set of its
// own — the tag reads 「非官方」 too) every seat shows whether its page has loaded and checked the room's content
// (seats[].content: 载入中 / 就绪 / 校验失败), 准备就绪 and 开始模拟 wait for it (the server refuses them before:
// CONTENT_NOT_READY), and a plugin mode the host chose shows beside the mode name in the top bar (the orange chip).
// Official versions (DESIGN §35.23, M1; versions.js): a room plays one version (room.state.version; absent = 第二期下半).
// Another version's name shows beside the mode in the top bar (ui/pluginTag.js VersionTag) and every page loads and checks
// its data like a gameplay plugin's content set (content.js) — the seat tags read 数据载入中 / 就绪 / 校验失败 and
// 准备就绪 / 开始模拟 wait for it (needsContent: gameplay plugins or another version; 非官方 stays the plugins' alone).
// The version pill beside the difficulty (and ⚙'s 版本 row in co-op) opens the version picker (ui/versionPicker.js): the
// host's pick proposes the switch (room.proposeVersion: a lone human's room switches at once; otherwise the seated humans
// vote — ui/versionVote.js, the strip between the 观战席 and the footer); everybody else reads it (由创建者发起). It is off
// during a vote, with gameplay plugins on (they play 第二期下半 only) and offline. A switch is told to everybody (a toast,
// never on entering a room), and a room whose version is not this browser's lobby choice says that leaving restores it.
// Texts go through t() (docs/I18N.md).

import { audio } from '../audio.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { ROOM_LIST_MIN_CAPACITY, DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, MAX_SPECTATORS } from '../../../shared/constants.js';
import { roomCapacity } from '../../../shared/playerCapacity.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyIcon, Tooltip, confirmDialog, doctorNo, Spinner, Modal,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { TestMark } from '../ui/testConsole.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { LoadoutButton } from './loadout.js';
import { PluginTag, VersionTag, isModdedRoom } from '../ui/pluginTag.js';
import { VersionVote, versionVoteOf } from '../ui/versionVote.js';
import { VersionPicker } from '../ui/versionPicker.js';
import { DEFAULT_VERSION, lobbyVersion, needsContent, offeredDifficulties, roomVersion, serverDefaultVersion, soloTimedOf, soloTimeMsgid, versionLabel } from '../versions.js';
import { hasScriptConsent, rememberScriptConsent, pageVersion } from '../content.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating, savePref } from '../store.js';
import { data, useData, getConfig } from '../data.js';
import { CARD_PREF, cardOperators, seatPortrait, cardAvatarUrl, lookOptions } from '../ui/seatArt.js';
import { CARD_SYNC, useMyCard, setCardOperator, setCardAvatar, setCardBackground, setCardBackgroundY, setCardLook, setAvatarLook } from '../ui/playerCard.js';
import { OperatorPicker, AvatarPicker } from '../ui/opPicker.js';
import { NameCardLayer, NameCardPicker } from '../ui/namecards.js';
import { TrophyBadge } from '../ui/trophies.js';
import { OwnerBadge, isOwnerSeat } from '../ui/ownerName.js';
import { difficultyInfo, ProtoCard } from './lobby.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { usePresence, useRise, afterLeave } from '../ui/transitions.js';
import { ExperimentalOptions, experimentalChanged, experimentalSummary } from '../ui/experimental.js';
import { ServerStatusModal } from '../ui/serverStatus.js';
import { QueueFlow, queueActive } from '../ui/matchmaking.js';
import { useGameData, BandIcon } from '../ui/gameComponents.js';
import { allowedBands } from './bandDraft.js';
import { t, tc } from '../../../shared/i18n.js';

/**
 * Seats padded to the room's capacity (co-op 4, an expanded room 8–20, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const cap = roomCapacity(room?.mode, room?.experimental);
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  // a room with gameplay plugins (DESIGN §32.6) or another official version (§35.23): every player's page has loaded and
  // checked its content (the host's too); `modded` (非官方) is the plugins' alone
  const modded = isModdedRoom(room);
  const loadsContent = needsContent(room);
  const contentReady = !loadsContent || humans.every((s) => s.content === 'ready');
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine && contentReady && (!room?.content?.trusted || humans.every(s => room.content.trusted.consent[s.seat])),
    othersReady,
    modded,
    needsContent: loadsContent,
    // another official version (its seat tags and texts; a gameplay plugin room keeps the plugins' words)
    versionRoom: loadsContent && !modded,
    contentReady,
    myContent: loadsContent ? (mine?.content || 'loading') : 'ready',
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
  };
}

/** Client hint only; the server independently validates every party member before queuing. */
export function partyQueueReason(room, myId, online = true) {
  if (!online) return t('连接中断，请稍候重试');
  if (room?.mode !== 'coop' || room.inMatch) return t('仅等待中的好友同盟可组队匹配');
  if (room.hostId !== myId) return t('由同盟创建者发起组队匹配');
  const seats = room.seats?.filter(Boolean) || [];
  if (seats.some(s => s.isBot)) return t('请先移除 AI 队友，公开匹配仅限真人');
  if (!seats.length || seats.some(s => s.connected === false)) return t('请等待所有队友连接后再匹配');
  if (seats.some(s => s.playerId !== room.hostId && !s.ready)) return t('仍有博士未准备就绪');
  return null;
}

/**
 * The co-op room option 「AI 队友最后选择」 (GitHub #338; room.setAiPicksLast, room.state.aiPicksLast): in the strategy and
 * 机变 drafts every human picks before the AI teammates. null in a solo room (no AI teammates); otherwise its state (off
 * when the server sends none) and whether this player may switch it — the host only, the others see it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function aiLastOption(room, myId) {
  if (!room || room.mode === 'solo') return null;
  return { on: room.aiPicksLast === true, editable: room.hostId != null && room.hostId === myId };
}

/** 公开到同盟列表 (feedback #30): what server/lobby.js listable allows; off by default, the host's. */
export function listedOption(room, myId) {
  if (!room || room.mode !== 'coop' || room.source !== 'private' || room.test || room.content?.vanilla === false
    || roomCapacity(room.mode, room.experimental) < ROOM_LIST_MIN_CAPACITY) return null;
  return { on: room.listed === true, editable: room.hostId != null && room.hostId === myId && !room.inMatch };
}

/** Spectator handover is available only in original default-version co-op rooms, with a host opt-in. */
export function aiTakeoverOption(room, myId) {
  if (!room || room.mode === 'solo' || roomVersion(room) !== DEFAULT_VERSION || room.content?.vanilla === false) return null;
  return { on: room.aiTakeoverEnabled === true, editable: room.hostId != null && room.hostId === myId && !room.inMatch };
}

/**
 * The solo room option 「不限时」 (DESIGN §35.23.10; room.setSoloUnlimited). null unless the room is solo AND `timed`
 * is exactly true (a version whose solo is timed, and whose data is on screen). Off when room.state omits the key.
 * The host switches it; everybody else sees it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @param {boolean | null} timed soloTimedOf(config, room version)
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function soloUnlimitedOption(room, myId, timed) {
  if (!room || room.mode !== 'solo' || timed !== true) return null;
  return { on: room.soloUnlimited === true, editable: room.hostId != null && room.hostId === myId };
}

/**
 * An AI teammate's name split into its 「AI·」 prefix and the rest, for the plate (room.css hides the prefix on a phone:
 * the avatar's badge and the card's AI 队友 tag say it, and at 特大 the prefix left one character of the name,
 * 「AI·华…」). Null for a human seat and for a name that is only a number after the prefix (`AI·2`).
 * @param {{ isBot?: boolean, name?: string } | null | undefined} seat
 * @returns {[string, string] | null}
 */
export function botNameParts(seat) {
  const m = seat?.isBot ? /^(AI\s*·\s*)(\D.*)$/su.exec(seat.name || '') : null;
  return m ? [m[1], m[2]] : null;
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

// 名片干员 portraits (the pick, else one chosen by the player id): ui/seatArt.js, shared with the strategy draft's rows
export { CARD_PREF, cardOperators, seatPortrait, CARD_SYNC };

/** An AI seat's strategy (自动选择 when none is set); the host's is a button opening the picker. */
function BotBandChip({ seat, gd, editable, busy, onOpen }) {
  const band = typeof seat.band === 'string' ? gd.band(seat.band) : null;
  const body = html`${band ? html`<${BandIcon} bandId=${band.bandId} size="sm" />` : html`<${Icon} name="robot" />`}
    <span class="seat__band-name">${band ? band.name : typeof seat.band === 'string' ? seat.band : t('自动选择')}</span>`;
  return editable
    ? html`<button type="button" class="seat__band rseat__band is-editable" disabled=${busy} onClick=${onOpen} title=${t('指定该 AI 队友选择的策略')}>
        <span class="seat__band-k">${t('策略')}</span>${body}<${Icon} name="edit" /></button>`
    : html`<span class="seat__band rseat__band"><span class="seat__band-k">${t('策略')}</span>${body}</span>`;
}

/**
 * The host's strategy picker for one AI seat: 自动选择, then every co-op strategy; one already set for another AI of the
 * room is disabled and names it (the server refuses a duplicate too).
 */
function BotBandPicker({ seat, room, gd, busy, onClose, onPick }) {
  const seats = roomFacts(room, null).seats;
  // an expanded room's 禁用鸭爵 option drops that strategy, as in its draft (server: the same GameData rule)
  const bands = allowedBands(gd.list('bands'), 'MULTI', seats.length > MAX_SEATS && room.experimental?.disableDuckLord === true);
  const usedBy = new Map();
  for (const s of seats) if (s && s.isBot && s.seat !== seat.seat && typeof s.band === 'string') usedBy.set(s.band, s.name);
  return html`<${Modal} open=${true} onClose=${onClose} title=${t('指定 AI 策略：{name}', { name: seat.name })} micro="AI STRATEGY"
      class="botband-dlg" actions=${html`<${Button} variant="secondary" data-autofocus onClick=${onClose}>${t('关闭')}<//>`}>
    <p class="botband-dlg__tip t-dim">${t('开局选择策略时，该 AI 队友会直接选择指定的策略，其他博士不能再选它。')}</p>
    <div class="botband-dlg__grid" role="listbox" aria-label=${t('策略')}>
      <button type="button" role="option" aria-selected=${seat.band == null ? 'true' : 'false'} disabled=${busy}
          class=${`botband ${seat.band == null ? 'is-sel' : ''}`} onClick=${() => onPick(null)}>
        <span class="botband__auto"><${Icon} name="robot" /></span><span class="botband__name">${t('自动选择')}</span>
      </button>
      ${bands.map((b) => {
        const other = usedBy.get(b.bandId);
        return html`<button key=${b.bandId} type="button" role="option" aria-selected=${seat.band === b.bandId ? 'true' : 'false'}
            disabled=${busy || !!other} title=${other ? t('已指定给 {name}', { name: other }) : b.effectName || b.name}
            class=${`botband ${seat.band === b.bandId ? 'is-sel' : ''} ${other ? 'is-used' : ''}`} onClick=${() => onPick(b.bandId)}>
          <${BandIcon} bandId=${b.bandId} size="md" /><span class="botband__name">${b.name}</span>
          ${other ? html`<span class="botband__used">${other}</span>` : b.effectName ? html`<span class="botband__eff">${b.effectName}</span>` : null}
        </button>`;
      })}
    </div>
  <//>`;
}

function SeatCard({ seat, index, room, facts, myId, myCard, busy, gd, queued, onKick, onInvite, onAddBot, onRemoveBot, onBotBand, portraits,
  onPickCard = null, onPickAvatar = null, onPickBg = null }) {
  const [bad, setBad] = useState(null);
  const flash = useRise(!!seat && (seat.ready || seat.isBot || seat.playerId === room.hostId));
  const coop = room.mode !== 'solo';
  if (!seat) {
    const invitable = coop && !facts.spectating;
    const canAdd = coop && facts.isHost && !queued;
    return html`<article class=${`rseat rseat--empty${queued ? ' is-searching' : ''}`} style=${`--i:${index}`}>
      <span class="rseat__clip" aria-hidden="true"></span>
      <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
      <div class="rseat__art">
        ${queued
          ? html`<span class="rseat__wait"><svg viewBox="0 0 40 48" aria-hidden="true"><path d="M20 2l5 5-5 5-5-5z" /><rect x="10" y="16" width="14" height="22" rx="3" /><path d="M24 22h10l-4 7 4 7H24" /></svg><small>STRONGHOLD PROTOCOL</small></span>`
          : invitable
            ? html`<button type="button" class="rseat__invite" onClick=${onInvite} title=${t('复制同盟密钥以邀请队友')}>
                <span class="rseat__plus" aria-hidden="true"></span><b>${t('邀请')}</b><small>${t('复制同盟密钥以邀请队友')}</small></button>`
            : html`<span class="rseat__wait"><small>${t('等待博士加入')}</small></span>`}
        <span class="rseat__noinfo" aria-hidden="true">NOINFO</span>
      </div>
      ${canAdd ? html`<button type="button" class="rseat__addbot" disabled=${busy === 'add'} onClick=${onAddBot}>
          <${Icon} name="robot" />${t('添加 AI 队友')}${busy === 'add' ? html`<${Spinner} size="sm" />` : null}</button>`
        : html`<div class="rseat__plate rseat__plate--empty" aria-hidden="true"></div>`}
    </article>`;
  }
  const consent = room.content?.trusted?.consent?.[seat.seat];
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  const ready = seat.ready || seat.isBot || isHostSeat;
  const src = seat.isBot ? null : seatPortrait(seat, portraits);
  const card = isMe ? myCard : seat.card && typeof seat.card === 'object' ? seat.card : null;
  const owner = isOwnerSeat(seat);
  const canPick = isMe && !seat.isBot && !!onPickCard;
  return html`<article class=${`rseat${ready ? ' is-ready' : ''}${flash ? ' is-flash' : ''}${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${offline ? ' is-offline' : ''}${seat.isBot ? ' is-bot' : ''}${owner ? ' is-owner' : ''}`}
      style=${`--i:${index}`}>
    <span class="rseat__clip" aria-hidden="true"></span>
    ${consent ? html`<span class="rseat__consent" data-testid="script-consented">${t('已同意')}</span>` : null}
    <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
    <div class=${`rseat__art${canPick ? ' is-pickable' : ''}`} onClick=${canPick ? onPickCard : undefined} title=${canPick ? t('点击更换名片干员') : undefined}>
      ${src && bad !== src ? html`<img src=${src} alt="" draggable=${false} loading="lazy" onError=${() => setBad(src)} />`
        : html`<span class="rseat__glyph">${seat.isBot ? html`<${Icon} name="robot" />` : [...(seat.name || '?')][0]}</span>`}
      ${canPick ? html`<button type="button" class="rseat__pick" onClick=${(e) => { e.stopPropagation(); onPickCard(); }} aria-label=${t('更换名片干员')}><${Icon} name="edit" /><span>${t('更换立绘')}</span></button>` : null}
      ${isHostSeat ? html`<span class="rseat__host">${t('创建者')}</span>` : null}
      ${offline ? html`<span class="rseat__lost"><${Icon} name="wifiOff" />${t('失去信号')}</span>` : null}
      <span class="rseat__state">${ready
        ? html`<span class="rseat__box"><${Icon} name="check" /></span>${isHostSeat && !seat.ready ? t('待命中') : t('已就绪')}`
        : html`<span class="rseat__box"></span>${t('准备中')}`}</span>
      ${facts.needsContent && !seat.isBot ? html`<span class=${`rseat__content is-${seat.content || 'loading'}`} data-testid="seat-content">
        ${facts.versionRoom
          ? seat.content === 'ready' ? t('数据就绪') : seat.content === 'failed' ? t('数据校验失败') : t('数据载入中')
          : seat.content === 'ready' ? t('插件内容就绪') : seat.content === 'failed' ? t('插件内容校验失败') : t('插件内容载入中')}
      </span>` : null}
    </div>
    ${seat.isBot && coop ? html`<${BotBandChip} seat=${seat} gd=${gd} editable=${facts.isHost && !queued} busy=${busy === `band${index}`} onOpen=${() => onBotBand(index)} />` : null}
    ${!seat.isBot && !isMe && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `kick${index}`}
      onClick=${() => onKick(index, seat.name, seat.playerId)} title=${t('将该博士移出同盟')} aria-label=${t('移出该博士')}><${Icon} name="user" /><${Icon} name="close" /></button>` : null}
    ${seat.isBot && facts.isHost ? html`<button type="button" class="rseat__kick rseat__kick--bot" disabled=${busy === `rm${index}`}
      onClick=${() => onRemoveBot(index)} title=${t('移除该 AI 队友')} aria-label=${t('移除 AI 队友')}><${Icon} name="robot" /><${Icon} name="close" /></button>` : null}
    <div class=${`rseat__plate${card?.bg ? ' has-nc' : ''}`}>
      ${card?.bg ? html`<${NameCardLayer} card=${card.bg} y=${card.bgY} />` : null}
      ${isMe ? html`<span class="rseat__me" title=${t('你')}><${Icon} name="info" /></span>` : null}
      ${isMe && onPickAvatar
        ? html`<button type="button" class="rseat__ava" onClick=${onPickAvatar} title=${t('更换头像')} aria-label=${t('更换头像')}>
            <${AvatarFrame} size="sm" name=${seat.name} src=${cardAvatarUrl(card?.avatar, portraits.m, card?.avatarLook)} seat=${index} self=${true} /><span class="rseat__ava-pen" aria-hidden="true"><${Icon} name="edit" /></span></button>`
        : html`<${AvatarFrame} size="sm" name=${seat.name} src=${seat.isBot ? null : cardAvatarUrl(card?.avatar, portraits.m, card?.avatarLook)} seat=${index} bot=${seat.isBot} self=${isMe} />`}
      <span class="rseat__who">
        ${seat.isBot ? null : html`<${TrophyBadge} count=${Number.isSafeInteger(card?.trophies) ? card.trophies : null} class="tbadge--inline" />`}<b class=${`rseat__name${owner ? ' sp-owner-name' : ''}`}>${seat.name || t('博士')}</b>
        <${OwnerBadge} seat=${seat} />
      </span>
      <small class="rseat__doc">${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}</small>
      ${isMe && onPickBg ? html`<button type="button" class="rseat__bg" onClick=${onPickBg} title=${t('更换名片底图')} aria-label=${t('更换名片底图')}><${Icon} name="edit" /></button>` : null}
    </div>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label=${t('观战席')}>
    <span class="specbar__label"><${Icon} name="eye" />${t('观战席')}<b class="num">${facts.spectators.length}</b><span class="num t-dim">${MAX_SPECTATORS > 0 ? `/${MAX_SPECTATORS}` : ` / ${t('无上限')}`}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}<span class=${isOwnerSeat(s) ? 'sp-owner-name' : ''}>${s.name || t('博士')}</span><${OwnerBadge} seat=${s} />${s.playerId === myId ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${t('移出观战者 {name}', { name: s.name || '' })} title=${t('移出该观战者')} />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>${t('入座')}<//>` : null}
  </section>`;
}

/** The 「不限时」 switch (a timed solo): the host toggles it, everybody else sees its state. */
function SoloUnlimitedToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-solo-unlimited"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('不限时')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** The 「AI 队友最后选择」 switch (co-op): the host toggles it, everybody else sees its state. */
function AiLastToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('策略与机变轮选时，所有博士先于 AI 队友选择')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'}
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('AI 队友最后选择')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

function ListedToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast" data-testid="room-opt-listed">
    <${Tooltip} text=${t('其他博士可在「公开同盟」中看到并直接加入；满员或开局时不显示')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'}
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('公开到同盟列表')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** mm:ss of a duration in seconds. */
const clock = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, '0')}`;

/** 选择模拟协议 over the room (host): the difficulty cards and 确认. */
function RoomProtocol({ room, onClose, onPick, busy, leaving = false, difficulties = DIFFICULTIES }) {
  const [pick, setPick] = useState(room.difficulty);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<div class=${`rs-proto${leaving ? ' is-leaving' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[pick]}`} role="dialog" aria-label=${t('选择模拟协议')}
      onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="rs-proto__scene" aria-hidden="true"><${ProtocolScene} key=${pick} difficulty=${pick} /></div>
    <section class="rs-proto__side">
      <h2 class="rs-proto__title">${t('选择模拟协议')}</h2>
      <div class="proto-list rs-proto__list" role="radiogroup" aria-label=${t('模拟难度')}>
        ${difficulties.map((d) => html`<${ProtoCard} key=${d} roomMode=${room.mode} difficulty=${d} selected=${pick === d} onSelect=${setPick} />`)}
      </div>
      <button type="button" class="proto-start rs-proto__ok" disabled=${!!busy} onClick=${() => (pick === room.difficulty ? onClose() : onPick(pick))}>
        <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
        <span class="proto-start__label">${busy === 'diff' ? html`<${Spinner} size="sm" />` : null}${t('确认')}</span>
        <span class="proto-start__deco" aria-hidden="true"></span>
      </button>
    </section>
  </div>`;
}

function AiTakeoverToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('默认关闭。开启后，观战者可在休整期经在座博士投票接替 AI；接替后的数据不计入个人统计或奖励。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-ai-takeover"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('允许观战者接替 AI')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** ⚙ of the bottom pill: the version, 允许观战者接替 AI, AI 队友最后选择 (a timed solo: 不限时) and 实验性选项 (with the current options summed up). */
function RoomOptions({ room, facts, myId, busy, onAiLast, onListed, onExperimental, onClose, leaving = false, takeoverOption = null, onAiTakeover, soloOption = null, onSoloUnlimited, version = null }) {
  const title = soloOption ? t('模拟设置') : t('同盟设置');
  useEffect(() => {
    const away = (e) => { if (!e.target.closest?.('.rs-opts, .rs-pill__gear, .modal')) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal')) { e.stopPropagation(); onClose(); } };
    addEventListener('pointerdown', away); addEventListener('keydown', onKey);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', onKey); };
  }, []);
  return html`<div class=${`rs-opts${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label=${title}>
    <h4>${title}${facts.isHost ? null : html`<small>${t('由创建者设置')}</small>`}</h4>
    ${!soloOption && version ? html`<div class="rs-opts__row" data-testid="room-opt-version">
      <span class="rs-opts__k">${t('版本')}</span>
      <${Tooltip} text=${version.why}>
        <button type="button" class="rs-opts__diff rs-opts__ver" disabled=${version.disabled} onClick=${version.onOpen}
            title=${version.editable ? t('发起切换版本') : t('由创建者发起')}>
          <${Icon} name="book" />${versionLabel(version.id)}${version.editable ? html`<em>${t('切换')}</em>` : null}
        </button>
      <//>
      ${version.editable ? null : html`<span class="t-dim">${t('由创建者发起')}</span>`}
    </div>` : null}
    <${AiTakeoverToggle} option=${takeoverOption} busy=${busy} onToggle=${onAiTakeover} />
    ${soloOption
      ? html`<${SoloUnlimitedToggle} option=${soloOption} busy=${busy} onToggle=${onSoloUnlimited} />`
      : html`<${AiLastToggle} option=${aiLastOption(room, myId)} busy=${busy} onToggle=${onAiLast} />`}
    <${ListedToggle} option=${listedOption(room, myId)} busy=${busy} onToggle=${onListed} />
    <button type="button" class="rs-opt rs-opt--exp" disabled=${!!busy} onClick=${onExperimental} aria-haspopup="dialog">
      <span>${t('实验性选项')}<small>${experimentalSummary(room.experimental)}</small></span><${Icon} name="chevronRight" /></button>
  </div>`;
}

/** How long a version proposal refused as too frequent (RATE) waits before it is sent once more [ASSUMED]. */
const PROPOSE_RETRY_MS = 1200;

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  // the 「原版 / 插件 ×N」 tag (ui/pluginTag.js): only on a server with plugins installed, or a room that has some on
  const installedPlugins = useStore((s) => s.installedPlugins);
  const showPlugins = installedPlugins > 0 || (Array.isArray(room?.content?.plugins) && room.content.plugins.length > 0);
  const conn = useStore((s) => s.connection, shallowEqual);
  const queue = useStore((s) => s.queue);
  const queued = queueActive(queue);
  const [busy, setBusy] = useState(null);
  const [picker, setPicker] = useState(false);
  const [opts, setOpts] = useState(false);
  const [experimentalOpen, setExperimentalOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  // the open service dialog keeps the whole cluster summary on every pong (server/net.js CLUSTER_LOAD_EVERY_MS)
  useEffect(() => { net.watchClusterLoad?.(loadOpen); return () => net.watchClusterLoad?.(false); }, [loadOpen]);
  const [bandSeat, setBandSeat] = useState(null);
  const gd = useGameData();
  const [since] = useState(() => Date.now());
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => { clearInterval(id); alive.current = false; }; }, []);
  useData('chess', 'assets');
  const m = data.get('assets');
  // 名片干员: the pickable operators, the default pool (5★/6★ by charId, the same order on every client), one's pick
  const cardList = useMemo(() => cardOperators(data.list('chess')), [data.get('chess')]);
  const myCard = useMyCard();
  const [picking, setPicking] = useState(null); // 'op' | 'avatar' | 'bg'
  const portraits = useMemo(() => ({
    pool: cardList.filter((c) => (c.rarity ?? 0) >= 5 && !c.roster).sort((a, b) => (a.charId < b.charId ? -1 : 1)),
    byChar: new Map(cardList.map((c) => [c.charId, c])), m, myId: me.playerId, myCard: myCard.charId, myLook: myCard.look,
  }), [cardList, m, me.playerId, myCard.charId, myCard.look]);
  const [protoShown, protoLeaving] = usePresence(picker && !!room && roomFacts(room, me.playerId).isHost, 220);
  const [optsShown, optsLeaving] = usePresence(opts, 160);
  const [exiting, setExiting] = useState(false);
  // the host's change of difficulty, told to the others (see the header); never on entering a room or switching rooms
  const seenDiff = useRef(room ? `${room.code}|${room.difficulty}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${room.difficulty}`;
    const before = seenDiff.current;
    seenDiff.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`) || room.hostId === me.playerId) return;
    const name = DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : room.difficulty;
    toast(t('创建者已将模拟难度改为「{name}」', { name }), 'info');
  }, [room?.code, room?.difficulty]);
  // official versions (DESIGN §35.23): the room's switch is told to everybody (the host's own page included — a vote's
  // result arrives later than the pick); never on entering a room or switching rooms
  const versions = useStore((s) => s.versions);
  const myLobby = useStore(lobbyVersion);
  const serverDefault = useStore(serverDefaultVersion);
  const [versionOpen, setVersionOpen] = useState(false);
  const seenVersion = useRef(room ? `${room.code}|${roomVersion(room)}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${roomVersion(room)}`;
    const before = seenVersion.current;
    seenVersion.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`)) return;
    setVersionOpen(false);
    toast(t('同盟已切换到「{version}」', { version: versionLabel(roomVersion(room)) }), 'success');
  }, [room?.code, room?.version]);

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const facts = roomFacts(room, me.playerId);
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);
  const big = facts.seats.length > MAX_SEATS;

  /** Runs one request at a time; resolves true once the server took it (false: not sent, or refused — toasted). */
  const run = async (kind, fn) => {
    if (inFlight.current) return false;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return false; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); return true; } catch (err) { toastError(err); return false; } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  // 准备 plays the official PLAYER_READY, cancelling it the plain button-up (feedback #10)
  const toggleReady = () => run('ready', async () => {
    const ready = !myReady;
    await net.request('room.ready', { ready });
    audio.sfx(ready ? 'ready' : 'back', { volume: 0.8 });
  });
  const start = () => run('start', () => net.request('room.start', {}));
  const queueReason = partyQueueReason(room, me.playerId, online);
  const joinQueue = () => run('queue', () => net.request('queue.join', { difficulty: room.difficulty, party: true }));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', async () => { await net.request('room.setDifficulty', { difficulty }); savePref('lobby.difficulty', difficulty); setPicker(false); });
  const setAiTakeover = (on) => run('aihandover', () => net.request('room.setAiTakeover', { on }));
  const setAiLast = (on) => run('ailast', () => net.request('room.setAiPicksLast', { on }));
  const setListed = (listed) => run('listed', () => net.request('room.setListed', { listed }));
  const setBotBand = (seat, bandId) => run(`band${seat}`, async () => { await net.request('room.setBotBand', { seat, bandId }); setBandSeat(null); });
  // the room is the authority; the lobby card reads the same pref the next time this browser creates a solo room
  const setSoloUnlimited = async (on) => {
    const sent = await run('solofree', () => net.request('room.setSoloUnlimited', { on }));
    if (sent) savePref('lobby.soloUnlimited', on === true);
  };
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code, ...(room.test ? { testAck: true } : {}) }));
  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」 — with the
    // version's name for another official version (DESIGN §35.23)
    const params = { name: me.name ?? '', difficulty: DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : '' };
    const invite = roomVersion(room) !== DEFAULT_VERSION
      ? t('{name}邀请你加入卫戍协议：盟约·{version}【{difficulty}】', { ...params, version: versionLabel(roomVersion(room)) })
      : t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', params);
    const ok = await copyText(what === 'code' ? room.code : `${inviteLink(room.code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code: room.code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  const leave = async () => {
    if (inFlight.current) return;
    if (queued) { toast(t('请先取消组队匹配，再离开同盟'), 'warn'); return; }
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: t('离开同盟'), text: t('你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    setExiting(true);
    await afterLeave(200);
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) { setBusy(null); setExiting(false); }
    }
  };

  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${t('连接中断，正在重连…')}</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />${t('观战中 · 不占博士席位，模拟开始后可切换观看各位博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : queued
      ? html`<span class="t-mint">${t('{n} 人好友小队 · 正在整队匹配', { n: facts.humans.length })}</span>`
    : facts.versionRoom && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入「{version}」的数据', { version: versionLabel(roomVersion(room)) })}</span>`
    : facts.needsContent && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入房间的插件内容')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待创建者开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，创建者即可开始模拟')}</span>`;
  const modeName = coop ? t('同盟模拟') : t('独立模拟');

  // the difficulties the room's version offers (its config's modes, versions.js) — the page shows that version's data
  // once it is loaded; until then (or for a gameplay plugin room's own modes) all four
  const protoDifficulties = offeredDifficulties(pageVersion() === roomVersion(room) ? getConfig() : null, room.mode);
  const soloTimed = soloTimedOf(pageVersion() === roomVersion(room) ? getConfig() : null, roomVersion(room));
  const soloOpt = soloUnlimitedOption(room, me.playerId, soloTimed);
  const soloBrief = soloTimeMsgid('brief', { timed: soloTimed, unlimited: room.soloUnlimited === true });
  // the room's version (DESIGN §35.23): the pill and ⚙'s row on a server that enables versions (or in a version room)
  const vote = versionVoteOf(room);
  const curVersion = roomVersion(room);
  const showVersion = Array.isArray(versions) || curVersion !== DEFAULT_VERSION;
  const versionWhy = !online ? t('连接中断，请稍候重试')
    : vote ? t('切换版本投票进行中，请等投票结束')
    : facts.modded ? t('请先关闭改变玩法的插件')
    : !Array.isArray(versions) || versions.length < 2 ? t('本服务器只启用了这一个版本') : null;
  const versionEditable = facts.isHost && !facts.spectating && !room.inMatch;
  // the room's version is not this browser's lobby choice: the banner says leaving restores it (on a short screen, where
  // the banner gives its room to the seats, the pill's tooltip says it)
  const bannerText = curVersion !== myLobby && Array.isArray(versions) ? t('本同盟为「{room}」，离开后恢复大厅版本「{mine}」', { room: versionLabel(curVersion), mine: versionLabel(myLobby) }) : null;
  const versionCtl = showVersion ? {
    id: curVersion, editable: versionEditable, why: [versionEditable ? versionWhy : t('由创建者发起'), bannerText].filter(Boolean).join(' · ') || null,
    disabled: versionEditable ? !!versionWhy || !!busy || queued : !Array.isArray(versions),
    onOpen: () => { setOpts(false); setVersionOpen(true); },
  } : null;
  // (a switch makes every page send its settings again, which share the server's budget of heavy messages with
  // room.proposeVersion: a RATE right after one is tried once more a moment later; the server's own 5 s pause after a
  // declined or expired vote answers RATE again and is told)
  const proposeVersion = async (version) => {
    const send = () => net.request('room.proposeVersion', { version });
    const sent = await run('version', async () => {
      try { await send(); } catch (err) {
        if (err?.code !== 'RATE') throw err;
        await new Promise((r) => setTimeout(r, PROPOSE_RETRY_MS));
        await send();
      }
    });
    if (sent && alive.current) setVersionOpen(false);
  };

  return html`<div class=${`screen room-screen rs${coop ? '' : ' rs--solo'}${big ? ' rs--big' : ''}${exiting ? ' is-leaving' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[room.difficulty]}; --n:${facts.seats.length}`}>
    <div class="rs__bg" aria-hidden="true"></div>
    <header class="rs-top">
      <div class="rs-top__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <button type="button" class="rs-exit" disabled=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')}><${Icon} name="exit" /></button>
        <//>
        <div class="rs-clock">
          <b>${modeName}${room.test ? html` <${TestMark} />` : null}<${VersionTag} room=${room} class="rs-clock__ver" />${room.content?.modeId ? html`<span class="room-mode" data-testid="room-mode">${(room.content.modes || []).find((m) => m.id === room.content.modeId)?.name || room.content.modeId}</span>` : null}<span class="rs-clock__sep"></span>${t('同盟已等待')} <span class="num">${clock((Date.now() - since) / 1000)}</span></b>
          ${big ? html`<span class="room-capacity">${t('实验性同盟 · {n} 人模式 · 支持同模式匹配', { n: facts.seats.length })}</span>` : html`<span>${t(DIFFICULTY_NAMES[room.difficulty])} · ${info.code}</span>`}
        </div>
        <div class="rs-tools">
          <${PingPill} ms=${conn.ping} online=${online} status=${conn.status} loadState=${conn.loadState ?? 'unknown'} loadDetails=${conn.loadDetails}
            clusterLoad=${conn.clusterLoad} loadOpen=${loadOpen} onLoadClick=${() => setLoadOpen(true)} class="rs-pingpill" />
          <${Button} variant="secondary" size="sm" square=${true} icon="chart" class="stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')} />
          <${SettingsButton} class="room-settings" variant="secondary" square=${true} />
          <${GuideButton} class="room-guide" variant="secondary" square=${true} />
          ${showPlugins ? html`<${PluginTag} room=${room} myId=${me.playerId} />` : null}
        </div>
      </div>
      <div class="rs-top__right">
        <${LoadoutButton} from="room" size="md" class="hub-plate hub-plate--loadout rs-loadout" label=${t('干员调配')} />
        ${coop ? html`<div class="rs-key">
          <span class="rs-key__k">${t('同盟密钥')}</span>
          <b class="rs-key__code num selectable" aria-label=${t('同盟密钥 {code}', { code: room.code })}>${room.code}</b>
          <button type="button" class="rs-key__copy" onClick=${() => copy('code')}>${t('复制')}</button>
          <button type="button" class="rs-key__link" onClick=${() => copy('link')} title=${t('复制邀请链接')} aria-label=${t('复制邀请链接')}><${Icon} name="link" /></button>
        </div>` : html`<div class="rs-key rs-key--solo"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class="rs-seats">
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} myCard=${myCard} busy=${busy} gd=${gd} queued=${queued} onKick=${kick} onInvite=${() => copy('code')}
        onAddBot=${addBot} onRemoveBot=${removeBot} onBotBand=${setBandSeat} portraits=${portraits}
        onPickCard=${cardList.length ? () => setPicking('op') : null} onPickAvatar=${cardList.length ? () => setPicking('avatar') : null}
        onPickBg=${() => setPicking('bg')} />`)}
      ${coop ? null : html`<aside class="solo-brief rs-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''} <span class="num t-dim">${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
          ${soloBrief ? html`<li>${t(soloBrief)}</li>` : null}
        </ul>
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />
    <${VersionVote} room=${room} />
    ${bannerText ? html`<p class="rs-verbanner" data-testid="version-banner"><${Icon} name="info" />${bannerText}</p>` : null}

    <footer class="rs-foot">
      <div class="rs-foot__left">
        <button type="button" class=${`rs-exp${experimentalChanged(room.experimental) ? ' is-on' : ''}`} disabled=${!!busy || queued} onClick=${() => setExperimentalOpen(true)}
          aria-haspopup="dialog" title=${experimentalSummary(room.experimental)}>
          <${Icon} name="edit" /><span><b>${t('实验性选项')}</b><small>${experimentalSummary(room.experimental)}</small></span></button>
      </div>
      <div class="rs-foot__center">
        <p class="rs-hint">${coop ? html`<span class="rs-ready num" title=${t('已就绪')}>${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}<b>${facts.readyHumans}</b>/${facts.humans.length}</span>` : null}${statusLine}</p>
        <div class="rs-pill">
          <button type="button" class="rs-pill__diff" disabled=${!facts.isHost || !!busy || queued} onClick=${() => setPicker(true)}
            title=${facts.isHost ? t('更改模拟难度') : t('由创建者选择')}><${DifficultyIcon} difficulty=${room.difficulty} />${t(DIFFICULTY_NAMES[room.difficulty])}</button>
          ${versionCtl ? html`<${Tooltip} text=${versionCtl.why} class="rs-pill__version"><button type="button" class=${`rs-pill__ver${versionCtl.editable ? '' : ' is-ro'}`} data-testid="room-version"
            disabled=${versionCtl.disabled} onClick=${versionCtl.onOpen} aria-label=${t('游戏版本：{name}', { name: versionLabel(curVersion) })}><${Icon} name="book" /><span class="rs-pill__vername">${versionLabel(curVersion)}</span></button><//>` : null}
          <button type="button" class=${`rs-pill__gear${opts ? ' is-on' : ''}`} onClick=${() => setOpts((v) => !v)} title=${soloOpt ? t('模拟设置') : t('同盟设置')} aria-label=${soloOpt ? t('模拟设置') : t('同盟设置')} aria-expanded=${opts ? 'true' : 'false'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill-rule="evenodd" /></svg>
          </button>
          ${optsShown ? html`<${RoomOptions} room=${room} facts=${facts} myId=${me.playerId} busy=${busy} onAiLast=${setAiLast} onListed=${setListed}
            takeoverOption=${aiTakeoverOption(room, me.playerId)} onAiTakeover=${setAiTakeover} soloOption=${soloOpt} onSoloUnlimited=${setSoloUnlimited} version=${versionCtl}
            onExperimental=${() => { setOpts(false); setExperimentalOpen(true); }} onClose=${() => setOpts(false)} leaving=${optsLeaving} />` : null}
        </div>
      </div>
      <div class="rs-foot__right">
        ${coop && facts.isHost && !queued ? html`<${Tooltip} text=${queueReason ? t(queueReason) : t('整队寻找相同人数模式和难度的真人，确认后自动开局')}>
            <button type="button" class="rs-search" data-testid="party-queue" disabled=${!!queueReason || !!busy} onClick=${joinQueue}>
              <${Icon} name="search" />${t('组队匹配')}${busy === 'queue' ? html`<${Spinner} size="sm" />` : null}</button>
          <//>` : null}
        ${facts.isHost
          ? html`<button type="button" class="proto-start rs-go" disabled=${!facts.canStart || !online || busy === 'start' || queued || !!vote} onClick=${start}
              title=${facts.canStart ? undefined : vote ? t('切换版本投票进行中，请等投票结束') : !facts.contentReady ? (facts.versionRoom ? t('仍有博士未载入「{version}」的数据', { version: versionLabel(curVersion) }) : t('仍有博士未载入房间的插件内容')) : t('仍有博士未准备就绪')}>
              <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
              <span class="proto-start__label">${busy === 'start' ? html`<${Spinner} size="sm" />` : null}${t('开始模拟')}</span>
              <span class="proto-start__deco" aria-hidden="true"></span></button>`
          : facts.spectating
            ? html`<button type="button" class="proto-start rs-go" disabled=${true}><span class="proto-start__label"><${Icon} name="eye" />${t('观战中')}</span></button>`
          : html`<button type="button" class=${`proto-start rs-go${myReady ? ' is-ready' : ''}`} disabled=${!online || !facts.mine || busy === 'ready' || queued || (!myReady && facts.myContent !== 'ready')} onClick=${toggleReady}
              title=${myReady ? t('再次点击取消就绪') : facts.myContent !== 'ready' ? (facts.versionRoom ? t('「{version}」的数据载入并通过校验后才能准备', { version: versionLabel(curVersion) }) : t('房间的插件内容载入并通过校验后才能准备')) : undefined}>
              <span class="rs-go__box" aria-hidden="true">${myReady ? html`<${Icon} name="check" />` : null}</span>
              <span class="proto-start__label">${busy === 'ready' ? html`<${Spinner} size="sm" />` : null}${myReady ? t('已就绪') : t('准备就绪')}</span>
              <span class="proto-start__deco" aria-hidden="true"></span></button>`}
      </div>
    </footer>

    ${queued ? html`<div class="rs-queue">
      <div class="rs-queue__team"><${MicroLabel} tone="mint">PARTY MATCHMAKING<//>
        <h2>${t('{n} 人好友小队', { n: facts.humans.length })}</h2>
        <p>${t('小队整体匹配相同人数模式和难度，不拆散队友。任一成员取消即可返回此房间；集齐 {n} 人后各自确认一次，直接开局。', { n: facts.seats.length })}</p>
      </div>
      <${QueueFlow} class="rs-searchpanel" queue=${queue} difficulty=${room.difficulty} experimental=${room.experimental} online=${online} party=${true} />
    </div>` : null}
    <${ExperimentalOptions} open=${experimentalOpen && !queued} value=${room.experimental} mode=${room.mode} source=${room.source} editable=${facts.isHost && online} busy=${!!busy}
      onChange=${experimental => run('experimental', () => net.request('room.setExperimental', { experimental }))} onClose=${() => setExperimentalOpen(false)} />
    <${ServerStatusModal} open=${loadOpen} online=${online} state=${conn.loadState} details=${conn.loadDetails} clusterLoad=${conn.clusterLoad} onClose=${() => setLoadOpen(false)} />
    ${bandSeat != null && facts.isHost && facts.seats[bandSeat]?.isBot ? html`<${BotBandPicker} seat=${facts.seats[bandSeat]} room=${room} gd=${gd}
      busy=${busy === `band${bandSeat}`} onClose=${() => setBandSeat(null)} onPick=${(bandId) => setBotBand(bandSeat, bandId)} />` : null}
    ${picking === 'op' ? html`<${OperatorPicker} title=${t('名片干员')} micro="SEAT CARD" current=${myCard.charId} list=${cardList} m=${m}
      autoLabel=${t('默认')} autoTitle=${t('按博士编号自动分配')}
      note=${CARD_SYNC ? t('选择后，同盟里的博士都会看到这张立绘') : t('目前只有你自己看得到；服务器下次更新后，同盟里的其他博士也能看到你的选择')}
      looks=${{ kind: 'portrait', current: myCard.look, onLook: (look) => { setCardLook(look); setPicking(null); } }}
      onPick=${(id) => { setCardOperator(id); if (!id || lookOptions(m, id, 'portrait').length < 2) setPicking(null); }} onClose=${() => setPicking(null)} />` : null}
    ${picking === 'avatar' ? html`<${AvatarPicker} current=${myCard.avatar} list=${cardList} m=${m}
      looks=${{ kind: 'avatar', current: myCard.avatarLook, onLook: (look) => { setAvatarLook(look); setPicking(null); } }}
      onPick=${(id) => { setCardAvatar(id); if (!id || lookOptions(m, id, 'avatar').length < 2) setPicking(null); }} onClose=${() => setPicking(null)} />` : null}
    ${picking === 'bg' ? html`<${NameCardPicker} current=${myCard.bg} y=${myCard.bgY} onPick=${setCardBackground} onAdjust=${setCardBackgroundY} onClose=${() => setPicking(null)} />` : null}
    ${protoShown ? html`<${RoomProtocol} room=${room} busy=${busy} onClose=${() => setPicker(false)} onPick=${setDifficulty} leaving=${protoLeaving} difficulties=${protoDifficulties} />` : null}
    ${versionOpen && versionCtl ? html`<${VersionPicker} mode="room" versions=${versions || [{ id: curVersion, roomModes: [room.mode] }]} current=${curVersion}
      serverDefault=${serverDefault} roomMode=${room.mode} editable=${versionEditable && !versionWhy} busy=${busy === 'version'}
      note=${versionEditable ? versionWhy || (facts.humans.length > 1 ? t('其他博士同意后才会切换；切换后需要重新准备。') : null) : t('由创建者发起')}
      onPick=${proposeVersion} onClose=${() => setVersionOpen(false)} />` : null}
  </div>`;
}

/** Persistent across room/game routes, including spectators who never consent. */
export function TrustedNotice() {
  const state = useStore(s => s);
  const room = state.room, cs = room?.content?.cs, trusted = room?.content?.trusted;
  const seat = room?.seats?.find(s => s && s.playerId === state.me?.playerId);
  const [dismissed,setDismissed] = useState(null);
  const [busy,setBusy] = useState(false);
  const [review,setReview] = useState(false);
  const choose = async accept => {
    setBusy(true);
    try {
      if (seat) await net.request('room.consent',{cs,accept});
      rememberScriptConsent(cs,accept);
      setDismissed(cs); setReview(false);
      if (accept && trusted.plugins.some(p => p.permissions.includes('trusted.page'))) {
        const url = new URL(location.href); url.searchParams.set('cs',cs); url.searchParams.set('room',room.code);
        location.assign(url.href); return;
      }
      store.set({room:{...store.get().room}}); // wake the content loader after local persistence
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (trusted && seat && hasScriptConsent(cs) && !trusted.consent?.[seat.seat] && !room.inMatch) {
      net.request('room.consent',{cs,accept:true}).catch(toastError);
    }
  },[cs,seat?.seat,!!trusted?.consent?.[seat?.seat]]);
  if (!trusted) return null;
  return html`<aside class="trusted-banner" data-testid="trusted-banner">
    <strong>${t('受信任插件')}</strong>
    <button onClick=${() => setReview(true)}>${t('查看风险与同意状态')}</button>
    <${Modal} open=${review || (dismissed !== cs && !hasScriptConsent(cs))} title=${t('受信任插件')} tone="red" closeOnBackdrop=${false}
      onClose=${() => room.inMatch ? setReview(false) : choose(false)} actions=${html`<${Button} disabled=${busy} onClick=${() => choose(false)} data-testid="script-decline">${t('拒绝')}<//>
        <${Button} disabled=${busy} onClick=${() => choose(true)} data-testid="script-accept">${t('同意运行')}<//>`}>
      <p>${t('它可以完全控制你的游戏页面')}</p>
      <p>${t('仅在你信任所有作者及以下代码时同意。换了内容组合需要重新同意。')}</p>
      <ul>${trusted.plugins.map(p => html`<li key=${p.id}><strong>${p.id} ${p.version}</strong>
        <p>${t('作者：{authors}',{authors:(p.authors || []).join(', ') || '—'})}</p>
        <p class="trusted-hash">SHA-256: ${p.hash}</p><p>${t('权限：{permissions}',{permissions:p.permissions.join(', ')})}</p></li>`)}</ul>
    <//>
  </aside>`;
}
