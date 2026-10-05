// Artificial 7-worker health fixture for late libuv birth; not a gameplay test.
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const workers = Array.from({ length: 7 }, () => new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.postMessage('ready'); setInterval(() => {}, 1000);`, { eval: true }));
const roles = () => fs.readdirSync('/proc/self/task').map(tid => fs.readFileSync(`/proc/self/task/${tid}/comm`, 'utf8').trim());
Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve)))).then(() => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ fixture: 'lazy', ok: true, maxRooms: 4096,
      combat: { status: 'ready', ready: 6, workers: 6 }, trial: { status: 'ready', ready: 1, workers: 1 } }));
  });
  server.listen(3000, '0.0.0.0', () => {
    console.log(JSON.stringify({ fixture: 'lazy', stage: 'ready', node: process.version,
      libuvBefore: roles().filter(name => name === 'libuv-worker').length }));
  });
  process.once('SIGUSR2', () => {
    crypto.pbkdf2('fixture', 'fixture', 10, 16, 'sha256', error => {
      console.log(JSON.stringify({ fixture: 'lazy', stage: error ? 'failed' : 'created',
        libuvAfter: roles().filter(name => name === 'libuv-worker').length }));
    });
  });
  process.once('SIGTERM', () => Promise.all(workers.map(worker => worker.terminate()))
    .then(() => server.close(() => process.exit(0))));
});
