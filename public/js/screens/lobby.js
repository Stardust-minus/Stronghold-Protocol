// Lobby screen — a hub (2026-10-14: the lobby / room / 干员调配 design by 雨千代chiyo, adopted by the owner with this
// fork's own features kept): an original backdrop (ui/hubBackdrop.js: generated night scenes or the player's own
// picture / video, kept in the browser) with the game's dot-matrix emblem in the middle; a left column (成就统计 ·
// 密钥加入 · tips · the feedback group and the design credit), a right column (公告 · S.W.E.E.P.报告 (screens/sweep.js) ·
// 干员调配) and three big entries at the bottom right: 独立模拟 opens 选择模拟协议 (difficulty, create), 同盟模拟
// opens 选择同盟方式 (create, join with a 同盟密钥 or 观战, 多人匹配), 多人匹配 opens 选择模拟协议 for the public queue
// (queue.join → queue.state: 搜寻中, 确认入场, 搜寻成功 — ui/matchmaking.js QueueFlow). Joining a room whose match has
// started goes back to this browser's own seat in it, else offers its spectator seat (joinRoom). There is no title screen
// (2026-10-15): ✎ beside the name chip renames (ui/nickname.js); the footer under the feedback group (HubFoot) carries
// the licence notice, the repository link and the version.
// Not carried over from the design's original deployment (the owner's decision of 2026-10-14): chat, accounts and
// friends, the cross-server room directory and public room list, 私密房间, 无限火力. Maintenance: the server's
// presence.state `maintenance` pauses new matches (the entries say so); an announcement's `banner` line is shown above
// the entries ahead of time.
// Official versions (DESIGN §35.23, M1; versions.js): with welcome.versions the top bar shows the version chip (ui/
// versionPicker.js VersionSwitch — this browser's choice, its data loaded and checked by content.js), the title names a
// version other than 第二期下半, 选择模拟协议 offers the difficulties of the version shown (its config's modes: 第一期 and
// 第二期上半 have no 终极; the remembered difficulty, when it is not offered, shows as the server's fallback — the highest
// offered below it — and stays remembered until the player picks one; the cards wait while the version loads), and
// 创建同盟 / 独立模拟 create the room in that version (room.create `version`). 多人匹配 waits in that version's pool (this
// fork, the owner 2026-11-15: one pool per version — queue.join `version`): 选择模拟协议 lists the version's co-op
// difficulties, names the pool (the version chip, data-testid match-version) and waits for its data like the cards above;
// a version the server cannot queue (welcome.versions `queue: false`) leaves the start button off with
// 「{version}」暂不开放多人匹配. The search names the version (QueueFlow's tag, the hub's line); the version chip is locked while
// a ticket waits (ui/versionPicker.js), so the ticket and the lobby show the same version.
// The pool's chip in 选择模拟协议 opens the version picker too (the owner, 2026-11-16: 「多人匹配界面可以切换匹配的版本」; a pick
// is the lobby's version); its 规则 row adds 我的实验性 — the ticket's own experimental options, edited by group in 我的实验性
// 功能 (ui/matchmaking.js MatchOptionsDialog, `lobby.matchExperimental`) — beside 标准规则 and 任意实验性. Both dialogs hang on
// the lobby, not inside the full-screen 选择模拟协议.
// 规程·序列Ⅰ (upstream 0.4.0, the lobby's default version there — shared/versions.js LOBBY_DEFAULT_VERSION): the title reads
// 卫戍协议·规程, and 独立模拟's 选择模拟协议 picks one of its laddered official modes — 极速模拟 or 规程等级 1–20 (LadderList,
// versions.js ladderModes; room.create `modeId`, remembered as `lobby.ladderMode`) — instead of the four difficulties.
// The lobby keeps this fork's green look in every version by default. Upstream 0.4.0's red 规程 season look is the
// 大厅背景 dialog's 规程 choice (the owner, 2026-11-15; ui/hubBackdrop.js REGULATION_THEME): while it is chosen, in every
// version, the lobby draws its ground (ui/regulationBackdrop.js), the season emblem and — in 规程 — its wordmark and title
// art (HubTitle), and `data-look="regulation"` turns the lobby, 选择模拟协议 and the room red (css/screens/lobby.css).
// `data-season` names the lobby version's season (no style of its own here). No release-notes popup (upstream #603):
// this fork's announcement board is its only automatic popup, opened once the entry film is over (useEntryFilmOver).
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).
// Texts go through t() (docs/I18N.md); the module-level tables hold msgids (N_) translated where they are shown, the
// config.json mode texts come localized from data.js.

import { LobbyMusicButton } from '../ui/lobbyMusic.js';
import { Emblem } from '../ui/emblem.js';
import { useHubBackdrop, HubBackdrop, HubRadar, BackdropSettings, BackdropGlyph, backdropTheme, regulationLook } from '../ui/hubBackdrop.js';
import { REGULATION_ART } from '../ui/regulationBackdrop.js';
import { ResumeMatchButton, resumeLocalMatch } from '../ui/resumeMatch.js';
import { openNameDialog } from '../ui/nickname.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor, ERR, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo, confirmDialog } from '../ui/components.js';
import { AnnouncementBoard, announcementRevision, announcementDismissed, dismissAnnouncement, announcementBanner, parseAnnouncements } from '../ui/announcements.js';
import { ServerStatusModal } from '../ui/serverStatus.js';
import { SiteBoards } from '../ui/siteBoards.js';
import { VersionPicker, VersionSwitch } from '../ui/versionPicker.js';
import { contentSet, retryContentSet } from '../content.js';
import { DEFAULT_VERSION, lobbyVersion, offeredDifficulties, fallbackDifficulty, ladderModes, ladderPick, seasonOf, serverDefaultVersion, setLobbyVersion, soloTimedOf, versionLabel, versionQueueable, REGULATION_SEASON } from '../versions.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton, openGuide } from '../ui/guide.js';
import { openStats } from './stats.js';
import { AchievementEntry, AchievementPanel } from '../ui/achievements.js';
import { TrophyBadge } from '../ui/trophies.js';
import { useMyCard } from '../ui/playerCard.js';
import { cardAvatarUrl } from '../ui/seatArt.js';
import { CardAvatarLive } from '../ui/avatarLive.js';
import { SettingsButton } from '../ui/settings.js';
import { PwaInstallButton, FullscreenButton, fullscreen, reducedMotion } from '../ui/device.js';
import { LoadoutButton } from './loadout.js';
import { SweepReport } from './sweep.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { RadarScene, CreateArt, JoinArt } from '../ui/matchFlow.js';
import { useLeave } from '../ui/transitions.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { data, getConfig, getMode, getStage, useData, localAsset } from '../data.js';
import { EXPERIMENTAL_RULES, MATCHING_RULES, MATCH_SCOPE_DEFAULT, MatchOptionsDialog, QueueFlow, customProblem, matchConfig, matchScope, matchScopeRequest, multiSeats, queueActive, queueDifficulties, queueScope, queueTakesCustom, queueVersion, toggleMatchScope } from '../ui/matchmaking.js';
import { ExperimentalBadge, experimentalItems } from '../ui/experimental.js';
import { RoomListDialog } from '../ui/roomList.js';
import { queueCancellation } from '../queueCancellation.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { NoticesButton } from '../ui/notices.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: N_('时长较短的模拟训练'), effects: [N_('可以快速完成作战'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: N_('敌方攻击强度较低的模拟训练'), effects: [N_('作战环境较为温和'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * From the data name only its 战场#NN part (with a (上半) / (下半) mark) — 'Battlefield #NN (First Half)' in English.
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) {
    const m = rec.name.match(/^(.*?#\d+(?:\s*[(（][^)）]*[)）])?)/);
    return m ? m[1] : rec.name.split(/\s+/)[0];
  }
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? t('战场#{no}', { no: String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0') }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? t('战场固定为 {name}', { name }) : t('战场固定'); }
    return ids.length > 1 ? t('战场随机（共{n}张）', { n: ids.length }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? t('战场随机（共{stages}张）', { stages }) : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: N_('独立模拟'), en: 'SOLO SIMULATION', icon: 'user',
    desc: N_('独自调配资金与干员，以自己的节奏完成整场模拟。'),
    points: [N_('1 名博士'), N_('休整期与机变阶段不限时')],
  },
  {
    id: 'coop', name: N_('同盟模拟'), en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: N_('与至多 {n} 名博士组成同盟，调配干员、联防协作抵御敌潮。'), params: { n: MAX_SEATS - 1 },
    points: [N_('1–{n} 名博士 · 可由 AI 队友补位'), N_('联防阶段 · 最终攻势合并生命值')], pointParams: { n: MAX_SEATS },
  },
  {
    id: 'match', name: N_('多人匹配'), en: 'PUBLIC MATCHMAKING', icon: 'search',
    desc: N_('寻找相同难度的博士，确认后组成同盟；也可从好友房组队匹配。'),
    points: [N_('4 名真人 · 不自动补 AI'), N_('跟随房间选项 · 全员确认自动开局')],
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•・･\s]+/, '')).filter(Boolean)
    : fallback.effects.map((e) => t(e));
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : t(fallback.desc),
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

/**
 * Text for one official mode of a laddered room mode (规程's 极速模拟 / 规程等级 n: data/config.json `modes[modeId]`), in
 * difficultyInfo's shape plus its own name, colour and difficulty (FAST, 极速模拟's, shows as 标准 where a difficulty is needed).
 * @param {string} modeId
 * @returns {{ name: string, color: string, difficulty: string, code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string, offBonds: string[] }}
 */
export function modeInfo(modeId) {
  const m = getMode(modeId) || {};
  const difficulty = DIFFICULTIES.includes(m.difficulty) ? m.difficulty : 'FUNNY';
  // the rounds / battlefield fallbacks of the difficulty (its desc and effects are the mode's own below: a laddered solo's
  // mode_single_funny is 极速模拟, whose 「时长较短的模拟训练」 is no 规程等级's)
  const base = difficultyInfo('coop', difficulty);
  const off = Array.isArray(m.inactiveBondIds) ? m.inactiveBondIds : [];
  return {
    ...base,
    name: typeof m.name === 'string' ? m.name : modeId,
    color: typeof m.color === 'string' && /^#?[0-9a-f]{6}$/i.test(m.color) ? (m.color.startsWith('#') ? m.color : `#${m.color}`) : DIFFICULTY_COLORS[difficulty],
    difficulty,
    code: typeof m.code === 'string' ? m.code : '',
    // its own text (规程等级5 追加更多盟约, 9 追加更多敌人 …), else the difficulty's general one — never another mode's own,
    // which names that mode's unlocks (险境模拟: 「解锁时可开放至【规程等级3】」)
    desc: typeof m.desc === 'string' && m.desc ? m.desc : t(MODE_TEXT.multi[difficulty]?.desc || ''),
    effects: Array.isArray(m.effectDescList) ? m.effectDescList.map((e) => String(e).replace(/^[·•・･\s]+/, '')).filter(Boolean) : [],
    rounds: Number.isFinite(m.lastRound) ? m.lastRound : base.rounds,
    hidden: Number.isFinite(m.hiddenRound),
    stageNote: stageNote(Array.isArray(m.stages) ? m.stages : []),
    offBonds: off.map((id) => data.lookup('bonds', id)?.name || id),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/**
 * Join a room, or — when the server says it has started — go back to this browser's own seat in it (a page whose token
 * this one could not take over, identity.recoverable), else offer its read-only spectator seat.
 */
export async function joinRoom(code, { connection = net, confirm = confirmDialog, getState = store.get,
  localSeats = () => identity.recoverable(), resume = resumeLocalMatch } = {}) {
  const viewer = getState().me;
  const current = () => {
    const s = getState();
    return viewer.playerId != null && connection.status === 'online' && s.session.entered && !s.room && !queueActive(s.queue)
      && s.me.playerId === viewer.playerId && s.me.token === viewer.token;
  };
  if (!current()) return false;
  try {
    await connection.request('room.join', { code });
    return true;
  } catch (err) {
    if (err?.code !== ERR.ROOM_STARTED) throw err;
    if (!current()) return false;
    // the seat of this match another (closed) page of this browser played: resume it instead of watching (the owner's
    // report of 2026-10-13); a seat a live page still holds stays there and the offer below follows
    const seat = localSeats().find((item) => item.code === code);
    if (seat && await resume(seat)) return true;
    if (!current()) return false;
    const accepted = await confirm({
      title: t('同盟已开始模拟'),
      text: t('同盟 {code} 已经开局，不能再加入博士席位。是否使用原密钥进入观战？', { code }),
      okText: t('观战'),
      cancelText: t('取消'),
      micro: 'SPECTATE STARTED ALLIANCE',
    });
    if (!accepted || !current()) return false;
    await connection.request('room.spectate', { code });
    return true;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code, test = false) {
  if (!CODE_RE.test(code)) return;
  const recent = [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4);
  const marks = loadPref('recentTestRooms', []);
  savePref('recentTestRooms', recent.filter(c => c === code ? test : Array.isArray(marks) && marks.includes(c)));
  savePref('recentRooms', recent);
}

export async function joinKnown(type, key) {
  try { return await net.request(type, { code: key }); } catch (err) {
    if (err?.code !== ERR.TEST_CONFIRM) throw err;
    const text = type === 'room.spectate'
      ? t('这是测试房间，不计入任何记录。确认观战？')
      : t('这是测试房间，不计入任何记录。确认加入？');
    if (await confirmDialog({ title: t('测试'), text })) {
      return net.request(type, { code: key, testAck: true });
    }
  }
}

/** The 观战 tooltip: MAX_SPECTATORS 0 = no cap (shared/constants.js). */
const spectateHint = () => (MAX_SPECTATORS > 0
  ? t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })
  : t('以观战者身份进入：不占博士席位，只能观看（观战席不设人数上限），模拟进行中也可进入'));

const FALLBACK_TIPS = [
  N_('联合模拟在选择策略时可以进行一次跳过'),
  N_('调度中心即使冻结，依然可以主动刷新'),
  N_('两件同名装备可以合成一件更强力的装备'),
  N_('只有达成完美作战的队友可以进行联防'),
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval
/** How long a 开始多人匹配 refused as too frequent (RATE) waits before it is sent once more [ASSUMED] (room.js PROPOSE_RETRY_MS). */
const QUEUE_RETRY_MS = 1200;

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const fallback = FALLBACK_TIPS.map((x) => t(x));
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((x) => (typeof x === 'string' ? x : x?.tip)).filter((x) => typeof x === 'string' && x)
    : fallback;
  const list = tips.length ? tips : fallback;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  // the rotation waits while the tip is pointed at or focused, and stays off with reduced motion (the arrows still turn it)
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || reducedMotion()) return undefined;
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, [held]);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets" onPointerEnter=${() => setHeld(true)} onPointerLeave=${() => setHeld(false)}
      onFocusIn=${() => setHeld(true)} onFocusOut=${() => setHeld(false)}>
    <div class="tips__head">
      <${Icon} name="info" />
      <span>${t('作战提示')}</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label=${t('上一条')}><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label=${t('下一条')}><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}

/**
 * 公告 in the right column: the newest notice's title and date, an unread dot; opens the board (ui/announcements.js).
 * Takes the place the design gave a public room list (not part of this server).
 */
function NoticeCard({ value, unread, status, onOpen }) {
  const entries = status === 'ready' ? parseAnnouncements(value) : null;
  const top = entries?.[0] || null;
  return html`<button type="button" class=${`hub-notice${unread ? ' is-unread' : ''}`} onClick=${onOpen} aria-haspopup="dialog"
      aria-label=${unread ? `${t('公告')} · ${t('有未读公告')}` : t('公告')}>
    <span class="hub-notice__head">
      <span class=${`hub-recruit__pulse${unread ? ' is-live' : ''}`} aria-hidden="true"></span>
      <span class="hub-notice__title">${t('公告')}</span><span class="hub-notice__en">NOTICE</span>
      ${unread ? html`<i class="lobby-dot" aria-hidden="true"></i>` : null}
      <span class="hub-notice__more">${t('查看')}<${Icon} name="chevronRight" /></span>
    </span>
    <span class="hub-notice__body">${top
      ? html`<b>${top.title}</b>${top.date ? html`<small class="num">${top.date}</small>` : null}`
      : html`<span class="t-dim">${status === 'missing' ? t('暂无公告') : status === 'error' ? t('公告加载失败，点击重试') : t('正在加载公告…')}</span>`}</span>
  </button>`;
}

/**
 * 全屏 / 退出全屏 in the top bar, styled like its neighbours; where the browser has no element fullscreen (iPhone) the
 * button stays and explains how to get a full screen there (ui/device.js FullscreenButton).
 */
function HubFullscreenButton() {
  const [on, setOn] = useState(() => fullscreen.active());
  const [ok] = useState(() => fullscreen.supported());
  useEffect(() => {
    const upd = () => setOn(fullscreen.active());
    document.addEventListener('fullscreenchange', upd);
    document.addEventListener('webkitfullscreenchange', upd);
    return () => { document.removeEventListener('fullscreenchange', upd); document.removeEventListener('webkitfullscreenchange', upd); };
  }, []);
  if (!ok) return html`<${FullscreenButton} class="hub-fs-btn hub-fs-btn--help" showUnavailable=${true} />`;
  const label = on ? t('退出全屏') : t('全屏');
  return html`<${Button} variant="secondary" size="sm" square=${true} icon=${on ? 'collapse' : 'expand'} class="hub-fs-btn"
    title=${label} aria-label=${label} aria-pressed=${on ? 'true' : 'false'} onClick=${() => fullscreen.toggle()} />`;
}

/** Crossed blades in a hexagon: the S.W.E.E.P. plate's glyph (original drawing). */
function SweepGlyph() {
  return html`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2z" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M9 9l12.5 12.5M23 9 10.5 21.5" stroke="currentColor" stroke-width="2.2" />
    <path d="M19.2 23.8l4.6-4.6M8.2 19.2l4.6 4.6M21.6 21.6l2.2 2.2M10.4 21.6l-2.2 2.2" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

/** S.W.E.E.P.报告: opens the report (screens/sweep.js — 盟约报告 / 策略报告 / 敌方资料). */
function SweepPlate({ onClick }) {
  return html`<button type="button" class="hub-plate hub-plate--sweep" onClick=${onClick} title=${t('S.W.E.E.P.报告：盟约、策略与敌方资料')}>
    <span class="hub-plate__glyph"><${SweepGlyph} /></span>
    <span class="hub-plate__label">S.W.E.E.P.${t('报告')}</span>
    <span class="hub-plate__tag">REPORT</span>
  </button>`;
}

/** One of the big entries at the bottom right. */
function HubEntry({ mode, group, name, en, icon, badge, tone = 'mint', note = null, onClick, disabled = false }) {
  return html`<div class="hub-entry-wrap">
    ${group ? html`<span class="hub-entry__group"><${Icon} name=${group.icon} />${group.label}</span>` : html`<span class="hub-entry__group hub-entry__group--blank"></span>`}
    <button type="button" class=${`hub-entry hub-entry--${tone}`} data-mode=${mode} onClick=${onClick} disabled=${disabled}>
      <span class="hub-entry__icon"><${Icon} name=${icon} /></span>
      <span class="hub-entry__en">${en}</span>
      <span class="hub-entry__name">${name}${badge ? html`<span class="mode-beta">${badge}</span>` : null}</span>
      ${note ? html`<span class="hub-entry__count">${note}</span>` : null}
      <span class="hub-entry__corner" aria-hidden="true"></span>
    </button>
  </div>`;
}

/** A small tile of the side column. */
function HubTile({ icon, label, en, onClick, children }) {
  return html`<button type="button" class="hub-tile" onClick=${onClick}>
    <span class="hub-tile__icon"><${Icon} name=${icon} /></span>
    <span class="hub-tile__text"><span class="hub-tile__label">${label}</span><span class="hub-tile__en">${en}</span></span>
    ${children}
  </button>`;
}

/** Shared frame of the hub's small dialogs (密钥加入, 大厅背景). */
function HubDialog({ open, micro, title, onClose, wide = false, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, [open]);
  if (!open) return null;
  return html`<div class="modal hub-dialog" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal__box hub-dialog__box brackets${wide ? ' hub-dialog__box--wide' : ''}`} role="dialog" aria-modal="true">
      <div class="modal__stripe" aria-hidden="true"></div>
      <header class="hub-dialog__head">
        <${MicroLabel} tone="mint">${micro}<//>
        <div class="hub-dialog__title-row">
          <h2 class="modal__title">${title}</h2>
          <button type="button" class="mm-modal__close" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
        </div>
      </header>
      <div class="hub-dialog__body">${children}</div>
    </div>
  </div>`;
}

/** The hand-drawn ring of the 已选定 stamp (two loose strokes). */
function StampRing() {
  return html`<svg class="pcard__ring" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
    <path pathLength="1" d="M18 62C6 34 34 8 70 10c34 2 48 30 38 54-10 24-46 32-72 22C20 80 10 66 16 50" />
    <path pathLength="1" d="M30 20c22-14 62-12 78 10 12 18 4 44-16 54" />
  </svg>`;
}

/** 正在加入同盟…: bottom left while the room is being opened, a light running along the bottom edge (css tr-join). */
function JoinLine({ text }) {
  return html`<div class="tr-join" role="status"><span class="tr-join__mark" aria-hidden="true"></span>${text}<span class="tr-join__dots" aria-hidden="true"></span></div>`;
}

/** One difficulty of 选择模拟协议: name, text, effects; the extras (code, rounds, 隐秘核心, battlefields) below. */
export function ProtoCard({ roomMode, difficulty, selected, onSelect, disabled = false }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`pcard${selected ? ' is-on' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`}
      onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'} disabled=${disabled}>
    <span class="pcard__glow" aria-hidden="true"></span>
    <span class="pcard__head">
      <${DifficultyIcon} difficulty=${difficulty} class="pcard__glyph" />
      <span class="pcard__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
    </span>
    <span class="pcard__desc">${info.desc}</span>
    <span class="pcard__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}</span>
    <span class="pcard__meta">
      ${info.code ? html`<span class="num">${info.code}</span>` : null}
      <span><b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t(' + 隐秘核心') : ''}</span>
      ${info.stageNote ? html`<span>${info.stageNote}</span>` : null}
    </span>
    <span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">${t('已选定')}</span></span>
  </button>`;
}

/**
 * A laddered room mode's choice (规程's solo, upstream 0.4.0; instead of the four difficulty cards): 极速模拟 — its modes
 * outside the ladder — as a card in ProtoCard's shape, then 规程等级 1–20 as numbered cells in rows by difficulty, each row
 * named and coloured by its difficulty (lobby.css .ladder). Shared with the room's 选择模拟协议 (room.js RoomProtocol).
 */
export function LadderList({ ladder, modeId, onMode, disabled = false }) {
  const side = ladder.filter((m) => !DIFFICULTIES.includes(m.difficulty));
  const rows = DIFFICULTIES.map((d) => ({ d, modes: ladder.filter((m) => m.difficulty === d) })).filter((r) => r.modes.length);
  const num = (m) => /(\d+)$/.exec(m.name)?.[1] ?? m.code;
  return html`<div class="ladder" data-testid="proto-ladder">
    ${side.map((m) => { const info = modeInfo(m.id); const on = m.id === modeId; return html`<button key=${m.id} type="button" class=${`pcard ladder__side${on ? ' is-on' : ''}`}
        style=${`--d-color:${info.color}`} disabled=${disabled} onClick=${() => onMode(m.id)} aria-pressed=${on ? 'true' : 'false'} data-mode=${m.id}>
      <span class="pcard__glow" aria-hidden="true"></span>
      <span class="pcard__head"><span class="pcard__name">${info.name}</span></span>
      <span class="pcard__desc">${info.desc}</span>
      <span class="pcard__meta">
        ${info.code ? html`<span class="num">${info.code}</span>` : null}
        <span><b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t(' + 隐秘核心') : ''}</span>
      </span>
      <span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">${t('已选定')}</span></span>
    </button>`; })}
    <div class="ladder__grid" role="group" aria-label=${t('规程等级')}>
      ${rows.map(({ d, modes }) => html`<div key=${d} class="ladder__row" style=${`--d-color:${DIFFICULTY_COLORS[d]}`}>
        <span class="ladder__tier"><${DifficultyIcon} difficulty=${d} />${t(DIFFICULTY_NAMES[d])}</span>
        <span class="ladder__cells">${modes.map((m) => html`<button key=${m.id} type="button" class=${`ladder__cell num${m.id === modeId ? ' is-on' : ''}`}
            disabled=${disabled} onClick=${() => onMode(m.id)} aria-pressed=${m.id === modeId ? 'true' : 'false'} title=${`${m.name} · ${m.code}`} data-mode=${m.id}>${num(m)}</button>`)}</span>
      </div>`)}
    </div>
  </div>`;
}

/** 多人匹配's difficulties after pressing `x` (feedback #87): the press toggles it, and the last one stays. */
export function toggleMatchPick(picks, x) {
  if (!picks.includes(x)) return [...picks, x];
  return picks.length > 1 ? picks.filter((d) => d !== x) : picks;
}

/** 多人匹配's line above its start button: how many humans this scope waits for. */
function matchHint(scope) {
  const { a, b } = multiSeats(), multi = !!scope?.seats.includes('multi');
  return multi ? t('{a}–{b} 名真人 · 不自动补 AI · 集齐后 30 秒内确认入场', { a: scope.seats.includes('four') ? MAX_SEATS : a, b })
    : t('{n} 名真人 · 不自动补 AI · 集齐后 30 秒内确认入场', { n: MAX_SEATS });
}

/**
 * 多人匹配's scope, under the difficulties: the room sizes and the rules this ticket takes (ui/matchmaking.js) — 标准规则,
 * 我的实验性 (the ticket's own options, `own`: while the server takes them) and 任意实验性. With 我的实验性 on, the line under
 * the rows names how many of its options are on (a 浮窗 lists them by group) and opens their dialog (`own.onEdit`).
 */
function MatchScope({ scope, onToggle, disabled, own = null }) {
  const row = (axis, label, options) => html`<div class=${`proto-scope__row${options.length > 2 ? ' is-three' : ''}`} role="group" aria-label=${label}>
    <span class="proto-scope__k">${label}</span>
    ${options.map(({ id, name, note, why }) => {
      const on = scope[axis].includes(id);
      return html`<button key=${id} type="button" class=${`proto-scope__opt${on ? ' is-on' : ''}`} aria-pressed=${on ? 'true' : 'false'} disabled=${disabled}
          title=${why} data-testid=${`match-scope-${id}`} onClick=${() => onToggle(axis, id)}>
        <${Icon} name="check" /><span>${name}${note ? html`<small class="num">${note}</small>` : null}</span>
      </button>`;
    })}
  </div>`;
  return html`<div class="proto-scope" data-testid="match-scope">
    ${row('seats', t('人数'), [
      { id: 'four', name: t('{n} 人同盟', { n: MAX_SEATS }), why: t('标准的 {n} 人同盟', { n: MAX_SEATS }) },
      { id: 'multi', name: t('多人同盟'), note: t('{a}–{b} 人', multiSeats()), why: t('{a}–{b} 人的同盟，最先集齐的人数开局', multiSeats()) },
    ])}
    ${row('rules', t('规则'), [
      { id: 'standard', name: t('标准规则'), why: t('所有规则保持原样的同盟') },
      ...(own ? [{ id: 'custom', name: t('我的实验性'), note: own.count ? String(own.count) : null, why: t('按我设置的实验性功能匹配，只和设置完全相同的博士或小队组队') }] : []),
      { id: 'experimental', name: own ? t('任意实验性') : t('实验性规则'), why: t('其他博士或小队开启了实验性功能的同盟，如复活、敌人倍率；确认入场前可以看到具体内容，不想玩可以退出') },
    ])}
    ${own && scope.rules.includes('custom') ? html`<div class="proto-scope__own" data-testid="match-own">
      <${ExperimentalBadge} value=${own.value} queue=${true} label=${t('我的实验性功能')} disabled=${disabled} onOpen=${own.onEdit} testid="match-own-options" class="proto-own" />
      ${own.problem ? html`<span class="proto-scope__warn" role="status">${own.problem === 'size' ? t('所选人数下没有生效的功能') : t('尚未开启任何功能')}</span>` : null}
    </div>` : null}
  </div>`;
}

/** 多人匹配's rules (the former lobby's 匹配说明, ui/matchmaking.js wording). */
function MatchRules() {
  const [open, setOpen] = useState(false);
  return html`<${Button} variant="ghost" size="sm" icon="info" class="matchmaking__help" onClick=${() => setOpen(true)}>${t('匹配说明')}<//>
    ${open ? html`<div class="modal hub-dialog" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div class="modal__box hub-dialog__box brackets" role="dialog" aria-modal="true" aria-label=${t('多人匹配规则')}>
        <div class="modal__stripe" aria-hidden="true"></div>
        <header class="hub-dialog__head"><${MicroLabel} tone="mint">MATCHMAKING RULES<//>
          <div class="hub-dialog__title-row"><h2 class="modal__title">${t('多人匹配规则')}</h2>
            <button type="button" class="mm-modal__close" onClick=${() => setOpen(false)} aria-label=${t('关闭')}><${Icon} name="close" /></button></div>
        </header>
        <div class="hub-dialog__body">
          <p class="modal__text">${t('按相同人数模式和难度匹配真人，不自动补 AI；好友小队保持整队。')}</p>
          <p class="modal__text">${t(MATCHING_RULES)}</p>
          <p class="modal__text">${t(EXPERIMENTAL_RULES)}</p>
          <p class="modal__text">${t('单人匹配可同时选择多个难度和人数：最先集齐的组合开局，其余随之退出等待。好友小队按同盟当前的难度和人数匹配。')}</p>
        </div>
      </div>
    </div>` : null}`;
}

/**
 * The picture of 选择模拟协议: the difficulty's scene (ui/protocolScene.js), or with the 规程 theme in 规程 (`regArt`)
 * the season's key art (the 乌萨斯 monument, upstream 0.4.0's ProtocolArt) when the local-client art has it.
 * @param {{ d: string, regArt?: boolean }} props
 */
function ProtocolArt({ d, regArt = false }) {
  useData('local');
  const pic = regArt ? localAsset(REGULATION_ART, 'bg_season_on') : null;
  if (pic) return html`<div class="proto-reg-art" data-difficulty=${d}><img src=${pic} alt="" /></div>`;
  return html`<${ProtocolScene} key=${d} difficulty=${d} />`;
}

/**
 * 选择模拟协议 (the design's second screen after 独立模拟; also 多人匹配's): full screen, the picture of the selected
 * difficulty at the left (ui/protocolScene.js, original), the difficulties down the right with the 已选定 stamp, the
 * start button at the bottom right — 开始模拟 (solo: room.create) or 开始多人匹配 (queue.join). While queued the right
 * column is the queue (QueueFlow: 搜寻中 / 确认入场 / 搜寻成功); ‹ returns to the hub and the queue keeps running.
 * Comes up from black over the hub (`chained`: straight after 选择同盟方式, already black) and fades back out
 * (ui/transitions.js); the picture is redrawn for each difficulty. A laddered version's solo (规程, `ladder`: versions.js
 * ladderModes) lists its official modes instead (LadderList), and the brief names, colours and describes the chosen one
 * (modeInfo), with the bonds it does not load; `season` is set as data-season. `look` (the 规程 theme, see the header):
 * the lobby's `data-look` turns it red, and in 规程 the season's key art stands in the picture's place (ProtocolArt).
 */
function ProtocolSelect({ card, purpose = 'create', difficulty, onDifficulty, onClose, online, maint, busy, queue, onCreate, onQueue, chained = false,
  difficulties = DIFFICULTIES, loading = false, failed = false, soloTime = null, picks = null, onPick = null, scope = null, onScope = null,
  ladder = null, modeId = null, onMode = null, season = null, look = false, pool = null, own = null, onLeaving = null }) {
  const [leaving, leave] = useLeave(onClose);
  useEffect(() => { if (leaving) onLeaving?.(); }, [leaving]); // ‹ / Esc pressed: closing from now (lobby.js queueMatch)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal, .guide')) leave(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, []);
  const fx = `${leaving ? ' is-leaving' : ''}${chained ? ' is-chained' : ''}`;
  const match = purpose === 'match';
  const roomMode = match ? 'coop' : card.id === 'solo' ? 'solo' : 'coop';
  const queued = queueActive(queue);
  // a laddered room mode (规程's solo): the chosen official mode names, colours and describes the brief
  const mode = !match && ladder && modeId ? modeInfo(modeId) : null;
  const d = mode ? mode.difficulty : queued && DIFFICULTIES.includes(queue.difficulty) ? queue.difficulty : difficulty;
  const info = mode || difficultyInfo(roomMode, d);
  const color = mode ? mode.color : DIFFICULTY_COLORS[d];
  const back = html`<button type="button" class="proto-back" onClick=${leave} title=${queued ? t('返回大厅（继续匹配）') : t('返回大厅 (Esc)')} aria-label=${t('返回大厅')}>
    <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
  </button>`;
  if (match && queued) {
    return html`<div class=${`proto proto--searching${fx}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`} data-difficulty=${d} role="dialog" aria-label=${t('多人匹配')}>
      <div class="proto__bg" aria-hidden="true"></div>
      <header class="proto-top">${back}
        <div class="proto-title"><h2>${t('同盟集结')}</h2><span class="proto-title__mode">${t('多人匹配')}<i>PUBLIC MATCHMAKING</i></span></div>
      </header>
      <div class="proto-body">
        <section class="proto-stage"><${ProtocolScene} key=${d} difficulty=${d} /></section>
        <section class="proto-side proto-side--search">
          <${QueueFlow} queue=${queue} difficulty=${d} online=${online} />
        </section>
      </div>
    </div>`;
  }
  const label = maint ? t('维护中 · 暂停开局') : match ? t('开始多人匹配') : roomMode === 'solo' ? t('开始模拟') : t('创建同盟');
  // 多人匹配's pool (the header): `pool` { label, off } while the server offers versions
  const closed = match && pool?.off === true;
  const hint = !online ? t('正在连接服务器…') : maint ? t('服务器即将维护，暂停开启新的模拟')
    : closed ? t('「{version}」暂不开放多人匹配', { version: pool.label })
    : match && own?.problem ? t('请先在「我的实验性」中开启至少一项在所选人数下生效的功能')
    : match ? matchHint(scope)
    : roomMode === 'solo' ? t('独自调配阵容，按自己的节奏开始模拟') : t('创建后可邀请好友或添加 AI 队友');
  const working = busy === 'create' || busy === 'queue';
  return html`<div class=${`proto${fx}`} style=${`--d-color:${color}`} data-difficulty=${d} data-season=${season || undefined} role="dialog" aria-label=${t('选择模拟协议')}>
    <div class="proto__bg" aria-hidden="true"></div>
    <header class="proto-top">${back}
      <div class="proto-title">
        <h2>${t('选择模拟协议')}</h2>
        <span class="proto-title__mode">${t(card.name)}<i>${card.en}</i></span>
      </div>
    </header>
    <div class="proto-body">
      <section class="proto-stage">
        <${ProtocolArt} key=${d} d=${d} regArt=${look && season === REGULATION_SEASON} />
        <div class="proto-brief">
          <span class="proto-brief__code num">${info.code}</span>
          <b class="proto-brief__name">${mode ? mode.name : t(DIFFICULTY_NAMES[d])}</b>
          <p>${mode ? mode.desc : t(card.desc, card.params)}</p>
          ${mode?.offBonds.length ? html`<p class="proto-brief__off" data-testid="proto-off-bonds">${t('本模式未载入的盟约：{names}', { names: mode.offBonds.join('、') })}</p>` : null}
        </div>
      </section>
      <section class="proto-side">
        <div class="proto-list" role=${match ? 'group' : 'radiogroup'} aria-label=${t('模拟难度')} aria-busy=${loading ? 'true' : 'false'}>
          ${failed ? html`<p class="proto-list__wait is-failed" data-testid="proto-failed"><${Icon} name="warn" />${t('版本数据校验失败')}
              <${Button} size="sm" variant="secondary" data-testid="proto-retry" onClick=${retryContentSet}>${t('重试')}<//></p>`
            : loading ? html`<p class="proto-list__wait" data-testid="proto-loading"><${Spinner} size="sm" />${t('正在载入版本数据…')}</p>` : null}
          ${!match && ladder ? html`<${LadderList} ladder=${ladder} modeId=${modeId} onMode=${onMode || (() => {})} disabled=${working || loading} />`
            : difficulties.map((x) => html`<${ProtoCard} key=${x} roomMode=${roomMode} difficulty=${x} selected=${match && picks ? picks.includes(x) : d === x} onSelect=${match && onPick ? onPick : onDifficulty} disabled=${working || loading} />`)}
        </div>
        <div class=${`proto-foot${match ? ' proto-foot--match' : ''}`}>
          ${match && scope ? html`<${MatchScope} scope=${scope} onToggle=${onScope} disabled=${working} own=${own} />` : null}
          ${match ? html`<div class="proto-opts"><span class="proto-mode-chip"><${Icon} name="search" />${t('多人匹配')}</span>${pool ? (pool.onPick
            ? html`<button type="button" class="proto-mode-chip proto-mode-chip--pick" data-testid="match-version" aria-haspopup="dialog" disabled=${working}
                title=${t('只和选择同一版本的博士匹配；点击切换匹配的版本')} onClick=${pool.onPick}><${Icon} name="book" />${pool.label}<${Icon} name="chevronRight" class="proto-mode-chip__go" /></button>`
            : html`<span class="proto-mode-chip" data-testid="match-version" title=${t('只和选择同一版本的博士匹配；匹配中不能切换版本')}><${Icon} name="book" />${pool.label}</span>`) : null}<${MatchRules} /></div>` : null}
          ${soloTime ? html`<label class="create-box__test" data-testid="solo-unlimited">
            <input type="checkbox" role="switch" checked=${soloTime.on} onChange=${(e) => soloTime.onToggle(e.target.checked)} />
            <span>${t('不限时')}</span>
            <em class="t-dim">${t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。')}</em>
          </label>` : null}
          ${match && picks ? html`<p class="proto-hint" data-testid="match-picks">${scope && !scope.rules.includes('standard') ? (scope.rules.includes('experimental')
              ? t('只加入开启了实验性功能的对局：没有这样的对局时会一直等待') : t('只和实验性功能设置完全相同的博士或小队匹配：没有时会一直等待'))
            : picks.length > 1 ? t('已选 {k} 个难度，任一难度集齐即开局', { k: picks.length }) : t('可多选难度，任一难度集齐即开局')}</p>` : null}
          <p class="proto-hint">${hint}</p>
          <button type="button" class="proto-start" disabled=${!online || maint || working || loading || closed || (match && !!own?.problem)} onClick=${match ? onQueue : onCreate}>
            <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
            <span class="proto-start__label">${working ? html`<${Spinner} size="sm" />` : null}${label}</span>
            <span class="proto-start__deco" aria-hidden="true"></span>
          </button>
        </div>
      </section>
    </div>
    ${busy === 'create' ? html`<${JoinLine} text=${roomMode === 'solo' ? t('正在进入模拟') : t('正在建立同盟')} />` : null}
  </div>`;
}

/**
 * 选择同盟方式 (the design's screen after 同盟模拟): the radar at the left (ui/matchFlow.js), 创建同盟 (a room at the
 * remembered difficulty — it is changed in the room) and 加入同盟 (the key field, 观战, recent keys) at the right, 多人匹配
 * between them, 入门协议 (玩法说明) at the bottom left. Esc or ‹ returns to the hub.
 */
function AllianceSelect({ onClose, code, onCode, codeOk, recent, online, maint, busy, queued, onCreate, onJoin, onList, onSpectate, onMatch, difficulty }) {
  const [leaving, leave] = useLeave(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal, .guide')) leave(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, []);
  const joining = busy === 'create' ? t('正在建立同盟') : busy === 'join' ? t('正在加入同盟') : busy === 'spectate' ? t('正在进入观战') : null;
  return html`<div class=${`proto ally${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label=${t('选择同盟方式')}>
    <div class="proto__bg ally__bg" aria-hidden="true"></div>
    <header class="proto-top">
      <button type="button" class="proto-back" onClick=${leave} title=${t('返回大厅 (Esc)')} aria-label=${t('返回大厅')}>
        <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
      </button>
      <div class="proto-title"><h2>${t('选择同盟方式')}</h2><span class="proto-title__mode ally__mode">${t('同盟模拟')}<i>ALLIANCE SIMULATION</i></span></div>
    </header>
    <div class="proto-body ally-body">
      <section class="ally-stage"><${RadarScene} />
        <button type="button" class="ally-guide" onClick=${() => openGuide(0)}><span class="ally-guide__icon"><${Icon} name="book" /></span>${t('入门协议')}</button>
      </section>
      <section class="ally-side">
        <button type="button" class="ally-card ally-card--create" disabled=${!online || maint || queued || busy === 'create'} data-testid="alliance-create" onClick=${onCreate}>
          <span class="ally-card__art"><${CreateArt} /></span>
          <span class="ally-card__bar"><span class="ally-card__icon"><${Icon} name="plus" /></span>${maint ? t('维护中 · 暂停开局') : t('创建同盟')}
            ${busy === 'create' ? html`<${Spinner} size="sm" />` : html`<small>${t('难度：{name}（可在同盟内更改）', { name: t(DIFFICULTY_NAMES[difficulty]) })}</small>`}</span>
        </button>
        <div class="ally-links">
          <button type="button" class="ally-pill" data-testid="room-list-open" onClick=${onList}><${Icon} name="users" />${t('公开同盟')}</button>
          <button type="button" class="ally-pill" onClick=${onMatch}><${Icon} name="search" />${queued ? t('匹配中') : t('多人匹配')}</button>
        </div>
        <div class="ally-card ally-card--join">
          <span class="ally-card__art"><${JoinArt} /></span>
          <label class="ally-key"><${Icon} name="search" />
            <input type="text" value=${code} placeholder=${t('输入同盟密钥')} maxlength="64" autocomplete="off" spellcheck="false"
              onInput=${(e) => onCode(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') onJoin(); }} />
            ${codeOk ? html`<button type="button" class="ally-key__spec" disabled=${!online || queued || busy === 'spectate'} onClick=${onSpectate}
              title=${spectateHint()}><${Icon} name="eye" />${t('观战')}</button>` : null}
          </label>
          ${recent.length ? html`<span class="ally-recent">${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')} onClick=${() => onCode(c)}>${c}</button>`)}</span>` : null}
          <button type="button" class="ally-card__bar ally-card__bar--join" disabled=${!codeOk || !online || queued || busy === 'join'} onClick=${() => onJoin()}>
            <span class="ally-card__icon"><${Icon} name="users" /></span>${t('加入同盟')}${busy === 'join' ? html`<${Spinner} size="sm" />` : null}
          </button>
          <span class="ally-note t-dim">${t('开局后仍可使用原同盟密钥观战。')}</span>
        </div>
      </section>
    </div>
    ${joining ? html`<${JoinLine} text=${joining} />` : null}
  </div>`;
}

// Mounted on demand. Keep optional announcement I/O here, outside the shared in-match UI data contract.
function LobbyAnnouncements({ snapshot, onClose }) {
  useData('announcements');
  const status = data.status('announcements');
  const ready = snapshot.value === data.get('announcements');
  return html`<${AnnouncementBoard} status=${status === 'ready' && !ready ? 'loading' : status} value=${snapshot.value}
    onRetry=${() => data.invalidate('announcements')} onClose=${onClose} />`;
}

/** The design credit under the feedback group (the owner's request of 2026-10-14). */
// The QQ contact is gone (the owner, 2026-11-16): front-end problems go to the 反馈板 like every other report.
export const UI_CREDIT = Object.freeze({ author: '雨千代chiyo', site: 'Bilibili' }); // i18n-ignore: a person's name

function DesignCredit() {
  return html`<p class="hub-credit" title=${t('界面设计：{author}（{site}）', UI_CREDIT)}>
    ${t('界面设计')} <b>${UI_CREDIT.site}@${UI_CREDIT.author}</b>
  </p>`;
}

/**
 * The fan-work notice, the project repository — this fork's, not upstream's (the owner, 2026-11-16) — and the version
 * (the title screen's footer until 2026-10-15). Upstream 0.4.0's 更新说明 (#603) is not taken (the owner, 2026-11-15):
 * updates are announced on the 公告板.
 */
function HubFoot() {
  return html`<p class="hub-credit hub-foot">
    <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span><span class="hub-credit__sep" aria-hidden="true">·</span><a class="hub-repo" href="https://github.com/Stardust-minus/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">${t('项目仓库')}</a><span class="hub-credit__sep" aria-hidden="true">·</span><span class="num">v${APP_VERSION}</span>
    ${DEV_BUILD ? html`<span class="hub-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
  </p>`;
}

/** The top bar's name chip: the trophy badge, the name, DOCTOR #; opens 统计数据. */
function MeChip({ me }) {
  const card = useMyCard();
  useData('assets');
  const face = cardAvatarUrl(card.avatar, undefined, card.avatarLook);
  const label = t('统计数据');
  return html`<button type="button" class="me-chip me-chip--btn stats-entry" onClick=${openStats} title=${label} aria-label=${label}>
    <${AvatarFrame} size="sm" name=${me.name} src=${face} seat=${0} self=${true}
      live=${html`<${CardAvatarLive} m=${data.get('assets')} avatar=${card.avatar} look=${card.avatarLook || ''} />`} />
    <span class="me-chip__text">
      <span class="me-chip__name"><${TrophyBadge} count=${card.trophies} class="tbadge--inline" />${me.name || t('博士')}</span>
      <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
    </span>
    <${Icon} name="chart" class="me-chip__stats" />
  </button>`;
}

/**
 * The emblem in its radar and the title. With the 规程 theme (大厅背景 → 规程, `look`), upstream 0.4.0's: the official
 * raised-fist season logo in the radar (the dot emblem without the local-client art) in every version; in 规程 also the
 * glowing РЕГЛАМЕНТ wordmark and the official 「卫戍协议【规程】」 title art in a Chinese script (elsewhere the title as text in
 * the same red brackets); a 盟约 version keeps its own words, set in the brackets.
 * @param {{ bg: any, look: boolean, reg: boolean, version: string }} props
 */
function HubTitle({ bg, look, reg, version }) {
  useData('local');
  const title = reg ? t('卫戍协议·规程') : t('卫戍协议：盟约');
  const ver = version !== DEFAULT_VERSION ? html`<div class="hub-center__ver" data-testid="hub-version">${versionLabel(version)}</div>` : null;
  if (!look) {
    return html`<div class="hub-center">
      <div class="hub-center__mark"><${HubRadar} bg=${bg} /><${Emblem} /></div>
      <div class="hub-center__en">STRONGHOLD PROTOCOL <b>${reg ? 'REGULATION' : 'ALLIANCE'}</b></div>
      <h1 class="hub-center__title">${title}</h1>
      ${ver}
    </div>`;
  }
  const art = (name) => localAsset(REGULATION_ART, name);
  const logo = art('entry_anim_season_logo') || art('entry_anim_season_logo_2');
  const word = reg ? art('entry_anim_season_logo_text_2') : null;
  const lockup = reg && scriptOf(t('卫戍协议')) !== 'alphabetic' && /^zh/i.test(document.documentElement.lang || 'zh') ? art('common_title') : null;
  return html`<div class="hub-center hub-center--reg">
    <div class="hub-center__mark"><${HubRadar} bg=${bg} />${logo ? html`<img class="hub-center__logo hub-center__fist" src=${logo} alt="" />` : html`<${Emblem} />`}</div>
    ${!reg ? html`<div class="hub-center__en">STRONGHOLD PROTOCOL <b>ALLIANCE</b></div>`
      : word ? html`<img class="hub-reg__word" src=${word} alt="РЕГЛАМЕНТ · STRONGHOLD PROTOCOL REGULATION" />`
      : html`<div class="hub-reg__wordtext" lang="ru">РЕГЛАМЕНТ</div>`}
    ${lockup ? html`<h1 class="hub-reg__lockup"><img src=${lockup} alt=${title} /></h1>`
      : html`<h1 class="hub-center__title hub-reg__title"><span class="hub-reg__brk" aria-hidden="true">[</span>${title}<span class="hub-reg__brk" aria-hidden="true">]</span></h1>`}
    ${ver}
  </div>`;
}

// the entry film (main.js → ui/entryFilm.js) is over for this page: the lobby's announcement board may open
let filmOver = false;
/**
 * False until this page's entry film is over — main.js's `__SP__.entryFilm` has settled (its overlay is up by then, or
 * none comes this page load) and the overlay (`.spa-entry`, a top-layer <dialog>) is gone — so the announcement board
 * never opens over the film; true at once afterwards (a later visit to the lobby does not wait).
 */
function useEntryFilmOver() {
  const [over, setOver] = useState(filmOver);
  useEffect(() => {
    if (over) return undefined;
    let live = true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      // main.js sets __SP__ right after the first render
      for (let i = 0; i < 100 && !globalThis.__SP__; i++) await sleep(50);
      try { await globalThis.__SP__?.entryFilm; } catch { /* no film */ }
      while (live && document.querySelector('.spa-entry')) await sleep(150);
      if (!live) return;
      filmOver = true;
      setOver(true);
    })();
    return () => { live = false; };
  }, []);
  return over;
}

/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const presence = useStore((s) => s.presence, shallowEqual);
  useData('config', 'announcements');
  const queue = useStore((s) => s.queue);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  const queued = queueActive(queue);
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [overlay, setOverlay] = useState(null); // 'announcements'
  const [loadOpen, setLoadOpen] = useState(false);
  // the open service dialog keeps the whole cluster summary on every pong (server/net.js CLUSTER_LOAD_EVERY_MS)
  useEffect(() => { net.watchClusterLoad?.(loadOpen); return () => net.watchClusterLoad?.(false); }, [loadOpen]);
  const [announcements, setAnnouncements] = useState({ value: null, revision: null });
  const noticeStatus = data.status('announcements'), noticeValue = data.get('announcements');
  const [recent] = useState(recentRooms);
  const [soloFree, setSoloFree] = useState(() => loadPref('lobby.soloUnlimited', false) === true);
  // a laddered version's solo mode (规程: 极速模拟 / 规程等级 n), remembered; the version's data decides what is shown
  const [ladderMode, setLadderMode] = useState(() => { const v = loadPref('lobby.ladderMode', null); return typeof v === 'string' ? v : null; });
  const [matchPicks, setMatchPicks] = useState(() => {
    const saved = loadPref('lobby.matchDifficulties', []);
    return Array.isArray(saved) ? saved.filter((d) => DIFFICULTIES.includes(d)) : [];
  });
  const [matchRange, setMatchRange] = useState(() => matchScope(loadPref('lobby.matchScope', MATCH_SCOPE_DEFAULT)));
  // 多人匹配's own experimental options (ui/matchmaking.js header), remembered; offered while the server takes them
  const [matchOpts, setMatchOpts] = useState(() => matchConfig(loadPref('lobby.matchExperimental', null)));
  const [optsOpen, setOptsOpen] = useState(false);
  const takesCustom = useStore(queueTakesCustom);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';
  const codeOk = CODE_RE.test(code);
  // the server's maintenance switch (presence.state, server/lobby.js): no new rooms, matches or queue tickets
  const maint = online && presence?.maintenance === true;
  const banner = maint ? t('服务器即将维护，暂停开启新的模拟') : announcementBanner(noticeValue);
  const bg = useHubBackdrop();
  const [bgOpen, setBgOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [achOpen, setAchOpen] = useState(false);
  // official versions (DESIGN §35.23): the lobby's version, the difficulties it offers and the one shown — the remembered
  // one, or the server's fallback when the version lacks it (the pref is only overwritten when the player picks)
  const versions = useStore((s) => s.versions);
  const version = useStore(lobbyVersion);
  const versionLoading = useStore((c) => version !== DEFAULT_VERSION && (c.kind !== 'version' || c.version !== version || c.status !== 'ready'), Object.is, contentSet);
  // its set failed to load or its check (the chip's 重试 sits under the dialog): 选择模拟协议 says so and offers 重试 too
  const versionFailed = useStore((c) => version !== DEFAULT_VERSION && c.kind === 'version' && c.version === version && c.status === 'failed', Object.is, contentSet);
  const cfg = getConfig();
  // null while that version's data is not on screen: the dialog hides the switch
  const soloTimed = soloTimedOf(versionLoading ? null : cfg, version);
  const solo = offeredDifficulties(versionLoading ? null : cfg, 'solo');
  const coop = offeredDifficulties(versionLoading ? null : cfg, 'coop');
  const shownSolo = fallbackDifficulty(solo, difficulty);
  const shownCoop = fallbackDifficulty(coop, difficulty);
  const ladder = ladderModes(versionLoading ? null : cfg, 'solo');
  const shownMode = ladder ? ladderPick(ladder, ladderMode, shownSolo) : null;

  useEffect(() => {
    // Optional low-frequency checks exist only while the lobby is mounted, never during a match.
    const refresh = () => {
      if (document.visibilityState === 'hidden' || data.status('announcements') === 'loading') return;
      if (data.status('announcements') === 'ready' || data.status('announcements') === 'missing') data.invalidate('announcements');
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    if (noticeStatus !== 'ready') return undefined;
    let current = true;
    announcementRevision(noticeValue).then(revision => {
      if (current && data.status('announcements') === 'ready' && data.get('announcements') === noticeValue) {
        setAnnouncements({ value: noticeValue, revision });
      }
    });
    return () => { current = false; };
  }, [noticeStatus, noticeValue]);
  // the board opens by itself once the entry film is over (never over it)
  const filmDone = useEntryFilmOver();
  useEffect(() => {
    if (filmDone && online && !queued && !busy && !pendingJoin && overlay == null && announcements.revision && !announcementDismissed(announcements.revision)) setOverlay('announcements');
  }, [filmDone, online, queued, busy, pendingJoin, overlay, announcements.revision]);
  const closeAnnouncements = () => { dismissAnnouncement(announcements.revision); setOverlay(null); };
  const unread = !!announcements.revision && !announcementDismissed(announcements.revision);

  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };
  const pickMode = (id) => { setLadderMode(id); savePref('lobby.ladderMode', id); };
  const setSoloFreePref = (on) => { const next = on === true; setSoloFree(next); savePref('lobby.soloUnlimited', next); };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  // hub screens: 选择模拟协议 of 独立模拟 / 多人匹配, 选择同盟方式, 密钥加入
  const [sheet, setSheet] = useState(null);                // null | 'solo' | 'match'
  const sheetSeq = useRef(0);                               // counts the sheet's changes and closings (queueMatch)
  useEffect(() => { sheetSeq.current += 1; }, [sheet]);
  const [sheetChained, setSheetChained] = useState(false); // opened from 选择同盟方式: no darkening of the hub between
  const [allyOpen, setAllyOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);          // 公开同盟, over 选择同盟方式 (ui/roomList.js)
  const [joinOpen, setJoinOpen] = useState(false);
  // `version`: the lobby's, only when welcome.versions is present (protocol §4; omitted when the server offers 第二期下半 alone)
  const create = (roomMode) => run('create', () => net.request('room.create', {
    mode: roomMode, difficulty: roomMode === 'solo' ? shownSolo : shownCoop, ...(versions ? { version } : {}),
    ...(roomMode === 'solo' && soloFree && soloTimed === true ? { soloUnlimited: true } : {}),
    // a laddered version's solo (规程): the official mode picked in 选择模拟协议 (server/lobby.js ladderMode)
    ...(roomMode === 'solo' && shownMode ? { modeId: shownMode } : {}),
  }));
  // 多人匹配 waits in every picked difficulty (feedback #87) the lobby version's co-op offers (the header: its pool); the
  // picture shows the one pressed last, and it is the first
  const offeredPicks = matchPicks.filter((d) => coop.includes(d));
  const picks = offeredPicks.length ? offeredPicks : [shownCoop];
  const matchFocus = picks.includes(difficulty) ? difficulty : picks[picks.length - 1];
  const pressPick = (x) => {
    const next = toggleMatchPick(picks, x);
    setMatchPicks(next);
    savePref('lobby.matchDifficulties', next);
    if (next.includes(x)) pickDifficulty(x);
    else if (x === matchFocus) pickDifficulty(next[next.length - 1]);
  };
  const pressScope = (axis, value) => {
    const next = toggleMatchScope(matchRange, axis, value);
    setMatchRange(next);
    savePref('lobby.matchScope', next);
    // 我的实验性 turned on with nothing set: its options open at once
    if (axis === 'rules' && value === 'custom' && next.rules.includes('custom') && !experimentalItems(matchOpts, { queue: true }).length) setOptsOpen(true);
  };
  const putMatchOpts = (next) => { const v = matchConfig(next); setMatchOpts(v); savePref('lobby.matchExperimental', v); };
  // the scope as this server takes it: without 'custom' (an older server) 我的实验性 is neither shown nor sent
  const shownRange = takesCustom ? matchRange : (() => { const rules = matchRange.rules.filter((r) => r !== 'custom'); return { ...matchRange, rules: rules.length ? rules : ['standard'] }; })();
  const own = takesCustom ? { value: matchOpts, count: experimentalItems(matchOpts, { queue: true }).length, problem: customProblem(shownRange, matchOpts),
    editing: optsOpen, onEdit: () => setOptsOpen(true), onDone: () => setOptsOpen(false), onChange: putMatchOpts } : null;
  // the pool of the lobby's version (welcome.versions present: protocol `version`; without it 第二期下半's, as before)
  // 多人匹配's version (the owner, 2026-11-16: 「多人匹配界面可以切换匹配的版本」): the pool's chip opens the version picker
  // when there is more than one; a pick is the lobby's version (setLobbyVersion), whose difficulties and data follow
  const [verOpen, setVerOpen] = useState(false);
  const serverDefault = useStore(serverDefaultVersion);
  const pool = versions ? { label: versionLabel(version), off: !versionQueueable({ versions }, version),
    onPick: versions.length > 1 && !queued ? () => setVerOpen(true) : null } : null;
  // (opening 多人匹配 makes the page send its settings again, which share the server's budget of heavy messages with
  // queue.join: a RATE right after them is tried once more a moment later, as room.js proposeVersion does — not when the
  // sheet closed or the lobby left meanwhile; a second RATE is told)
  const queueMatch = () => run('queue', async () => {
    const send = () => net.request('queue.join', { difficulty: matchFocus, ...(picks.length > 1 ? { difficulties: picks } : {}),
      ...matchScopeRequest(shownRange, matchOpts, takesCustom), ...(versions ? { version } : {}) });
    const seq = sheetSeq.current;
    try {
      try { await send(); } catch (err) {
        if (err?.code !== ERR.RATE) throw err;
        await new Promise((r) => setTimeout(r, QUEUE_RETRY_MS));
        if (!alive.current || sheetSeq.current !== seq) return;
        await send();
      }
    } catch (err) {
      // a version this server cannot queue right now (its data, its match host): say which, not the room's wording
      if (err?.code === ERR.VERSION_UNSUPPORTED || err?.code === ERR.VERSION_UNKNOWN) { toast(t('「{version}」暂不开放多人匹配', { version: versionLabel(version) }), 'warn'); return; }
      throw err;
    }
  });
  // an offer while the hub shows: 选择模拟协议 comes up with 确认入场 (the 30-second window must not go unseen)
  useEffect(() => { if (queue?.state === 'offered' && sheet !== 'match') { setAllyOpen(false); setSheetChained(false); setSheet('match'); } }, [queue?.state]);
  const join = (c = code) => {
    if (queued) { toast(t('请先取消多人匹配，再加入好友同盟'), 'warn'); return; }
    // Click callbacks may pass an event; only an explicit string overrides the typed key.
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('join', () => joinRoom(k));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    if (queued) { toast(t('请先取消多人匹配，再进入观战席'), 'warn'); return; }
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Keep a missing or already-joined room distinct from a generic network error.
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(t('没有找到密钥 {k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）', { k }), 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast(t('你已经是该同盟的博士：先离开同盟，才能以观战身份进入'), 'warn');
        return;
      }
      throw err;
    }));
  };
  const rename = () => {
    if (queued) { toast(t('请先取消多人匹配再修改代号'), 'warn'); return; }
    openNameDialog();
  };
  const openSolo = () => { if (queued) { toast(t('请先取消多人匹配'), 'warn'); return; } savePref('lobby.mode', 'solo'); setSheetChained(false); setSheet('solo'); };
  const openAlly = () => { savePref('lobby.mode', 'coop'); setAllyOpen(true); };
  const openMatch = () => { savePref('lobby.mode', 'match'); setSheetChained(allyOpen); setAllyOpen(false); setSheet('match'); };
  const sheetCard = MODE_CARDS.find((c) => c.id === sheet) || MODE_CARDS[0];
  const cancelling = useStore((s) => s.ui.queueCancel);
  // the lobby version's season: 规程 renames the title (卫戍协议·规程); the 规程 theme (大厅背景) is the red look in every
  // version (`data-look`, see the header)
  const season = seasonOf(version);
  const reg = season === REGULATION_SEASON;
  const look = regulationLook(bg.pref);

  return html`<div class="screen lobby-screen lobby-hub" data-hub-theme=${backdropTheme(bg)} data-season=${season} data-look=${look ? 'regulation' : undefined}>
    <${HubBackdrop} bg=${bg} />
    <header class="topbar hub-topbar">
      <div class="topbar__left">
        <${PingPill} ms=${conn.ping} online=${conn.status === 'online'} status=${conn.status} loadState=${conn.loadState ?? 'unknown'} loadDetails=${conn.loadDetails}
          clusterLoad=${conn.clusterLoad} loadOpen=${loadOpen} onLoadClick=${() => setLoadOpen(true)} />
        <span class="topbar__sep" aria-hidden="true"></span>
        <div class="topbar__tools">
          <${NoticesButton} />
          <${SettingsButton} class="lobby-settings" variant="secondary" square=${true} />
          <${GuideButton} class="lobby-guide" variant="secondary" square=${true} />
          <${Button} variant="secondary" size="sm" square=${true} class="hub-bg-btn" onClick=${() => setBgOpen(true)}
            title=${t('大厅背景')} aria-label=${t('大厅背景')}><${BackdropGlyph} /><//>
          <${HubFullscreenButton} />
          <${LobbyMusicButton} />
          <${PwaInstallButton} class="lobby-pwa" square=${true} />
        </div>
      </div>
      <div class="topbar__right">
        <span class="hub-online" title=${t('按已连接的玩家会话计数，不含机器人、离线保留局和未进入的连接；不等于去重自然人数。')}>
          <span class="online-pill__dot"></span>${Number.isInteger(presence?.online) && conn.status === 'online'
            ? html`<span class="num">${presence.online}</span><span class="online-word">${t('名博士在线')}</span>` : html`<span>${t('在线人数 —')}</span>`}</span>
        <${VersionSwitch} />
        <${ResumeMatchButton} />
        <${Button} variant="secondary" size="sm" square=${true} icon="edit" class="me-rename" onClick=${rename} title=${t('修改博士代号')} aria-label=${t('修改博士代号')} />
        <${MeChip} me=${me} />
      </div>
    </header>

    <main class="hub-stage">
      <${HubTitle} bg=${bg} look=${look} reg=${reg} version=${version} />

      <aside class="hub-side">
        <${AchievementEntry} onOpen=${() => setAchOpen(true)} />
        <${HubTile} icon="key" label=${t('密钥加入')} en="JOIN WITH KEY" onClick=${() => setJoinOpen(true)} />
        <${TipsPanel} />
        <div class="hub-contact"><div class="hub-contact__row"><${SiteBoards} /></div><${DesignCredit} /><${HubFoot} /></div>
      </aside>

      <aside class="hub-right">
        <${NoticeCard} value=${noticeValue} status=${noticeStatus} unread=${unread} onOpen=${() => setOverlay('announcements')} />
        <div class="hub-right__plates">
          <${SweepPlate} onClick=${() => setSweepOpen(true)} />
          <${LoadoutButton} from="lobby" size="lg" class="hub-plate hub-plate--loadout" label=${t('干员调配')} />
        </div>
      </aside>

      <section class="hub-entries" aria-label=${t('模拟方式')}>
        ${queued && sheet !== 'match' ? html`<div class="matchmaking-hud brackets hub-searching" role="status">
            <div class="matchmaking-hud__info">
              <${Spinner} size="sm" />
              <span class="matchmaking-hud__text">${queue.state === 'offered' ? t('队友已集结，请确认入场') : t('正在匹配同盟')} · ${[versions ? versionLabel(queueVersion(queue)) : null, (queueDifficulties(queue) || [queue.difficulty]).map((x) => t(DIFFICULTY_NAMES[x] || '')).join(' / '), queueScope(queue)?.seats, queueScope(queue)?.rules].filter(Boolean).join(' · ')}</span>
            </div>
            <${Button} variant="secondary" size="md" onClick=${openMatch}>${t('查看')}<//>
            <${Button} variant="danger" size="md" loading=${cancelling?.ticketId === queue.ticketId && cancelling?.status !== 'idle' && cancelling?.status !== 'failed'}
              onClick=${() => queueCancellation.cancel(queue.ticketId)}>${t('取消匹配')}<//>
          </div>` : null}
        ${banner ? html`<div class="hub-maint" role="status">${banner}</div>` : null}
        <div class="hub-entries__row">
          <${HubEntry} mode="solo" group=${{ icon: 'user', label: t('独立模拟') }} name=${t('独立模拟')} en="SOLO" icon="user" onClick=${openSolo} />
          <${HubEntry} mode="coop" group=${{ icon: 'users', label: t('同盟模拟') }} name=${t('同盟模拟')} en="ALLIANCE" icon="users" onClick=${openAlly} />
          <${HubEntry} mode="match" name=${t('多人匹配')} en="MATCHMAKING" icon="search" tone="bright" onClick=${openMatch}
            note=${queued ? html`<span class="num">${t('匹配中')}</span>` : null} />
        </div>
      </section>
    </main>

    ${sheet ? html`<${ProtocolSelect} card=${sheetCard} purpose=${sheet === 'match' ? 'match' : 'create'} difficulty=${sheet === 'match' ? matchFocus : shownSolo}
      picks=${sheet === 'match' ? picks : null} onPick=${pressPick} scope=${sheet === 'match' ? shownRange : null} onScope=${pressScope} own=${sheet === 'match' ? own : null}
      onDifficulty=${pickDifficulty} onClose=${() => setSheet(null)} online=${online} maint=${maint} busy=${busy} queue=${queue}
      difficulties=${sheet === 'match' ? coop : solo} loading=${versionLoading} failed=${versionFailed} pool=${sheet === 'match' ? pool : null}
      soloTime=${sheet !== 'match' && soloTimed === true ? { on: soloFree, onToggle: setSoloFreePref } : null}
      ladder=${sheet === 'match' ? null : ladder} modeId=${sheet === 'match' ? null : shownMode} onMode=${pickMode} season=${sheet === 'match' ? null : season} look=${look}
      onCreate=${() => create('solo')} onQueue=${queueMatch} chained=${sheetChained} onLeaving=${() => { sheetSeq.current += 1; }} />` : null}

    ${allyOpen ? html`<${AllianceSelect} onClose=${() => setAllyOpen(false)} code=${code} onCode=${(v) => setCode(normalizeCode(v))} codeOk=${codeOk}
      recent=${recent} online=${online} maint=${maint} busy=${busy} queued=${queued} difficulty=${shownCoop}
      onCreate=${() => create('coop')} onJoin=${() => join()} onList=${() => setListOpen(true)} onSpectate=${() => spectate()} onMatch=${openMatch} />` : null}
    ${verOpen && sheet === 'match' && Array.isArray(versions) && !queued ? html`<${VersionPicker} mode="lobby" versions=${versions} current=${version} serverDefault=${serverDefault} roomMode="coop"
      note=${t('多人匹配只和选择同一版本的博士匹配。切换后大厅也使用该版本，难度列表随版本更新。')}
      onPick=${(id) => { setLobbyVersion(id); setVerOpen(false); }} onClose=${() => setVerOpen(false)} />` : null}
    ${own?.editing && sheet === 'match' && !queued ? html`<${MatchOptionsDialog} value=${own.value} multi=${shownRange.seats.includes('multi')} onChange=${own.onChange} onClose=${own.onDone} />` : null}
    ${listOpen && allyOpen ? html`<${RoomListDialog} online=${online} queued=${queued} busy=${busy} onJoin=${(c) => join(c)} onClose=${() => setListOpen(false)} />` : null}

    <${HubDialog} open=${joinOpen} micro="JOIN WITH ALLIANCE KEY" title=${t('密钥加入')} onClose=${() => setJoinOpen(false)}>
      <div class="join-row">
        <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
          transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
      </div>
      <div class="join-row hub-join__buttons">
        <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online || queued || !!busy} onClick=${() => join()}>${t('加入同盟')}<//>
        <${Tooltip} text=${spectateHint()}>
          <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online || queued || !!busy} onClick=${spectate}>${t('观战')}<//>
        <//>
      </div>
      <div class="join-foot">
        ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
          ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
            onClick=${() => setCode(c)}>${c}</button>`)}`
          : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
        <span class="join-foot__note t-dim">${t('开局后仍可使用原同盟密钥观战。')}</span>
      </div>
    <//>

    <${HubDialog} open=${bgOpen} micro="LOBBY BACKDROP" title=${t('大厅背景')} onClose=${() => setBgOpen(false)}>
      <${BackdropSettings} bg=${bg} />
    <//>

    <${ServerStatusModal} open=${loadOpen} online=${conn.status === 'online'} state=${conn.loadState} details=${conn.loadDetails} clusterLoad=${conn.clusterLoad} onClose=${() => setLoadOpen(false)} />
    ${overlay === 'announcements' ? html`<${LobbyAnnouncements} snapshot=${announcements} onClose=${closeAnnouncements} />` : null}
    ${achOpen ? html`<${AchievementPanel} me=${me} onClose=${() => setAchOpen(false)} />` : null}
    ${sweepOpen ? html`<${SweepReport} onClose=${() => setSweepOpen(false)} />` : null}
  </div>`;
}

