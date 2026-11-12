// public/js/battle/verifyWorker.js — a verifier's run of a battle of another match (DESIGN §14 "Shadow verification"),
// in a module Worker so a whole simulated battle never touches the page's frame budget.
//
// battle/verify.js (the page) sends the simulation data once, then one task at a time; this worker builds the battle
// from its (pseudonymized) BattleSpec exactly as the server's combat Worker does, steps it to its end — at the server's
// hard cap (`cap` ticks) it ends it 'timeout', as the server's field runner would —, and answers the SHA-256 of the
// result's canonical JSON (/sim/spec.js resultCanonicalJson, /shared/resultHash.js). Nothing else leaves here.
//
//   postMessage → { t: 'ready' }                                once, when this script has been evaluated
//   onmessage ← { t: 'data', raw }                              the page's official /data/*.json (once, before any task)
//             ← { t: 'verify', vid, spec, cap }                  one battle
//   postMessage → { t: 'done', vid, rh, ticks, ms } | { t: 'error', vid, message }

const { createBattleFromSpec, resultCanonicalJson } = await import('/sim/spec.js');
const { DataSource, setSimData } = await import('/sim/simdata.js');
const { resultHashOf } = await import('/shared/resultHash.js');

let ds = null;
const now = () => (globalThis.performance ? performance.now() : Date.now());

async function verify(task) {
  if (!ds) throw new Error('simulation data not loaded');
  const spec = task.spec;
  if (!spec || typeof spec !== 'object' || (typeof spec.cs === 'string' && spec.cs) || spec.version) throw new Error('not an official battle');
  const t0 = now();
  const b = createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false });
  const cap = Number.isInteger(task.cap) && task.cap > 0 ? task.cap : 111_000;
  while (!b.finished && b.tickCount < cap) b.step(); // loop-cap: the server's hard cap
  if (!b.finished) b.forceEnd('timeout');
  const json = resultCanonicalJson(b.result());
  const ms = now() - t0;
  return { rh: await resultHashOf(json), ticks: Number(b.tickCount) || 0, ms: Math.round(ms * 10) / 10 };
}

self.onmessage = (ev) => {
  const msg = ev && ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'data') {
    setSimData(msg.raw);
    ds = new DataSource(msg.raw, null);
    return;
  }
  if (msg.t !== 'verify') return;
  verify(msg).then((r) => self.postMessage({ t: 'done', vid: msg.vid, ...r }),
    (e) => self.postMessage({ t: 'error', vid: msg.vid, message: String((e && e.message) || e) }));
};

self.postMessage({ t: 'ready' });
