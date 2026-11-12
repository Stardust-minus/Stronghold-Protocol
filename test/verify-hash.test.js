// The result hash of shadow verification (shared/resultHash.js, server/match/verify/hash.js): the canonical JSON is
// resultDigest's of before (no rename), and node:crypto, crypto.subtle and the plain-JS SHA-256 give the same digest of
// it — the bytes a browser and the server hash are the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resultCanonicalJson, resultDigest, createBattleFromSpec } from '../server/sim/spec.js';
import { DataSource } from '../server/sim/simdata.js';
import { resultHashOf, isResultHash } from '../shared/resultHash.js';
import { sha256Hex } from '../shared/sha256.js';
import { resultHashSync, resultHashOfResult } from '../server/match/verify/hash.js';
import { getData } from '../server/data.js';
import { corpusSpecs } from '../tools/sim-check.mjs';

const fnv = (json) => {
  let h = 2166136261;
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

function run(spec, cap = null) {
  const b = createBattleFromSpec(spec, new DataSource(getData(), null), { quiet: true, recordEvents: false });
  const limit = cap ?? 111_000;
  while (!b.finished && b.tickCount < limit) b.step();
  if (!b.finished) b.forceEnd('timeout');
  return b.result();
}

const SAMPLE = {
  reason: 'cleared', time: 41.23456789, killed: 12, total: 14,
  perPlayer: {
    p_b: { killed: 5, total: 7, perfect: false, coins: 2.5, layerGains: { bond_z: 1.25, bond_a: 2 }, damageDealt: 1234.6, bossDamage: 0,
      leaked: [{ enemyKey: 'enemy_x', counted: true, sourcePlayerId: 'p_a', mods: { atk: 1.2, bounty: 'b1' } }, { enemyKey: 'enemy_a' }],
      unitsEnd: [{ uid: 3, hpPct: 0.123456, sp: 4, alive: true }] },
    p_a: { killed: 7, total: 7, perfect: true, coins: 0, layerGains: {}, damageDealt: 99, bossDamage: 0, leaked: [], unitsEnd: [] },
  },
};

test('the canonical JSON without rename is exactly the JSON resultDigest hashed before', () => {
  const { json, hash } = resultDigest(SAMPLE);
  assert.equal(resultCanonicalJson(SAMPLE), json);
  assert.equal(hash, fnv(json));
  // the old construction, kept here verbatim as the reference
  const r4 = (v) => Math.round((Number(v) || 0) * 1e4) / 1e4;
  const modsKey = (m) => (m && typeof m === 'object' ? JSON.stringify(Object.keys(m).filter((k) => m[k] !== undefined).sort().map((k) => [k, m[k]])) : '');
  const old = JSON.stringify([SAMPLE.reason, r4(SAMPLE.time), SAMPLE.killed, SAMPLE.total, Object.keys(SAMPLE.perPlayer).sort().map((pid) => {
    const p = SAMPLE.perPlayer[pid];
    return [pid, p.killed | 0, p.total | 0, !!p.perfect, r4(p.coins), Object.keys(p.layerGains).sort().map((k) => [k, r4(p.layerGains[k])]),
      p.leaked.map((l) => `${l.enemyKey}|${l.counted === false ? 0 : 1}|${l.uniteRuntime ? 'x' : ''}|${l.sourcePlayerId || ''}|${modsKey(l.mods)}`).sort(),
      Math.round(p.damageDealt), Math.round(p.bossDamage), p.unitsEnd.map((u) => [u.uid, r4(u.hpPct), r4(u.sp), !!u.alive])];
  })]);
  assert.equal(json, old);
});

test('rename writes every player id of the result through the map, and sorts by the new names', () => {
  const json = resultCanonicalJson(SAMPLE, { p_a: 'vaa', p_b: 'vab' });
  assert.ok(!json.includes('p_a') && !json.includes('p_b'));
  const players = JSON.parse(json)[4];
  assert.deepEqual(players.map((p) => p[0]), ['vaa', 'vab']);
  assert.ok(players[1][6].some((l) => l.includes('|vaa|')), 'a leak names its source by the pseudonym');
});

test('node:crypto, crypto.subtle and shared/sha256.js agree on canonical results (and on non-ASCII text)', async () => {
  const jsons = [resultCanonicalJson(SAMPLE), resultCanonicalJson({}), '', '漏怪 ☃ 𝄞 é', JSON.stringify({ a: [1, 2.5, 'x'] })];
  for (const { spec, cap } of corpusSpecs(['fields']).slice(0, 6)) jsons.push(resultCanonicalJson(run(spec, cap)));
  for (const json of jsons) {
    const node = createHash('sha256').update(json, 'utf8').digest('hex');
    assert.equal(resultHashSync(json), node);
    assert.equal(sha256Hex(json), node);
    assert.equal(await resultHashOf(json), node, 'crypto.subtle');
    assert.equal(await resultHashOf(json, { subtle: null }), node, 'the plain-JS fallback (no secure context)');
    assert.ok(isResultHash(node));
  }
  assert.equal(resultHashOfResult(SAMPLE), resultHashSync(resultCanonicalJson(SAMPLE)));
});
