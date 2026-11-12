// Shadow verification hands a verifier a pseudonymized spec (server/match/verify/pseudonym.js): run both, the verifier's
// canonical result equals the server's renamed one — over the golden corpus's fast battles (every family: rosters,
// bonds, the field kinds with 联防 leakers, stand-ins, 自选).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleFromSpec, resultCanonicalJson } from '../server/sim/spec.js';
import { DataSource } from '../server/sim/simdata.js';
import { getData } from '../server/data.js';
import { pseudonymizeSpec } from '../server/match/verify/pseudonym.js';
import { corpusSpecs } from '../tools/sim-check.mjs';

const ds = new DataSource(getData(), null);
function run(spec, cap) {
  const b = createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false });
  const limit = cap ?? 111_000;
  while (!b.finished && b.tickCount < limit) b.step();
  if (!b.finished) b.forceEnd('timeout');
  return { result: b.result(), ticks: b.tickCount };
}
const idsIn = (spec) => (spec.players || []).map((p) => p.playerId);

test('a pseudonymized spec names no player id and keeps their order', () => {
  const spec = { battleId: 'b.1.2.n:p_zz', fieldId: 'n:p_zz', kind: 'unite', players: [{ playerId: 'p_zz' }, { playerId: 'p_aa' }],
    spawns: [{ enemyKey: 'e', sourcePlayerId: 'p_mm' }], flags: { note: 'from p_zz to p_aa' } };
  const { spec: out, rename } = pseudonymizeSpec(spec, 'sv01');
  assert.deepEqual(rename, { p_aa: 'vaa', p_mm: 'vab', p_zz: 'vac' });
  assert.equal(out.battleId, 'sv01');
  assert.equal(out.fieldId, 'n:vac');
  assert.deepEqual(idsIn(out), ['vac', 'vaa']);
  assert.equal(out.spawns[0].sourcePlayerId, 'vab');
  assert.equal(JSON.stringify(out).match(/p_(aa|mm|zz)/), null);
  assert.equal(spec.players[0].playerId, 'p_zz', 'the original is untouched');
});

test('the fast golden battles give the same result pseudonymized (canonical JSON, renamed)', () => {
  const corpus = corpusSpecs().filter((c) => c.fast);
  assert.ok(corpus.length >= 40, `fast corpus of ${corpus.length}`);
  let unite = 0, multi = 0;
  for (const { id, spec, cap } of corpus) {
    const { spec: pseudo, rename } = pseudonymizeSpec(spec, `sv${id.length}`);
    if (spec.kind === 'unite') unite++;
    if (Object.keys(rename).length > 1) multi++;
    const a = run(spec, cap), b = run(pseudo, cap);
    assert.equal(b.ticks, a.ticks, `${id}: ticks`);
    assert.equal(resultCanonicalJson(b.result), resultCanonicalJson(a.result, rename), `${id}: canonical result`);
  }
  assert.ok(multi > 0, 'some battle has more than one player id');
  void unite;
});
