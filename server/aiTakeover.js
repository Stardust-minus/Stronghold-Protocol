// Game-owned spectator-to-AI handover. No monitor or administrator API dependency.
// A match on a game node (remoteAiTakeover, ClusterLobby): the room, its seats and the votes are the coordinator's, the
// match is the node's. A request asks the node for the seat (m.aiSeat, phase PREP, the round, who is on autoplay); a passed
// vote has the node make the seat a human's in one step (m.transferAiSeat, GameHost.transferAiSeat, fenced by that round),
// and only then the coordinator follows it (ClusterLobby.transferRemoteSeat). A refused or unanswered transfer changes
// nothing: the applicant keeps watching. Both run on the room's queue, so no message of the room crosses them.
import { ERR } from '../shared/constants.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { resetStateDelta, stateDeltaVersion } from './stateTransport.js';
const fail = detail => ({ error: ERR.BAD_TARGET, detail });
const pending = new WeakMap();
export function resetAiTakeover(room) {
  const votes = pending.get(room);
  if (votes) { for (const vote of votes.values()) clearTimeout(vote.timer); votes.clear(); }
  room.aiTakeoverVotes = [];
}
function voters(room, autoplay) {
  const seats = room.seats.filter(s => s && !s.isBot && !s.left && s.connected);
  const ids = seats.filter(s => !autoplay(s.playerId)).map(s => s.playerId);
  if (!ids.length && room.seatOf(room.hostId)?.connected) ids.push(room.hostId);
  return ids;
}
export function takeoverVoters(room) {
  const m = room.match;
  return voters(room, id => m.players.get(id)?.autoplay);
}
/** Whether the match can hand `botId`'s seat over right now. */
export function aiSeatOpen(m, botId) {
  const ps = m?.players?.get(botId);
  return !!ps?.isBot && !ps.left && !!ps.alive && m.phase === 'PREP' && !m.ended && !m.disposed && !m.emergencyFrozen;
}
/**
 * The match side of a handover (aiSeatOpen first): the seat is a human's from now on. `connected`: this process already
 * has the player's socket; a game node's seat comes online as the new channel binds (GameHost.bind).
 */
export function adoptAiSeat(m, botId, name, connected) {
  const ps = m.players.get(botId);
  ps._botPrepToken = (ps._botPrepToken || 0) + 1;
  m.cancelSeatRehearsal(botId);
  Object.assign(ps, { isBot: false, autoplay: false, connected, ready: false, name });
  m.loneHuman = m.order.filter(p => !p.isBot && !p.left).length === 1;
  ps.aiTakeoverRound = m.round;
  m.markPublic(); ps.dirty();
}
/** The lobby side: the applicant's spectator seat is gone and its session answers to the AI seat's id. */
export function rebindSession(lobby, room, session, botId) {
  const applicantId = session.playerId;
  lobby.removeMember(room, applicantId); lobby.clearResync(applicantId);
  lobby.registry.byPlayerId.delete(applicantId); session.playerId = botId; lobby.registry.byPlayerId.set(botId, session);
  session.roomCode = room.code; session.notice = null; session.pendingResult = null; session.resyncAt = -Infinity;
  session.aiTakeoverFrom = applicantId;
}
/** The socket is told its new identity; what a repeated hello gets follows (room state, the match). */
export function welcomeAgain(lobby, conn) {
  resetStateDelta(conn.ws);
  lobby.network.rewelcome(conn, stateDeltaVersion(conn.ws), lobby.now());
}
export function transferAiSeat(lobby, room, applicantId, botId) {
  const m = room.match, session = lobby.registry.byId(applicantId), spectator = room.spectatorOf(applicantId);
  const seat = room.seatOf(botId);
  if (room.aiTakeoverEnabled !== true || room.mode !== 'coop' || room.version !== DEFAULT_VERSION) return fail('AI handover is disabled');
  if (!session?.connected || !session.ws || !spectator || !seat || !aiSeatOpen(m, botId)) return fail('AI handover unavailable');
  if (room.modded || m.hosted) return fail('AI handover is unavailable in isolated plugin matches');
  if (lobby.registry.byId(botId)) return fail('AI seat already has a session');
  const conn = lobby.network?.conns.get(session.ws);
  if (!conn || conn.closing) return fail('connection unavailable');
  rebindSession(lobby, room, session, botId);
  adoptAiSeat(m, botId, session.name, true);
  Object.assign(seat, { isBot: false, connected: true, left: false, ready: false, name: session.name });
  welcomeAgain(lobby, conn);
  lobby.broadcastState(room); return { ok: true };
}
// [ASSUMED] Any electorate change cancels rather than lowering the approval threshold.
function drop(votes, id) {
  clearTimeout(votes.get(id)?.timer);
  votes.delete(id);
}
function snapshot(room, votes) {
  room.aiTakeoverVotes = [...votes.values()].map(v => ({ id: v.id, applicantId: v.applicantId,
    applicantName: v.applicantName, botId: v.botId, expiresAt: v.expiresAt, eligible: v.eligible,
    yes: [...v.yes], no: [...v.no] }));
}
export function reconcileAiTakeover(lobby, room) {
  const votes = pending.get(room);
  if (!votes?.size) return false;
  const m = room.match;
  let changed = false;
  for (const [id, v] of votes) {
    const applicant = lobby.registry.byId(v.applicantId), bot = m?.players?.get(v.botId);
    // v.autoplay: a vote on a game node's match (remoteAiTakeover), whose phase only the node knows: its transfer is fenced there
    const eligible = !m ? [] : v.autoplay ? voters(room, pid => v.autoplay.has(pid)) : takeoverVoters(room);
    if (room.aiTakeoverEnabled !== true || room.modded || m?.hosted || room.version !== DEFAULT_VERSION
      || m !== v.match || (v.autoplay ? m.ended || !room.seatOf(v.botId)?.isBot : m.phase !== 'PREP' || m.round !== v.round || m.ended || m.disposed || m.emergencyFrozen)
      || !room.spectatorOf(v.applicantId)?.connected || !applicant?.connected || applicant.roomCode !== room.code
      || (!v.autoplay && (!bot?.isBot || !bot.alive || bot.left)) || Date.now() >= v.expiresAt
      || eligible.length !== v.eligible.length || eligible.some((id, i) => id !== v.eligible[i])) {
      drop(votes, id); changed = true;
    }
  }
  if (changed) snapshot(room, votes);
  return changed;
}
/** The votes of `room`, and how a change reaches its members. */
function ballot(lobby, room) {
  let votes = pending.get(room); if (!votes) pending.set(room, votes = new Map());
  return { votes, sync: () => { snapshot(room, votes); lobby.broadcastState(room); } };
}
function openVote(room, { votes, sync }, fields) {
  const id = String(room.aiTakeoverSeq = (room.aiTakeoverSeq || 0) + 1);
  // [ASSUMED] A 30-second vote expires without approval; the whole room elects by strict majority.
  const vote = { id, ...fields, expiresAt: Date.now() + 30000, yes: new Set(), no: new Set() };
  votes.set(id, vote);
  vote.timer = setTimeout(() => { if (votes.get(id) === vote) { drop(votes, id); sync(); } }, 30000);
  vote.timer.unref?.(); sync(); return { ok: true };
}
/** room.aiVote; `transfer(vote)` once it passes: its answer, or a Promise of it. */
function castVote(session, msg, { votes, sync }, transfer) {
  const vote = votes.get(msg.voteId);
  if (!vote) return fail('request expired');
  if (!vote.eligible.includes(session.playerId)) return fail('only online human room teammates can vote');
  (msg.approve ? vote.no : vote.yes).delete(session.playerId);
  (msg.approve ? vote.yes : vote.no).add(session.playerId);
  const required = Math.floor(vote.eligible.length / 2) + 1;
  if (vote.no.size >= required) { drop(votes, vote.id); sync(); return { ok: true }; }
  if (vote.yes.size >= required) {
    drop(votes, vote.id);
    const done = result => { sync(); return result; };
    const result = transfer(vote);
    return typeof result?.then === 'function' ? result.then(done) : done(result);
  }
  sync(); return { ok: true };
}
export function aiTakeover(lobby, session, msg) {
  const room = lobby.roomOf(session), m = room?.match;
  if (room && reconcileAiTakeover(lobby, room)) lobby.broadcastState(room);
  if (!room || room.aiTakeoverEnabled !== true || room.mode !== 'coop' || room.version !== DEFAULT_VERSION || !m || m.hosted || room.modded || m.phase !== 'PREP' || m.ended || m.disposed || m.emergencyFrozen) return fail('AI handover requires preparation in an original-content match');
  const open = ballot(lobby, room), { votes } = open;
  if (msg.t === 'room.aiRequest') {
    const bot = m.players.get(msg.botId);
    if (!room.spectatorOf(session.playerId) || !session.connected || !bot?.isBot || bot.left || !bot.alive) return fail('a spectator must select an active AI');
    if ([...votes.values()].some(v => v.applicantId === session.playerId || v.botId === msg.botId)) return fail('request already pending');
    const eligible = takeoverVoters(room);
    if (!eligible.length) return fail('no online voter available');
    return openVote(room, open, { applicantId: session.playerId, applicantName: session.name, botId: msg.botId, match: m, round: m.round, eligible });
  }
  return castVote(session, msg, open, vote => transferAiSeat(lobby, room, vote.applicantId, vote.botId));
}
/**
 * room.aiRequest / room.aiVote in a room whose match runs on a game node (the header). The answer is a Promise while the
 * node is asked; the room's queue keeps its other messages behind it.
 */
export function remoteAiTakeover(lobby, session, msg) {
  const room = lobby.roomOf(session), m = room?.match;
  if (room && reconcileAiTakeover(lobby, room)) lobby.broadcastState(room);
  if (!room || room.aiTakeoverEnabled !== true || room.mode !== 'coop' || room.version !== DEFAULT_VERSION || !m || room.modded || m.ended) return fail('AI handover requires preparation in an original-content match');
  return lobby.serial(room, async () => {
    const open = ballot(lobby, room), { votes } = open;
    if (msg.t !== 'room.aiRequest') return castVote(session, msg, open, vote => lobby.transferRemoteSeat(room, vote));
    const free = () => room.match === m && !m.ended && !!room.spectatorOf(session.playerId) && session.connected && !!room.seatOf(msg.botId)?.isBot
      && ![...votes.values()].some(v => v.applicantId === session.playerId || v.botId === msg.botId);
    if (!free()) return fail('a spectator must select an active AI');
    const seat = await m.aiSeat(session.playerId, msg.botId);
    if (seat.error || !free()) return fail('AI handover requires preparation in an original-content match');
    const autoplay = new Set(seat.autoplay);
    const eligible = voters(room, id => autoplay.has(id));
    if (!eligible.length) return fail('no online voter available');
    return openVote(room, open, { applicantId: session.playerId, applicantName: session.name, botId: msg.botId, match: m, round: seat.round, eligible, autoplay });
  });
}
