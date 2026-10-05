// A page-local cancellation intent survives a socket swap, never a new ticket or a new session.
import { net } from './net.js';
import { store } from './store.js';

export const CANCEL_BUDGET_MS = 30000;
export const CANCEL_STATE_TIMEOUT_MS = 8000;
export const CANCEL_RECOVERY_RETRIES = 2;
const active = (q) => q?.state === 'queued' || q?.state === 'offered';
const idle = Object.freeze({ status: 'idle', ticketId: null });
const retryable = new Set(['TIMEOUT', 'DISCONNECTED', 'OFFLINE']);

export function createQueueCancellation({ net, timers = globalThis, now = () => performance.now(), onChange = () => {} }) {
  let intent = null, serial = 0, sessionId = null, socket = null, fresh = false, queue = null, disposed = false;
  let state = idle;
  const publish = (status, ticketId = null) => { state = Object.freeze({ status, ticketId }); onChange(state); };
  const remaining = (i) => Math.max(0, i.deadline - now());
  const current = (i) => !disposed && intent === i && i.id === serial;
  const clearWait = (i) => { if (i.waitTimer != null) timers.clearTimeout(i.waitTimer); i.waitTimer = null; };
  const finish = (status = 'idle') => {
    const i = intent;
    if (i) { clearWait(i); timers.clearTimeout(i.timer); i.seq++; }
    intent = null;
    publish(status, status === 'idle' ? null : i?.ticketId ?? state.ticketId);
  };
  const validTicket = (i) => sessionId === i.sessionId && active(queue) && queue.ticketId === i.ticketId;
  const waitState = (i) => {
    if (!current(i)) return;
    if (!remaining(i)) { finish('failed'); return; }
    if (i.waitTimer == null) i.waitTimer = timers.setTimeout(() => {
      i.waitTimer = null;
      if (current(i)) recover(i);
    }, Math.min(CANCEL_STATE_TIMEOUT_MS, remaining(i)));
  };

  function recover(i) {
    if (!current(i)) return;
    clearWait(i);
    i.seq++;
    i.sending = false;
    if (!remaining(i) || i.retries >= CANCEL_RECOVERY_RETRIES) { finish('failed'); return; }
    if (!i.forced && net.status === 'online') {
      i.forced = true;
      fresh = false;
      i.waitingFresh = true;
      publish('recovering', i.ticketId);
      waitState(i);
      try { net.reconnectNow(); } catch { if (current(i)) finish('failed'); }
    } else if (fresh && socket === net.ws && net.status === 'online') {
      send(i, true);
    } else {
      // A bounded wait, not a fresh eight seconds on every status notification.
      finish('failed');
    }
  }

  function send(i, recovery = false) {
    if (!current(i) || i.sending) return;
    if (!validTicket(i)) { finish(); return; }
    if (!fresh || socket !== net.ws || net.status !== 'online') {
      i.waitingFresh = true;
      publish('recovering', i.ticketId);
      waitState(i);
      return;
    }
    if (!remaining(i) || (recovery && i.retries >= CANCEL_RECOVERY_RETRIES)) { finish('failed'); return; }
    if (recovery) i.retries++;
    clearWait(i);
    i.waitingFresh = false;
    i.sending = true;
    const seq = ++i.seq, sentSocket = socket;
    publish(recovery ? 'recovering' : 'sending', i.ticketId);
    let request;
    try { request = net.request('queue.cancel', { ticketId: i.ticketId }, { timeout: Math.min(8000, remaining(i)) }); }
    catch (err) { request = Promise.reject(err); }
    Promise.resolve(request).then(() => {
      if (!current(i) || seq !== i.seq || sentSocket !== socket) return;
      i.sending = false;
      // An ack alone never fabricates queue.idle; the server's state push is authoritative.
      publish('confirming', i.ticketId);
      waitState(i);
    }, (err) => {
      if (!current(i) || seq !== i.seq || sentSocket !== socket) return;
      i.sending = false;
      if (retryable.has(err?.code)) recover(i); else finish('failed');
    });
  }

  const off = [
    net.on('status', (snapshot) => {
      if (snapshot.status === 'online') return;
      fresh = false;
      if (!intent) return;
      if (snapshot.status === 'closed' || snapshot.status === 'idle') { finish('failed'); return; }
      const i = intent;
      i.seq++;
      i.sending = false;
      i.waitingFresh = true;
      publish('recovering', i.ticketId);
      waitState(i);
    }),
    net.on('welcome', (msg) => {
      socket = net.ws;
      fresh = false;
      queue = null;
      sessionId = msg.playerId;
      if (!intent) return;
      if (intent.sessionId !== sessionId) { finish(); return; }
      intent.seq++;
      intent.sending = false;
      intent.waitingFresh = true;
      publish('recovering', intent.ticketId);
      waitState(intent);
    }),
    net.on('queue.state', (msg) => {
      if (net.status !== 'online' || !socket || socket !== net.ws) return;
      queue = msg;
      fresh = true;
      const i = intent;
      if (!i) {
        if (state.ticketId && (!active(queue) || queue.ticketId !== state.ticketId)) publish('idle');
        return;
      }
      if (!validTicket(i)) { finish(); return; }
      if (i.waitingFresh && !i.sending) send(i, true);
    }),
    net.on('replaced', () => { fresh = false; if (intent) finish('failed'); }),
  ];

  return {
    snapshot: () => state,
    cancel(ticketId) {
      if (disposed || intent || !sessionId || !fresh || net.status !== 'online' || !active(queue) || queue.ticketId !== ticketId) return false;
      const i = { id: ++serial, sessionId, ticketId, deadline: now() + CANCEL_BUDGET_MS,
        seq: 0, retries: 0, forced: false, sending: false, waitingFresh: false, waitTimer: null, timer: null };
      intent = i;
      i.timer = timers.setTimeout(() => { if (current(i)) finish('failed'); }, CANCEL_BUDGET_MS);
      send(i);
      return true;
    },
    dispose() {
      if (disposed) return;
      finish();
      disposed = true;
      for (const unsubscribe of off) unsubscribe();
    },
  };
}

export const queueCancellation = createQueueCancellation({ net, onChange: (value) => store.patch('ui', { queueCancel: value }) });
