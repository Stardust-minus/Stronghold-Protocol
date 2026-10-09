import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../../public/js/store.js';
import { operatorPresetPayload, parseOperatorPreset, prepareOperatorPreset } from '../../public/js/ui/operatorPresetModel.js';
import { applyOperatorPreset } from '../../public/js/ui/loadoutSync.js';
import { serializeExport } from '../../public/js/ui/loadoutModel.js';
import { cultivationCharIds } from '../../shared/protocol.js';

const read = name => JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url)));
const chess = read('chess'), backups = read('backups');
const lookup = id => Object.hasOwn(chess, id) ? chess[id] : null;
const deps = { lookup, data: { chess, backups }, kitted: Object.keys(backups.diy.operators) };
const charId = [...cultivationCharIds(chess, backups)][0];
const empty = () => ({ entries: {}, notOwned: [], diy: {}, skins: {} });
const ops = () => ({ [charId]: { potential: 1, cultivate: 0 } });

test('complete presets carry independent potential/cultivation with one memory update and one loadout write', () => {
  const state = { ...empty(), ops: ops() };
  const raw = operatorPresetPayload(state, { now: 0 });
  assert.equal(raw.v, 1);
  assert.deepEqual(raw.ops, state.ops);
  assert.notEqual(raw.ops, state.ops);
  assert.notEqual(raw.ops[charId], state.ops[charId]);
  const target = createStore({ ...empty(), ops: {}, open: true });
  const saved = [], updated = [];
  target.subscribe(value => updated.push(structuredClone(value)));
  const result = applyOperatorPreset(parseOperatorPreset(raw), deps, { target, persist: (key, value) => saved.push({ key, value }) });
  assert.equal(result.ok, true);
  assert.deepEqual(target.get().ops, ops());
  assert.equal(target.get().open, true);
  assert.equal(updated.length, 1);
  assert.equal(saved.length, 4);
  assert.equal(saved.filter(row => row.key === 'loadout').length, 1);
  assert.deepEqual(saved.find(row => row.key === 'loadout').value.ops, ops());
});

test('older complete four-section presets preserve current operator settings in memory and storage', () => {
  const target = createStore({ ...empty(), ops: ops() });
  const saved = [];
  const result = applyOperatorPreset(parseOperatorPreset(operatorPresetPayload(empty())), deps, { target, persist: (key, value) => saved.push({ key, value }) });
  assert.equal(result.ok, true);
  assert.deepEqual(target.get().ops, ops());
  assert.deepEqual(saved.find(row => row.key === 'loadout').value.ops, ops());
});

test('legacy operator-settings-only files do not clear existing skill/module choices', () => {
  const entries = { chess_char_1_01_a: { skill: 0 } };
  const target = createStore({ ...empty(), entries, ops: {} });
  const saved = [];
  const parsed = parseOperatorPreset(serializeExport({}, { ops: ops() }));
  const result = applyOperatorPreset(parsed, deps, { target, persist: (key, value) => saved.push({ key, value }) });
  assert.equal(result.ok, true);
  assert.deepEqual(target.get().entries, entries);
  assert.deepEqual(target.get().ops, ops());
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].value.entries, entries);
  assert.deepEqual(saved[0].value.ops, ops());
});

test('explicit empty operator section restores defaults coherently', () => {
  const target = createStore({ ...empty(), ops: ops() });
  const result = applyOperatorPreset(parseOperatorPreset(operatorPresetPayload({ ...empty(), ops: {} })), deps, { target, persist() {} });
  assert.equal(result.ok, true);
  assert.deepEqual(target.get().ops, {});
});

test('unknown operator settings reject the entire preset before storage or notification', () => {
  const before = { ...empty(), ops: ops() }, target = createStore(structuredClone(before));
  const saved = [], updates = [];
  target.subscribe(value => updates.push(value));
  const raw = operatorPresetPayload({ ...empty(), ops: {} });
  raw.ops = { missing: { potential: 1 } };
  const result = applyOperatorPreset(parseOperatorPreset(raw), deps, { target, persist: (...args) => saved.push(args) });
  assert.equal(result.ok, false);
  assert.deepEqual(target.get(), before);
  assert.deepEqual(saved, []);
  assert.deepEqual(updates, []);
});

test('nonempty operator settings require both data sources, malformed shapes reject during pure parsing', () => {
  const raw = operatorPresetPayload({ ...empty(), ops: ops() });
  assert.equal(parseOperatorPreset({ ...raw, ops: [] }).ok, false);
  for (const data of [{ chess }, { backups }]) {
    assert.equal(prepareOperatorPreset(parseOperatorPreset(raw), { ...deps, data }).ok, false);
  }
});
