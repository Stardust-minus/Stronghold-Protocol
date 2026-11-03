// 联防 red droplets (rel26, the owner's report of 2026-11-02: operators sometimes turn into red droplets that keep
// fighting but open no panel). A 联防 is shown from its opening meta, taken at tick 0 before Battle.start deploys anyone:
// it lists no unit, every UnitInfo comes from the 'spawn' events after it. Anything that re-entered the field later from
// that same meta object lost them all. The relay rooms (expanded, ≥ 8 alive) did exactly that whenever the throttled
// m.public naming the relay round arrived after the runner had shown the field: the new relay key reset the screen and
// the enter effect entered the stored opening meta again. observe.js relayShown keeps the view; screens/game.js also asks
// for a fresh meta (runner reshow / g.watch) whenever it re-enters a battle meta it had entered before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { relayShown, uniteRelayKey, currentRelayField } from '../../public/js/battle/observe.js';

const relay = (round, battleId) => ({ phase: PHASE.UNITE, round: 5, uniteRound: round, uniteRounds: 2,
  fields: [{ fieldId: round === 1 ? 'u' : 'u:2', kind: 'unite', players: ['p1', 'p2'] }], unite: { battleId } });
const shownU = { t: 'm.field', fieldId: 'u', kind: 'unite', local: true, battleId: 'b.5.9.relay1', units: [] };

test('the public relay state after the field was shown: the view is kept (no reset, no re-entry)', () => {
  // the order of arrival around a 联防 opening, at every offset: m.public (relay round 1) before / after the show
  const pub = relay(1, 'b.5.9.relay1');
  assert.ok(uniteRelayKey(pub), 'a relay key appears');
  assert.equal(currentRelayField(pub, shownU), true);
  assert.equal(relayShown(shownU, pub), true, 'already the relay round on screen');
  assert.equal(relayShown(null, pub), false, 'nothing entered yet: the reset is harmless');
  assert.equal(relayShown({ ...shownU, prep: true, fieldId: 'n:p1' }, pub), false, 'a scouted board is never kept');
  assert.equal(relayShown({ ...shownU, battleId: undefined }, pub), true, 'a meta without battle id (a stream) matches by field');
});

test('a real relay change still resets: round 1 on screen, round 2 announced', () => {
  const pub = relay(2, 'b.5.10.relay2');
  assert.equal(relayShown(shownU, pub), false, 'the previous helpers\' field is not this round');
  assert.equal(relayShown({ ...shownU, fieldId: 'u:2', battleId: 'b.5.10.relay2' }, pub), true, 'round 2 already shown');
  assert.equal(relayShown({ ...shownU, fieldId: 'u:2', battleId: 'old' }, pub), false, 'another battle under that id');
  assert.equal(relayShown(shownU, { ...pub, uniteRounds: 1 }), false, 'no relay: no key to guard');
});

test('screens/game.js: the relay reset checks relayShown first; a stale battle meta asks for a fresh one', () => {
  const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  const relayFx = src.slice(src.indexOf('if (enteredRelayRef.current === relayKey) return;'), src.indexOf('}, [relayKey]);'));
  assert.ok(relayFx.indexOf('if (relayShown(enteredFieldRef.current, pub)) return;') > 0
    && relayFx.indexOf('if (relayShown(enteredFieldRef.current, pub)) return;') < relayFx.indexOf('enteredFieldRef.current = null;'));
  assert.match(src, /const staleMeta = !field\.prep && enteredMetasRef\.current\.has\(field\) && !viewChanged;\s*enteredMetasRef\.current\.add\(field\);/);
  assert.match(src, /if \(staleMeta\) \{\s*if \(field\.local\) battleRunner\?\.reshow\(\);\s*else net\.request\('g\.watch', \{ fieldId: field\.fieldId \}\)/);
});
