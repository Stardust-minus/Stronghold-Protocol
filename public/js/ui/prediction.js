// ui/prediction.js — client-side prediction of the prep intents (rel26; the owner's request of 2026-11-02: 商店购买、出售、
// 部署干员、刷新 must not wait for the server under a high RTT or packet loss).
//
// Every g.* intent of ui/gameActions.js goes through `submit`. While the server acknowledges intents (m.private `ack`,
// shared/protocol.js ACKED_INTENTS — a rel25 server never does, and the prediction stays off) and the own seat is in its
// prep, a predictable intent (ui/gameLogic/predict.js) is applied to the shown m.private at once and stays pending:
//   - every authoritative m.private (main.js → `authoritative`) is shown with the still-pending intents replayed over it;
//   - an intent leaves the pending list when a state whose `ack` is at least its rid arrives (that state contains it,
//     whatever the server made of it), when its request fails (refused, timed out, the socket dropped — the reply of a
//     sent request is never resent, so a dropped intent can never be applied twice), or SETTLE_MS after its reply
//     without such a state;
//   - the server stays the only authority: a refused or different outcome is replaced by the next state.
// A piece bought by prediction has a negative placeholder uid. An intent that names it (dragged onto the board, sold,
// equipped) is shown at once but sent only when the purchase is acknowledged and the real uid is known
// (gameLogic/predict.js resolveBought); intents are always sent in the order they were made, so every intent made after a
// waiting one waits too — the server applies them in the order the prediction did.

import { isPredictable, replayIntents, resolveBought, pieceUids } from './gameLogic/predict.js';
import { net } from '../net.js';
import { store } from '../store.js';
import { data } from '../data.js';
import { PHASE } from '../../../shared/constants.js';

/** An acknowledged-but-unseen intent is dropped from the replay this long after its reply. [ASSUMED] */
export const SETTLE_MS = 3000;
const UID_FIELDS = ['uid', 'itemUid', 'targetUid', 'replaceUid'];

/** An error like net.js NetError (ui/toasts.js toastError reads `code`). */
const refusal = (code) => Object.assign(new Error(code), { code });

/**
 * @param {{
 *   request: (t: string, fields: object, opts: { onRid: (rid: number) => void }) => Promise<any>,
 *   lookups: { getChess: (id: string) => any, getItem: (id: string) => any },
 *   publish: (view: any) => void,
 *   canPredict?: () => boolean,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 * }} deps
 */
export function createPrediction({ request, lookups, publish, canPredict = () => true, timers = globalThis }) {
  let auth = null;              // the last authoritative m.private
  let ackSeen = false;          // the server acknowledges intents (m.private carries `ack`)
  let ack = 0;
  let before = new Set();       // piece uids of `auth`
  let made = new Map();         // op id → the placeholder its purchase made (the last replay)
  let resolved = new Map();     // placeholder uid → the real uid, once known (a drag begun on the placeholder may end later)
  let ops = [];                 // pending, in order: { id, t, fields, dep, sent, rid, replied, timer, resolve, reject }
  let nextId = 1;

  const replay = () => {
    if (!auth || !ops.some((o) => o.predict)) return { priv: auth, made: new Map(), applied: new Set() };
    return replayIntents(auth, ops.filter((o) => o.predict), lookups);
  };
  const view = () => { const r = replay(); made = r.made; return r.priv; };
  const show = () => publish(view());

  function drop(op) {
    const i = ops.indexOf(op);
    if (i < 0) return false;
    ops.splice(i, 1);
    if (op.timer != null) { try { timers.clearTimeout(op.timer); } catch { /* ignore */ } op.timer = null; }
    return true;
  }

  /** The intents waiting on `op`'s placeholder fail with it. */
  function failDependents(op, err) {
    for (const d of ops.filter((o) => o.dep === op.id)) {
      drop(d);
      failDependents(d, err);
      d.reject(err);
    }
  }

  function send(op) {
    op.sent = true;
    let p;
    try { p = Promise.resolve(request(op.t, op.fields, { onRid: (rid) => { op.rid = rid; } })); }
    catch (err) { p = Promise.reject(err); }
    p.then((reply) => {
      op.replied = true;
      // nothing to wait for: not predicted, the server does not acknowledge, or its state already arrived
      if (!op.predict || !ackSeen || (op.rid != null && ack >= op.rid)) { if (drop(op) && op.predict) show(); }
      else if (ops.includes(op)) op.timer = timers.setTimeout(() => { op.timer = null; if (drop(op)) { show(); pump(); } }, SETTLE_MS);
      pump();
      op.resolve(reply);
    }, (err) => {
      const was = drop(op);
      failDependents(op, err);
      if (was) show();
      pump();
      op.reject(err);
    });
  }

  /** Send what may go now: in order, up to the first intent still waiting for a purchase's uid. */
  function pump() {
    for (const op of ops) {
      if (op.sent) continue;
      if (op.dep != null) break;
      send(op);
    }
  }

  return {
    /**
     * An authoritative m.private arrived: drop what it contains, resolve placeholders, send what can go; returns the
     * view to show.
     * @param {any} priv
     */
    authoritative(priv) {
      if (!priv || (auth && priv.playerId !== auth.playerId)) this.reset();
      if (!priv) return priv;
      if (Number.isInteger(priv.ack)) { ackSeen = true; ack = priv.ack; }
      const lastMade = made;
      for (const op of [...ops]) {
        if (!op.sent || op.rid == null || op.rid > ack) continue;
        // the placeholder the last replay showed, else (that replay could not apply the purchase) its card's id
        const m = lastMade.get(op.id) || (op.buyId ? { uid: -op.id, idx: -1, id: op.buyId, kind: op.buyKind } : null);
        if (m) {
          const real = resolveBought(priv, before, m);
          if (real != null) resolved.set(m.uid, real);
          for (const d of ops.filter((o) => o.dep === op.id)) {
            if (real == null) { drop(d); failDependents(d, refusal('BAD_TARGET')); d.reject(refusal('BAD_TARGET')); continue; }
            for (const k of UID_FIELDS) if (d.fields[k] === m.uid) d.fields[k] = real;
            d.dep = null;
          }
        } else {
          // a purchase that made no placeholder (a merge, an item): nothing can name it
          for (const d of ops.filter((o) => o.dep === op.id)) { drop(d); failDependents(d, refusal('BAD_TARGET')); d.reject(refusal('BAD_TARGET')); }
        }
        drop(op);
      }
      auth = priv;
      before = pieceUids(priv);
      pump();
      return view();
    },

    /**
     * Send an intent (predicting it when it can). `predicted`: the shown view changed at once (the caller plays its
     * sound now instead of on the reply).
     * @param {string} t
     * @param {object} [fields]
     * @returns {{ promise: Promise<any>, predicted: boolean }}
     */
    submit(t, fields = {}) {
      const f = { ...(fields && typeof fields === 'object' ? fields : {}) };
      // a placeholder uid: the purchase that made it
      let dep = null;
      for (const k of UID_FIELDS) {
        if (!(Number.isInteger(f[k]) && f[k] < 0)) continue;
        if (resolved.has(f[k])) { f[k] = resolved.get(f[k]); continue; }
        const owner = ops.find((o) => o.id === -f[k] && o.t === 'g.buy');
        if (!owner) return { promise: Promise.reject(refusal('BAD_TARGET')), predicted: false };
        dep = owner.id;
      }
      const waiting = ops.some((o) => !o.sent);
      // the server's gate (player/prep.js _gate): alive, its prep, not Ready
      const active = ackSeen && !!auth && auth.alive !== false && auth.ready !== true && canPredict() && isPredictable(t);
      // nothing pending to keep in order and nothing to predict: the plain request, as before rel26
      if (!active && !waiting && dep == null) {
        let promise;
        try { promise = Promise.resolve(request(t, f, {})); } catch (err) { promise = Promise.reject(err); }
        return { promise, predicted: false };
      }
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const op = { id: nextId++, t, fields: f, dep, predict: active, sent: false, rid: null, replied: false, timer: null, resolve, reject };
      // the card a purchase takes (its placeholder is found by it if the last replay could not apply the purchase)
      if (t === 'g.buy') { const slot = (view() || auth)?.shop?.slots?.[f.slot]; if (slot && typeof slot.id === 'string') { op.buyId = slot.id; op.buyKind = slot.kind === 'item' ? 'item' : 'chess'; } }
      ops.push(op);
      let predicted = false, shown = null;
      if (active) {
        const r = replay();
        made = r.made;
        predicted = r.applied.has(op.id);
        shown = r.priv;
        // not predictable after all (a merge, a full hand…): it waits for the server like before, but stays in order
        if (!predicted) op.predict = false;
      }
      if (!waiting && dep == null) send(op);
      if (predicted) publish(shown);
      return { promise, predicted };
    },

    /** The match is gone (or another seat's state arrived): forget everything; intents not sent yet fail. */
    reset() {
      for (const op of ops) { if (op.timer != null) { try { timers.clearTimeout(op.timer); } catch { /* ignore */ } } if (!op.sent) op.reject(refusal('CLOSED')); }
      ops = []; auth = null; ackSeen = false; ack = 0; before = new Set(); made = new Map(); resolved = new Map();
    },

    /** Diagnostics / tests: the pending intents. */
    pending() { return ops.map((o) => ({ id: o.id, t: o.t, fields: { ...o.fields }, sent: o.sent, rid: o.rid, dep: o.dep })); },
    get enabled() { return ackSeen; },
  };
}

/** localStorage key that switches the prediction off in this browser ('1'), e.g. to compare or to rule it out. */
export const NO_PREDICT_KEY = 'sp.noPredict';
const switchedOff = () => { try { return globalThis.localStorage?.getItem(NO_PREDICT_KEY) === '1'; } catch { return false; } };

/** The page's prediction: net.request looked up at call time (the dev mock harness and tests stub it). */
export const prediction = createPrediction({
  request: (t, fields, opts) => net.request(t, fields, opts),
  lookups: { getChess: (id) => data.lookup('chess', id), getItem: (id) => data.lookup('items', id) },
  publish: (view) => store.patch('match', { private: view }),
  // the own seat's prep only (a spectator has no m.private at all)
  canPredict: () => !switchedOff() && store.get().match?.public?.phase === PHASE.PREP,
});
// the match left the screen (store.js emptyMatch): nothing of it may be replayed onto the next one
store.subscribe((s, prev) => { if (prev?.match?.private && !s.match?.private) prediction.reset(); });
