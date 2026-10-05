// Isolated opt-in fixture only: exercise real combat/trial replacement, never production.
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { startServer } from '../../../../server/index.js';

const profile = process.env.SP_PRIORITY_FIXTURE_PROFILE ?? 'prod';
const counts = { prod: [6, 1], beta: [12, 2] }[profile];
if (!Array.isArray(counts)) throw new Error('invalid fixture profile');
const [combatWorkers, trialWorkers] = counts;
const app = await startServer({ host: '0.0.0.0', port: 3000, combatWorkers, trialWorkers });
console.log(JSON.stringify({ fixture: 'game', profile, stage: 'ready', node: process.version,
  combatWorkers, trialWorkers }));
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
    while (app.combatPool.stats().ready !== combatWorkers || app.trialPool.stats().ready !== trialWorkers) {
      if (Date.now() >= deadline) throw new Error('replacement deadline');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    console.log(JSON.stringify({ fixture: 'game', profile, stage: 'replaced', newWorkerNice: born.nice,
      combatReady: app.combatPool.stats().ready, trialReady: app.trialPool.stats().ready,
      combatReplacements: app.combatPool.stats().replacements, trialReplacements: app.trialPool.stats().replacements }));
  } catch (error) {
    console.log(JSON.stringify({ fixture: 'game', stage: 'failed', reason: error.message }));
  }
});
process.once('SIGTERM', () => app.close().then(() => process.exit(0)));
