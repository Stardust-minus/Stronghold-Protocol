// Isolated opt-in fixture only: exercise real combat/trial replacement, never production.
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { startServer } from '../../../../server/index.js';

const app = await startServer({ host: '0.0.0.0', port: 3000, combatWorkers: 6, trialWorkers: 1 });
console.log(JSON.stringify({ fixture: 'game', stage: 'ready', node: process.version }));
process.once('SIGUSR2', async () => {
  try {
    const worker = new Worker(`const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const fields = fs.readFileSync('/proc/thread-self/stat', 'utf8').split(') ')[1].split(' ');
      parentPort.postMessage({ nice: Number(fields[16]) }); setInterval(() => {}, 1000);`, { eval: true });
    const [born] = await once(worker, 'message');
    await worker.terminate();
    await Promise.all([app.combatPool.slots[0].worker.terminate(), app.trialPool.slots[0].worker.terminate()]);
    const deadline = Date.now() + 15000;
    while (app.combatPool.stats().ready !== 6 || app.trialPool.stats().ready !== 1) {
      if (Date.now() >= deadline) throw new Error('replacement deadline');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    console.log(JSON.stringify({ fixture: 'game', stage: 'replaced', newWorkerNice: born.nice,
      combatReplacements: app.combatPool.stats().replacements, trialReplacements: app.trialPool.stats().replacements }));
  } catch (error) {
    console.log(JSON.stringify({ fixture: 'game', stage: 'failed', reason: error.message }));
  }
});
process.once('SIGTERM', () => app.close().then(() => process.exit(0)));
