// Private worker protocol: one ordered request in flight per worker, one engine per whole phase.
import { parentPort, workerData } from 'node:worker_threads';
import { initializeData } from '../../data.js';

const { epoch, data, maxSessions } = workerData;
const sessions = new Map();
const log = Object.freeze({ error() {}, warn() {}, info() {} });
const reply = (request, result) => parentPort.postMessage({
  type: 'reply', epoch, generation: request.generation, seq: request.seq, ...result,
});

try {
  initializeData(data);
  const { CombatEngine } = await import('./engine.js');
  const { combatData } = await import('./data.js');
  combatData(data);
  parentPort.on('message', (request) => {
    if (request?.type !== 'request' || request.epoch !== epoch || typeof request.generation !== 'string') return;
    const { generation, seq, op, payload } = request;
    try {
      if (op === 'close') {
        sessions.get(generation)?.engine.dispose();
        sessions.delete(generation);
        reply(request, { dto: null });
        return;
      }
      if (op === 'init') {
        if (seq !== 1 || sessions.has(generation)) throw new Error('invalid or duplicate combat session');
        if (sessions.size >= maxSessions) throw new Error('worker session limit reached');
        const engine = new CombatEngine(payload, { log });
        sessions.set(generation, { engine, seq });
        reply(request, { dto: engine.state({ snapshotFields: payload.specs.map((s) => s.fieldId) }) });
        return;
      }
      const session = sessions.get(generation);
      if (!session || seq !== session.seq + 1) throw new Error('stale or out-of-order combat request');
      session.seq = seq;
      const p = payload || {};
      let dto;
      switch (op) {
        case 'advance': dto = session.engine.advance(p.ticks, { snapshotFields: p.snapshotFields }); break;
        case 'state': dto = session.engine.state({ snapshotFields: p.snapshotFields }); break;
        case 'forceField': dto = session.engine.forceField(p.fieldId, p.reason); break;
        case 'forceAll': dto = session.engine.forceAll(p.reason); break;
        default: throw new Error(`unknown combat operation ${op}`);
      }
      reply(request, { dto });
    } catch (e) {
      // A failed command may have partially advanced; never reanimate it or accept later work on that engine.
      sessions.get(generation)?.engine.dispose();
      sessions.delete(generation);
      reply(request, { error: { message: String(e?.message ?? e), code: 'WORKER_COMMAND' } });
    }
  });
  parentPort.on('close', () => {
    for (const { engine } of sessions.values()) engine.dispose();
    sessions.clear();
  });
  parentPort.postMessage({ type: 'ready', epoch });
} catch (e) {
  parentPort.postMessage({ type: 'fatal', epoch, message: String(e?.message ?? e) });
  parentPort.close();
}
