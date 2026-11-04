import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadClusterConfig } from './config.js';
import { startGameRuntime } from './game-runtime.js';
import { startCoordinator } from './coordinator.js';
import { startIngress } from './ingress.js';
import { netCounters } from '../net.js';
import { stateDeltaStats } from '../stateTransport.js';
import { startMainWatchdog } from './watchdog.js';

const NET_LOG_MS = 60_000;

export async function startConfiguredCluster(config) {
  const { role, ...options } = config;
  if (role === 'game') return startGameRuntime({ ...options, generation: randomUUID() });
  if (role === 'coordinator') return startCoordinator(options);
  if (role === 'ingress') return startIngress(options);
  throw new TypeError('invalid configured cluster role');
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('CLUSTER_CONFIG_REQUIRED');
  const configFile = process.argv[3];
  let config = await loadClusterConfig(configFile);
  const runtime = await startConfiguredCluster(config);
  let stopping = false, reloading = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; console.error('[cluster] shutdown failed'); }
    finally { process.exit(); }
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('SIGHUP', async () => {
    if (stopping || reloading) return;
    reloading = true;
    try {
      const next = await loadClusterConfig(configFile);
      const stable = value => { const { nodes, ...other } = value; return other; };
      if (config.role === 'game' || !isDeepStrictEqual(stable(config), stable(next))) throw new Error('IMMUTABLE_RUNTIME_CONFIG');
      if (config.role === 'coordinator') await runtime.addNodes(next.nodes);
      else runtime.addRoutes(next.nodes);
      config = next;
      console.log(JSON.stringify({ event: 'routes-extended', role: config.role, nodes: next.nodes.length }));
    } catch { console.error('[cluster] route extension refused'); }
    finally { reloading = false; }
  });
  // Readiness is administrative output only: no keys, tickets, sessions or full config.
  console.log(JSON.stringify({ event: 'ready', role: config.role, node: process.version }));
  // a game node whose main thread stops answering is killed and restarted by its container (./watchdog.js)
  if (config.role === 'game') {
    try { startMainWatchdog({ role: 'game' }); } catch { console.error('[cluster] watchdog not started'); }
  }
  // backpressure and m.state totals since start, once a minute when they moved (this role has no /healthz of its own)
  let lastNet = '';
  setInterval(() => {
    const net = { ...netCounters, stateDelta: { ...stateDeltaStats } };
    const text = JSON.stringify(net);
    if (text === lastNet) return;
    lastNet = text;
    console.log(JSON.stringify({ event: 'net', role: config.role, ...net }));
  }, NET_LOG_MS).unref();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('[cluster] startup refused'); process.exitCode = 1; });
}
