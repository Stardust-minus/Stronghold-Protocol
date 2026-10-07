// Room-owned experimental rules are snapshotted at launch, never player votes.
export const EXPERIMENTAL_DEFAULTS = Object.freeze({ revivalEnabled: false, disableSharedPool: false });

export function isExperimental(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.every(key => Object.hasOwn(EXPERIMENTAL_DEFAULTS, key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && typeof Object.getOwnPropertyDescriptor(value, key)?.value === 'boolean');
}

export function experimentalOptions(value = EXPERIMENTAL_DEFAULTS) {
  if (!isExperimental(value)) throw new TypeError('invalid experimental options');
  return Object.freeze({ revivalEnabled: value.revivalEnabled, disableSharedPool: value.disableSharedPool });
}

export const experimentalKey = value => `${value.revivalEnabled ? 1 : 0}${value.disableSharedPool ? 1 : 0}`;
export const sameExperimental = (a, b) => !!a && !!b
  && a.revivalEnabled === b.revivalEnabled && a.disableSharedPool === b.disableSharedPool;
