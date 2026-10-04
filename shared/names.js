// Node game/auth share ONE canonical pure policy and offline dictionary. The auth directory is
// its home because the password gate has an isolated Docker build context and no dependencies.
// Not imported by browser UI; nickname acceptance is always server-authoritative.
export { moderateName, sanitizeName, createNamePolicy, NAME_POLICY_LIMITS, NAME_REASON,
  NAME_REJECTED_MESSAGE, nameReasonMessage } from '../deploy/stardust/auth/name-policy.mjs';
