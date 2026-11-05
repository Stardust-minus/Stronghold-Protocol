// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes; no title screen — the nickname: ui/nickname.js):
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has a name and the
// session is online (after a short grace period in case the server restores a room on resume).
// Boot connects with the remembered nickname (the gate's callsign; a first visit: 博士 + four digits) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.
// Cosmetic plugins (DESIGN §32 P1a): installContent (content.js) lays the room's visual set and the player's personal
// plugins over the art manifest every screen reads. Gameplay plugins (§32.6): installContentSet (content.js) downloads and
// checks a room's content set and makes it the data every screen and the battle runner read.
// Official versions (DESIGN §35.23, versions.js): welcome.versions turns the lobby's version switch on; installContentSet
// also loads and checks the version the page shows (the lobby's choice, a room's version). A room whose version changes
// while a result is on screen drops that result (the server dropped the room's replay: its chess ids are the old
// version's), and a result that arrives after the room is gone keeps the version its frames name (m.result / m.public
// `version`, versions.js matchFrameVersion), also on a freshly loaded page that never saw the room.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { render } from '../vendor/preact.module.js';
import { useEffect, useErrorBoundary } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs, confirmDialog } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { MatchNotice, matchNoticeText, replayingRound, MATCH_NOTICE_REFRESH_MS } from './ui/matchNotice.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { applyLikes, likedToast } from './ui/likes.js';
import { net, identity, NetError } from './net.js';
import { createAuthProbe } from './authProbe.js';
import './queueCancellation.js';
import { store, useStore, emptyMatch, selectRoute, sessionResetNotice, isSpectating } from './store.js';
import { data, useData } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { NameHost, sanitizeName, defaultName } from './ui/nickname.js';
import { LobbyScreen, rememberRoom, parseRoomParam, joinRoom } from './screens/lobby.js';
import { RoomScreen, TrustedNotice } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { preloadBootArt } from './ui/protocolBoot.js';
import { audio, installAudio } from './audio.js';
import { roomCue, cueGate } from './ui/roomCues.js';
import { settingsStore } from './ui/settings.js';
import { matchMusic } from './ui/lobbyMusic.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport, useFullscreen, useScreenWakeLock } from './ui/device.js';
import { isCombatPhase } from './ui/gameLogic/phases.js';
import { registerImportedAssetWorker } from './assetCache.js';
import { installAssetHints } from './ui/assetSection.js';
import { codeSource } from './codeSource.js';
import { LoadoutHost } from './screens/loadout.js';
import { StatsHost, useStatsOpen } from './screens/stats.js';
import { CoveredVersionVote } from './ui/versionVote.js';
import { installRehearsal } from './battle/rehearsal.js';
import { recordResult, recordQuit, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync, installSkinsSync, installPlayerCardSync, installSettingsViews, loadoutStore } from './ui/loadoutSync.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { acceptDamageSnapshot } from './ui/damageBoard.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';
import { recordError, installTrafficMeter } from './diag.js';
import { installContent, installContentSet } from './content.js';
import { cosmetics } from './cosmetics.js';
import { sanitizeVersions, roomVersion, isDefaultVersion, matchFrameVersion } from './versions.js';
import { prediction } from './ui/prediction.js';

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
/** The gap between the hellos that ask again for a shared seat after SESSION_IN_USE (identity.retryClaim). */
const CLAIM_RETRY_GAP_MS = 5000;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

const SCREENS = { lobby: LobbyScreen, room: RoomScreen, game: GameScreen };

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
let claimRetryTimer = null;
let claimRetrying = false;
const authProbe = createAuthProbe({
  ask: () => confirmDialog({
    title: t('登录已失效'),
    text: t('登录已过期，无法连接服务器。重新登录后会自动回到当前对局。'),
    okText: t('重新登录'),
    cancelText: t('取消'),
    micro: 'SIGN-IN EXPIRED',
  }),
});
/** The rehearsal installer (battle/rehearsal.js): its tasks follow the match on screen (see wireNet's store hook). */
let rehearsal = null;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !s.session.entered || net.status !== 'online') return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      await joinRoom(code);
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  identity.rememberMatch(null);
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [] });
  store.patch('ui', { restoring: false, resumed: false });
}

/** The unofficial plugins a server counts in welcome / /healthz `content.plugins` (absent: none — DESIGN §32 P1a). */
const pluginCount = (content) => (content && Number.isInteger(content.plugins) && content.plugins > 0 ? content.plugins : 0);

// the first room state after a welcome re-sends the room as it was (reconnect / restored page): no room cue for it
let roomCueQuiet = false;
const roomCueGate = cueGate();

function onWelcome(msg) {
  roomCueQuiet = true;
  clearTimeout(claimRetryTimer);
  claimRetryTimer = null;
  claimRetrying = false;
  authProbe.onWelcome();
  identity.saveToken(msg.token);
  identity.rememberMatch(null);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  if (name) {
    identity.saveName(name);
    try { localStorage.setItem('ark.callsign', name); } catch { /* storage may be unavailable */ }
  }
  store.set({
    me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null, ...(msg.owner === true ? { owner: true } : {}) },
    // the server's content identity (DESIGN §32): the diagnostics name it (diag.js contentLine)
    content: msg.content && typeof msg.content.vanilla === 'string' ? { vanilla: msg.content.vanilla } : null,
    // how many unofficial plugins it has (P1a — absent: none; content.js fetches the catalogue only when there are some)
    installedPlugins: pluginCount(msg.content),
    installedNotices: msg.content?.notices === true,
    testMode: msg.testMode === true,
    // the official versions the server enables (protocol §2; absent: the switch is off — versions.js)
    versions: sanitizeVersions(msg.versions),
  });
  welcomeAt = Date.now();
  // The server rebound this tab's session: until its match state (or a room outside a match) arrives, a match screen
  // still loading is a match being restored after a server restart (ui/gameLoading.js 正在恢复对局…).
  store.patch('ui', { resumed: msg.resumed === true });
  // A retained ticket is not a fresh population sample from this new socket.
  if (Object.hasOwn(prev.queue || {}, 'waitingCount')) store.set({ queue: { ...prev.queue, waitingCount: undefined } });

  if (msg.takeoverFrom === prevId && prevId != null) {
    toast(t('你已接替 AI 席位，资金与阵容已保留'), 'info');
  } else if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    store.set({ queue: { state: 'idle', ticketId: null }, presence: null });
    if (notice) toast(t(notice), 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  schedulePendingJoin();
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectating(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  const cue = roomCue(prevRoom, room, myId, { quiet: roomCueQuiet });
  roomCueQuiet = false;
  if (cue && roomCueGate(cue)) audio.sfx(cue, { volume: 0.7 });
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  // The room switched its version (DESIGN §35.23): a result still on screen (a settlement, a spectator's view) names the old
  // version's chess ids, and the server dropped the room's replay — it closes, back to the room.
  else if (prevRoom && prevRoom.code === room.code && !room.inMatch && roomVersion(prevRoom) !== roomVersion(room) && store.get().match.public) store.set({ match: emptyMatch() });
  store.set({ room });
  identity.rememberMatch(room.inMatch && seats.some((seat) => seat?.playerId === myId)
    ? { name: store.get().me.name, code: room.code || '' } : null);
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code);
  if (!room.inMatch && store.get().ui.resumed) store.patch('ui', { resumed: false });
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
  // the match's game node restarted / stopped answering, so its match cannot continue (server/cluster/coordinator.js closeReasonFor)
  'node-restarted': N_('对局服务器已重启，本局模拟已中断'), 'node-unavailable': N_('对局服务器连接中断，本局模拟已结束'),
  // 挂机移出 while offline: the next connection hears it here instead of m.removed (server Match _removeIdle)
  afk: N_('连续多个回合没有任何操作，你已被移出对局'),
};

/**
 * The outcome lines of the match's votes (m.notice): 重刷本局 (setupVote.js) and 投票移出 (kickVote.js) — the vote panels
 * vanish when a vote ends, so its result is told here. [text, toast kind] or null.
 */
const VOTE_NOTICE = {
  rerollPassed: () => [t('重刷投票通过，开局信息已重新随机'), 'success'],
  rerollFailed: (m) => [m.reason === 'timeout' ? t('重刷投票超时，未通过') : t('重刷投票未通过'), 'info'],
  rerollCancelled: () => [t('重刷投票已取消'), 'info'],
  kickPassed: (m) => [t('{name} 已被投票移出对局', { name: typeof m.name === 'string' && m.name ? m.name : t('博士') }), 'info'],
  kickFailed: (m) => [m.reason === 'timeout' ? t('移出投票超时，未通过') : t('移出投票未通过'), 'info'],
  kickCancelled: (m) => [m.reason === 'reconnected' ? t('该玩家已重新连接，移出投票取消') : t('移出投票已取消'), 'info'],
};

function wireNet() {
  net.on('status', (snap) => {
    authProbe.onStatus(snap);
    const cur = store.get().connection;
    store.set({
      ...(snap.status !== 'online' && Object.hasOwn(store.get().queue || {}, 'waitingCount')
        ? { queue: { ...store.get().queue, waitingCount: undefined } } : {}),
      connection: {
        status: snap.status, ping: snap.ping, loadState: snap.loadState ?? 'unknown', loadDetails: snap.loadDetails ?? null, clusterLoad: snap.clusterLoad ?? null, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('presence.state', (msg) => store.set({ presence: payload(msg) }));
  net.on('queue.state', (msg) => store.set({ queue: payload(msg) }));
  net.on('helloError', (err) => {
    if (err.code === 'SESSION_IN_USE') {
      // A shared seat's holder may be a socket the server has not seen drop yet: ask again for a while before giving
      // the seat up for a new identity (identity.retryClaim); the deep-linked join waits for the welcome meanwhile.
      if (identity.retryClaim()) {
        if (!claimRetrying) toast(t('正在恢复上一局…'), 'info', { ttl: CLAIM_RETRY_GAP_MS });
        claimRetrying = true;
        clearTimeout(claimRetryTimer);
        claimRetryTimer = setTimeout(() => { claimRetryTimer = null; net.reconnectNow(net.name); }, CLAIM_RETRY_GAP_MS);
        return;
      }
      claimRetrying = false;
      identity.rejectToken();
    }
    if (err.code === 'NAME_REJECTED') {
      // ui/nickname.js NameHost asks for another name over the screen; room/token stay: correcting a legacy name must
      // not abandon its game
      store.set({ session: { entered: false } });
    }
    if (err.code === 'SERVER_FULL') return; // the connection banner shows it and counts down to the automatic retry
    toastError(err);
  });
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => {
    matchAt = Date.now();
    store.patch('match', { public: payload(msg) });
    if (store.get().ui.resumed) store.patch('ui', { resumed: false });
    maybeFinishRestore();
  });
  // the prep intents still pending are replayed over it (ui/prediction.js; the server's own state when none is)
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: prediction.authoritative(payload(msg)) }); });
  net.on('m.layer', (msg) => {
    const s = store.get();
    if (selectRoute(s) === 'game' && msg.playerId === s.me?.playerId) audio.layerGain(msg.bondId, msg.add);
  });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.damage', (msg) => {
    const s = store.get(), view = s.match.public;
    const damage = acceptDamageSnapshot(s.match.damage, payload(msg), view?.matchId || view?.revival?.matchId);
    if (damage !== s.match.damage) store.patch('match', { damage });
  });
  net.on('m.result', (msg) => {
    const res = payload(msg);
    // a settlement starts without likes (a replay's room.likes follows it)
    store.patch('match', { result: res, likes: null });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    // (`vs`: the room's cosmetic plugins, recorded — such a match still counts as the original game: ui/stats.js)
    // (`content`: the room's content set when it played gameplay plugins — such a match is unofficial: ui/stats.js)
    // (`version`: the official version the match played, DESIGN §35.23 — the room's, or the result's own `version` when
    // it arrives after the room is gone, also to a freshly loaded page; only a non-default one is written)
    const s = store.get();
    const version = s.room ? roomVersion(s.room) : matchFrameVersion({ result: res, public: s.match.public });
    if (s.room?.test !== true && s.match.public?.test !== true) recordResult(res, { myId: s.me.playerId, roomMode: s.room?.mode ?? null, vs: s.room?.content?.vs ?? null, content: s.room?.content ?? null, version: isDefaultVersion(version) ? null : version, now: Date.now() });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  // 挂机移出 (server Match afkRemoveRounds): a human with no real action for N rounds in a row leaves the match like a
  // quitter. The removed player gets m.removed — out of the room too, the run recorded as a quit, back to the lobby —
  // and everyone else m.notice afkRemoved.
  net.on('m.removed', async (msg) => {
    const before = store.get();
    const rounds = Number.isInteger(msg.rounds) && msg.rounds > 0 ? msg.rounds : 2;
    try { await net.request('room.leave', {}); } catch { /* already out of the room */ }
    if (!store.get().match.result) {
      try { recordQuit(before); } catch (err) { console.warn('[stats] quit record failed', err); }
    }
    backToLobby();
    toast(msg.reason === 'afk' ? t('连续 {n} 回合没有任何操作，你已被移出对局', { n: rounds }) : msg.reason === 'kicked' ? t('你掉线期间被队友投票移出了对局') : t('你已被移出对局'), 'warn', { ttl: 10000 });
  });
  net.on('m.notice', (msg) => {
    if (VOTE_NOTICE[msg.kind]) { const n = VOTE_NOTICE[msg.kind](msg); if (n) toast(n[0], n[1], { ttl: 5000 }); return; }
    if (msg.kind !== 'afkRemoved') return;
    const rounds = Number.isInteger(msg.rounds) && msg.rounds > 0 ? msg.rounds : 2;
    toast(t('{name} 连续 {n} 回合没有任何操作，已被移出对局', { name: typeof msg.name === 'string' && msg.name ? msg.name : t('博士'), n: rounds }), 'info', { ttl: 6000 });
  });
  // 点赞 (ui/likes.js): the counts of the settlement on screen, and a toast when the like is mine
  net.on('room.likes', (msg) => {
    const s = store.get();
    const likes = applyLikes(s.match.likes, msg, s.me.playerId);
    if (likes !== s.match.likes) store.patch('match', { likes });
    const text = likedToast(s, msg);
    if (text) toast(text, 'success', { ttl: 3500 });
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // A corrected name (after NAME_REJECTED) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    if (s.session.entered && !prev.session.entered) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    // the match on screen is over (left, closed, kicked, a new session): a rehearsal task of it is dead, and the frame
    // that cancels it may never arrive (a disposed match sends nothing) — the page stops what it is running itself
    if (selectRoute(prev) === 'game' && selectRoute(s) !== 'game') rehearsal?.clear();
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * and the pre-game sprites in the background once the player is in a room — a match is near (the lobby alone never
 * downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  // a room with gameplay plugins: content.js downloads its content set's files instead (DESIGN §32.6). With the art list
  // in, the pre-game sprites (协议启动！ and the 请选择策略 band, ui/protocolBoot.js) start too: a solo player who starts
  // at once and skips through the briefing meets the band draft's first turn with them at hand (§35.18's leftover)
  // Another official version's room (DESIGN §35.23): its version set brings those files (content.js) — the server's
  // default ones would race it; only the art list the sprites need is fetched.
  const go = () => {
    const room = store.get().room;
    if (room?.content?.vanilla === false) return;
    if (typeof room?.version === 'string') { data.load('assets').then(() => preloadBootArt(), () => {}); return; }
    data.loadAll(GAME_FILES).then(() => preloadBootArt(), () => {});
  };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

/**
 * The match route's notice line (ui/matchNotice.js): the optional announcement file is loaded and re-read here, outside
 * the match UI (which waits only for GAME_FILES — ui/gameComponents.js), with the server's maintenance switch.
 */
function MatchNoticeHost() {
  useData('announcements');
  const maintenance = useStore((s) => s.connection.status === 'online' && s.presence?.maintenance === true);
  const replay = useStore((s) => replayingRound(s.match?.public));
  useEffect(() => {
    const timer = setInterval(() => {
      const status = data.status('announcements');
      if (document.visibilityState !== 'hidden' && (status === 'ready' || status === 'missing')) data.invalidate('announcements');
    }, MATCH_NOTICE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return html`<${MatchNotice} text=${matchNoticeText(maintenance ? { maintenance } : null, data.get('announcements'), { replay })} />`;
}

function App() {
  const route = useStore(selectRoute);
  const combatActive = useStore((s) => selectRoute(s) === 'game' && s.room?.inMatch === true
    && !s.match?.result && isCombatPhase(s.match?.public?.phase));
  const fullscreenWakeLock = useStore((s) => s.fullscreenWakeLock, Object.is, settingsStore);
  const fullscreenActive = useFullscreen();
  useScreenWakeLock(combatActive || (fullscreenWakeLock && fullscreenActive));
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  const Screen = SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${route} />`}
    <${TrustedNotice} />
    <${ConnectionBanner} />
    ${route === 'game' ? html`<${MatchNoticeHost} />` : null}
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
    <${StatsHost} />
    <${NameHost} />
    <${VoteOverOverlays} />
  </div>`;
}

/** The room's version vote above 干员调配 / 统计数据 while one covers the room (ui/versionVote.js CoveredVersionVote). */
function VoteOverOverlays() {
  const lo = useStore((s) => !!s.open, Object.is, loadoutStore);
  const st = useStatsOpen();
  return html`<${CoveredVersionVote} covered=${lo || st} />`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

async function boot() {
  installGlobalErrorHandlers();
  // what this page downloads, by category, for the 问题反馈 report's traffic line (diag.js; nothing is sent anywhere)
  installTrafficMeter();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // Hashed art a player imported, and — with the release's material profile (/code-source.json) — the art this page
  // fetches, kept by path across the provider's rotating signed redirects. HTTPS or localhost only; never stops boot.
  void codeSource.get().then((source) => registerImportedAssetWorker(undefined, undefined, source?.material ?? null));
  // a slow material load suggests 设置 → 素材下载 once per session (fork: ui/assetSection.js)
  installAssetHints();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const identityReady = identity.init();

  const pendingJoin = parseRoomParam(location.search);
  const savedName = sanitizeName(identity.loadName());
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered: true },
    ui: { ...s.ui, pendingJoin },
  }));

  wireNet();
  installStatsRecorder(store); // follows the match on screen, so a 放弃模拟 can be recorded (ui/stats.js)
  // the loadout / 干员持有 / 自选 settings by operator, shown for the data on screen (DESIGN §35.23; a v1 store migrates)
  installSettingsViews();
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  installSkinsSync({ net });
  installPlayerCardSync({ net });
  // the room's cosmetic plugins and the player's own over the art manifest (content.js; nothing is fetched without them)
  installContent({ toast });
  // a room with gameplay plugins: its content set downloaded, checked and shown (content.js — DESIGN §32.6)
  installContentSet({ toast });
  // A bot prep's layout rehearsal the server offers this host's browser (DESIGN §14, SP_BOT_REHEARSAL=host on the
  // server): a same-origin module Worker simulates the candidates off the main thread and answers with its pick; a
  // browser that cannot run one answers `error` and the server rehearses itself. Nothing happens while the server
  // does not delegate. A gameplay-plugin room is never offered (the server keeps that rehearsal).
  rehearsal = installRehearsal({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // a cosmetic plugin's sound that will not load falls back like its art (content.js, DESIGN §32 P1a)
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get(),
    onFailed: (url) => cosmetics.fail(url) });
  matchMusic.load(); // the player's 休整期 / 作战 自选曲 files (IndexedDB)
  // …and the music follows the art: the screen's track again when the cosmetic layers change its URLs
  cosmetics.subscribe(() => audio.refreshBgm());
  data.load('assets').catch(() => {});
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  // the language (and its UI translations) before the first render: no Chinese flash for an English player
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  const connectWhenReady = Promise.all([identityReady, langReady]).then(() => {
    // a first visit (no gate callsign, nothing remembered): 博士 + four digits in the chosen language; ✎ renames
    const name = savedName || defaultName();
    if (!savedName) {
      identity.saveName(name);
      store.set((s) => ({ me: { ...s.me, name } }));
    }
    net.setName(name);
  });
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = { store, net, data, version: 1 };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/client-build` (not private health). Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
      // a body that names the server's plugins (`content`, as /healthz does) updates their count and whether any has a
      // notice; /client-build carries only { build }, which says nothing about plugins: what welcome gave stays
      onHealth: (h) => {
        if (!h?.content || typeof h.content !== 'object') return;
        const n = pluginCount(h.content), notices = h.content.notices === true;
        if (n !== store.get().installedPlugins || notices !== store.get().installedNotices) store.set({ installedPlugins: n, installedNotices: notices });
      },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
