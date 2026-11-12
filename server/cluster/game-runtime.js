// Process-owned assembly for a game node: the transport borrows these pools,
// this owner starts/closes them. Ordinary server/index.js remains opt-out.
// The other official versions (DESIGN §35.23): this node's version service (SP_VERSIONS, as a server's: server/http/
// config.js) and their match hosts — a child process per version, started by its first match here and stopped
// IDLE_MS after its last (server/match/host/), at most SP_NODE_VERSION_HOSTS at once (default 1), each with
// SP_NODE_VERSION_COMBAT_WORKERS combat Workers (default 1) — whose matches the coordinator places here like default
// ones (server/cluster/directory.js weighs the host). SP_NODE_VERSION_HOSTS=0 runs 第二期下半 alone.
import path from 'node:path';
import { CombatWorkerPool } from '../match/combat/pool.js';
import { DATA_DIR, ROOT, getData } from '../data.js';
import { createMatchHosts } from '../match/host/index.js';
import { createVersionSets } from '../versions.js';
import { computeVanillaContent } from '../plugins/identity.js';
import { versionsFrom } from '../http/config.js';
import { DATA_SHIM_JS } from '../http/static.js';
import { createHealthMetrics, serverLoadState, publicLoadDetails } from '../healthMetrics.js';
import { parseCombatWorkers, parseTrialWorkers } from '../index.js';
import { startGameNode } from './game-node.js';
import { processVerifyHub } from '../match/verify/hub.js';
import { createRpcAuthenticator, createRpcClient } from './rpc.js';
import { sendEndReceipt, sendMemberRemoved } from './receipts.js';
import { storeConfig, createCheckpointStore } from '../persist/store.js';
import { NodeCheckpoints } from '../persist/node.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
/** Defaults of the node's version hosts (the header). [ASSUMED: measured in NOTES-ckpt.md] */
export const NODE_VERSION_HOSTS = 1, NODE_VERSION_COMBAT_WORKERS = 1;

/** A non-negative integer of an option or the environment, else `fallback` (up to `max`). */
function count(value, fallback, max) {
  const n = Number(value ?? fallback);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/**
 * The other official versions of this node (the header), or nulls when none may run here.
 * @param {{ versions?: object, versionHosts?: number, versionCombatWorkers?: number, matchHost?: object }} o test /
 *   runtime options (the environment otherwise): `matchHost` the version hosts' test options (match options, virtual time)
 */
function nodeVersions(o, data, log) {
  const maxHosts = count(o.versionHosts ?? process.env.SP_NODE_VERSION_HOSTS, NODE_VERSION_HOSTS, 3);
  const cfg = versionsFrom({ versions: o.versions }, log);
  if (!maxHosts || !cfg.enabled.some((id) => id !== 'act2autochess')) return { versions: null, versionHosts: null };
  const vanilla = computeVanillaContent({ simDir: path.join(ROOT, 'server', 'sim'), sharedDir: path.join(ROOT, 'shared'), dataDir: DATA_DIR, shim: DATA_SHIM_JS, log });
  const versions = createVersionSets({ enabled: cfg.enabled, dataDir: DATA_DIR, vanilla, defaultData: data, log });
  if (!versions.nonDefault.length) return { versions: null, versionHosts: null };
  const combatWorkers = count(o.versionCombatWorkers ?? process.env.SP_NODE_VERSION_COMBAT_WORKERS, NODE_VERSION_COMBAT_WORKERS, 8);
  // a game node's matches are server-run whatever SP_COMBAT says (GameHost); so are its version hosts'
  const matchHost = o.matchHost || {};
  const versionHosts = createMatchHosts({ contents: versions, log, options: { transport: 'process', combatWorkers, ...matchHost,
    matchOptions: { clientCombat: false, ...(matchHost.matchOptions || {}) }, kind: 'version', maxWorkers: maxHosts } });
  log.info?.(`[versions] game node: ${versions.nonDefault.join(', ')} (at most ${maxHosts} version host(s), ${combatWorkers} combat worker(s) each)`);
  return { versions, versionHosts };
}

export async function startGameRuntime({ combatWorkers = 8, trialWorkers = 2, coordinatorUrl,
  data, log = noopLog, onEnd, onRemoved, persistStore = null, persistSaveMs, versions: versionList, versionHosts: versionHostCount,
  versionCombatWorkers, matchHost, ...options } = {}) {
  const combatCount = parseCombatWorkers(combatWorkers), trialCount = combatCount ? parseTrialWorkers(trialWorkers) : 0;
  const gameData = data ?? getData({ log });
  let combatPool, trialPool, node, events, closing, checkpoints = null, versions = null, versionHosts = null;
  // shadow verification settings (server/match/verify/config.js): a bad value refuses to start
  const verifyHub = processVerifyHub();
  const metrics = createHealthMetrics({ log });
  // match checkpoints (SP_REDIS_URL; server/persist/node.js): off unless a store is configured
  const store = persistStore || createCheckpointStore(storeConfig(), { log });
  if (coordinatorUrl) events = createRpcClient({ url: coordinatorUrl,
    authority: createRpcAuthenticator({ key: options.key, scope: options.nodeId }) });
  if (!events && typeof onEnd !== 'function') throw new TypeError('game runtime requires an end-receipt target');
  try {
    if (combatCount) {
      combatPool = new CombatWorkerPool({ size: combatCount, data: gameData, log });
      await combatPool.start();
    }
    if (trialCount) {
      trialPool = new CombatWorkerPool({ role: 'trial', size: trialCount, data: gameData, log });
      await trialPool.start();
    }
    ({ versions, versionHosts } = nodeVersions({ versions: versionList, versionHosts: versionHostCount, versionCombatWorkers, matchHost }, gameData, log));
    node = await startGameNode({ ...options, data: gameData, log, combatPool, trialPool, streamMarkers: true, versions, versionHosts,
      getLoadState: () => serverLoadState(metrics.snapshot()),
      getLoadDetails: () => publicLoadDetails(metrics.snapshot()),
      onEnd: receipt => {
        if (onEnd) return onEnd(receipt);
        return sendEndReceipt({ client: events, nodeGeneration: options.generation, receipt });
      },
      // the AFK rule: the coordinator leaves the removed player's room seat (receipts.js member.removed)
      onRemoved: removal => {
        if (typeof onRemoved === 'function') return onRemoved(removal);
        return events ? sendMemberRemoved({ client: events, nodeGeneration: options.generation, removal }) : undefined;
      },
      restoreSource: store ? (checkpointId, assignmentId) => checkpoints ? checkpoints.load(checkpointId, assignmentId) : null : null,
      getCheckpointStats: store ? () => checkpoints?.snapshot() ?? null : null,
      getVerifyStats: () => verifyHub?.snapshot() ?? null });
    if (store) checkpoints = new NodeCheckpoints({ store, gameHost: node.gameHost, nodeId: options.nodeId, log,
      saveMs: persistSaveMs ?? (Number(process.env.SP_PERSIST_SAVE_MS) || undefined) }).start();
    metrics.start();
  } catch (e) {
    await checkpoints?.shutdown(); if (!persistStore) await store?.close();
    metrics.dispose(); events?.close();
    await node?.close(); versionHosts?.close(); await trialPool?.close(); await combatPool?.close();
    throw e;
  }
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // the last checkpoints before the actors go (server/persist/node.js)
      await checkpoints?.shutdown();
      await node.close(); metrics.dispose(); events?.close();
      // after the actors: their matches are disposed, the children go
      versionHosts?.close();
      if (!persistStore) await store?.close();
      await trialPool?.close(); await combatPool?.close();
    })();
    return closing;
  };
  return { ...node, combatPool, trialPool, metrics, checkpoints, versions, versionHosts, close };
}
