// Room-owned experimental rules are snapshotted at launch, never player votes.
import { MAX_SEATS } from './constants.js';
import { isPlayerCapacity, roomCapacity } from './playerCapacity.js';
import { canonicalPoolPlan, isPoolPlan } from './poolPlan.js';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });
/**
 * Optional booleans: absent when off, so an ordinary room, a saved room and a queue key keep their old shape.
 * @type {ReadonlySet<string | symbol>}
 */
const OPTIONAL_FLAGS = new Set(['disableDuckLord', 'disableLayerCap', 'disableHitLimit', 'collabOps']);
/**
 * The enemy multipliers a room can pick (feedback #47); the first, a standard room's, is never stored: an ordinary room,
 * a saved room and a queue key keep their old shape.
 */
export const ENEMY_MULTIPLIERS = Object.freeze([1, 1.25, 1.5, 2, 3, 5]);
export const isEnemyMultiplier = value => ENEMY_MULTIPLIERS.includes(value);
/** @type {ReadonlySet<string | symbol>} */
const OPTIONAL_MULTIPLIERS = new Set(['enemyHpMul', 'enemyAtkMul']);
const enemyMultiplier = value => (isEnemyMultiplier(value) ? value : 1);

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 2 || keys.length > 10) return false;
  for (const key of Object.keys(EXPERIMENTAL_DEFAULTS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || typeof descriptor.value !== 'boolean') return false;
  }
  return keys.every(key => {
    if (Object.hasOwn(EXPERIMENTAL_DEFAULTS, key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) return false;
    if (key === 'playerCapacity') return isPlayerCapacity(descriptor.value);
    if (key === 'poolPlan') return isPoolPlan(descriptor.value, roomCapacity('coop', value));
    if (OPTIONAL_MULTIPLIERS.has(key)) return isEnemyMultiplier(descriptor.value);
    return OPTIONAL_FLAGS.has(key) && typeof descriptor.value === 'boolean';
  });
}

/**
 * @param {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean,
 *   disableLayerCap?: boolean, disableHitLimit?: boolean, enemyHpMul?: number, enemyAtkMul?: number,
 *   poolPlan?: readonly number[], collabOps?: boolean }} [value] `poolPlan`: 手动指定卡池编组, one pool number per seat
 *   (shared/poolPlan.js); it states every seat's pool, so it replaces 禁用共享卡池. `collabOps`: 联动干员 (isCollabRoom).
 */
export function experimentalOptions(value = EXPERIMENTAL_DEFAULTS) {
  if (!isExperimental(value)) throw new TypeError('invalid experimental options');
  const capacity = roomCapacity('coop', value);
  return Object.freeze({ revivalEnabled: value.revivalEnabled, disableSharedPool: value.disableSharedPool && !value.poolPlan,
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    // Optional and false by default: ordinary rooms and legacy DTOs keep their two-flag shape.
    ...(capacity > MAX_SEATS && value.disableDuckLord === true ? { disableDuckLord: true } : {}),
    // Any mode, any capacity: these change battle rules, not seats.
    ...(value.disableLayerCap === true ? { disableLayerCap: true } : {}),
    ...(value.disableHitLimit === true ? { disableHitLimit: true } : {}),
    ...(enemyMultiplier(value.enemyHpMul) !== 1 ? { enemyHpMul: value.enemyHpMul } : {}),
    ...(enemyMultiplier(value.enemyAtkMul) !== 1 ? { enemyAtkMul: value.enemyAtkMul } : {}),
    ...(value.poolPlan ? { poolPlan: Object.freeze(canonicalPoolPlan(value.poolPlan)) } : {}),
    ...(value.collabOps === true ? { collabOps: true } : {}) });
}

const duckLordDisabled = value => roomCapacity('coop', value) > MAX_SEATS && value.disableDuckLord === true;
/** One string per pool layout, in any numbering; empty without a plan. */
const planKey = value => (value.poolPlan ? canonicalPoolPlan(value.poolPlan).join() : '');
export const experimentalKey = value => {
  const key = `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
  const capacity = roomCapacity('coop', value);
  const legacy = capacity === MAX_SEATS ? key : `${key}:${capacity}`;
  const hp = enemyMultiplier(value.enemyHpMul), atk = enemyMultiplier(value.enemyAtkMul);
  return `${duckLordDisabled(value) ? `${legacy}:duck` : legacy}${value.disableLayerCap === true ? ':layers' : ''}${value.disableHitLimit === true ? ':hits' : ''}${hp !== 1 ? `:hp${hp}` : ''}${atk !== 1 ? `:atk${atk}` : ''}${value.poolPlan ? `:pools${planKey(value)}` : ''}${value.collabOps === true ? ':collab' : ''}`;
};
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool
  && roomCapacity('coop', a) === roomCapacity('coop', b)
  && duckLordDisabled(a) === duckLordDisabled(b)
  && (a.disableLayerCap === true) === (b.disableLayerCap === true)
  && (a.disableHitLimit === true) === (b.disableHitLimit === true)
  && enemyMultiplier(a.enemyHpMul) === enemyMultiplier(b.enemyHpMul)
  && enemyMultiplier(a.enemyAtkMul) === enemyMultiplier(b.enemyAtkMul)
  && planKey(a) === planKey(b)
  && (a.collabOps === true) === (b.collabOps === true);

/**
 * Whether a room's options change a rule of the game, whatever the seat count: any key but playerCapacity that is set
 * (an option that is off is false or absent, shared/experimental.js experimentalOptions). 多人匹配's rules scope reads it
 * (server/matchmaking.js): the seat count is the other axis of a ticket.
 */
export const experimentalRuleChanged = value => !!value && Object.entries(value).some(([key, set]) => key !== 'playerCapacity' && !!set);

/**
 * 联动干员 (the owner's decision of 2026-11-02): with `collabOps` on, every player of the room may pick the collab 6★ in
 * 自选 (data/backups.json `diy.excluded`; shared/diy.js `collab`), after the host confirmed a copyright warning (the
 * client's 5 s hold, ui/experimental.js). A private (自建) room only: a matchmade room never has it (server/lobby.js
 * refuses it there and keeps such a room out of matchmaking). The client then also loads the collab art pack
 * (data/assets-collab.json, shared/collabAssets.js).
 * @param {any} value a room's / match's experimental options
 */
export const isCollabRoom = value => !!value && typeof value === 'object' && value.collabOps === true;
