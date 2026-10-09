import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentalOptions, experimentalSummary, ExperimentalOptions } from '../../public/js/ui/experimental.js';
import { allowedBands } from '../../public/js/screens/bandDraft.js';

const walk = node => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
const rules = (capacity, disableDuckLord = false) => ({ revivalEnabled: true, disableSharedPool: false,
  ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...(disableDuckLord ? { disableDuckLord: true } : {}) });
const control = (value, props = {}) => walk(ExperimentalOptions({ open: true, value, editable: true, ...props })).find(n => n.props.id === 'experimental-ducklord');

test('duck-lord checkbox appears only after expanded co-op is enabled and is optional by default', () => {
  assert.equal(control(rules(4)), undefined);
  for (const n of [8, 12, 16, 20]) {
    assert.equal(control(rules(n)).props.checked, false);
    assert.equal(control(rules(n, true)).props.checked, true);
    assert.equal(control(rules(n), { mode: 'solo' }), undefined);
  }
  assert.equal(control(rules(12, true), { source: 'matchmaking', editable: false }).props.disabled, true, 'inherited public rules remain visible');
});

test('only an editable, non-busy host can change the duck-lord rule and other options remain intact', () => {
  const value = rules(12), changes = [];
  control(value, { onChange: x => changes.push(x) }).props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(changes, [rules(12, true)]); assert.deepEqual(value, rules(12));
  for (const props of [{ editable: false }, { busy: true }]) {
    const c = control(value, { ...props, onChange: x => changes.push(x) });
    assert.equal(c.props.disabled, true); c.props.onChange({ currentTarget: { checked: true } });
  }
  assert.equal(changes.length, 1);
});

test('expanded capacity changes retain the duck-lord rule; returning to four clears it', () => {
  const changes = [], value = rules(20, true);
  const v = walk(ExperimentalOptions({ open: true, value, editable: true, onChange: x => changes.push(x) }));
  v.find(n => n.props.id === 'experimental-capacity').props.onChange({ currentTarget: { value: '8' } });
  assert.deepEqual(changes.at(-1), rules(8, true));
  v.find(n => n.props.id === 'experimental-multiplayer').props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(changes.at(-1), rules(4));
  assert.deepEqual(experimentalOptions(rules(4, true)), rules(4));
  assert.ok(experimentalSummary(value).includes('禁用鸭爵策略'));
  assert.ok(!experimentalSummary(rules(12)).includes('禁用鸭爵策略'));
});

test('strategy list removes only Duck Lord when strictly enabled; normal mode ordering stays intact', () => {
  const bands = [{ bandId: 'band_ducklord', sortId: 2, modeTypeList: ['MULTI'] },
    { bandId: 'band_bldsk', sortId: 1, modeTypeList: ['SINGLE', 'MULTI'] },
    { bandId: 'solo', sortId: 0, modeTypeList: ['SINGLE'] }];
  const before = JSON.stringify(bands);
  assert.deepEqual(allowedBands(bands, 'MULTI').map(b => b.bandId), ['band_bldsk', 'band_ducklord']);
  assert.deepEqual(allowedBands(bands, 'MULTI', true).map(b => b.bandId), ['band_bldsk']);
  assert.deepEqual(allowedBands(bands, 'MULTI', 'true').map(b => b.bandId), ['band_bldsk', 'band_ducklord']);
  assert.deepEqual(allowedBands(bands, 'SINGLE').map(b => b.bandId), ['solo', 'band_bldsk']);
  assert.equal(JSON.stringify(bands), before);
});
