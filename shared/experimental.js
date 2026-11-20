// Room-owned experimental rules are snapshotted at launch, never player votes.
import { MAX_SEATS } from './constants.js';
import { N_ } from './i18n.js';
import { isPlayerCapacity, roomCapacity } from './playerCapacity.js';
import { canonicalPoolPlan, isPoolPlan } from './poolPlan.js';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });
/**
 * Optional booleans: absent when off, so an ordinary room, a saved room and a queue key keep their old shape.
 * @type {ReadonlySet<string | symbol>}
 */
const OPTIONAL_FLAGS = new Set(['disableDuckLord', 'disableLayerCap', 'disableHitLimit', 'collabOps', 'console', 'uniteHumansFirst', 'staticPoolSplit']);
/**
 * The enemy multipliers a room can pick (feedback #47); the first, a standard room's, is never stored: an ordinary room,
 * a saved room and a queue key keep their old shape.
 */
export const ENEMY_MULTIPLIERS = Object.freeze([1, 1.25, 1.5, 2, 2.5, 3, 5]);
export const isEnemyMultiplier = value => ENEMY_MULTIPLIERS.includes(value);
/** @type {ReadonlySet<string | symbol>} */
const OPTIONAL_MULTIPLIERS = new Set(['enemyHpMul', 'enemyAtkMul']);
const enemyMultiplier = value => (isEnemyMultiplier(value) ? value : 1);

/**
 * 敌人生命倍率 by round (feedback #118, rel27): `enemyHpPlan` = [[fromRound, multiplier], …] — "from round N on ×M", the
 * first segment from round 1, rounds ascending, 2..ENEMY_HP_PLAN_MAX segments, each multiplier one of ENEMY_MULTIPLIERS.
 * It replaces the single enemyHpMul (same scope: every enemy, the leader's shared pool included); a plan whose segments
 * all name one multiplier is that multiplier (canonicalEnemyHpPlan → null). A rel26 server refuses a room / match that
 * carries it (isExperimental), as any unknown option.
 */
export const ENEMY_HP_PLAN_MAX = 6;
/** The last round a segment may start at (co-op's last round is 14, a hidden leader's 15; a margin for other modes). */
export const ENEMY_HP_PLAN_ROUND_MAX = 20;
export function isEnemyHpPlan(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ENEMY_HP_PLAN_MAX) return false;
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const seg = value[i];
    if (!Array.isArray(seg) || seg.length !== 2) return false;
    const [from, mul] = seg;
    if (!Number.isInteger(from) || from < 1 || from > ENEMY_HP_PLAN_ROUND_MAX || (i === 0 ? from !== 1 : from <= last)) return false;
    if (!isEnemyMultiplier(mul)) return false;
    last = from;
  }
  return true;
}
/** A plan as stored: frozen pairs, or null when it is one multiplier throughout (then that multiplier is the room's). */
export function canonicalEnemyHpPlan(value) {
  if (!isEnemyHpPlan(value) || value.every(([, mul]) => mul === value[0][1])) return null;
  return Object.freeze(value.map(([from, mul]) => Object.freeze([from, mul])));
}
/** The single multiplier a plan collapses to (its only multiplier), or the room's single one. */
const flatHpMul = value => (isEnemyHpPlan(value?.enemyHpPlan) && !canonicalEnemyHpPlan(value.enemyHpPlan) ? value.enemyHpPlan[0][1] : enemyMultiplier(value?.enemyHpMul));
/** The multiplier of round `round` under a plan (rounds before 1 take the first segment's). */
const planAt = (plan, round) => {
  let mul = plan[0][1];
  for (const [from, m] of plan) if (round >= from) mul = m;
  return mul;
};
/**
 * The enemy HP multiplier a room's options give round `round` (1 = none): the plan's segment, else the single one.
 * @param {any} options experimental options @param {number} round
 */
export function enemyHpMulAt(options, round) {
  const plan = canonicalEnemyHpPlan(options?.enemyHpPlan);
  return plan ? planAt(plan, Number.isFinite(round) ? round : 1) : flatHpMul(options);
}
/** One string per HP rule: '' none, `hp<m>` one multiplier, `hpplan<from>x<m>,…` a plan. */
const hpKey = value => {
  const plan = canonicalEnemyHpPlan(value?.enemyHpPlan);
  if (plan) return `hpplan${plan.map(([from, mul]) => `${from}x${mul}`).join()}`;
  const hp = flatHpMul(value);
  return hp !== 1 ? `hp${hp}` : '';
};

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 2 || keys.length > 14) return false;
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
    if (key === 'enemyHpPlan') return isEnemyHpPlan(descriptor.value);
    return OPTIONAL_FLAGS.has(key) && typeof descriptor.value === 'boolean';
  });
}

/**
 * @param {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean,
 *   disableLayerCap?: boolean, disableHitLimit?: boolean, enemyHpMul?: number, enemyAtkMul?: number,
 *   enemyHpPlan?: readonly (readonly number[])[], poolPlan?: readonly number[], collabOps?: boolean, console?: boolean,
 *   uniteHumansFirst?: boolean, staticPoolSplit?: boolean }} [value]
 *   `poolPlan`: 手动指定卡池编组, one pool number per seat (shared/poolPlan.js); it states every seat's pool, so it replaces
 *   禁用共享卡池. `enemyHpPlan`: 敌人生命倍率 by round (isEnemyHpPlan); it replaces enemyHpMul. `collabOps`: 联动干员
 *   (isCollabRoom). `console`: 调控台 (isConsoleRoom). `uniteHumansFirst`: AI 联防置后 (server/match/unite.js helperOrder).
 *   `staticPoolSplit`: 卡池静态初始化 (isStaticPoolSplit); dropped under 禁用共享卡池, where every seat has a whole pool.
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
    ...hpOption(value),
    ...(enemyMultiplier(value.enemyAtkMul) !== 1 ? { enemyAtkMul: value.enemyAtkMul } : {}),
    ...(value.poolPlan ? { poolPlan: Object.freeze(canonicalPoolPlan(value.poolPlan)) } : {}),
    ...(value.collabOps === true ? { collabOps: true } : {}),
    ...(value.console === true ? { console: true } : {}),
    ...(value.uniteHumansFirst === true ? { uniteHumansFirst: true } : {}),
    ...(value.staticPoolSplit === true && !(value.disableSharedPool && !value.poolPlan) ? { staticPoolSplit: true } : {}) });
}

/** The HP rule as stored: a plan (it replaces the single multiplier), else the single multiplier when ≠ 1, else nothing. */
function hpOption(value) {
  const plan = canonicalEnemyHpPlan(value.enemyHpPlan);
  if (plan) return { enemyHpPlan: plan };
  const hp = flatHpMul(value);
  return hp !== 1 ? { enemyHpMul: hp } : {};
}

const duckLordDisabled = value => roomCapacity('coop', value) > MAX_SEATS && value.disableDuckLord === true;
/** One string per pool layout, in any numbering; empty without a plan. */
const planKey = value => (value.poolPlan ? canonicalPoolPlan(value.poolPlan).join() : '');
export const experimentalKey = value => {
  const key = `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
  const capacity = roomCapacity('coop', value);
  const legacy = capacity === MAX_SEATS ? key : `${key}:${capacity}`;
  const hp = hpKey(value), atk = enemyMultiplier(value.enemyAtkMul);
  return `${duckLordDisabled(value) ? `${legacy}:duck` : legacy}${value.disableLayerCap === true ? ':layers' : ''}${value.disableHitLimit === true ? ':hits' : ''}${hp ? `:${hp}` : ''}${atk !== 1 ? `:atk${atk}` : ''}${value.poolPlan ? `:pools${planKey(value)}` : ''}${value.collabOps === true ? ':collab' : ''}${value.console === true ? ':console' : ''}${value.uniteHumansFirst === true ? ':humans' : ''}${value.staticPoolSplit === true ? ':split' : ''}`;
};
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool
  && roomCapacity('coop', a) === roomCapacity('coop', b)
  && duckLordDisabled(a) === duckLordDisabled(b)
  && (a.disableLayerCap === true) === (b.disableLayerCap === true)
  && (a.disableHitLimit === true) === (b.disableHitLimit === true)
  && hpKey(a) === hpKey(b)
  && enemyMultiplier(a.enemyAtkMul) === enemyMultiplier(b.enemyAtkMul)
  && planKey(a) === planKey(b)
  && (a.collabOps === true) === (b.collabOps === true)
  && (a.console === true) === (b.console === true)
  && (a.uniteHumansFirst === true) === (b.uniteHumansFirst === true)
  && (a.staticPoolSplit === true) === (b.staticPoolSplit === true);

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

/**
 * 调控台 (feedback #125, the owner's decisions of 2026-11-03): with `console` on, the room's matches run as test matches
 * (DESIGN §34.8 phase 2, server/match/match/testCommands.js) without the input journal — every seated player commands
 * their own seat; a command that changes the whole match only while that player is its only human — and count for
 * nothing (no titles / trophies / rewards; the client keeps no record). Set by the host of a private (自建) room in the
 * room settings after a 5 s warning (ui/consoleRoom.js), never at room.create; a room with it never enters matchmaking
 * and a matchmade room never has it (server/lobby.js). It rides with the options, so a game node, a version host and a
 * restored room see it like any rule; a console match takes no checkpoint (snapshot.js canSnapshot: a test match).
 * @param {any} value a room's / match's experimental options
 */
export const isConsoleRoom = value => !!value && typeof value === 'object' && value.console === true;

/**
 * AI 联防置后 (the owner's request of 2026-11-04): with `uniteHumansFirst` on, the 联防 helpers are chosen among the humans
 * first — the usual order (server/match/unite.js helperOrder) within them — and the seats the engine plays (an AI teammate,
 * a human under AI 托管) only after every human; the pair's order (who meets the enemies first) puts the human first too
 * [ASSUMED]. A rule of the room, any room; it changes nothing outside 联防. A rel28 server refuses it (isExperimental).
 * @param {any} value a room's / match's experimental options
 */
export const isUniteHumansFirst = value => !!value && typeof value === 'object' && value.uniteHumansFirst === true;

/**
 * 卡池静态初始化 (the owner's request of 2026-11-20: 「开局定死每个人的卡池，只有在队友退出/死亡时才会重新刷新」, then 「按等级
 * 分，每个人的每个等级的干员数量是一样的，但是每个干员，每人持有的数量是不一样的」): with `staticPoolSplit` on, every chess-pool
 * group (server/match/pool.js createPoolGroups) deals its copies to its seats at the match's start — per tier, every copy of
 * every operator of that tier shuffled into one deck with the match's seeded rng and dealt round-robin, so each seat holds
 * the same number of copies of a tier (a remainder: one more for seats the rng picks) but its own mix of operators; the
 * equipment stock is dealt the same way by equipment tier. A seat's shop, rewards and grants draw only on its own share,
 * its buys take from it, its sales and losses go back to it. When a seat of the group is eliminated or leaves (a seat AI
 * 托管 plays on keeps its share), its pieces go back first, then every copy the group has left is dealt again among the
 * seats still in it (pool.js dealShares). Nothing of it under 禁用共享卡池 (experimentalOptions drops it) or in a group of
 * one seat. A rel44 server refuses it (isExperimental), as any unknown option.
 * @param {any} value a room's / match's experimental options
 */
export const isStaticPoolSplit = value => !!value && typeof value === 'object' && value.staticPoolSplit === true;

/**
 * The categories of the experimental options (the owner, 2026-11-16: 「实验性功能需要拆分成多个分类，目前单个大项下的选项太
 * 多了」): every option belongs to exactly one, in this order. The room's dialog (ui/roomSettings.js), 多人匹配's own options
 * (ui/matchmaking.js) and every summary — the room's 实验性功能 badge, 确认入场 (ui/matchOffer.js) — list them by these
 * groups; which options a place offers is its own (a solo room has no teammates, a ticket no seat plan). `keys`: the option
 * fields of the group (`enemyHpPlan` stands in for `enemyHpMul` when set, isEnemyHpPlan).
 */
export const EXPERIMENTAL_GROUPS = Object.freeze([
  Object.freeze({ id: 'seats', label: N_('同盟人数'), keys: Object.freeze(['playerCapacity']) }),
  Object.freeze({ id: 'team', label: N_('队友协作'), keys: Object.freeze(['revivalEnabled', 'uniteHumansFirst']) }),
  Object.freeze({ id: 'bonds', label: N_('盟约与策略'), keys: Object.freeze(['disableLayerCap', 'disableDuckLord']) }),
  Object.freeze({ id: 'enemy', label: N_('敌人'), keys: Object.freeze(['enemyHpMul', 'enemyHpPlan', 'enemyAtkMul', 'disableHitLimit']) }),
  Object.freeze({ id: 'pools', label: N_('卡池'), keys: Object.freeze(['disableSharedPool', 'staticPoolSplit', 'poolPlan']) }),
  Object.freeze({ id: 'special', label: N_('特殊功能'), keys: Object.freeze(['collabOps', 'console']) }),
]);
/** The group of an option field, or null. @param {string} key */
export const experimentalGroupOf = key => EXPERIMENTAL_GROUPS.find(group => group.keys.includes(key))?.id ?? null;

/**
 * The options a lone 多人匹配 ticket may bring (queue.join `rules` 'custom' + `experimental`, the owner 2026-11-16: 「匹配
 * 玩家也支持调整实验性功能，然后带着这个实验性功能配置进入匹配」; server/matchmaking.js): the rules of the game only — not the
 * seat count (the ticket's sizes say it), not 手动指定卡池编组 (nobody knows the seats yet), not 联动干员 / 调控台 (a private
 * room's alone).
 */
export const QUEUE_OPTION_KEYS = Object.freeze(['revivalEnabled', 'disableSharedPool', 'staticPoolSplit', 'uniteHumansFirst', 'disableLayerCap', 'disableDuckLord',
  'enemyHpMul', 'enemyHpPlan', 'enemyAtkMul', 'disableHitLimit']);

/**
 * A ticket's own options, checked and canonical (frozen), or null when `value` is not experimental options of
 * QUEUE_OPTION_KEYS. 禁用鸭爵策略 is kept as asked: it only counts in a pool above four seats (queueOptionsAt).
 * @param {unknown} value
 */
export function queueOptions(value) {
  if (!isExperimental(value) || Object.keys(value).some(key => !QUEUE_OPTION_KEYS.includes(key))) return null;
  const { disableDuckLord, ...rules } = /** @type {any} */ (value);
  return Object.freeze({ ...experimentalOptions(rules), ...(disableDuckLord === true ? { disableDuckLord: true } : {}) });
}

/**
 * The options of the game a ticket's own options make in a pool of `required` seats: the room's options at that size
 * (experimentalOptions; 禁用鸭爵策略 only above four seats). @param {any} options queueOptions @param {number} required
 */
export const queueOptionsAt = (options, required) => experimentalOptions({ ...options, ...(required === MAX_SEATS ? {} : { playerCapacity: required }) });
