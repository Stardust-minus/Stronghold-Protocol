import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, legalTileFor } from './match/harness.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { GEO } from '../shared/constants.js';
import { OPERATOR_SKINS } from '../shared/skins.js';

const CHAR = 'char_103_angel', ID = 'chess_char_3_01_a';
const skinId = OPERATOR_SKINS[0].id;

test('actual PlayerBattleInput → BattleSpec → resolved UnitInfo carries choice only on its owner\'s instances', t => {
  const h = makeMatch({ seats: [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins: { [CHAR]: skinId } },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true },
  ] }).start();
  t.after(() => h.m.dispose()); h.toPrep(1);
  const inputs = [];
  for (let i = 0; i < 2; i++) {
    const ps = h.ps(`p_${i}`); ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
    const tile = legalTileFor(h.m, ps, ID); assert.ok(tile);
    const piece = ps.newPiece('chess', ID); ps.board.set(tile.join(','), piece);
    const input = ps.battleInput({ colOffset: i * 8 });
    assert.equal(input.units.length, 1);
    if (i) assert.equal(Object.hasOwn(input.units[0], 'skinId'), false);
    else assert.equal(input.units[0].skinId, skinId);
    assert.equal(Object.hasOwn(input, 'skins'), false, 'the private preference map never travels in a BattleSpec');
    inputs.push(input);
  }
  const opts = { battleId: 'skin-spec', fieldId: 'unite:skin', kind: 'unite', seed: 17, modeId: h.m.modeId, round: 1,
    stageId: h.m.stageId, rect: { ...GEO.UNITE_RECT }, timeLimit: 5, players: inputs, spawns: [], routes: [], flags: { ...h.m.gd.dp }, content: 'full' };
  const spec = buildBattleSpec(opts);
  const copy = JSON.stringify(spec);
  const battle = createBattleFromSpec(spec, h.m.ds, { quiet: true });
  battle.step();
  const own = battle.fieldMeta().units.find(u => u.ownerId === 'p_0'), other = battle.fieldMeta().units.find(u => u.ownerId === 'p_1');
  assert.equal(own.skinId, skinId); assert.equal(Object.hasOwn(other, 'skinId'), false);
  assert.equal(own.spine, other.spine); assert.equal(own.avatar, other.avatar); assert.equal(own.defId, other.defId);
  assert.equal(JSON.stringify(spec), copy, 'building/simulating a field does not mutate the spec');
  for (const u of battle.allyUnits) assert.equal(Object.hasOwn(u.def, 'skinId'), false);

  h.ps('p_0').setSkins({});
  const defaultInput = h.ps('p_0').battleInput();
  const stripped = JSON.parse(JSON.stringify(inputs[0])); delete stripped.units[0].skinId;
  assert.equal(JSON.stringify(defaultInput), JSON.stringify(stripped), 'default input bytes match the exact skin-free input');
  const defaultSpec = buildBattleSpec({ ...opts, players: [defaultInput] });
  const strippedSpec = buildBattleSpec({ ...opts, players: [stripped] });
  assert.equal(JSON.stringify(defaultSpec), JSON.stringify(strippedSpec), 'no default skinId:null/undefined key is inserted');
});
