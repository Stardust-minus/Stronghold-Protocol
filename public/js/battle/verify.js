// public/js/battle/verify.js — this page as a verifier of other matches' battles (DESIGN §14 "Shadow verification",
// server/match/verify/hub.js). The server may hand a page that declared it verifies (battle/clientInfo.js, g.sim
// `client`) one battle of ANOTHER match on its process at a time: S→C b.verify { vid, spec, deadline, cap? } with the
// spec pseudonymized (no player id of that match). The page runs it in a module Worker (battle/verifyWorker.js, off the
// main thread) and answers C→S g.verifyResult { vid, rh, ticks, ms } — or { vid, error: true } when it cannot (no
// Worker, no data, a task past the queue). Nothing is shown and nothing of the answer changes any match: the server only
// compares it with its own result.
//
// Like the rehearsal delegate (battle/rehearsal.js): one Worker for the tab, created on the first task, handed the
// page's own official data once; a task that waited past its deadline is dropped; a socket that goes offline drops
// everything (the answer could not be delivered).
//
//   installVerify({ net, runner, createWorker, now, log }) → { pending(), clear(), dispose() } | null   (wired in main.js)
import { battleRunner } from './runner.js';

export const VERIFY_WORKER_URL = '/js/battle/verifyWorker.js';
/** Tasks kept while the worker is busy (the server sends one at a time per page; a margin for a reconnect). */
export const MAX_VERIFY_QUEUE = 2;

/**
 * @param {{ net?: any, runner?: any, createWorker?: () => Worker, now?: () => number, log?: object }} [deps]
 * @returns {null | { pending: () => number, clear: () => void, dispose: () => void }}
 */
export function installVerify({ net, runner = battleRunner, createWorker = () => new Worker(VERIFY_WORKER_URL, { type: 'module' }),
  now = () => Date.now(), log = console } = {}) {
  if (!net || typeof net.on !== 'function' || !runner || typeof runner.ensureSim !== 'function') return null;
  const queue = [];
  let w = null;
  let broken = false;

  const answer = (task, fields) => {
    if (task.settled) return;
    task.settled = true;
    try { net.send('g.verifyResult', { vid: task.vid, ...fields }); } catch { /* offline: the server times it out */ }
  };

  const killWorker = () => {
    const dead = w;
    w = null;
    if (dead) { try { dead.port.terminate(); } catch { /* ignore */ } }
    return dead;
  };

  const failWorker = (why, err) => {
    log.warn?.(`[verify] ${why}`, err || '');
    broken = true;
    const dead = killWorker();
    const tasks = queue.splice(0);
    if (dead && dead.task) tasks.unshift(dead.task);
    for (const task of tasks) answer(task, { error: true });
  };

  function startWorker() {
    if (w || broken) return w;
    const inst = { port: null, ready: false, data: false, task: null };
    try { inst.port = createWorker(); } catch (err) { failWorker('module Worker unavailable', err); return null; }
    inst.port.onmessage = (ev) => onWorkerMessage(inst, ev && ev.data);
    inst.port.onerror = (ev) => { if (w === inst) failWorker('worker failed', ev && ev.message); };
    w = inst;
    return inst;
  }

  const sendData = (inst) => runner.ensureSim().then((sim) => {
    if (!sim || !sim.raw || (typeof sim.cs === 'string' && sim.cs !== '')) throw new Error('no official simulation data');
    if (w !== inst) return;
    inst.port.postMessage({ t: 'data', raw: sim.raw });
    inst.data = true;
  });

  function sendTask(inst, task) {
    Promise.resolve(inst.data ? null : sendData(inst)).then(() => {
      if (w !== inst || inst.task !== task) return;
      if (now() > task.until) { inst.task = null; answer(task, { error: true }); pump(); return; }
      inst.port.postMessage({ t: 'verify', vid: task.vid, spec: task.spec, ...(task.cap ? { cap: task.cap } : {}) });
    }, (err) => {
      log.warn?.('[verify] simulation data unavailable', err);
      if (w !== inst || inst.task !== task) return;
      inst.task = null;
      answer(task, { error: true });
      pump();
    });
  }

  function onWorkerMessage(inst, msg) {
    if (!msg || w !== inst) return;
    if (msg.t === 'ready') { inst.ready = true; if (inst.task) sendTask(inst, inst.task); return; }
    const task = inst.task;
    if (!task || msg.vid !== task.vid) return;
    inst.task = null;
    if (msg.t === 'done' && typeof msg.rh === 'string') answer(task, { rh: msg.rh, ticks: msg.ticks | 0, ms: Math.max(0, Number(msg.ms) || 0) });
    else { log.warn?.('[verify] the run failed', msg && msg.message); answer(task, { error: true }); }
    pump();
  }

  function pump() {
    if (w && w.task) return;
    const task = queue.shift();
    if (!task) return;
    if (now() > task.until) { answer(task, { error: true }); pump(); return; }
    const inst = startWorker();
    if (!inst) { answer(task, { error: true }); return; }
    inst.task = task;
    if (inst.ready) sendTask(inst, task);
  }

  function onVerify(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.vid !== 'string' || !msg.spec || typeof msg.spec !== 'object') return;
    const deadline = Number.isFinite(msg.deadline) && msg.deadline > 0 ? msg.deadline : 20_000;
    const task = { vid: msg.vid, spec: msg.spec, cap: Number.isInteger(msg.cap) ? msg.cap : null, until: now() + deadline, settled: false };
    if (broken || queue.length >= MAX_VERIFY_QUEUE) { answer(task, { error: true }); return; }
    queue.push(task);
    pump();
  }

  function clear() {
    const dead = killWorker();
    if (dead && dead.task) dead.task.settled = true;
    for (const task of queue.splice(0)) task.settled = true;
  }

  const offVerify = net.on('b.verify', onVerify);
  const offStatus = net.on('status', (snap) => { if (!snap || snap.status !== 'online') clear(); });
  return {
    pending: () => queue.length,
    clear,
    dispose() { offVerify(); offStatus(); clear(); },
  };
}
