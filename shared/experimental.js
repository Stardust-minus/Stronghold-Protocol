// Room-owned experimental rules are snapshotted at launch, never player votes.
import { MAX_SEATS } from './constants.js';
import { isPlayerCapacity, roomCapacity } from './playerCapacity.js';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });

// Optional rules with their own defaults: a room that never mentions one keeps the ordinary two-flag wire shape
// (legacy DTOs, matchmaking offers and stored rooms are unaffected). Unlike the two rules above they are
// presentation/runtime switches, not combat rules:
//   briefingSpecialEnemies  the strategy draft also shows 本局特训敌人 — **on by default** (the owner, 2026-10-16);
//                           a room that wants the old behaviour stores an explicit `false`
//   luckConsole             the Luck test console stays dormant unless the room asked for it (off by default)
export const EXPERIMENTAL_OPTIONAL = Object.freeze(['briefingSpecialEnemies', 'luckConsole']);
export const EXPERIMENTAL_OPTIONAL_DEFAULTS = Object.freeze({ briefingSpecialEnemies: true, luckConsole: false });
const OPTIONAL_TAGS = Object.freeze({ briefingSpecialEnemies: 'brief', luckConsole: 'luck' });

/** The switch's value as the game reads it: the stored boolean, or the option's own default when absent. */
export function optionalValue(value, key) {
  const stored = Object.getOwnPropertyDescriptor(value ?? {}, key)?.value;
  return typeof stored === 'boolean' ? stored : EXPERIMENTAL_OPTIONAL_DEFAULTS[key] === true;
}
const optionalOn = (value, key) => optionalValue(value, key);

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  // two rules + optional capacity + optional duck lord + the optional switches
  if (keys.length < 2 || keys.length > 4 + EXPERIMENTAL_OPTIONAL.length) return false;
  for (const key of Object.keys(EXPERIMENTAL_DEFAULTS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || typeof descriptor.value !== 'boolean') return false;
  }
  return keys.every(key => {
    if (Object.hasOwn(EXPERIMENTAL_DEFAULTS, key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) return false;
    if (EXPERIMENTAL_OPTIONAL.includes(key)) return typeof descriptor.value === 'boolean';
    return key === 'playerCapacity' ? isPlayerCapacity(descriptor.value)
      : key === 'disableDuckLord' && typeof descriptor.value === 'boolean';
  });
}

/** @param {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean, briefingSpecialEnemies?: boolean, luckConsole?: boolean }} [value] */
export function experimentalOptions(value = EXPERIMENTAL_DEFAULTS) {
  if (!isExperimental(value)) throw new TypeError('invalid experimental options');
  const capacity = roomCapacity('coop', value);
  return Object.freeze({ revivalEnabled: value.revivalEnabled, disableSharedPool: value.disableSharedPool,
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    // Optional and false by default: ordinary rooms and legacy DTOs keep their two-flag shape.
    ...(capacity > MAX_SEATS && value.disableDuckLord === true ? { disableDuckLord: true } : {}),
    // Only switches that differ from their own default ride the wire: an ordinary room keeps its two-flag shape,
    // and 策略阶段看特训敌人 (default on) is carried as an explicit `false` when a room turns it off.
    ...EXPERIMENTAL_OPTIONAL.reduce((out, key) => {
      const next = optionalValue(value, key);
      if (next !== EXPERIMENTAL_OPTIONAL_DEFAULTS[key]) out[key] = next;
      return out;
    }, {}) });
}

const duckLordDisabled = value => roomCapacity('coop', value) > MAX_SEATS && value.disableDuckLord === true;
export const experimentalKey = value => {
  let key = `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
  const capacity = roomCapacity('coop', value);
  if (capacity !== MAX_SEATS) key += `:${capacity}`;
  if (duckLordDisabled(value)) key += ':duck';
  for (const name of EXPERIMENTAL_OPTIONAL) {
    const on = optionalValue(value, name);
    if (on !== EXPERIMENTAL_OPTIONAL_DEFAULTS[name]) key += `:${on ? '' : 'no'}${OPTIONAL_TAGS[name]}`;
  }
  return key;
};
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool
  && roomCapacity('coop', a) === roomCapacity('coop', b)
  && duckLordDisabled(a) === duckLordDisabled(b)
  // A switch this comparison forgets is silently dropped by room.setExperimental (server/lobby.js:1185), so
  // compare the optional ones explicitly rather than by object identity.
  && EXPERIMENTAL_OPTIONAL.every(key => optionalOn(a, key) === optionalOn(b, key));
