// feedback #89: the organisations' emblems among the 名片底图 — every one in the art manifest, a card id room.card can carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAMECARDS, namecardOf, namecardSrc } from '../../public/js/ui/namecards.js';
import { validateC2S } from '../../shared/protocol.js';

const M = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));

test('every card has its picture in the manifest', () => {
  for (const c of NAMECARDS) assert.ok(namecardSrc(c, M), c.id);
  assert.equal(new Set(NAMECARDS.map((c) => c.id)).size, NAMECARDS.length);
});

test('巴别塔 and the other organisations are cards a room.card can carry', () => {
  for (const id of ['camp:babel', 'camp:rhine', 'camp:penguin', 'camp:followers', 'camp:sweep']) {
    assert.equal(namecardOf(id)?.kind, 'camp', id);
    assert.equal(validateC2S({ t: 'room.card', bg: id }), null, id);
  }
});
