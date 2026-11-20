// server/match/secret.js — a match's own private secret (docs/history/0.4.0.md §37.275, §37.277). server/sim/rng.js
// deriveSeed is a reversible mix and the server's code is public, so a stream whose seed is a mix of anything a page sees
// can be computed by the page. The secret is 256 random bits drawn on the server, never derived from anything a page
// sees, kept in the match's checkpoint (server/match/snapshot.js) and never sent. Every stream of the match — setup, shop,
// waves, draft, bots, meta, each battle's seed, every other draw — is seeded by an HMAC of it (Match.streamSeed), and the
// ids a page gets name the match by another HMAC of it (secretTag): one value tells nothing of the secret or of another.
// Tools and tests fix the secret by a seed (seedSecret) so their runs repeat; the lobby and the game nodes draw a fresh one.
// Note: each stream is still mulberry32 with 32 bits of state — its own outputs could in principle be searched for that
// state; the HMAC keeps one stream's state from telling anything of the secret or of another stream.

import { createHash, createHmac, randomBytes } from 'node:crypto';

/** A secret's form: 64 lower-case hex digits (256 bits). @param {unknown} v */
export const isMatchSecret = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** A fresh secret. */
export const newMatchSecret = () => randomBytes(32).toString('hex');

/**
 * The fixed secret of a tool's or a test's seed (tools/matchrun.mjs, tools/golden.mjs, the test harness, a lobby given a
 * seedFn): the same seed, the same match. Never used for a match the lobby or a game node draws itself.
 * @param {number} seed uint32
 */
export const seedSecret = (seed) => createHash('sha256').update(`stronghold-match-secret:${Number(seed) >>> 0}`).digest('hex');

const mac = (secret, salt) => createHmac('sha256', Buffer.from(secret, 'hex')).update(String(salt)).digest();

/**
 * The uint32 seed of the private stream `salt` (HMAC-SHA256 of the secret, its first four bytes).
 * @param {string} secret isMatchSecret @param {string} salt
 */
export function secretSeed(secret, salt) {
  return mac(secret, salt).readUInt32LE(0);
}

/**
 * An opaque public name of the match (HMAC-SHA256 of the secret under `salt`, 48 bits in base 36, ≤ 10 characters): the
 * battleId prefix, m.public / m.result `matchId`. One-way: it tells nothing of the secret or of any stream.
 * @param {string} secret isMatchSecret @param {string} salt
 */
export function secretTag(secret, salt) {
  return mac(secret, `tag:${salt}`).readUIntLE(0, 6).toString(36);
}
