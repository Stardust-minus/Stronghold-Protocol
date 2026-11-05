// 确认入场's sounds (2026-11-05, the user: 「匹配到人之后需要添加动效和音效」; docs/history/0.3.3.md 「匹配成功确认页」): one listener on
// the store's queue state, installed once by main.js, so a cue plays whichever screen is up (the takeover covers them
// all, ui/matchOffer.js) and never twice — a re-render, a re-mounted takeover or a reconnect's re-sent queue.state (the
// same offerId) is no new event (offerCueStep). The cues are drawn in code (ui/offerSynth.js, through audio.synth into
// the SFX channel: mute and the SFX volume apply; nothing new is shipped):
//   arrive   — a new offer (offerId): a riser into an impact, landing with the title's slam
//   peer     — acceptedCount rose by someone other than me: a crisp tick
//   mine     — my accept is on the server (queue.accepted): a confirm hit
//   tick     — 5, 4, 3, 2, 1 s left while I have not confirmed: a dry click (offerTick, each second once)
//   allReady — everyone is in (allocationPending, the count full, or matched before that was heard): a whoosh
//   broken   — the offer fell apart (the ticket waits again, or out with the server's reason): a falling tone
// While an offer stands the audio context stays awake in a hidden tab (audio.keepAwake 'offer'): a doctor waiting in
// another tab hears the arrival, and only the SFX channel sounds there (the music and voices wait for the page).

import { audio } from '../audio.js';
import { serverNow } from '../store.js';
import { OFFER_URGENT_S, offerSize } from './matchOffer.js';
import { playOfferSynth } from './offerSynth.js';

/** cue → its volume (ui/offerSynth.js draws each one) */
export const OFFER_CUES = Object.freeze({ arrive: 1, peer: 0.8, mine: 0.9, tick: 0.55, allReady: 0.9, broken: 0.7 });

/**
 * The cues of one queue update (pure). `memo` is what this page last heard of the standing offer (null: none).
 * @param {null|{ offerId: any, count: number, accepted: boolean, allReady: boolean, tick: number|null }} memo
 * @param {any} q store queue (queue.state)
 * @returns {{ memo: null|{ offerId: any, count: number, accepted: boolean, allReady: boolean, tick: number|null }, cues: string[] }}
 */
export function offerCueStep(memo, q) {
  if (q?.state !== 'offered' || q.offerId == null) {
    const cues = !memo ? []
      : q?.state === 'matched' ? (memo.allReady ? [] : ['allReady'])
      : q?.state === 'queued' || (q?.state === 'idle' && typeof q.reason === 'string' && q.reason !== 'cancelled') ? ['broken'] : [];
    return { memo: null, cues };
  }
  const count = Number.isSafeInteger(q.acceptedCount) && q.acceptedCount > 0 ? q.acceptedCount : 0;
  const accepted = q.accepted === true;
  const allReady = q.allocationPending === true || (accepted && count >= offerSize(q));
  if (!memo || memo.offerId !== q.offerId) {
    return { memo: { offerId: q.offerId, count, accepted, allReady, tick: null }, cues: [allReady ? 'allReady' : 'arrive'] };
  }
  const cues = [];
  const mineNow = accepted && !memo.accepted;
  if (count - memo.count - (mineNow ? 1 : 0) > 0) cues.push('peer');
  if (mineNow) cues.push('mine');
  if (allReady && !memo.allReady) cues.push('allReady');
  return { memo: { ...memo, count: Math.max(memo.count, count), accepted: memo.accepted || accepted, allReady: memo.allReady || allReady }, cues };
}

/**
 * The countdown second to tick now, or null: OFFER_URGENT_S … 1 s left on the offer `memo` follows, before my accept
 * and before everyone is in; each second once (memo.tick).
 * @param {any} memo offerCueStep's @param {any} q @param {number} now serverNow()
 */
export function offerTick(memo, q, now) {
  if (!memo || memo.allReady || q?.state !== 'offered' || q.offerId !== memo.offerId || q.accepted === true || q.allocationPending === true) return null;
  const s = Math.max(0, Math.ceil(((q.deadline || 0) - now) / 1000));
  return s >= 1 && s <= OFFER_URGENT_S && s !== memo.tick ? s : null;
}

/**
 * Wire the cues to the store (main.js, once). Returns the uninstaller.
 * @param {{ subscribe: (fn: (s: any, prev: any) => void) => () => void, getState: () => any,
 *   play?: (cue: string, volume: number) => void, awake?: (on: boolean) => void, now?: () => number,
 *   every?: (fn: () => void, ms: number) => any, stop?: (id: any) => void }} deps
 */
export function installOfferCues({ subscribe, getState,
  play = (cue, volume) => audio.synth((ctx, out, v) => playOfferSynth(ctx, out, cue, v), volume, `offer:${cue}`),
  awake = (on) => audio.keepAwake('offer', on), now = serverNow,
  every = (fn, ms) => setInterval(fn, ms), stop = (id) => clearInterval(id) }) {
  let memo = null, timer = null;
  const fire = (cue) => { try { play(cue, OFFER_CUES[cue]); } catch { /* never breaks the page */ } };
  const tickNow = () => {
    const s = offerTick(memo, getState().queue, now());
    if (s == null) return;
    memo = { ...memo, tick: s };
    fire('tick');
  };
  const sync = (q) => {
    const step = offerCueStep(memo, q);
    memo = step.memo;
    for (const cue of step.cues) fire(cue);
    try { awake(!!memo); } catch { /* ignore */ }
    if (memo && timer == null) timer = every(tickNow, 250);
    else if (!memo && timer != null) { stop(timer); timer = null; }
    if (memo) tickNow();
  };
  sync(getState().queue);
  const unsub = subscribe((s, prev) => { if (s.queue !== prev?.queue) sync(s.queue); });
  return () => {
    unsub();
    if (timer != null) stop(timer);
    timer = null;
    try { awake(false); } catch { /* ignore */ }
  };
}
