// The watchdog's Worker (./watchdog.js): watches the main thread's heartbeat; on a silence of `thresholdMs` it captures
// where the main thread is (inspector, at most `captureMs`), writes one JSON line to fd 1 and SIGKILLs the process.
import { workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import inspector from 'node:inspector';

const { shared, thresholdMs, checkMs, role, captureMs, root } = workerData;
const counter = new Int32Array(shared);
const FRAMES = 30;
let last = Atomics.load(counter, 0), lastAt = performance.now(), firing = false;

const where = (f, urls) => {
  const url = (typeof f.url === 'string' && f.url) || urls.get(f.location.scriptId) || '';
  const file = url.startsWith(root) ? url.slice(root.length) : url.replace(/^file:\/\//, '');
  return `${file || '?'}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`;
};

/** The main thread's top frames, or null (no inspector, or no answer within captureMs). */
function capture() {
  return new Promise((resolve) => {
    let session = null, done = false;
    const finish = (frames) => {
      if (done) return; done = true; clearTimeout(timer);
      try { session?.disconnect(); } catch { /* going down anyway */ }
      resolve(frames);
    };
    const timer = setTimeout(() => finish(null), captureMs);
    try {
      session = new inspector.Session();
      session.connectToMainThread();
      // a CallFrame's url is often empty: the scripts Debugger.enable announces name them
      const urls = new Map();
      session.on('Debugger.scriptParsed', ({ params }) => { if (params?.url) urls.set(params.scriptId, params.url); });
      session.once('Debugger.paused', ({ params }) => finish((params.callFrames || []).slice(0, FRAMES)
        .map((f) => ({ fn: f.functionName || '(anonymous)', at: where(f, urls) }))));
      session.post('Debugger.enable', (err) => {
        if (err) return finish(null);
        session.post('Debugger.pause', (e) => { if (e) finish(null); });
      });
    } catch { finish(null); }
  });
}

async function fire(blockedMs) {
  firing = true;
  const frames = await capture();
  const line = { event: 'watchdog', role, blockedMs, thresholdMs, frames: frames ?? [], captured: !!frames };
  try { writeSync(1, `${JSON.stringify(line)}\n`); } catch { /* the kill still matters more */ }
  process.kill(process.pid, 'SIGKILL');
}

setInterval(() => {
  if (firing) return;
  const now = performance.now(), cur = Atomics.load(counter, 0);
  if (cur !== last) { last = cur; lastAt = now; return; }
  if (now - lastAt >= thresholdMs) void fire(Math.round(now - lastAt));
}, checkMs);
