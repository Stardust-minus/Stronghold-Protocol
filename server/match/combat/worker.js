// Private worker protocol. Formal/legacy sessions retain one ordered request per wire turn.
import { parentPort, workerData } from 'node:worker_threads';
import { initializeData } from '../../data.js';

const { epoch, data, maxSessions, role = 'combat', trialProgressMs = 50 } = workerData;
const sessions = new Map();
const log = Object.freeze({ error() {}, warn() {}, info() {} });
const reply = (request, result) => parentPort.postMessage({
  type: 'reply', epoch, kind: request.kind ?? 'combat', generation: request.generation, seq: request.seq, ...result,
});
const event = (generation, session, name, extra = {}) => parentPort.postMessage({
  type: 'trialEvent', epoch, kind: 'trial', generation, eventSeq: ++session.eventSeq, event: name, ...extra,
});
const dispose = (session) => {
  if (!session) return;
  clearImmediate(session.immediate);
  session.engine.dispose();
};

try {
  initializeData(data);
  const { CombatEngine } = await import('./engine.js');
  const { TrialEngine } = await import('./trial.js');
  const { combatData } = await import('./data.js');
  combatData(data);
  const schedule = (generation, session) => {
    session.immediate = setImmediate(() => {
      session.immediate = null;
      if (sessions.get(generation) !== session) return;
      try {
        session.engine.advanceSlice();
        if (session.engine.done) {
          // Terminal delivery is never gated on progress credit or the main-thread consumer.
          event(generation, session, 'done', { dto: session.engine.state({ stream: true }) });
          return;
        }
        const now = performance.now();
        if (session.credit && now >= session.nextReport) {
          session.credit = false;
          session.nextReport = now + trialProgressMs;
          event(generation, session, 'progress', { dto: session.engine.state({ stream: true }) });
          session.creditEvent = session.eventSeq;
        }
        schedule(generation, session);
      } catch (e) {
        dispose(session);
        sessions.delete(generation);
        event(generation, session, 'error', { error: { message: String(e?.message ?? e), code: 'WORKER_COMMAND' } });
      }
    });
  };
  parentPort.on('message', (request) => {
    if (!request || request.epoch !== epoch || typeof request.generation !== 'string') return;
    const { generation, seq, op, payload } = request;
    if (request.type === 'trialControl' && role === 'trial') {
      const session = sessions.get(generation);
      try {
        if (request.kind !== 'trial' || !Number.isSafeInteger(seq) || seq < 2) throw new Error('invalid trial control');
        if (session && (!session.stream || seq !== session.seq + 1)) throw new Error('stale or out-of-order trial control');
        if (op === 'cancel') {
          dispose(session);
          sessions.delete(generation);
          event(generation, session || { eventSeq: 0 }, 'closed', { seq });
          return;
        }
        if (!session) return; // An ACK may race terminal disposal; never resurrect its generation.
        if (op !== 'progressAck' || session.credit || payload?.eventSeq !== session.creditEvent) throw new Error('invalid progress credit');
        session.seq = seq;
        session.credit = true;
      } catch (e) {
        dispose(session);
        sessions.delete(generation);
        event(generation, session || { eventSeq: 0 }, 'error', { error: { message: String(e?.message ?? e), code: 'WORKER_COMMAND' } });
      }
      return;
    }
    if (request.type !== 'request') return;
    const kind = request.kind ?? 'combat';
    try {
      if (kind !== 'combat' && kind !== 'trial') throw new Error('unknown session kind');
      if (role === 'trial' && kind !== 'trial') throw new Error('dedicated trial worker rejects combat');
      if (op === 'close') {
        const session = sessions.get(generation);
        if (session && session.kind !== kind) throw new Error('session kind mismatch');
        dispose(session);
        sessions.delete(generation);
        reply(request, { dto: null });
        return;
      }
      if (op === 'init' || op === 'run') {
        if (op === 'run' && (role !== 'trial' || kind !== 'trial')) throw new Error('autonomous trial requires dedicated worker');
        if (seq !== 1 || sessions.has(generation)) throw new Error('invalid or duplicate combat session');
        const count = [...sessions.values()].filter((s) => s.kind === kind).length;
        if (count >= (kind === 'trial' ? 1 : maxSessions)) throw new Error('worker session limit reached');
        if (op === 'run' && typeof payload?.summary !== 'boolean') throw new Error('invalid summary mode');
        const engine = kind === 'trial' ? new TrialEngine(op === 'run' ? payload.input : payload,
          { log, isolated: true, summary: op === 'run' && payload.summary }) : new CombatEngine(payload, { log });
        const session = { kind, engine, seq };
        sessions.set(generation, session);
        if (op === 'run') {
          Object.assign(session, { stream: true, eventSeq: 0, credit: true, nextReport: performance.now() + trialProgressMs });
          reply(request, { dto: engine.state({ stream: true }) });
          schedule(generation, session);
        } else reply(request, { dto: kind === 'trial' ? engine.state() : engine.state({ snapshotFields: payload.specs.map((s) => s.fieldId) }) });
        return;
      }
      const session = sessions.get(generation);
      if (!session || session.kind !== kind || session.stream || seq !== session.seq + 1) throw new Error('stale or out-of-order combat request');
      session.seq = seq;
      const p = payload || {};
      let dto;
      if (kind === 'trial') {
        if (op !== 'advance') throw new Error(`unknown trial operation ${op}`);
        dto = session.engine.advance(p.ticks);
      } else switch (op) {
        case 'advance': dto = session.engine.advance(p.ticks, { snapshotFields: p.snapshotFields }); break;
        case 'state': dto = session.engine.state({ snapshotFields: p.snapshotFields }); break;
        case 'forceField': dto = session.engine.forceField(p.fieldId, p.reason); break;
        case 'forceAll': dto = session.engine.forceAll(p.reason); break;
        default: throw new Error(`unknown combat operation ${op}`);
      }
      reply(request, { dto });
    } catch (e) {
      // A failed command may have partially advanced. Only its session is invalidated.
      dispose(sessions.get(generation));
      sessions.delete(generation);
      reply(request, { error: { message: String(e?.message ?? e), code: 'WORKER_COMMAND' } });
    }
  });
  parentPort.on('close', () => {
    for (const session of sessions.values()) dispose(session);
    sessions.clear();
  });
  parentPort.postMessage({ type: 'ready', epoch });
} catch (e) {
  parentPort.postMessage({ type: 'fatal', epoch, message: String(e?.message ?? e) });
  parentPort.close();
}
