// server/match/verify/hash.js — the server's side of shared/resultHash.js: the SHA-256 of a result's canonical JSON
// (server/sim/spec.js resultCanonicalJson) with node:crypto, synchronously (the browsers' crypto.subtle is async).
import { createHash } from 'node:crypto';
import { resultCanonicalJson } from '../../sim/spec.js';

/** @param {string} json @returns {string} 64 hex digits */
export const resultHashSync = (json) => createHash('sha256').update(json, 'utf8').digest('hex');

/** The result hash of `result` as a page computes it from its own run (`rename`: a pseudonymized spec's player ids). */
export const resultHashOfResult = (result, rename = null) => resultHashSync(resultCanonicalJson(result, rename));
