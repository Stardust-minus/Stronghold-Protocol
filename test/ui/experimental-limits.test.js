import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentalOptions, experimentalChanged, experimentalSummary, capacityRows, duckLordRow, poolRows, ruleRows } from '../../public/js/ui/experimental.js';
const settingsRows = (props) => [capacityRows(props), duckLordRow(props), ruleRows(props), poolRows(props)];
import { discCount } from '../../public/js/ui/components.js';
import { withLiveLayers } from '../../public/js/ui/watchBonds.js';
import { enemyPreviewStat } from '../../public/js/ui/detailPanel.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const body = (node) => (node?.props ? [node, ...[].concat(node.props.children ?? []).flatMap(body)] : Array.isArray(node) ? node.flatMap(body) : []);

test('options, marker and summary name each rule, and only when it is on', () => {
  assert.deepEqual(experimentalOptions(rules()), rules());
  assert.equal(experimentalChanged(rules()), false);
  assert.equal(experimentalChanged(rules({ disableLayerCap: true })), true);
  assert.equal(experimentalChanged(rules({ disableHitLimit: true })), true);
  assert.doesNotMatch(experimentalSummary(rules()), /禁用层数上限|禁用单次伤害上限/);
  assert.match(experimentalSummary(rules({ disableLayerCap: true })), /· 禁用层数上限$/);
  assert.match(experimentalSummary(rules({ disableHitLimit: true })), /· 禁用单次伤害上限$/);
  assert.match(experimentalSummary(rules({ disableLayerCap: true, disableHitLimit: true, playerCapacity: 8 })), /禁用层数上限 · 禁用单次伤害上限 · 8 人模式$/);
  assert.deepEqual(experimentalOptions(rules({ disableLayerCap: true, disableHitLimit: true })), rules({ disableLayerCap: true, disableHitLimit: true }));
});

test('both switches show in every room and change only their own key; capacity changes keep them', () => {
  for (const mode of ['coop', 'solo']) for (const source of ['private', 'matchmaking']) {
    const sent = [];
    const modal = settingsRows({ value: rules({ playerCapacity: 8, disableLayerCap: true }), mode, source, editable: true, onChange: (v) => sent.push(v) });
    const inputs = body(modal).filter((n) => n.type === 'input');
    const layer = inputs.find((n) => n.props.id === 'experimental-layer-cap'), hit = inputs.find((n) => n.props.id === 'experimental-hit-limit');
    assert.ok(layer && hit, `${mode} ${source}`);
    assert.equal(layer.props.checked, true); assert.equal(hit.props.checked, false);
    hit.props.onChange({ currentTarget: { checked: true } });
    assert.equal(sent[0].disableHitLimit, true); assert.equal(sent[0].disableLayerCap, true);
  }
  const sent = [];
  const modal = settingsRows({ value: rules({ playerCapacity: 8, disableLayerCap: true }), mode: 'coop', editable: true, onChange: (v) => sent.push(v) });
  body(modal).find((n) => n.type === 'select' && n.props.id === 'experimental-capacity').props.onChange({ currentTarget: { value: '4' } });
  assert.deepEqual(sent, [rules({ disableLayerCap: true })]);
});

test('the enemy multipliers: a list in every room, ×1 absent, the marker and summary name them, other rules stay', () => {
  assert.equal(experimentalChanged(rules({ enemyHpMul: 2 })), true);
  assert.equal(experimentalChanged(rules({ enemyAtkMul: 1.5 })), true);
  assert.equal(experimentalChanged(rules({ enemyHpMul: 1, enemyAtkMul: 1 })), false);
  assert.deepEqual(experimentalOptions(rules({ enemyHpMul: 1 })), rules());
  assert.deepEqual(experimentalOptions(rules({ enemyHpMul: 7 })), rules(), 'not on the list');
  assert.match(experimentalSummary(rules({ enemyHpMul: 2, enemyAtkMul: 1.5 })), /敌人生命 ×2 · 敌人攻击 ×1\.5$/);
  assert.doesNotMatch(experimentalSummary(rules()), /敌人/);
  for (const mode of ['coop', 'solo']) for (const source of ['private', 'matchmaking']) {
    const sent = [];
    const nodes = body(settingsRows({ value: rules({ disableLayerCap: true, enemyAtkMul: 3 }), mode, source, editable: true, onChange: (v) => sent.push(v) }));
    const hp = nodes.find((n) => n.props.id === 'experimental-enemy-hp'), atk = nodes.find((n) => n.props.id === 'experimental-enemy-atk');
    assert.ok(hp && atk, `${mode} ${source}`);
    assert.equal(hp.props.value, 1); assert.equal(atk.props.value, 3);
    assert.deepEqual([].concat(hp.props.children).flat().map((o) => o.props.value), [1, 1.25, 1.5, 2, 2.5, 3, 5]);
    hp.props.onChange({ currentTarget: { value: '2' } });
    assert.deepEqual(sent.at(-1), rules({ disableLayerCap: true, enemyAtkMul: 3, enemyHpMul: 2 }));
    atk.props.onChange({ currentTarget: { value: '1' } });
    assert.deepEqual(sent.at(-1), rules({ disableLayerCap: true }), '×1 is no key');
    hp.props.onChange({ currentTarget: { value: '4' } });
    assert.equal(sent.length, 2, 'not on the list');
  }
  const locked = [];
  const nodes = body(settingsRows({ value: rules(), editable: false, onChange: (v) => locked.push(v) }));
  const hp = nodes.find((n) => n.props.id === 'experimental-enemy-hp');
  assert.equal(hp.props.disabled, true);
  hp.props.onChange({ currentTarget: { value: '2' } });
  assert.deepEqual(locked, []);
});

test('an enemy card outside a battle shows the multiplied HP and ATK; no multiplier, the data\'s', () => {
  assert.equal(enemyPreviewStat(1000, 2), 2000);
  assert.equal(enemyPreviewStat(1000, undefined), 1000);
  assert.equal(enemyPreviewStat(undefined, 2), undefined);
});

test('the bond disc keeps up to four digits, then shortens; the exact count stays in the popup', () => {
  assert.equal(discCount(0), 0); assert.equal(discCount(999), 999); assert.equal(discCount(9999), 9999);
  assert.equal(discCount(10000), '10k'); assert.equal(discCount(123456), '123k'); assert.equal(discCount(999999), '999k');
  assert.equal(discCount(1e6), '1M'); assert.equal(discCount(1234567), '1.2M'); assert.equal(discCount(1e9), '1000M');
  assert.equal(discCount(undefined), undefined);
});

test('live layers pass 999 only in a room that lifted the cap', () => {
  const list = [{ bondId: 'sargonShip', layers: 40 }];
  assert.equal(withLiveLayers(list, { sargonShip: 5000 })[0].layers, 999);
  assert.equal(withLiveLayers(list, { sargonShip: 5000 }, true)[0].layers, 5000);
  assert.equal(withLiveLayers([], { kjeragShip: 2000 }, true)[0].layers, 2000);
});
