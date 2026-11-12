// shared/resultHash.js — the result hash of the battle-result consensus checks (DESIGN §14 "Shadow verification"): the
// SHA-256 of a result's canonical JSON (server/sim/spec.js resultCanonicalJson) as 64 lowercase hex digits. The old
// resultDigest is a 32-bit FNV — easy to collide on purpose, fine for diagnostics, never for a consensus check.
//
//   resultHashOf(json)  → Promise<string>   a browser: crypto.subtle where the page is a secure context (the served
//                                           HTTPS page), shared/sha256.js otherwise (a LAN page at http://…, which has no
//                                           crypto.subtle); the server hashes with node:crypto (server/match/verify/hash.js)
//   isResultHash(v)     → boolean
//
// All three hash the UTF-8 bytes of the same string, so they give the same digest (test/verify-hash.test.js; a real
// Chrome in test/ui/shadow-verify.e2e.test.js).
import { sha256Hex } from './sha256.js';

/** Bumped if the canonical JSON or the hash ever changes: a page and a server of different versions never compare. */
export const RESULT_HASH_VERSION = 1;

const HEX = /^[0-9a-f]{64}$/;
/** @param {unknown} v @returns {v is string} */
export const isResultHash = (v) => typeof v === 'string' && HEX.test(v);

const toHex = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
};

/**
 * @param {string} json the canonical JSON of a result
 * @param {{ subtle?: SubtleCrypto | null }} [opts] `subtle`: tests (null = the plain-JS hash)
 * @returns {Promise<string>}
 */
export async function resultHashOf(json, { subtle = globalThis.crypto?.subtle ?? null } = {}) {
  if (typeof json !== 'string') throw new TypeError('resultHashOf: the canonical JSON string is required');
  if (subtle && typeof subtle.digest === 'function' && typeof TextEncoder === 'function') {
    try {
      return toHex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(json))));
    } catch { /* a context without the digest: the plain-JS hash below gives the same digest */ }
  }
  return sha256Hex(json);
}
