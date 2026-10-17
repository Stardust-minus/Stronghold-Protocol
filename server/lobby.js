// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.setAiPicksLast, room.setBotBand, room.addBot, room.removeBot, room.kick,
//     room.start. ▸ Changing the difficulty, the AI-picks-last option or an AI seat's strategy (co-op only) un-readies
//     the other humans. ▸ room.start requires every other human to be connected and ready; the host's start counts as
//     the host's ready (the host may still toggle room.ready for display).
//   * room.setBotBand {seat, bandId} (co-op only, before the match): the strategy (BAND_DRAFT band) the AI seat takes,
//     or null = it picks by itself (the default). The band must be one the match's mode offers (checked with the
//     GameData the match builds — roomGameData) and is designated to at most one AI seat (BAD_TARGET). It lives on the
//     AI seat (`seat.band`, room.state seats[].band of every AI seat): removing the AI clears it, the room keeps it for
//     its next matches, and a difficulty / experimental change drops one the new rules no longer offer. The match gets
//     it as seats[].band of that AI seat (Match holds it for that seat in the draft: MatchPhases.bandTaken).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     Co-op (掉线由 AI 接管, the owner's rule of 2026-10-14): a player who drops out of a running match stays resumable
//     the same way while another player of the match is online — the match hands the seat to the AI after
//     OFFLINE_TAKEOVER_ROUNDS and back on the player's return; once no player of the match is online, every dropped
//     one gets the plain window again from that moment, so a match nobody is left in still ends 'abandoned'
//     (refreshMatchWindows).
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, the
//     AI-picks-last option, AI seats and their strategies, start), leave it, or a new match starts. A human removed by
//     the lobby grace gets them right after `room.closed {timeout}` on their next resume (Match.onReconnect cannot do
//     this: the lobby drops the match reference at onEnd and disposes it on the next macrotask).
//   * Optional per-network limits (internet clients only, see net.js clientAddress): positive `maxRoomsPerAddr`
//     and `maxMatchesPerAddr` cap concurrent rooms and running matches (room.create / room.start → ERR.LIMIT;
//     matchmaking allocation → ERR.RATE), positive `maxBotsPerAddr` the AI seats in the rooms charged to a network
//     (room.addBot → ERR.LIMIT; a room is charged to the network that created it, a matchmade one to all of its
//     players' networks). The global `maxRooms` and `maxBots` caps work the same way for everyone. All default to 0
//     (unlimited); the limits file (server/onlineLimit.js, Lobby.cap) may change each of them while the server runs.
//     A lower cap never closes rooms or removes AI seats that already exist. Match rules, reconnect policy,
//     per-socket backpressure and Worker execution/queue safeguards are independent and remain enforced.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle(). A human the match removes
//     (opts.onRemove: the AFK rule, option `afkRemoveRounds`, default 2, 0 = off) departs the same way (matchRemoved):
//     the match already sent it m.removed; one removed while offline gets room.closed {reason:'afk'} on its next resume.
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'afk' (removed by the match while offline), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//     ▸ Its `ops` (0.2.2: the per-operator 潜能 / 练度, shared/protocol.js checkLoadoutOps — an operator of the 干员调配
//     roster or the 自选 owned pool, strict like the entries) travel with it: session.ops / seat.ops / seats[].ops and
//     match.setLoadout(playerId, loadout, ops); a message without `ops` sets none (every operator 潜能 6, 精英2 Lv.60).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Content identity (DESIGN §32, the plugin system's first step): the lobby is given the server's vanilla content
//     (server/plugins/identity.js; none in unit tests that build a Lobby without it). Every `welcome` carries
//     `content: { vanilla: <cs> }` — and `plugins: <n>` when this server has n > 0 unofficial plugins (every class but a
//     language: the title screen's 「本服务器安装了 N 个插件」; a page fetches the catalogue only when n > 0 and something
//     needs it, so a server without plugins sends exactly what it sent before) —, every room's `room.state.content` is
//     `{ cs, vanilla: true, plugins: [] }` while it has
//     no plugin, and the match receives `cs`, which it copies into every BattleSpec (the sim never reads it;
//     diagnostics and replays name the content with it).
//   * The room's plugins (DESIGN §32 P1a — cosmetic plugins only): room.setPlugins { plugins: [{ id }] } — host-only,
//     before the match, and ▸ like a difficulty change it un-readies the other humans. The lobby asks the server's
//     visual sets (server/plugins/visualSet.js resolve: loaded cosmetic plugins of scope `room`, their requirements
//     switched on, in load order, within the size limit — PLUGIN_UNKNOWN / PLUGIN_BLOCKED / PLUGIN_DEPENDENCY /
//     PLUGIN_CONFLICT / PLUGIN_LIMIT otherwise; none given to the Lobby → PLUGIN_UNKNOWN) and the room's content becomes
//     `{ cs, vanilla: true, vs, plugins: [{ id, version, class, hash, auto? }], warnings, bytes }`: `cs` stays the vanilla
//     one — art never changes a battle, so the match, its BattleSpecs and the golden results are those of the original
//     content and ▸ such a match counts as the original game in the statistics overview (the owner's decision of
//     2026-10-13: gameplay and numbers unchanged) —, `vs` names the
//     art every member's page draws with (/vs/<vs16>/overlay.json, composed by public/js/content.js on the page's own
//     manifest). An empty list brings back
//     exactly the vanilla shape above. The set is the room's: kept across its matches and a host change, held in the
//     visual sets while the room uses it (hold / release) and gone with the room. The same set again (the same `vs`)
//     un-readies nobody; ▸ when only its 「自动」 marks changed (a plugin first switched on automatically is now chosen, or
//     the other way round) the new state is broadcast without un-readying. A request that changes nothing (the same `vs`
//     and the same marks) — or a refused one — leaves the host's result replay (a settlement screen still open:
//     dropReplay; a change is the host moving on). ▸ When a plugin of the room's set changes on disk while the room holds
//     it (the visual sets' onStale, after the registry read the folders again), the host is told once (an m.toast: apply
//     the room's plugins again — the panel's 「重新应用」 sends the same list, which resolves to the set of the files as
//     they are now) — during a match, once the room is back in its lobby (onMatchEnd), when it can be done; nothing
//     changes by itself — ▸ but in a room the plugin studio names (DESIGN §32.9: `autoApplyPlugins`, set by
//     server/studio/index.js — a room whose host is the plugin's author or whose host is its only player) the same choice
//     is applied again at once, during a match too (refreshPlugins: art never changes a battle, the `cs` stays the vanilla
//     one; nobody is un-readied), and the host is told only when that fails.
//   * Gameplay plugins (DESIGN §32.6, P1c): room.setPlugins also takes the server's content plugins (data: numbers,
//     records, modes). The lobby's `plugins` (server/plugins/roomSets.js) closes the list over its requirements, refuses
//     conflicts, other classes and scopes, what the server owner's plugins/config.json does not allow and — unless it
//     allows them — gameplay plugins made for other game versions (PLUGIN_INCOMPATIBLE), and builds the room's content set:
//     a `cs` of its own (server/plugins/contentSets.js; at most limits.maxSets such sets held by rooms at once, else
//     PLUGIN_BUSY). The room's content is then `{ cs, vanilla: false, plugins: [{ id, version, class, hash, auto? }],
//     warnings, bytes, dataBytes, vs?, modes?, modeId? }` and ▸ the room is held to it like to a visual set (holdContent /
//     releaseContent). Its members' pages load and check that set (/cs/<cs16>/…, public/js/content.js) and say so with
//     room.contentReady { cs } — `seats[].content` (and `spectators[].content`) is 'loading' | 'ready' | 'failed' in such a
//     room only, reset to 'loading' when the set changes and when the member's socket drops (a reloaded page loads it
//     again); room.ready { ready: true } and room.start wait for every player's 'ready' (CONTENT_NOT_READY). A new room
//     starts with the policy's `default` plugins (none: the original game).
//     room.setMode { modeId } (host, before the match): an official mode of the room's type sets the difficulty; a mode
//     of the room's content set (content.modes, same room type) becomes content.modeId — the match's modeId — until the
//     host picks a difficulty or the set no longer has it; ▸ like a difficulty change it un-readies the other humans.
//     The match of such a room runs in that set's match host (server/match/host/ — a child process, a worker thread with
//     SP_MATCH_HOST=worker: hosts.create — the match is a MatchProxy whose answers are Promises), with opts.cs = the set's cs, opts.requireCs (a b.result naming another
//     content is refused) and opts.vs; ▸ every message and event of such a room is handled in order, one at a time, on
//     the room's own queue (serial): a request waits for the previous one's answer. A vanilla room never queues — its
//     match is in this process and answers at once, exactly as before. A loadout, 干员持有 list or 自选 roster stored while
//     the player was in a room of another content is filtered to the room's data when its match starts (an id the set
//     does not know is dropped, the rest kept — design study §6.9), and room.loadout / room.ownership / room.diy are
//     checked against the room's own data (and its 自选 list). When the worker stops (a crash, the watchdog), the match
//     ends with summary.reason 'plugin-crash' | 'plugin-hang' | 'plugin-start' and the room is back in its lobby.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } adds a co-op observer (MAX_SPECTATORS = 0 means unlimited), in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).
//   * Display card (fork lobby, 2026-10-14): room.card { charId?, avatar?, bg?, trophies? } — a portrait operator and an
//     avatar operator (real operators of the game data: cardCharIds, else BAD_MSG), a namecard background id (format
//     only) and a self-reported trophy
//     count (cosmetic, never used by a match) — is stored on the session (it follows the player into every room; a field
//     the message leaves out keeps its value, '' / 0 clears it) and copied to the player's seat; room.state shows it as
//     seats[].card on human seats that have one (spectators: none). A change is broadcast to the room, at most
//     CARD_CHANGES per CARD_WINDOW_MS per session (RATE beyond); the card never enters a match.
//   * Owner mark (服主, server/ownerFile.js): a session whose latest hello carried the owner key (net.js session.owner) is
//     shown as `owner: true` on its room.state seat or spectator entry; a hello updates it like the name.
//   * Maintenance (the limits file's `maintenance`, server/onlineLimit.js): while it is on, room.create, room.start and
//     queue.join answer MAINTENANCE and the matchmaker forms no offer; switching it on ends matchmaking (tickets go idle
//     with reason 'maintenance') and every switch reaches every online session as presence.state at once
//     (`maintenance: true` while on). Running matches, rooms, room.join and room.spectate go on; nobody is removed.

import { randomBytes, randomInt } from 'node:crypto';
import { DIFFICULTIES, ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, MATCHMAKING_VERSION, modeIdFor } from '../shared/constants.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds, checkNotOwned, checkDiyPicks, charPotentialChanges } from '../shared/protocol.js';
import { isSkinChoices, skinFor } from '../shared/skins.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, isExperimental, sameExperimental } from '../shared/experimental.js';
import { MAX_PLAYER_CAPACITY, PLAYER_CAPACITY_VERSION, roomCapacity } from '../shared/playerCapacity.js';
import { encode, isErrCode, sendEncodedMany, sendMessage, sendRaw, sendSession, TokenBucket } from './net.js';
import { isCompressibleType } from './wsCompression.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch, AFK_REMOVE_ROUNDS } from './match/Match.js';
import { GameData } from './match/gamedata.js';
import { Matchmaking } from './matchmaking.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { NO_PHASES } from './phaseMetrics.js';

const VANILLA_KITTED = new Set(KITTED_CHARS);
import { isContentHash } from '../shared/plugins/identity.js';
import { msg, wireMessage } from '../shared/i18n.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 0,           // concurrent rooms (0 = unlimited)
  maxRoomsPerAddr: 0,     // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 0,   // matches started from one client network that may run at once (0 = unlimited)
  maxBots: 0,             // AI seats in all rooms (0 = unlimited)
  maxBotsPerAddr: 0,      // AI seats in the rooms charged to one client network (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  matchmaking: null,           // queue admission/deadline options; defaults live in matchmaking.js
  afkRemoveRounds: AFK_REMOVE_ROUNDS, // the match removes a human idle this many rounds in a row (Match opts; 0 = off)
});

/**
 * presence.state fan-out: one publication is sent in slices of this many sessions per macrotask, so a large lobby
 * never sends to every online session inside one event-loop turn.
 */
export const PRESENCE_SLICE = 200;
/**
 * Sessions whose room is in a running match render no online count (public/js/ui/matchmaking.js OnlinePlayers is a
 * lobby-screen element): they receive the coalesced presence.state at most this often (ms), every other session as
 * before. Their count is at most this much older when they come back to the lobby screen.
 */
export const PRESENCE_IN_MATCH_MS = 10_000;

/** room.card: at most this many card changes per session in CARD_WINDOW_MS (a token bucket; RATE beyond). */
export const CARD_CHANGES = 6;
export const CARD_WINDOW_MS = 10_000;

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
/** The distinct non-null network keys of a single key and an optional set (Room ownerKey/ownerKeys, matchKey/matchKeys). */
const chargedKeys = (key, keys) => {
  if (!keys) return key ? [key] : [];
  const out = new Set(keys);
  if (key) out.add(key);
  return [...out];
};
/** A match's answer to a request as the platform replies it: OK, or its error (an unknown code: INTERNAL). */
const matchAnswer = (res) => (res && typeof res === 'object' && res.error
  ? fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined)
  : OK);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             ops?: Readonly<Record<string, { potential: number, cultivate: number }>> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null,
 *             skins?: Readonly<Record<string, string>>, band?: string | null, card?: Card | null, owner?: boolean,
 *             content?: 'ready' | 'failed' | null, contentGen?: number, loadoutCs?: string | null, notOwnedCs?: string | null,
 *             diyCs?: string | null }} Seat
 *   (`band`: AI seats only — the strategy room.setBotBand designated, null = the AI picks by itself; `card` / `owner`:
 *   human seats only, display only — room.card and the 服主 mark)
 *   content: a room with gameplay plugins — whether the player's page loaded and checked its content (header "Gameplay
 *   plugins"; null = still loading); contentGen: counts the seat's disconnects (a queued room.contentReady of an earlier
 *   page no longer counts); loadoutCs / notOwnedCs / diyCs: the content its settings were checked for
 * @typedef {Readonly<{ charId?: string, avatar?: string, bg?: string, trophies?: number }>} Card
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked operator settings (0.2.2 潜能 / 练度; shared by the session, the seat and the match). */
function freezeOps(ops) {
  const out = {};
  for (const [id, e] of Object.entries(ops || {})) out[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
  return Object.freeze(out);
}

/** The charIds a player may set a potential / 练度 for, per data object (shared/protocol.js cultivationCharIds). */
const OPS_IDS = new WeakMap();
function opsCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = OPS_IDS.get(data);
  if (!ids) { ids = cultivationCharIds(data.chess, data.backups); OPS_IDS.set(data, ids); }
  return ids;
}

/** The operators a display card may show (room.card charId / avatar): every chess record's charId and the 自选 owned pool. */
const CARD_IDS = new WeakMap();
function cardCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = CARD_IDS.get(data);
  if (!ids) {
    ids = new Set();
    for (const c of Object.values(data.chess && typeof data.chess === 'object' ? data.chess : {})) if (typeof c?.charId === 'string') ids.add(c.charId);
    for (const id of Array.isArray(data.backups?.diy?.ownedPool) ? data.backups.diy.ownedPool : []) if (typeof id === 'string') ids.add(id);
    CARD_IDS.set(data, ids);
  }
  return ids;
}
const sameCard = (a, b) => (a?.charId ?? '') === (b?.charId ?? '') && (a?.avatar ?? '') === (b?.avatar ?? '')
  && (a?.art ?? '') === (b?.art ?? '') && (a?.face ?? '') === (b?.face ?? '')
  && (a?.bg ?? '') === (b?.bg ?? '')
  && (a?.trophies ?? 0) === (b?.trophies ?? 0);

/**
 * The GameData a room's next match builds (Match: mode, difficulty and the expanded-room 鸭爵 switch), per data object —
 * room.setBotBand checks a strategy with it exactly as the match's draft does (gd.bandAllowed).
 */
const ROOM_GD = new WeakMap();
function roomGameData(data, room) {
  const modeId = modeIdFor(room.mode, room.difficulty);
  // Match.disableDuckLord: expanded co-op rooms only (experimentalOptions keeps the flag only there)
  const noDuckLord = room.mode !== 'solo' && room.experimental.disableDuckLord === true;
  let byMode = ROOM_GD.get(data);
  if (!byMode) { byMode = new Map(); ROOM_GD.set(data, byMode); }
  const key = `${modeId}|${noDuckLord}`;
  let gd = byMode.get(key);
  if (!gd) {
    gd = new GameData(data, modeId);
    gd.disableDuckLord = noDuckLord;
    byMode.set(key, gd);
  }
  return gd;
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/** One room: finite experimental seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now, experimental = EXPERIMENTAL_DEFAULTS) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /**
     * 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338; co-op only, off by default): the match's strategy and 机变 drafts
     * put every human seat before every AI seat (Match opts.aiPicksLast). Kept across the room's matches.
     */
    this.aiPicksLast = false;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.experimental = experimentalOptions(experimental);
    // Solo keeps its legacy four-slot DTO, but admits only seat zero.
    this.seats = new Array(mode === 'solo' ? MAX_SEATS : this.capacity).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean, owner?: boolean }[]} observers; MAX_SPECTATORS > 0 opts into a cap */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    this.revivalLocked = null;
    this.source = 'private';
    // Public rooms charge every participant's network, not a rotating/randomly selected host alone.
    this.ownerKeys = null;
    this.matchKeys = null;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string[] | null} plugins of the room's set that changed on disk — the host not told yet (Lobby.pluginsChanged) */
    this.pluginsChanged = null;
    this.pluginNoticeKeys = {};
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
    /**
     * The content set the room plays (DESIGN §32): `{ cs, vanilla, plugins }` — the server's vanilla set, or with the
     * cosmetic plugins its host switched on (header "The room's plugins": `vs`, `warnings`, `bytes` beside them), or a
     * content set with gameplay plugins (header "Gameplay plugins": `vanilla: false`, its own cs, `dataBytes`, `modes`,
     * `modeId`); null when the lobby has no content identity (room.state then carries none).
     * @type {Readonly<{ cs: string, vanilla: boolean, plugins: readonly object[], vs?: string, warnings?: readonly object[],
     *   bytes?: number, dataBytes?: number, modes?: readonly object[], modeId?: string }> | null}
     */
    this.content = null;
    /** the room's queue (header "Gameplay plugins": Lobby.serial): what is still waiting or running, and its tail */
    this.queue = { pending: 0, tail: Promise.resolve() };
  }

  /** Does the room play a content set with gameplay plugins (its own cs; header "Gameplay plugins")? */
  get modded() { return !!this.content && this.content.vanilla === false; }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  get capacity() { return roomCapacity(this.mode, this.experimental); }

  admitsSeat(seat) { return Number.isInteger(seat) && seat >= 0 && seat < this.capacity; }

  /** Lowest free admitted seat index, or -1. Never compact occupied seat numbers. */
  freeSeat() { return this.seats.findIndex((seat, index) => index < this.capacity && seat === null); }

  validCapacity() {
    return isExperimental(this.experimental) && this.seats.length === (this.mode === 'solo' ? MAX_SEATS : this.capacity)
      && this.seats.every((seat, index) => !seat || (this.admitsSeat(index) && seat.seat === index));
  }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  revivalState() {
    return { enabled: this.mode === 'coop' && this.experimental.revivalEnabled };
  }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      aiPicksLast: this.aiPicksLast,
      inMatch: !!this.match,
      source: this.source,
      experimental: { ...this.experimental },
      revival: this.revivalState(),
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left, revivalVote: s.isBot ? null : s.revivalVote ?? null,
          // an AI seat's designated strategy (room.setBotBand; null = it picks by itself)
          ...(s.isBot ? { band: s.band ?? null } : {}),
          // display only: the player's room.card and the 服主 mark (absent when none)
          ...(!s.isBot && s.card ? { card: s.card } : {}), ...(!s.isBot && s.owner ? { owner: true } : {}),
          // a room with gameplay plugins (header "Gameplay plugins"): has this player's page loaded and checked its content?
          ...(this.modded && !s.isBot ? { content: s.content || 'loading' } : {}) }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected, ...(s.owner ? { owner: true } : {}),
        ...(this.modded ? { content: s.content || 'loading' } : {}) })),
      ...(this.content ? { content: this.content.trusted ? {...this.content, trusted:{...this.content.trusted, consent:Object.fromEntries(this.seats.filter(x => x && !x.isBot).map(x => [x.seat,x.consentCs === this.content.cs]))}} : this.content } : {}),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   content?: { cs: string } | null,
   *   plugins?: { resolve: (ids: string[], opts?: { scope?: 'room' | 'personal', settings?: object, replacing?: object | null }) => any,
   *     hold?: (vs: string) => void, release?: (vs: string) => void, holdContent?: (cs: string) => void,
   *     releaseContent?: (cs: string) => void, onContentStale?: (fn: (cs: string, ids: string[]) => void) => () => void, onStale?: (fn: (vs: string, ids: string[]) => void) => () => void,
   *     unofficial?: () => number, defaults?: () => string[], dataOf?: (cs: string) => any, kittedOf?: (cs: string) => any,
   *     contentInUse?: () => number } | null,
   *   hosts?: { create: (cs: string, opts: object) => any, stats?: () => object } | null,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   *   limits?: { caps?: () => Readonly<Record<string, number>> } | null,
   *   metrics?: typeof NO_PHASES,
   * }} opts  (`limits`: the limits file, server/onlineLimit.js — the room / AI caps it sets win over `options`)
   *   content: the server's vanilla content (server/plugins/identity.js; header "Content identity"); plugins: what a host
   *   chooses from — the room's sets (server/plugins/roomSets.js: visual sets and content sets; header "The room's
   *   plugins", "Gameplay plugins"); hosts: the match hosts a room with gameplay plugins runs its match in
   *   (server/match/host/index.js; none: such a match runs here, unit tests — or, in the cluster, on the game node)
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, combatPool = null, trialPool = null, options = {},
    limits = null, metrics = NO_PHASES, content = null, plugins = null, hosts = null }) {
    this.combatPool = combatPool;
    this.trialPool = trialPool;
    this.registry = registry;
    /** the vanilla content set every room plays (header "Content identity"), or null */
    this.vanilla = content && isContentHash(content.cs) ? Object.freeze({ cs: content.cs, vanilla: true, plugins: Object.freeze([]) }) : null;
    /** the server's room sets — visual and content (header "The room's plugins", "Gameplay plugins"), or null */
    this.plugins = plugins;
    /** the match hosts (header "Gameplay plugins"), or null */
    this.hosts = hosts;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    this.limits = limits;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** Consumed party codes are spectator-only aliases for one exact live match context. */
    this.spectatorAliases = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /** room.create / room.start / room.addBot refusals per cap since start (/healthz limits.refused) */
    this.limitRefusals = { maxRooms: 0, maxRoomsPerAddr: 0, maxMatchesPerAddr: 0, maxBots: 0, maxBotsPerAddr: 0 };
    /** human seats that left a running match since start: the AFK rule (online / offline) or an elapsed reconnect window */
    this.matchDepartures = { afkOnline: 0, afkOffline: 0, expired: 0 };
    this.online = new Map();
    this.presenceSeq = 0;
    this.presenceTimer = null;
    this.presencePublishedAt = -Infinity;
    /** @type {{ frame: string | null, sessions: import('./net.js').Session[], index: number, at: number, immediate: any, force: boolean } | null} unfinished fan-out */
    this.presenceBatch = null;
    /** diagnostics only (server/phaseMetrics.js) */
    this.metrics = metrics;
    /** @type {WeakMap<import('./net.js').Session, TokenBucket>} room.card change budget per session */
    this.cardBuckets = new WeakMap();
    this.queue = new Matchmaking({
      now, options: this.opts.matchmaking || {}, send: sendSession, metrics,
      available: (s, entry) => this.matchmakingAvailable(s, entry),
      members: (s, difficulty, party) => this.matchmakingMembers(s, difficulty, party),
      allocate: (sessions, difficulty) => this.allocateMatchmadeRoom(sessions, difficulty),
      paused: () => this.maintenance(),
    });
    /** stops following the limits file's maintenance switch (server/onlineLimit.js onMaintenance) */
    this.unwatchMaintenance = typeof limits?.onMaintenance === 'function' ? limits.onMaintenance((on) => this.maintenanceChanged(on)) : null;
    /** log lines said once (warnOnce) */
    this.told = new Set();
    /** a held visual set whose plugins changed on disk: its rooms' hosts are told (header "The room's plugins") */
    this.offStale = typeof plugins?.onStale === 'function' ? plugins.onStale((vs, ids) => this.pluginsChanged(vs, ids)) : null;
    /**
     * Whether a room applies a change of its plugins on disk by itself (header "The room's plugins"): `({ code, hostId,
     * humans, inMatch }) => boolean`, set by the plugin studio (server/studio/index.js); null — every host is told.
     * @type {((room: { code: string, hostId: string, humans: number, inMatch: boolean }) => boolean) | null}
     */
    this.autoApplyPlugins = null;
    /**
     * Checkpoints (docs/DEPLOY.md「断点续玩」, server/persist/persister.js): `onCheckpoint(room, ctx, match, reason)` hears a
     * running local match's safe points; `closingQuietly` — the state was saved, so a shutdown closes the rooms without
     * room.closed / notices (their players are coming back).
     * @type {((room: Room, ctx: object, match: any, reason: string) => void) | null}
     */
    this.onCheckpoint = null;
    this.closingQuietly = false;
    this.offContentStale = plugins?.onContentStale?.((cs, ids) => this.pluginsChanged(cs, ids, 'content')) || null;
  }

  /**
   * The plugins `ids` of the visual set `vs` changed on disk: the host of every room using it is told to apply the room's
   * plugins again (header "The room's plugins") — a host offline now misses it; the panel's 「重新应用」 is always there.
   * @param {string} vs @param {string[]} ids
   */
  pluginsChanged(vs, ids, kind = 'visual') {
    for (const room of this.rooms.values()) {
      if (room.disposed || (kind === 'content' ? room.content?.cs : room.content?.vs) !== vs) continue;
      const noticeKey = `${room.content?.cs}|${room.content?.vs || ''}`;
      if (room.pluginNoticeKeys[kind] === noticeKey) continue;
      // the plugin studio's rooms (the author hosts, or plays alone): the same choice again at once (refreshPlugins)
      let auto;
      try { auto = !!this.autoApplyPlugins?.({ code: room.code, hostId: room.hostId, humans: room.activeHumans().length, inMatch: !!room.match }); } catch { auto = false; }
      if (kind === 'visual' && auto && this.refreshPlugins(room)) continue;
      room.pluginNoticeKeys[kind] = noticeKey;
      this.log.info(`[lobby] ${room.code} plugins changed on disk: ${ids.join(', ')} — the host is asked to apply them again`);
      // during a match the panel cannot change them: the host hears it once the room is back in its lobby (onMatchEnd)
      room.pluginsChanged = [...new Set([...(room.pluginsChanged || []), ...ids])];
      if (!room.match) this.tellPluginsChanged(room);
    }
  }

  /**
   * Apply a room's plugins again as they are on disk now (header "The room's plugins": the plugin studio's rooms) — the
   * plugins its host chose (not the 「自动」 ones), resolved again (resolveContent); the room's content becomes the new set,
   * held in its place, and every member hears it. Allowed during a match: a cosmetic set never changes a battle (the `cs`
   * stays the vanilla one) and nobody is un-readied. Only a room of cosmetic plugins: one with gameplay plugins (DESIGN
   * §32.6) would get another `cs` — every page loads and checks it again, the players are un-readied, a match keeps its
   * set — so its host is told instead, as is the host of a room whose plugins would now make one. Whether it worked
   * (false: the host is told).
   * @param {Room} room
   */
  refreshPlugins(room) {
    const before = room.content;
    if (!before?.vs || before.vanilla === false || !this.vanilla || !this.plugins) return false;
    const ids = before.plugins.filter((p) => !p.auto).map((p) => p.id);
    const r = this.resolveContent(room, ids);
    if (!('content' in r) || !r.content) { this.log.info(`[lobby] ${room.code} plugins changed on disk and no longer apply: ${'detail' in r && r.detail ? r.detail : ('error' in r ? r.error : '?')}`); return false; }
    const next = r.content;
    if (next.vanilla === false || !next.vs) return false;
    room.pluginsChanged = null;
    if (next.vs === before.vs) return true;
    room.content = next;
    this.holdContent(next);
    this.releaseContent(before);
    this.log.info(`[lobby] ${room.code} plugins applied again: ${next.plugins.map((p) => `${p.id}@${p.version}`).join(', ')}`);
    this.broadcastState(room);
    return true;
  }

  /** Tell the host of `room` that its plugins changed on disk (pluginsChanged), once. @param {Room} room */
  tellPluginsChanged(room) {
    const ids = room.pluginsChanged;
    room.pluginsChanged = null;
    // the room's set changed since (re-applied, switched off): nothing to tell
    if (!ids || !room.content?.plugins?.length) return;
    const names = ids.slice(0, 8).join('、');
    this.sendToPlayer(room, room.hostId, { t: 'm.toast', kind: 'warn', ...wireMessage(msg('房间插件「{names}」的文件在服务器上变了，请在插件面板中点「重新应用」', { names })) });
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Only spectator lookup follows a consumed party code; never follow it into another room/match incarnation. */
  spectatorRoom(code) {
    const norm = String(code).trim().toUpperCase();
    if (norm.length !== ROOM_CODE_LEN) return null;
    const room = this.rooms.get(norm);
    if (room) return room;
    const alias = this.spectatorAliases.get(norm);
    if (!alias) return null;
    const { room: destination, ctx } = alias;
    if (!destination.disposed && this.rooms.get(destination.code) === destination && destination.match
      && destination.matchCtx === ctx && destination.match === ctx.match && ctx.live && !ctx.ended && !ctx.disposed) return destination;
    this.spectatorAliases.delete(norm);
    return null;
  }

  bindSpectatorAliases(oldRooms, room) {
    const ctx = room.matchCtx;
    if (room.disposed || this.rooms.get(room.code) !== room || !room.match || room.match !== ctx?.match
      || !ctx.live || ctx.ended || ctx.disposed) return;
    for (const old of oldRooms) this.spectatorAliases.set(old.code, { room, ctx });
  }

  clearSpectatorAliases(ctx) {
    for (const [code, alias] of this.spectatorAliases) if (alias.ctx === ctx) this.spectatorAliases.delete(code);
  }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators, online: this.online.size, queued: this.queue.size };
  }

  isOnline(session) {
    return !!session?.connected && session.ws?.readyState === 1 && this.registry.byId(session.playerId) === session;
  }

  supportsCapacity(session) { return session?.playerCapacityVersion === PLAYER_CAPACITY_VERSION; }

  capacityClients(room, capacity = room.capacity) {
    return capacity <= MAX_SEATS || [...room.activeHumans(), ...room.spectators].every(member => {
      const session = this.registry.byId(member.playerId);
      return !this.isOnline(session) || this.supportsCapacity(session);
    });
  }

  // Called before Network attaches/replaces a transport, so a legacy resume can
  // neither receive a large-room snapshot nor evict the compatible live socket.
  helloAdmission(session, message) {
    const room = session ? this.roomOf(session) : null;
    return room?.capacity > MAX_SEATS && message.playerCapacityVersion !== PLAYER_CAPACITY_VERSION ? fail(ERR.BAD_MSG) : OK;
  }

  presenceState() {
    return { t: 'presence.state', online: this.online.size, seq: this.presenceSeq, serverNow: this.now(), ...(this.maintenance() ? { maintenance: true } : {}) };
  }

  /** The limits file's maintenance switch is on (server/onlineLimit.js): no new room, match start or matchmaking. */
  maintenance() {
    try { return this.limits?.maintenance?.() === true; } catch { return false; }
  }

  /**
   * The maintenance switch flipped (header): switching it on ends matchmaking — queued and offered tickets go idle with
   * reason 'maintenance' (their parties' rooms stay) —, and either way every online session gets a presence.state now,
   * one in a running match too (not held back to PRESENCE_IN_MATCH_MS).
   * @param {boolean} on
   */
  maintenanceChanged(on) {
    if (on) this.queue.clear('maintenance');
    this.presenceSeq++;
    this.publishPresence(true);
  }

  /** Connected sessions — the number the online cap (server/onlineLimit.js, Network.serverFull) compares. */
  onlineCount() { return this.online.size; }

  presenceChanged(session, connected) {
    const changed = connected ? !this.online.has(session.playerId) : this.online.has(session.playerId);
    if (connected) this.online.set(session.playerId, session);
    else this.online.delete(session.playerId);
    if (!changed) return;
    this.presenceSeq++;
    if (this.presenceTimer != null) return;
    this.presenceTimer = setTimeout(() => this.publishPresence(), Math.max(0, this.presencePublishedAt + 1000 - this.now()));
    this.presenceTimer.unref?.();
  }

  /** @param {boolean} [force] reach sessions in a running match too (presenceDue does not hold them back) */
  publishPresence(force = false) {
    if (this.presenceTimer != null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.presencePublishedAt = this.now();
    // A newer publication replaces an unfinished fan-out: everyone it had not reached gets the newer frame (forced
    // when the replaced one was).
    if (this.presenceBatch?.immediate) clearImmediate(this.presenceBatch.immediate);
    this.presenceBatch = { frame: encode(this.presenceState()), sessions: [...this.online.values()], index: 0,
      at: this.presencePublishedAt, immediate: null, force: force || !!this.presenceBatch?.force };
    this.presenceSlice(); // the first slice synchronously (a small lobby is reached at once, as before)
  }

  /** One slice of the current presence fan-out; the rest follows on later macrotasks. */
  presenceSlice() {
    const batch = this.presenceBatch;
    if (!batch) return;
    batch.immediate = null;
    const t0 = this.metrics.start(), end = Math.min(batch.sessions.length, batch.index + PRESENCE_SLICE), sockets = [];
    for (; batch.index < end; batch.index++) {
      const session = batch.sessions[batch.index];
      if (!this.isOnline(session) || (!batch.force && !this.presenceDue(session, batch.at))) continue;
      session.presenceAt = batch.at;
      sockets.push(session.ws);
    }
    // One frame per ingress link for its sessions of this slice (net.js sendEncodedMany).
    const sent = sendEncodedMany(sockets, batch.frame);
    this.metrics.end('presence.publish', t0, sent);
    if (batch.index < batch.sessions.length) batch.immediate = setImmediate(() => this.presenceSlice());
    else if (this.presenceBatch === batch) this.presenceBatch = null;
  }

  /** In a running match the online count is not shown: refresh it there only every PRESENCE_IN_MATCH_MS. */
  presenceDue(session, at) {
    if (!session.roomCode || !this.rooms.get(session.roomCode)?.match) return true;
    return !(at - session.presenceAt < PRESENCE_IN_MATCH_MS);
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    this.presenceChanged(session, this.isOnline(session));
    if (sendSession(session, this.presenceState())) session.presenceAt = this.now();
    this.queue.sync(session);
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!!seat.owner !== session.owner) { seat.owner = session.owner; changed = true; } // the 服主 mark (display only)
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    // a player back in a running co-op match holds its dropped teammates' seats again
    if (changed && room.match && room.seatOf(session.playerId)) this.refreshMatchWindows(room);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session. A room whose match runs in a match host handles its
   * messages one at a time, in order (serial; header "Gameplay plugins"): the answer is then a Promise (server/net.js
   * replies when it settles).
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string } | Promise<{ ok: true } | { error: string, detail?: string }>}
   */
  onMessage(session, msg) {
    const room = this.queuedRoom(session);
    if (!room) return this.handleMessage(session, msg);
    // a queued room.contentReady speaks for the page that sent it: the seat and its generation now — a disconnect in
    // between bumps it, and the page that comes back checks the set again (contentReady)
    const ctx = msg && msg.t === 'room.contentReady' ? { from: this.seatGen(room, session.playerId) } : null;
    return this.serial(room, () => this.handleMessage(session, msg, ctx));
  }

  /** A seat (or spectator seat) of `room` and its content generation (header "Gameplay plugins"), or null. */
  seatGen(room, playerId) {
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    return seat ? { seat, gen: seat.contentGen || 0 } : null;
  }

  /**
   * The room of `session` when its messages go through the room's queue: its match runs in a match host
   * (MatchProxy `hosted`), or something of the room is still pending. Null for every vanilla room.
   * @param {import('./net.js').Session} session
   */
  queuedRoom(session) {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : null;
    return room && !room.disposed && (room.queue.pending > 0 || room.match?.hosted === true) ? room : null;
  }

  /**
   * Run `fn` on the room's queue (header "Gameplay plugins"): at once when nothing of the room is pending — a synchronous
   * answer stays synchronous —, else after everything before it has settled. An answer that is a Promise keeps the room's
   * queue busy until it settles.
   * @template T
   * @param {Room} room @param {() => T} fn
   * @returns {T | Promise<Awaited<T>>}
   */
  serial(room, fn) {
    const q = room.queue;
    if (q.pending === 0) {
      const r = fn();
      if (!r || typeof /** @type {any} */ (r).then !== 'function') return r;
      q.pending++;
      const done = Promise.resolve(r).finally(() => { q.pending--; });
      q.tail = done.then(() => {}, () => {});
      return /** @type {any} */ (done);
    }
    q.pending++;
    const done = q.tail.then(() => fn()).finally(() => { q.pending--; });
    q.tail = done.then(() => {}, () => {});
    return /** @type {any} */ (done);
  }

  /** An event of the room (a disconnect, a resync, an expiry) on its queue: nothing waits for it; a failure is logged. */
  queueEvent(room, fn) {
    let r;
    try { r = this.serial(room, fn); } catch (e) { this.log.error(`[lobby] ${room.code} a room event failed`, e); return; }
    if (r && typeof r.then === 'function') r.then(null, (e) => this.log.error(`[lobby] ${room.code} a room event failed`, e));
  }

  /**
   * One message (onMessage), now. `ctx`: what onMessage noted when it queued the message (a contentReady's seat
   * generation), else null.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  handleMessage(session, msg, ctx = null) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.voteRevival': return this.voteRevival(session, msg);
      case 'room.setExperimental': return this.setExperimental(session, msg);
      case 'queue.join': return this.queue.join(session, msg);
      case 'queue.cancel': return this.queue.cancel(session, msg);
      case 'queue.accept': return this.queue.accept(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.setBotBand': return this.setBotBand(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.rerollSetup': return this.rerollSetup(session, msg);
      case 'room.cancelReroll': return this.rerollSetup(session, msg, true);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.skins': return this.skins(session, msg);
      case 'room.card': return this.setCard(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      case 'room.setPlugins': return this.setPlugins(session, msg);
      case 'room.setMode': return this.setMode(session, msg);
      case 'room.contentReady': return this.contentReady(session, msg, ctx);
      case 'room.consent': return this.consent(session,msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGameNow(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    if (this.isOnline(session)) return; // an obsolete socket must not detach its replacement
    this.presenceChanged(session, false);
    this.queue.remove(session, 'disconnected');
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    session.matchHeld = false;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // the page may come back as a new one (a reload): it loads and checks the room's content again (header "Gameplay
    // plugins") — and a room.contentReady of the page that went, still on the room's queue, no longer counts (seatGen)
    if (room.modded) seat.content = null;
    seat.contentGen = (seat.contentGen || 0) + 1;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) {
      if (player) {
        // a match in a match host hears it in order with the room's messages (header "Gameplay plugins") — not at
        // all when the player is back by then (the resync after the reconnect tells it onReconnect)
        if (this.queuedRoom(session)) this.queueEvent(room, () => { if (!session.connected) this.callMatch(room, 'onDisconnect', session.playerId); });
        else this.callMatch(room, 'onDisconnect', session.playerId);
        this.refreshMatchWindows(room);
      }
    } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /**
   * 掉线由 AI 接管 (the owner's rule of 2026-10-14; the header's Reconnect item): while a player of a running match that
   * is not solo is online, every dropped player of it stays resumable for the solo window (a ceiling no match reaches)
   * — the match plays its seat by AI and hands it back on its return. Once none is online, each of them gets the plain
   * reconnect window again, counted from now (once: a later call does not push it further). Called when a player of a
   * running match drops, comes back or departs.
   * @param {Room} room
   */
  refreshMatchWindows(room) {
    if (!room?.match || room.disposed || room.mode === 'solo') return;
    const humans = room.activeHumans();
    const online = humans.some((s) => s.connected);
    const now = this.now();
    for (const s of humans) {
      const session = s.connected ? null : this.registry.byId(s.playerId);
      if (!session || session.connected || session.roomCode !== room.code || session.disconnectedAt == null) continue;
      if (online) {
        session.resumeWindowMs = this.soloResumeWindowMs();
        session.matchHeld = true;
      } else if (session.matchHeld) {
        session.resumeWindowMs = now - session.disconnectedAt + this.registry.reconnectWindowMs;
        session.matchHeld = false;
      }
    }
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    this.presenceChanged(session, false);
    this.queue.remove(session, 'expired');
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    const room = code ? this.rooms.get(code) : null;
    const seat = room?.match ? room.seatOf(session.playerId) : null;
    if (seat && !seat.isBot && !seat.left) this.matchDepartures.expired++;
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (room && this.queuedRoom(session)) {
      this.queueEvent(room, () => { if (session.roomCode === code) session.roomCode = null; this.removeMember(room, session.playerId); });
      return;
    }
    session.roomCode = null;
    if (room) this.removeMember(room, session.playerId);
  }

  /** /healthz `reconnect.matchSeats`: human seats that left a running match since start, by cause (matchDepartures). */
  departureStats() { return { ...this.matchDepartures }; }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.unwatchMaintenance?.();
    this.unwatchMaintenance = null;
    this.queue.close();
    if (this.presenceTimer != null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (this.presenceBatch?.immediate) clearImmediate(this.presenceBatch.immediate);
    this.presenceBatch = null;
    this.online.clear();
    this.offStale?.();
    this.offContentStale?.();
    this.offStale = null;
    this.offContentStale = null;
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    this.spectatorAliases.clear();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, experimental = EXPERIMENTAL_DEFAULTS }) {
    if (!isExperimental(experimental)) return fail(ERR.BAD_MSG);
    if (roomCapacity(mode, experimental) > MAX_SEATS && !this.supportsCapacity(session)) return fail(ERR.BAD_MSG);
    if (this.maintenance()) return fail(ERR.MAINTENANCE);
    if (this.queue.has(session)) return fail(ERR.QUEUED);
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    // The room being left disappears with this create when the creator is its only human (a spectator is none).
    const leaves = !!cur && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId);
    const maxRooms = this.cap('maxRooms');
    if (maxRooms > 0 && this.rooms.size - (leaves ? 1 : 0) >= maxRooms) {
      return this.limitRefusal('maxRooms', `room cap (${maxRooms}) reached`, 'too many rooms');
    }
    const key = session.limitKey || null;
    const perAddr = this.cap('maxRoomsPerAddr');
    if (key && perAddr > 0) {
      const leaving = leaves && this.roomCharges(cur, key) ? 1 : 0;
      if (this.countRooms((r) => this.roomCharges(r, key)) - leaving >= perAddr) {
        return this.limitRefusal('maxRoomsPerAddr', `room limit (${perAddr}) reached for ${session.addr}`, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now(), experimental);
    room.content = this.vanilla;
    // the server owner's default plugins (plugins/config.json `default`; header "Gameplay plugins"): none — the original game
    const defaults = this.plugins?.defaults?.() || [];
    if (defaults.length) {
      const r = this.resolveContent(room, defaults);
      if ('error' in r) this.warnOnce(`[lobby] the default plugins (${defaults.join(', ')}) cannot be applied: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
      else { room.content = r.content; this.holdContent(r.content); }
    }
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  join(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) {
      const aliasRoom = this.spectatorRoom(norm);
      if (!aliasRoom) return fail(ERR.ROOM_NOT_FOUND);
      if (aliasRoom.capacity > MAX_SEATS && !this.supportsCapacity(session)) return fail(ERR.BAD_MSG);
      if (this.queue.has(session)) return fail(ERR.QUEUED);
      return fail(ERR.ROOM_STARTED); // The client must explicitly confirm spectating; never admit a player via an alias.
    }
    if (room.capacity > MAX_SEATS && !this.supportsCapacity(session)) return fail(ERR.BAD_MSG);
    const cur = this.roomOf(session);
    // idempotent for players; a spectator may take a free player seat below, but never while the party is queued
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (this.queue.has(session)) return fail(ERR.QUEUED);
    if (room.source === 'matchmaking' && session.matchmakingVersion !== MATCHMAKING_VERSION) {
      return fail(ERR.BAD_MSG, 'matchmaking version required; refresh the page');
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.queue.remove(session, 'cancelled');
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const room = this.spectatorRoom(code);
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.capacity > MAX_SEATS && !this.supportsCapacity(session)) return fail(ERR.BAD_MSG);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (this.queue.has(session)) return fail(ERR.QUEUED);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (MAX_SPECTATORS > 0 && room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected, owner: session.owner === true });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    // a room with gameplay plugins: ready once the page has loaded and checked its content (header "Gameplay plugins")
    if (ready && room.modded && seat.content !== 'ready') return fail(ERR.CONTENT_NOT_READY);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  voteRevival() { return fail(ERR.BAD_MSG, 'revival voting was replaced by room experimental options'); }

  setExperimental(session, { experimental }) {
    if (!isExperimental(experimental)) return fail(ERR.BAD_MSG);
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    const capacity = roomCapacity(room.mode, experimental);
    if (room.source !== 'private' && capacity !== room.capacity) return fail(ERR.BAD_MSG, 'matchmade room capacity cannot change');
    if (capacity > MAX_SEATS && (!this.supportsCapacity(session) || !this.capacityClients(room, capacity))) return fail(ERR.BAD_MSG);
    // Reject before touching options, ready flags, replay or seats, including a
    // disconnected human / AI in a high slot. A shrink never reassigns seats.
    if (room.seats.slice(capacity).some(Boolean)) return fail(ERR.ROOM_FULL, 'higher seats must be empty before reducing capacity');
    this.dropReplay(room, session.playerId);
    if (!sameExperimental(room.experimental, experimental)) {
      const slots = room.mode === 'solo' ? MAX_SEATS : capacity;
      while (room.seats.length < slots) room.seats.push(null);
      room.seats.length = slots;
      room.experimental = experimentalOptions(experimental);
      this.dropUnofferedBotBands(room);
      for (const seat of room.activeHumans()) if (seat.playerId !== room.hostId) seat.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    this.dropReplay(room, session.playerId);
    // a plugin mode chosen (header "Gameplay plugins") carries its own difficulty: picking one leaves it
    if (room.difficulty !== difficulty || room.content?.modeId) {
      room.difficulty = difficulty;
      this.dropUnofferedBotBands(room);
      if (room.content?.modeId) { const rest = { ...room.content }; delete rest.modeId; room.content = Object.freeze(rest); }
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** 「AI 队友最后选择」 (GitHub #338): host-only, before the match, co-op rooms only (a solo room has no AI seat). */
  setAiPicksLast(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'solo rooms have no AI teammates');
    this.dropReplay(room, session.playerId);
    if (room.aiPicksLast !== on) {
      room.aiPicksLast = on;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * room.setBotBand {seat, bandId} (header): host-only, before the match, co-op rooms only — the strategy the AI seat
   * takes in the strategy draft, or null for its own pick. One AI seat per strategy.
   */
  setBotBand(session, { seat, bandId = null }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'solo rooms have no AI teammates');
    if (!room.admitsSeat(seat)) return fail(ERR.BAD_TARGET, 'seat outside room capacity');
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    if (bandId !== null) {
      if (!roomGameData(this.safeData(), room).bandAllowed(bandId)) return fail(ERR.BAD_TARGET, 'strategy not offered in this mode');
      if (room.seats.some((s) => s && s !== target && s.isBot && s.band === bandId)) return fail(ERR.BAD_TARGET, 'strategy designated to another AI');
    }
    this.dropReplay(room, session.playerId);
    if ((target.band ?? null) !== bandId) {
      target.band = bandId;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** After a difficulty / experimental change: an AI seat's strategy the new rules no longer offer goes back to automatic. */
  dropUnofferedBotBands(room) {
    if (!room.seats.some((s) => s && s.isBot && s.band != null)) return;
    const gd = roomGameData(this.safeData(), room);
    for (const s of room.seats) if (s && s.isBot && s.band != null && !gd.bandAllowed(s.band)) s.band = null;
  }

  /**
   * room.setPlugins (header "The room's plugins", "Gameplay plugins"): host-only, before the match; the set of the plugins
   * asked for becomes the room's content and the other humans are un-readied — nothing changes (and nobody is un-readied)
   * when it is the set the room already has. The host's result replay (a settlement screen still open) is dropped only
   * when the set did change: re-applying the same plugins, or a refused set, leaves it.
   */
  setPlugins(session, { plugins }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const ids = [...new Set(plugins.map((p) => p.id))];
    /** @type {Record<string, Record<string, unknown>>} */
    const settings = {};
    for (const p of plugins) if (p.settings) settings[p.id] = p.settings;
    const r = this.resolveContent(room, ids, settings);
    if ('error' in r) return r;
    let content = r.content;
    const before = room.content;
    const sameSet = (before?.vs ?? null) === (content?.vs ?? null) && (before?.cs ?? null) === (content?.cs ?? null);
    const marks = (c) => JSON.stringify((c?.plugins || []).map((p) => [p.id, !!p.auto, p.settings || null]));
    if (sameSet && marks(before) === marks(content)) return OK;
    this.dropReplay(room, session.playerId);
    // another set: a notice still waiting for the end of a match (pluginsChanged) is moot
    if (!sameSet) { room.pluginsChanged = null; room.pluginNoticeKeys = {}; }
    // the plugin mode chosen stays while the set still provides it (header "Gameplay plugins")
    if (before?.modeId && content?.modes?.some((m) => m.id === before.modeId)) content = Object.freeze({ ...content, modeId: before.modeId });
    room.content = content;
    if (!sameSet) {
      this.holdContent(content);
      this.releaseContent(before);
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      // another content set: every page loads and checks it again (room.contentReady)
      if ((before?.cs ?? null) !== (content?.cs ?? null)) for (const s of [...room.seats, ...room.spectators]) if (s && !s.isBot)  { s.content = null; s.consentCs = null; }
      this.log.info(`[lobby] ${room.code} plugins: ${content?.plugins?.length ? content.plugins.map((p) => `${p.id}@${p.version}`).join(', ') : 'none'}${room.modded ? ` (content ${content.cs.slice(0, 8)})` : ''}`);
    }
    this.broadcastState(room);
    return OK;
  }

  /**
   * The content a room gets for the plugins `ids` (header "The room's plugins", "Gameplay plugins"): the vanilla set for
   * none, else what the room sets resolve — cosmetic plugins only: the vanilla cs with their `vs`; content plugins: the
   * content set's own cs (`vanilla: false`). Nothing is held yet (holdContent).
   * @param {Room | null} room @param {string[]} ids @param {Record<string, Record<string, unknown>>} [settings]
   * @returns {{ content: Room['content'] } | { error: string, detail?: string }}
   */
  resolveContent(room, ids, settings = {}) {
    if (!ids.length) {
      // the server owner may fix every room's plugins (plugins/config.json rooms: fixed): the original game is not one
      const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
      if (fixed && fixed.length) return fail(ERR.PLUGIN_BLOCKED, 'this server fixes every room\'s plugins (plugins/config.json rooms: fixed)');
      return { content: this.vanilla };
    }
    if (!this.vanilla || !this.plugins) return fail(ERR.PLUGIN_UNKNOWN, 'this server applies no plugins');
    let r;
    try { r = this.plugins.resolve(ids, { scope: 'room', settings, replacing: room?.content ?? null }); } catch (e) {
      this.log.error(`[lobby] ${room?.code ?? '----'} plugin set failed`, e);
      return fail(ERR.INTERNAL);
    }
    if (!r || !r.ok) return fail(r && isErrCode(r.error) ? r.error : ERR.INTERNAL, r && typeof r.detail === 'string' ? r.detail.slice(0, 200) : undefined);
    const { cs, vs, plugins: list, warnings, bytes, dataBytes, modes, kitted, trusted, execution } = r.set;
    const modded = isContentHash(cs) && cs !== this.vanilla.cs;
    const frozen = (a) => Object.freeze((Array.isArray(a) ? a : []).map((p) => Object.freeze({ ...p })));
    // the operators its plugins add to a 自选 slot's list (welcome.diyKitted holds the server's own): the pages' pickers
    const extra = modded && Array.isArray(kitted) ? kitted.filter((id) => typeof id === 'string' && !VANILLA_KITTED.has(id)).slice(0, 200) : [];
    return {
      content: Object.freeze({
        cs: modded ? cs : this.vanilla.cs,
        vanilla: !modded,
        ...(vs ? { vs } : {}),
        plugins: frozen(list),
        ...(trusted ? {trusted} : {}),
        ...(execution ? {execution} : {}),
        warnings: Object.freeze([...(warnings || [])]),
        bytes: Number(bytes) || 0,
        ...(modded ? { dataBytes: Number(dataBytes) || 0, modes: frozen(modes), ...(extra.length ? { kittedExtra: Object.freeze(extra) } : {}) } : {}),
      }),
    };
  }

  /** A room now uses `content`: its visual set and its content set are held (released by releaseContent). */
  holdContent(content) {
    if (content?.vs) this.plugins?.hold?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.holdContent?.(content.cs);
  }

  /** A room no longer uses `content`. */
  releaseContent(content) {
    if (content?.vs) this.plugins?.release?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.releaseContent?.(content.cs);
  }

  /**
   * room.setMode (header "Gameplay plugins"): host-only, before the match. An official mode of the room's type sets its
   * difficulty (and leaves a plugin mode); a mode of the room's content set (content.modes, the room's type) becomes
   * content.modeId — its difficulty the room's. Like a difficulty change it un-readies the other humans.
   */
  setMode(session, { modeId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const official = DIFFICULTIES.find((d) => modeIdFor(room.mode, d) === modeId);
    let difficulty = room.difficulty;
    let content = room.content;
    if (official) {
      difficulty = official;
      if (content?.modeId) { const rest = { ...content }; delete rest.modeId; content = Object.freeze(rest); }
    } else {
      const mode = Array.isArray(content?.modes) ? content.modes.find((m) => m && m.id === modeId) : null;
      if (!mode) return fail(ERR.BAD_TARGET, 'not a mode of this room');
      if (mode.roomMode !== room.mode) return fail(ERR.BAD_TARGET, `a mode of ${mode.roomMode} rooms`);
      if (DIFFICULTIES.includes(mode.difficulty)) difficulty = mode.difficulty;
      if (content.modeId !== modeId) content = Object.freeze({ ...content, modeId });
    }
    if (difficulty === room.difficulty && content === room.content) return OK;
    this.dropReplay(room, session.playerId);
    room.difficulty = difficulty;
    room.content = content;
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  /**
   * room.contentReady { cs, ok? } (header "Gameplay plugins"): the member's page has loaded and checked the room's content
   * set (`ok: false`: it could not). Recorded for the room's current set only — a page that checked an older one is
   * answered OK and changes nothing — and only for the page that is there: a session whose socket is gone, or a message
   * that waited on the room's queue across a disconnect of its seat (`ctx.from`: the seat's generation when it was
   * queued), is answered OK and writes nothing (the page that comes back checks the set again).
   * @param {import('./net.js').Session} session @param {{ cs: string, ok?: boolean }} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  contentReady(session, { cs, ok }, ctx = null) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.modded || room.content.cs !== cs) return OK;
    if (!session.connected) return OK;
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    if (!seat) return OK;
    if (ctx && ctx.from && (ctx.from.seat !== seat || ctx.from.gen !== (seat.contentGen || 0))) return OK;
    if (ok !== false && room.content?.trusted && room.seatOf(session.playerId) && seat.consentCs !== cs) return fail(ERR.PLUGIN_CONSENT);
    const state = ok === false ? 'failed' : 'ready';
    if (seat.content === state) return OK;
    seat.content = state;
    if (state === 'failed') this.log.warn(`[lobby] ${room.code} ${session.name}: the room's content ${cs.slice(0, 8)} did not load or check on that page`);
    this.broadcastState(room);
    return OK;
  }

  /** Each live session consents only for its own seat and the current cs. Reconnect keeps the seat. */
  consent(session, {cs,accept}) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const seat = room.seatOf(session.playerId);
    if (!seat || seat.isBot) return fail(ERR.SPECTATOR);
    if (!session.connected || !room.content?.trusted || room.content.cs !== cs) return fail(ERR.PLUGIN_CONSENT);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const changed = (seat.consentCs === cs) !== accept;
    seat.consentCs = accept ? cs : null;
    if (changed) seat.content = null;
    if (!accept) { seat.ready = false; seat.content = null; }
    this.broadcastState(room);
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const capped = this.botCapRefusal(room, session);
    if (capped) return capped;
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false, band: null };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    if (!room.admitsSeat(seat)) return fail(ERR.BAD_TARGET, 'seat outside room capacity');
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!room.admitsSeat(seat)) return fail(ERR.BAD_TARGET, 'seat outside room capacity');
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (this.maintenance()) return fail(ERR.MAINTENANCE);
    if (this.roomQueued(room)) return fail(ERR.QUEUED);
    if (!room.validCapacity() || !this.capacityClients(room)) return fail(ERR.BAD_MSG);
    const humans = room.activeHumans();
    if (room.content?.trusted && humans.some(s => s.consentCs !== room.content.cs)) return fail(ERR.PLUGIN_CONSENT);
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    // a room with gameplay plugins starts once every player's page has loaded and checked its content (the host's too)
    if (room.modded && humans.some((s) => s.content !== 'ready')) return fail(ERR.CONTENT_NOT_READY);
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    const keys = room.ownerKeys ? new Set(room.ownerKeys) : new Set();
    if (key) keys.add(key);
    if (room.ownerKeys) for (const s of humans) {
      const memberKey = this.registry.byId(s.playerId)?.limitKey;
      if (memberKey) keys.add(memberKey);
    }
    const maxMatches = this.cap('maxMatchesPerAddr');
    if (maxMatches > 0) for (const network of keys) {
      if (this.countRooms((r) => !!r.match && this.matchCharges(r, network)) >= maxMatches) {
        return this.limitRefusal('maxMatchesPerAddr', `match limit (${maxMatches}) reached for public/private room network`,
          'too many running matches from your network');
      }
    }
    return this.startMatch(room, key, room.ownerKeys ? keys : null);
  }

  /** Host authorization stays in the lobby; the match owns the vote and setup. */
  rerollSetup(session, msg, cancel = false) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    const method = cancel ? 'cancelSetupReroll' : 'requestSetupReroll';
    if (!room.match || typeof room.match[method] !== 'function') return fail(ERR.WRONG_PHASE);
    return this.callMatch(room, method, session.playerId, cancel ? msg.voteId : msg.setupRevision) || fail(ERR.INTERNAL);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout — and its per-operator 潜能 / 练度 `ops` (0.2.2) — against the
   * game data, store both on the session and the seat, and — while a match runs — hand them to the match (accepted only
   * during INFO_CHECK, see the header). Either part refused: nothing is stored.
   */
  loadout(session, { entries, ops }) {
    const room = this.roomOf(session);
    // checked against the room's own data: a room with gameplay plugins knows its plugins' operators (header "Gameplay plugins")
    const data = this.dataFor(room);
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const ids = opsCharIds(data);
    const resOps = checkLoadoutOps(ops, (id) => ids.has(id), (id) => charPotentialChanges(data, id));
    if (!resOps || resOps.error) return fail(resOps && isErrCode(resOps.error) ? resOps.error : ERR.BAD_MSG, resOps && resOps.detail);
    const loadout = freezeLoadout(res.loadout);
    const opsSet = freezeOps(resOps.ops);
    const cs = this.csOf(room);
    session.loadout = loadout;
    session.ops = opsSet;
    session.loadoutCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = opsSet; seat.loadoutCs = cs; }
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout, opsSet);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    // a match in a match host answers later (header "Gameplay plugins")
    if (r && typeof r.then === 'function') return Promise.resolve(r).then(matchAnswer, () => fail(ERR.INTERNAL));
    return matchAnswer(r);
  }

  roomQueued(room) { return room.activeHumans().some((seat) => this.queue.entries.has(seat.playerId)); }

  matchmakingMembers(session, difficulty, party) {
    const room = this.roomOf(session);
    if (room?.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (!party) {
      if (room) return fail(ERR.WRONG_PHASE, 'leave your room before solo matchmaking');
      return { sessions: [session], roomCode: null, leaderId: session.playerId };
    }
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.mode !== 'coop' || room.match) return fail(ERR.WRONG_PHASE, 'party matchmaking requires a waiting cooperative room');
    if (!room.validCapacity() || !this.capacityClients(room)) return fail(ERR.BAD_MSG, 'all room members must support its capacity');
    if (difficulty !== room.difficulty) return fail(ERR.BAD_MSG, 'party difficulty must match the room');
    if (room.seats.some((seat) => seat?.isBot)) return fail(ERR.BAD_MSG, 'public matchmaking has no AI players');
    if (room.activeHumans().some(seat => !seat.connected || (seat.playerId !== room.hostId && seat.ready !== true))) return fail(ERR.NOT_READY);
    const sessions = room.activeHumans().map((seat) => this.registry.byId(seat.playerId));
    if (!sessions.length || sessions.some((s) => !this.isOnline(s))) return fail(ERR.NOT_READY, 'all party members must be online');
    return { sessions, roomCode: room.code, leaderId: room.hostId, experimental: room.experimental };
  }

  matchmakingAvailable(session, entry) {
    if (!this.isOnline(session)) return false;
    const room = this.roomOf(session);
    const party = entry?.party;
    if (!party?.roomCode) return !room;
    if (!room || room.code !== party.roomCode || room.match || room.mode !== 'coop'
      || room.capacity !== party.required || !room.validCapacity() || !this.capacityClients(room)
      || room.activeHumans().some(seat => !seat.connected || (seat.playerId !== room.hostId && seat.ready !== true))
      || room.hostId !== party.leaderId || room.difficulty !== entry.difficulty
      || !sameExperimental(room.experimental, party.experimental)
      || room.seats.some((seat) => seat?.isBot)) return false;
    const humans = room.activeHumans();
    return humans.length === party.entries.length && party.entries.every((member) =>
      humans.some((seat) => seat.playerId === member.session.playerId) && this.isOnline(member.session));
  }

  roomCharges(room, key) { return room.ownerKey === key || !!room.ownerKeys?.has(key); }
  matchCharges(room, key) { return room.matchKey === key || !!room.matchKeys?.has(key); }
  /** The networks a room is charged to (roomCharges) / its running match is charged to (matchCharges). */
  roomNetworks(room) { return chargedKeys(room.ownerKey, room.ownerKeys); }
  matchNetworks(room) { return chargedKeys(room.matchKey, room.matchKeys); }

  /**
   * A room / AI cap in force (0 = unlimited): the limits file (server/onlineLimit.js) wins over the options for every
   * key it sets, so an operator changes caps without a restart.
   * @param {'maxRooms'|'maxRoomsPerAddr'|'maxMatchesPerAddr'|'maxBots'|'maxBotsPerAddr'} name
   */
  cap(name) {
    const caps = this.limits?.caps?.();
    return (caps && Object.hasOwn(caps, name) ? caps[name] : this.opts[name]) || 0;
  }

  /** Count, log (limitWarn) and answer a room.create / room.start / room.addBot refused by a cap. */
  limitRefusal(name, text, detail) {
    this.limitRefusals[name]++;
    this.limitWarn(text);
    return fail(ERR.LIMIT, detail);
  }

  /**
   * room.addBot's caps: the AI seats of all rooms (`maxBots`) and of the rooms charged to each network this room is
   * charged to (`maxBotsPerAddr`). One pass over the rooms, only while a cap is set.
   * @returns {{ error: string, detail: string } | null}
   */
  botCapRefusal(room, session) {
    const total = this.cap('maxBots'), perAddr = this.cap('maxBotsPerAddr');
    const keys = perAddr > 0 ? this.roomNetworks(room) : [];
    if (total <= 0 && !keys.length) return null;
    const mine = new Map(keys.map((key) => [key, 0]));
    let all = 0;
    for (const r of this.rooms.values()) {
      let bots = 0;
      for (const s of r.seats) if (s && s.isBot) bots++;
      if (!bots) continue;
      all += bots;
      for (const key of keys) if (this.roomCharges(r, key)) mine.set(key, mine.get(key) + bots);
    }
    if (total > 0 && all >= total) return this.limitRefusal('maxBots', `AI cap (${total}) reached`, 'too many AI teammates');
    for (const bots of mine.values()) {
      if (bots >= perAddr) {
        return this.limitRefusal('maxBotsPerAddr', `AI limit (${perAddr}) reached for the network of room ${room.code} (host ${session.addr})`,
          'too many AI teammates from your network');
      }
    }
    return null;
  }

  /**
   * /healthz `limits`: the caps in force, the maintenance switch (0 / 1, server/onlineLimit.js), the largest use any one
   * network makes of each per-network cap, and the refusals since start (limitRefusal; matchmaking allocation refusals
   * are not counted).
   */
  limitStats() {
    const rooms = new Map(), matches = new Map(), bots = new Map();
    const add = (map, key, n) => map.set(key, (map.get(key) || 0) + n);
    for (const r of this.rooms.values()) {
      let n = 0;
      for (const s of r.seats) if (s && s.isBot) n++;
      for (const key of this.roomNetworks(r)) { add(rooms, key, 1); if (n) add(bots, key, n); }
      if (r.match) for (const key of this.matchNetworks(r)) add(matches, key, 1);
    }
    const largest = (map) => { let m = 0; for (const n of map.values()) if (n > m) m = n; return m; };
    const caps = {};
    for (const name of Object.keys(this.limitRefusals)) caps[name] = this.cap(name);
    return { ...caps, maintenance: this.maintenance() ? 1 : 0, perAddrPeak: { rooms: largest(rooms), matches: largest(matches), bots: largest(bots) },
      refused: { ...this.limitRefusals } };
  }

  /** Build/start privately, then commit the whole cohort together; failed starts retain the old rooms. */
  allocateMatchmadeRoom(sessions, difficulty) {
    if (sessions.length < MAX_SEATS || sessions.length > MAX_PLAYER_CAPACITY
      || new Set(sessions.map((s) => s.playerId)).size !== sessions.length) return fail(ERR.BAD_TARGET);
    const first = this.queue.entries.get(sessions[0].playerId);
    const offer = first?.offerId ? this.queue.offers.get(first.offerId) : null;
    const now = this.now();
    if (!offer || offer.entries.length !== offer.required || sessions.length !== offer.required
      || offer.deadline <= now) return fail(ERR.BAD_TARGET, 'expired matchmaking offer');
    if (!isExperimental(offer.experimental) || roomCapacity('coop', offer.experimental) !== offer.required) return fail(ERR.BAD_MSG);
    const oldRooms = new Set();
    for (const session of sessions) {
      const entry = this.queue.entries.get(session.playerId);
      if (!this.matchmakingAvailable(session, entry) || session.matchmakingVersion !== MATCHMAKING_VERSION
        || entry?.session !== session || entry.version !== MATCHMAKING_VERSION || entry.expiresAt <= now
        || (entry.key || null) !== (session.limitKey || null)
        || !entry.accepted || entry.offerId !== offer.id || entry.difficulty !== difficulty || !offer.entries.includes(entry)) {
        return fail(ERR.WRONG_PHASE, 'matchmaking participant unavailable');
      }
      // Never consume half a party, even if allocation is called with tampered offer membership.
      if (entry.party.entries.some((member) => !offer.entries.includes(member))) return fail(ERR.BAD_TARGET, 'incomplete party');
      if (entry.party.roomCode) oldRooms.add(this.roomOf(session));
    }
    const spectators = [...oldRooms].flatMap((r) => r.spectators);
    if (MAX_SPECTATORS > 0 && spectators.length > MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'party rooms exceed the spectator limit');
    for (const old of oldRooms) {
      if (old.spectators.some((s) => this.registry.byId(s.playerId)?.roomCode !== old.code)) return fail(ERR.BAD_TARGET, 'party spectator unavailable');
    }
    const maxRooms = this.cap('maxRooms'), perAddr = this.cap('maxRoomsPerAddr'), maxMatches = this.cap('maxMatchesPerAddr');
    if (maxRooms > 0 && this.rooms.size - oldRooms.size >= maxRooms) return fail(ERR.RATE, 'too many rooms');
    const keys = new Set(sessions.map((s) => s.limitKey).filter(Boolean));
    for (const key of keys) {
      const released = [...oldRooms].filter((r) => this.roomCharges(r, key)).length;
      if (perAddr > 0 && this.countRooms((r) => this.roomCharges(r, key)) - released >= perAddr) {
        return fail(ERR.RATE, 'too many rooms from your network');
      }
      if (maxMatches > 0 && this.countRooms((r) => !!r.match && this.matchCharges(r, key)) >= maxMatches) {
        return fail(ERR.RATE, 'too many running matches from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    const room = new Room(code, 'coop', difficulty, this.now());
    room.source = 'matchmaking';
    room.experimental = experimentalOptions(offer.experimental);
    room.ownerKeys = keys;
    room.ownerKey = sessions[0].limitKey || null;
    room.hostId = sessions[0].playerId;
    // Spectators follow the intact parties as observers, never seats/voters or charged participant networks.
    room.spectators = spectators.map((s) => ({ ...s }));
    room.seats = sessions.map((s, i) => ({
      ...this.humanSeat(i, s), ready: true, revivalVote: this.queue.entries.get(s.playerId).revivalVote,
    }));
    const result = this.startMatch(room, room.ownerKey, keys, { deferPublish: true });
    if (result.error) return result;
    // No await: quota validation, construction, successful start and membership commit share one turn.
    // Transfer old waiting rooms silently. disposeRoom would send room.closed AFTER membership moved,
    // which could clear the new game on clients. Old timers see disposed and cannot mutate this match.
    for (const old of oldRooms) {
      old.disposed = true;
      old.replay = null;
      this.rooms.delete(old.code);
      for (const seat of [...old.activeHumans(), ...old.spectators]) { this.clearGrace(seat.playerId); this.clearResync(seat.playerId); }
    }
    this.rooms.set(code, room);
    for (const session of [...sessions, ...spectators.map((s) => this.registry.byId(s.playerId))]) {
      session.roomCode = code; session.notice = null; session.pendingResult = null;
    }
    this.bindSpectatorAliases(oldRooms, room);
    return { code, publish: result.publish };
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const room = this.roomOf(session);
    const data = this.dataFor(room);
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    const cs = this.csOf(room);
    session.notOwned = list;
    session.notOwnedCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.notOwned = list; seat.notOwnedCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS — the room's own in a
   * room with gameplay plugins), store them on the session and the seat (see the header). A running match never takes
   * them: it keeps the picks its seat had at its start.
   */
  diy(session, { picks }) {
    const room = this.roomOf(session);
    const res = checkDiyPicks(picks, { data: this.dataFor(room), kitted: this.kittedFor(room) });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    const cs = this.csOf(room);
    session.diy = kept;
    session.diyCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.diy = kept; seat.diyCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /** Display-only choices follow loadout's INFO_CHECK contract, not ownership / DIY's start-time lock. */
  skins(session, { choices }) {
    if (!isSkinChoices(choices)) return fail(ERR.BAD_MSG, 'invalid skin choices');
    const kept = Object.freeze({ ...choices });
    session.skins = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.skins = kept;
    if (!room.match || !seat) return OK; // spectators store their own preference, never change a watched player
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try { r = room.match.setSkins(session.playerId, kept); }
    catch (e) {
      this.log.error(`[lobby] ${room.code} match.setSkins threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.card (header): merge the message into the session's display card — a field left out keeps its value, '' / 0
   * clears it; an unknown operator is BAD_MSG — and copy it to the player's seat (never a spectator's), broadcasting the
   * room state when it changed. An unchanged card costs nothing; a change beyond CARD_CHANGES per CARD_WINDOW_MS is RATE.
   * `art` / `face` are the Elite 1 / Elite 2 / skin variants of `charId` / `avatar` (see CARD_LIMITS): a skin that is
   * not that operator's own is dropped while the rest of the card still lands.
   */
  setCard(session, { charId, avatar, art, face, bg, trophies }) {
    const known = cardCharIds(this.safeData());
    if ((charId && !known.has(charId)) || (avatar && !known.has(avatar))) return fail(ERR.BAD_MSG, 'unknown operator');
    const prev = session.card || {};
    const next = {};
    const id = charId === undefined ? prev.charId : charId, back = bg === undefined ? prev.bg : bg;
    const faceId = avatar === undefined ? prev.avatar : avatar;
    const count = trophies === undefined ? prev.trophies : trophies;
    const variant = (value, keep, who) => {
      const v = value === undefined ? keep : value;
      if (!v) return '';
      if (v === 'e1' || v === 'e2') return v;
      const skinId = v.startsWith('skin:') ? v.slice(5) : '';
      return skinId && skinFor(who, skinId) ? v : '';
    };
    const artV = variant(art, prev.art, id), faceV = variant(face, prev.face, faceId);
    if (id) next.charId = id;
    if (faceId) next.avatar = faceId;
    if (artV) next.art = artV;
    if (faceV) next.face = faceV;
    if (back) next.bg = back;
    if (count > 0) next.trophies = count;
    const card = Object.keys(next).length ? Object.freeze(next) : null;
    if (sameCard(card, session.card)) return OK;
    let bucket = this.cardBuckets.get(session);
    if (!bucket) { bucket = new TokenBucket(CARD_CHANGES * 1000 / CARD_WINDOW_MS, CARD_CHANGES, this.now()); this.cardBuckets.set(session, bucket); }
    if (!bucket.take(this.now())) return fail(ERR.RATE, 'card changed too often');
    session.card = card;
    const room = this.roomOf(session);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (seat && !sameCard(seat.card, card)) {
      seat.card = card;
      this.broadcastState(room);
    }
    return OK;
  }

  /** The game data of a room's content (header "Gameplay plugins"): its content set's, else the server's. @param {Room | null} room */
  dataFor(room) {
    if (room?.modded) {
      try {
        const d = this.plugins?.dataOf?.(room.content.cs);
        if (d) return d;
      } catch (e) { this.log.error(`[lobby] ${room.code} content data failed`, e); }
    }
    return this.safeData();
  }

  /** The operators a 自选 slot may field in a room (its content set's list, else the vanilla one). @param {Room | null} room */
  kittedFor(room) {
    if (room?.modded) {
      try {
        const k = this.plugins?.kittedOf?.(room.content.cs);
        if (Array.isArray(k)) return k;
      } catch (e) { this.log.error(`[lobby] ${room.code} content 自选 list failed`, e); }
    }
    return KITTED_CHARS;
  }

  /** The content a setting stored now is checked for: the room's cs, else the server's vanilla one. @param {Room | null} room */
  csOf(room) { return room?.content?.cs ?? this.vanilla?.cs ?? null; }

  /**
   * A human seat's stored settings for a match of `room` (header "Gameplay plugins", the design study's §6.9): kept as
   * they are when they were checked for the room's content; filtered to its data otherwise — an id it does not know is
   * dropped, the rest kept (never the whole setting refused).
   * @param {Room} room @param {Seat} s @param {Readonly<Record<string, any>>} data
   */
  seatSettings(room, s, data) {
    const cs = this.csOf(room);
    const other = (checked) => !!cs && (checked ?? this.vanilla?.cs ?? null) !== cs;
    let loadout = s.loadout || null;
    let ops = s.ops || null;
    let notOwned = s.notOwned || null;
    let diy = s.diy || null;
    const chess = (id) => lookup('chess', id, data);
    if (loadout && other(s.loadoutCs)) {
      const keep = {};
      for (const [id, e] of Object.entries(loadout)) {
        const r = checkLoadout({ [id]: { skill: e.skill, ...(e.module != null ? { module: e.module } : {}) } }, chess);
        if (r && !r.error && r.loadout[id]) keep[id] = r.loadout[id];
      }
      loadout = freezeLoadout(keep);
      const ids = opsCharIds(data);
      const changes = (x) => charPotentialChanges(data, x);
      const keepOps = {};
      for (const [id, e] of Object.entries(ops || {})) {
        // a 潜能 that changes nothing on this content's operator (a plugin's char_x_ without a curve) is dropped, its 练度
        // kept — as the page's sanitizeOps does (public/js/ui/loadoutModel.js)
        const one = changes(id) === false ? { cultivate: e.cultivate } : { potential: e.potential, cultivate: e.cultivate };
        const r = checkLoadoutOps({ [id]: one }, (x) => ids.has(x), changes);
        if (r && !r.error && r.ops[id]) keepOps[id] = r.ops[id];
      }
      ops = freezeOps(keepOps);
    }
    if (notOwned && other(s.notOwnedCs)) {
      const r = checkNotOwned([...notOwned], chess);
      notOwned = r && !r.error ? Object.freeze(r.notOwned.slice()) : null;
    }
    if (diy && other(s.diyCs)) {
      const r = checkDiyPicks({ ...diy }, { data, kitted: this.kittedFor(room) });
      diy = r && 'ok' in r ? freezeDiy(r.picks) : null;
    }
    return { loadout, ops, notOwned, diy };
  }

  /**
   * Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`) and the
   * server's content identity (header "Content identity").
   */
  welcomeInfo() {
    if (!this.vanilla) return { diyKitted: KITTED_CHARS };
    let n;
    try { n = Number(this.plugins?.unofficial?.()) || 0; } catch { n = 0; }
    return { diyKitted: KITTED_CHARS, content: n > 0 ? { vanilla: this.vanilla.cs, plugins: n } : { vanilla: this.vanilla.cs } };
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** Factory hook; the default lobby still constructs exactly one local Match. */
  createMatch(opts) { return new this.MatchClass(opts); }

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null, keys = null, { deferPublish = false, restore = null } = {}) {
    if (!room.validCapacity() || !this.capacityClients(room)) return fail(ERR.BAD_MSG);
    const revival = room.revivalState();
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    // the room's data: its content set's in a room with gameplay plugins (header "Gameplay plugins")
    const data = this.dataFor(room);
    // `restore` (server/persist/persister.js): a match coming back from its checkpoint — its own seats, seed and number,
    // and `apply(match)` instead of start()
    const seats = restore ? restore.seats : room.seats.filter(Boolean).map((s) => {
      // a setting checked for another content is filtered to this room's data (header "Gameplay plugins")
      const own = s.isBot ? null : this.seatSettings(room, s, data);
      return {
        seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
        // DESIGN §16: the human's checked operator loadout and (0.2.2) per-operator 潜能 / 练度 (bots fight with the defaults)
        loadout: own ? own.loadout : null,
        ops: own ? own.ops : null,
        // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
        notOwned: own ? own.notOwned : null,
        // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
        diy: own ? own.diy : null,
        skins: Object.freeze({ ...(s.isBot ? {} : s.skins || {}) }),
        // room.setBotBand: an AI seat's designated strategy (absent when it picks by itself)
        ...(s.isBot && s.band ? { band: s.band } : {}),
      };
    });
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    // Only freshly allocated public matches defer publication. Snapshot messages now: Match may mutate
    // its state again during start(), and no startup frame may escape if construction/start fails.
    let pending = deferPublish ? [] : null;
    const dispatch = (send, msg) => {
      if (!ctx.live) return false;
      if (!pending) return send(msg);
      const data = encode(msg);
      if (data == null) throw new TypeError('unserializable match startup frame');
      pending.push(() => send(JSON.parse(data)));
      return true;
    };
    let seed = 0;
    try { seed = restore ? restore.seed >>> 0 : this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    const modded = room.modded;
    try {
      const opts = {
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        // a plugin mode the host chose (header "Gameplay plugins"), else the official mode of the difficulty
        modeId: room.content?.modeId || modeIdFor(room.mode, room.difficulty),
        revivalEnabled: revival.enabled,
        disableSharedPool: room.experimental.disableSharedPool,
        experimental: room.experimental,
        // 「AI 队友最后选择」 (GitHub #338): fixed for the match
        aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true,
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        // the room's host: the current executor of a delegated bot layout rehearsal (DESIGN §14; setHost follows a
        // migration while the match runs)
        hostId: room.hostId,
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: restore ? restore.matchNo : room.matchCount + 1,
        // the room's content hash (header "Content identity"): copied into every BattleSpec; its visual set too (a
        // replay names the art), and with gameplay plugins a b.result must name the room's cs (header "Gameplay plugins")
        ...(room.content ? { cs: room.content.cs } : {}),
        ...(room.content?.vs ? { vs: room.content.vs } : {}),
        ...(modded ? { requireCs: true } : {}),
        data,
        combatPool: this.combatPool,
        trialPool: this.trialPool,
        snapshotHz: this.opts.snapshotHz,
        afkRemoveRounds: this.opts.afkRemoveRounds,
        log: this.log,
        now: this.now,
        send: (playerId, msg) => dispatch((frame) => this.matchSend(room, ctx, playerId, frame), msg),
        sendEncoded: (playerId, type, data) => {
          if (!ctx.live) return false;
          if (!pending) return this.sendEncodedToPlayer(room, playerId, type, data);
          pending.push(() => this.sendEncodedToPlayer(room, playerId, type, data));
          return true;
        },
        broadcast: (msg) => { dispatch((frame) => this.matchBroadcast(room, ctx, frame), msg); },
        onEnd: (summary) => {
          if (pending) { ctx.ended = true; return; } // synchronous failed/ended startup is not a match
          this.onMatchEnd(room, ctx, summary);
        },
        // the match removed a human (the AFK rule): its seat departs like a g.leave
        onRemove: (playerId, removal) => {
          if (pending || !ctx.live || room.matchCtx !== ctx) return;
          this.matchRemoved(room, playerId, typeof removal?.reason === 'string' ? removal.reason : 'removed');
        },
        // a safe point for a checkpoint (server/match/snapshot.js; server/persist/persister.js sets onCheckpoint)
        onCheckpoint: (match, reason) => { if (ctx.live && room.matchCtx === ctx) this.onCheckpoint?.(room, ctx, match, reason); },
      };
      // a room with gameplay plugins plays in its content set's match host when this server has them; every other room
      // (and, in the cluster, every room: the game node runs the content set's match) as always (createMatch)
      const match = modded && this.hosts ? this.hosts.create(room.content.cs, opts) : this.createMatch(opts);
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.matchKeys = keys;
      room.revivalLocked = Object.freeze(revival);
      room.replay = null;
      room.matchCount = restore ? restore.matchNo : room.matchCount + 1;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} ${restore ? 'restored' : 'starting'} (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed}${modded ? `, content ${room.content.cs.slice(0, 8)}${match.hosted ? ' in its match host' : ''}` : ''})`);
      if (!deferPublish) this.broadcastState(room);
      const started = restore ? restore.apply(match) : match.start();
      if (deferPublish && started && typeof started.then === 'function') {
        Promise.resolve(started).catch((e) => this.log.error(`[lobby] ${room.code} asynchronous start rejected`, e));
        throw new TypeError('public match start must be synchronous');
      }
      if (deferPublish && (ctx.ended || room.match !== match)) throw new Error('public match ended during startup');
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; room.matchKeys = null; room.revivalLocked = null; }
      this.disposeMatchCtx(ctx);
      if (!deferPublish) this.broadcastState(room);
      // the match hosts refuse one content set more than they run (PLUGIN_BUSY: server/match/host/index.js)
      return fail(e && isErrCode(e.code) ? e.code : ERR.INTERNAL, 'match failed to start');
    }
    if (!deferPublish) return OK;
    return { ok: true, publish: () => {
      if (!pending || !ctx.live || room.matchCtx !== ctx) return;
      const frames = pending;
      pending = null;
      this.broadcastState(room);
      for (const send of frames) send();
    } };
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    this.clearSpectatorAliases(ctx);
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.matchKeys = null;
    room.revivalLocked = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    // a match of gameplay plugins whose match host stopped (header "Gameplay plugins"; its members were told: proxy.js)
    const why = summary && typeof summary.reason === 'string' && summary.reason.startsWith('plugin-') ? ` (${summary.reason}${summary.detail ? `: ${summary.detail}` : ''})` : '';
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended${why}`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      s.revivalVote = null;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else {
      this.broadcastState(room);
      // its plugins changed on disk during the match: the host can apply them again now
      if (room.pluginsChanged) this.tellPluginsChanged(room);
    }
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (this.queuedRoom(session)) { this.queueEvent(room, () => this.resyncNow(session)); return; }
    this.resyncNow(session);
  }

  /** runResync, now. @param {import('./net.js').Session} session */
  resyncNow(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** A warning logged once per text (the default plugins that cannot be applied …). @param {string} line */
  warnOnce(line) {
    if (this.told.has(line)) return;
    if (this.told.size < 256) this.told.add(line);
    this.log.warn(line);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /**
   * Route a 'g.*' intent or a 'b.*' report (server/net.js) to the running match — on the room's queue when its match runs
   * in a match host (header "Gameplay plugins").
   */
  routeGame(session, msg) {
    const room = this.queuedRoom(session);
    return room ? this.serial(room, () => this.routeGameNow(session, msg)) : this.routeGameNow(session, msg);
  }

  /** routeGame, now. */
  routeGameNow(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // a match in a match host answers later (header "Gameplay plugins"): the reply waits for it
      if (room.match?.hosted === true) {
        return Promise.resolve(res).then((r) => matchAnswer(r), (e) => {
          this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e);
          return fail(ERR.INTERNAL);
        });
      }
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    return matchAnswer(res);
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    this.clearSpectatorAliases(ctx);
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null, revivalVote: null,
      ops: session.ops || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
      skins: Object.freeze({ ...(session.skins || {}) }),
      card: session.card || null,
      owner: session.owner === true,
      // the content each was checked for (header "Gameplay plugins": filtered at the match start when it is another)
      loadoutCs: session.loadoutCs ?? null,
      notOwnedCs: session.notOwnedCs ?? null,
      diyCs: session.diyCs ?? null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    // Kick, room switching and grace removal cancel an indivisible party before its membership changes.
    if (session && session.roomCode === room.code) { this.queue.remove(session, 'cancelled'); session.roomCode = null; }
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    // the last player online leaving lets its dropped teammates' windows run again
    if (room.match) this.refreshMatchWindows(room);
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * A match removed one of its humans (Match opts.onRemove: the AFK rule, reason 'afk' — it already sent the player
   * m.removed): the seat departs exactly like a g.leave (removeMember → match.onLeave; freed when the match ends). A player
   * removed while offline is told on its next resume: room.closed { reason }.
   * @param {Room} room @param {string} playerId @param {string} reason
   */
  matchRemoved(room, playerId, reason) {
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    const session = this.registry.byId(playerId);
    const offline = !!session && session.roomCode === room.code && !session.connected;
    this.matchDepartures[offline ? 'afkOffline' : 'afkOnline']++;
    this.removeMember(room, playerId);
    if (offline) session.notice = reason;
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
    // a running match follows the host change: its delegated bot rehearsals fall back to the server and later ones ask
    // the new host (DESIGN §14, Match.setHost)
    if (room.match && room.hostId !== prev) this.callMatch(room, 'setHost', room.hostId);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) { this.trustedRuntime?.event('roomClosed',{room:room.toState()}); this.rooms.delete(room.code); }
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.matchKeys = null;
    room.revivalLocked = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty' || this.closingQuietly) continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (this.closingQuietly) continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    // the room's visual set and content set are no longer held by it (server/plugins/visualSet.js, contentSets.js)
    this.releaseContent(room.content);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code) && !this.spectatorAliases.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    if (this.trustedRuntime) {
      const state = room.toState(), prev = room.trustedPrevious;
      const event = (name,extra={}) => this.trustedRuntime.event(name,{room:state,...extra});
      if (!prev) event('roomCreated');
      const before = new Set((prev?.seats || []).filter(Boolean).map(s => s.playerId));
      const after = new Set(state.seats.filter(Boolean).map(s => s.playerId));
      for (const id of after) if (!before.has(id)) event('playerJoined',{playerId:id});
      for (const id of before) if (!after.has(id)) event('playerLeft',{playerId:id});
      if (state.inMatch && !prev?.inMatch) event('matchStarted');
      room.trustedPrevious = state;
    }
    const data = encode(room.toState());
    sendEncodedMany([...this.memberSessions(room)].map((session) => session.ws), data);
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    for (const session of this.memberSessions(room)) sendMessage(session.ws, msg, data);
    return data;
  }

  /** Only live battle frames use this path: result replay still goes through matchSend/matchBroadcast. */
  sendEncodedToPlayer(room, playerId, type, data) {
    if (room.disposed || !['m.field', 'b.snap', 'b.ev', 'm.damage', 'b.damage'].includes(type) || typeof data !== 'string') return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session?.connected || session.roomCode !== room.code) return false;
    return sendRaw(session.ws, data, { droppable: type === 'b.snap', compress: isCompressibleType(type) });
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
