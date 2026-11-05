// In-match intents (`g.*`, DESIGN §8.2) with uniform error handling: every request goes through
// `act()`, which plays a UI sound on success, shows the ERR_TEXT toast on failure and never throws.
// Since rel26 the prep intents the server acknowledges (buy, sell, move, refresh, freeze, level-up) are predicted:
// ui/prediction.js shows their outcome at once and replays it over every m.private until the server's state contains
// it (the server stays the authority; a refusal simply restores its state). A predicted intent plays its sound at
// once; everything else waits for the reply as before. Requests always leave in the order they were made.
// `net.request` is looked up at call time (ui/prediction.js) so the dev mock harness can stub it.

import { toastError } from './toasts.js';
import { audio } from '../audio.js';
import { prediction } from './prediction.js';

const SUCCESS_SFX = {
  'g.buy': 'buy', 'g.sell': 'sell', 'g.refresh': 'refresh', 'g.freeze': 'freeze', 'g.levelUp': 'levelup',
  'g.move': 'drop', 'g.equip': 'equip', 'g.art': 'artPlace', 'g.reward': 'pick', 'g.choice': 'pick',
  'g.band': 'confirm', 'g.bandSkip': 'back', 'g.bandHold': 'pick', 'g.bandCancel': 'back', 'g.bandLock': 'confirm', 'g.infoReady': 'ready', 'g.emote': 'emote', 'g.destroy': 'back', 'g.unequip': 'back',
};

let inflight = 0;
const busyListeners = new Set();
const emitBusy = () => { for (const fn of [...busyListeners]) { try { fn(inflight); } catch { /* ignore */ } } };

/** Subscribe to the number of in-flight intents (for subtle busy indicators). */
export function onBusy(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }

// Single-flight shop refresh (GitHub #501, single-ptilopsis): under a high RTT the shop has not answered yet while the
// player taps 刷新 again — every extra g.refresh the client sends is a paid refresh (server/match intents.js → ps.refresh).
// A tap while the previous request is still on the wire is dropped; the button dims and the R hotkey stays inert (both
// call actions.refresh) until the request settles (success or failure). This is not server-side cancellation or
// idempotency: a timed-out request may already have executed. The shop bar receives onRefreshBusy via the game screen.
let refreshPending = false;
const refreshBusyListeners = new Set();
const emitRefreshBusy = () => { for (const fn of [...refreshBusyListeners]) { try { fn(refreshPending); } catch { /* ignore */ } } };

/**
 * Subscribe to the shop refresh's in-flight state — fires once with the current state.
 * @param {(busy: boolean) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onRefreshBusy(fn) { refreshBusyListeners.add(fn); try { fn(refreshPending); } catch { /* ignore */ } return () => refreshBusyListeners.delete(fn); }

/**
 * Send an intent. Resolves true on `ok`, false on error (already toasted).
 * @param {string} t
 * @param {object} [fields]
 * @param {{ sfx?: string|false, quiet?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function act(t, fields = {}, opts = {}) {
  inflight += 1;
  emitBusy();
  const s = opts.sfx === undefined ? SUCCESS_SFX[t] : opts.sfx;
  try {
    const { promise, predicted } = prediction.submit(t, fields);
    if (predicted && s) audio.sfx(s);
    await promise;
    if (!predicted && s) audio.sfx(s);
    return true;
  } catch (err) {
    if (!opts.quiet) {
      toastError(err);
      audio.sfx('error', { volume: 0.6 });
    }
    return false;
  } finally {
    inflight = Math.max(0, inflight - 1);
    emitBusy();
  }
}

export const actions = {
  infoReady: (setupRevision = 0) => act('g.infoReady', { setupRevision }),
  // 自选候补 (feedback #114): the candidates of one tier that fill its slots (the briefing's 自选上场)
  diyChoose: (tier, charIds) => act('g.diyChoose', { tier, charIds }, { sfx: 'confirm' }),
  rerollSetup: (setupRevision) => act('room.rerollSetup', { setupRevision }, { sfx: 'confirm' }),
  rerollVote: (voteId, agree) => act('g.rerollVote', { voteId, agree }, { sfx: agree ? 'confirm' : 'back' }),
  cancelReroll: (voteId) => act('room.cancelReroll', { voteId }, { sfx: 'back' }),
  band: (bandId) => act('g.band', { bandId }),
  bandSkip: () => act('g.bandSkip'),
  // a free draft (server MatchPhases.freeDraft): the tentative choice, its cancel and its 锁定
  bandHold: (bandId) => act('g.bandHold', { bandId }),
  bandCancel: () => act('g.bandCancel'),
  bandLock: () => act('g.bandLock'),
  buy: (slot) => act('g.buy', { slot }),
  // a tap while the previous g.refresh is still on the wire is dropped (GitHub #501) — see onRefreshBusy above
  refresh: () => {
    if (refreshPending) return Promise.resolve(false);
    refreshPending = true;
    emitRefreshBusy();
    return act('g.refresh').finally(() => { refreshPending = false; emitRefreshBusy(); });
  },
  freeze: () => act('g.freeze'),
  levelUp: () => act('g.levelUp'),
  sell: (uid) => act('g.sell', { uid }),
  // `dir` (UP|RIGHT|DOWN|LEFT): the direction chosen with the deploy wheel (research 09 §6.1 — g.move / g.art carry it;
  // the server defaults to RIGHT when absent)
  move: (uid, to, dir) => act('g.move', dir ? { uid, to, dir } : { uid, to }),
  // `replaceUid`: the equipped item the replace dialog picked (ui/equipReplace.js) — it is destroyed; absent ⇒ none needed
  equip: (itemUid, targetUid, replaceUid) => act('g.equip', Number.isInteger(replaceUid) ? { itemUid, targetUid, replaceUid } : { itemUid, targetUid }),
  art: (itemUid, row, col, dir) => act('g.art', dir ? { itemUid, row, col, dir } : { itemUid, row, col }),
  destroy: (uid) => act('g.destroy', { uid }),
  unequip: (itemUid) => act('g.unequip', { itemUid }),
  reward: (idx) => act('g.reward', { idx }),
  offer: (offer, idx, refresh = false, cardId) => act(refresh ? 'g.offerRefresh' : 'g.offer', { offerId: offer.id, pluginId: offer.pluginId, seq: offer.seq, idx, cardId }),
  choice: (idx, choiceId) => act('g.choice', choiceId === undefined ? { idx } : { idx, choiceId }),
  ready: (ready) => act('g.ready', { ready }, { sfx: ready ? 'ready' : 'back' }),
  emote: (id) => act('g.emote', { id }, { quiet: true }),
  // `playerId`: the player tapped in the team panel (a shared field shows two) — what an eliminated viewer follows
  watch: (fieldId, playerId = null) => act('g.watch', typeof playerId === 'string' && playerId ? { fieldId, playerId } : { fieldId }, { sfx: 'tab' }),
  autoplay: (on) => act('g.autoplay', { on }),
  // solo battles only (ui/matchStatus.js pauseAvailable): m.public.paused follows
  pause: (on) => act('g.pause', { on: !!on }, { sfx: on ? 'click' : 'confirm' }),
  // 战斗 2 倍速: this seat's standing vote (m.public speedVote follows)
  speedVote: (agree) => act('g.speedVote', { agree: !!agree }, { sfx: agree ? 'confirm' : 'back' }),
  // room-level intent (NOT g.*): the host frees a spectator seat while the match runs — the server takes room.removeSpectator at
  // any time (server/lobby.js removeSpectator), the game screen had no entry for it (ui/hud.js SpectatorPill; GitHub #120)
  removeSpectator: (playerId) => act('room.removeSpectator', { playerId }, { sfx: 'back' }),
};
