// server/match/secret.js — a match's own private secret (docs/history/0.4.0.md §37.275). The match seed reaches every page
// (battle ids, m.result) and server/sim/rng.js deriveSeed is reversible, so a stream that must stay unpredictable cannot
// come from it. The secret is 256 random bits drawn on the server, never derived from anything a page sees, kept in the
// match's checkpoint (server/match/snapshot.js) and never sent; each private stream's seed is an HMAC of it. Today only an
// ELO room's match has one (server/match/tilt.js eloSeed: the streams a tilt draws from); a later fix of the seed leak can
// seed every server-only stream from it.
// Note: each stream is still mulberry32 with 32 bits of state — its own outputs could in principle be searched for that
// state; the HMAC keeps one stream's state from telling anything of the secret or of another stream.

import { createHmac, randomBytes } from 'node:crypto';

/** A secret's form: 64 lower-case hex digits (256 bits). @param {unknown} v */
export const isMatchSecret = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** A fresh secret. */
export const newMatchSecret = () => randomBytes(32).toString('hex');

/**
 * The uint32 seed of the private stream `salt` (HMAC-SHA256 of the secret, its first four bytes).
 * @param {string} secret isMatchSecret @param {string} salt
 */
export function secretSeed(secret, salt) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(String(salt)).digest().readUInt32LE(0);
}
