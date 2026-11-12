// server/match/verify/pseudonym.js — the BattleSpec a verifier of another match receives (the consensus design §2.2):
// every player id in it (the field's players, the 联防 leakers its spawns name, the ids inside other strings such as the
// field id `n:<playerId>`) is replaced by a pseudonym, and the battle id by the verification id — a browser outside the
// match learns no id of anyone in it. The pseudonyms keep the ids' code-unit order ('vaa' < 'vab' < … in the order of the
// sorted ids), so anything that sorts players sorts them the same way; the sim never reads a player id but to look a
// player up (test/verify-pseudonym.test.js runs real specs both ways and compares their canonical results).
//
//   pseudonymizeSpec(spec, vid) → { spec, rename }   rename: { [playerId]: pseudonym } — resultCanonicalJson(result,
//                                                    rename) of the server's own result is what the verifier's run gives

/** Keys whose string value names a player (a spec's players and the 联防 leakers its spawns carry). */
const ID_KEYS = new Set(['playerId', 'sourcePlayerId', 'ownerId', 'leakerId']);

const alias = (i) => `v${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + (i % 26))}`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {object} spec @param {string} vid @returns {{ spec: object, rename: Record<string, string> }} */
export function pseudonymizeSpec(spec, vid) {
  const ids = new Set();
  const collect = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 16) return;
    if (Array.isArray(v)) { for (const x of v) collect(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEYS.has(k) && typeof x === 'string' && x) ids.add(x);
      else collect(x, depth + 1);
    }
  };
  collect(spec?.players, 0);
  collect(spec?.spawns, 0);
  const sorted = [...ids].sort();
  if (sorted.length > 26 * 26) throw new RangeError('too many players to pseudonymize');
  const rename = Object.create(null);
  sorted.forEach((id, i) => { rename[id] = alias(i); });
  const re = sorted.length ? new RegExp([...sorted].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g') : null;
  const sub = (s) => (re ? s.replace(re, (m) => rename[m]) : s);
  const map = (v) => {
    if (typeof v === 'string') return sub(v);
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(map);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[sub(k)] = map(x);
    return out;
  };
  const out = map(spec);
  out.battleId = vid;
  return { spec: out, rename: { ...rename } };
}
