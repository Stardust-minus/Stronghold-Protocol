// Card looks (feedback #9 / #24): the seat card's portrait and the 头像 in 精二 / 精一 / a skin of that operator
// (ui/seatArt.js lookUrl / lookOptions), and the room.card message carrying them (ui/playerCard.js cardMessage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookUrl, lookOptions, cardAvatarUrl, officialAvatars } from '../../public/js/ui/seatArt.js';
import { cardMessage } from '../../public/js/ui/playerCard.js';
import { validateC2S } from '../../shared/protocol.js';

const M = {
  chars: {
    char_a: { avatar: '/a1.png', avatarE2: '/a2.png', portrait: '/p1.png', portraitE2: '/p2.png' },
    char_b: { avatar: '/b1.png', portrait: '/q1.png' },
  },
  skins: {
    char_a_x_1: { charId: 'char_a', name: 'X', avatar: '/sa.png', portrait: '/sp.png', illustration: '/si.png' },
    char_b_y_1: { charId: 'char_b', name: 'Y', avatar: '/sb.png', portrait: '/sq.png' },
  },
};

test('lookUrl: 精二 by default, 精一 with e1, a skin only for its own operator', () => {
  assert.equal(lookUrl(M, 'char_a', '', 'avatar'), '/a2.png');
  assert.equal(lookUrl(M, 'char_a', 'e1', 'avatar'), '/a1.png');
  assert.equal(lookUrl(M, 'char_a', 'char_a_x_1', 'portrait'), '/sp.png');
  assert.equal(lookUrl(M, 'char_a', 'char_b_y_1', 'portrait'), '/p2.png', "another operator's skin falls back");
  assert.equal(lookUrl(M, 'char_b', '', 'portrait'), '/q1.png', 'no E2 art: 精一');
  assert.equal(lookUrl(M, 'char_zz', '', 'avatar'), null);
});

test('lookOptions: 精二 + 精一 + skins; an operator without E2 art offers 精一 as its default', () => {
  assert.deepEqual(lookOptions(M, 'char_a', 'portrait').map((o) => [o.id, o.src]), [['', '/p2.png'], ['e1', '/p1.png'], ['char_a_x_1', '/sp.png']]);
  assert.deepEqual(lookOptions(M, 'char_b', 'avatar').map((o) => [o.id, o.src]), [['', '/b1.png'], ['char_b_y_1', '/sb.png']]);
  assert.deepEqual(lookOptions(M, 'char_zz', 'avatar'), []);
});

test('cardMessage sends a look only with its operator', () => {
  const msg = cardMessage({ charId: 'char_a', look: 'e1', avatar: '', avatarLook: 'e1', bg: 'skin:char_a_x_1', trophies: 3 });
  assert.equal(msg.look, 'e1');
  assert.equal(msg.avatarLook, '', 'no avatar operator: no avatar look');
  assert.equal(msg.bg, '', 'an unknown skin card is not sent');
});

test('feedback #100: an official avatar is its manifest picture, and the picker groups the manifest\'s', () => {
  const m = { ui: { 'playerAvatar/avatar_activity_OF': '/of.png', 'playerAvatar/avatar_def_02': '/d2.png', 'playerAvatar/avatar_def_10': '/d10.png', 'other/x': '/x.png' } };
  assert.equal(cardAvatarUrl('avatar_activity_OF', m), '/of.png');
  assert.equal(cardAvatarUrl('avatar_activity_NO', m), null, 'only what the manifest has');
  assert.deepEqual(officialAvatars(m).map((g) => [g.key, g.items.map((a) => a.id)]),
    [['activity', ['avatar_activity_OF']], ['def', ['avatar_def_02', 'avatar_def_10']]]);
  assert.deepEqual(officialAvatars(null), []);
});

test('feedback #100: room.card takes an official avatar id by format, an operator id as before', () => {
  assert.equal(validateC2S({ t: 'room.card', avatar: 'avatar_activity_EP10_2' }), null);
  assert.equal(validateC2S({ t: 'room.card', avatar: 'char_002_amiya' }), null);
  for (const bad of ['avatar_', 'avatar_a b', 'avatar_x/y', `avatar_${'x'.repeat(48)}`]) assert.notEqual(validateC2S({ t: 'room.card', avatar: bad }), null, bad);
});
