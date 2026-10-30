// Card looks (feedback #9 / #24): the seat card's portrait and the 头像 in 精二 / 精一 / a skin of that operator
// (ui/seatArt.js lookUrl / lookOptions), and the room.card message carrying them (ui/playerCard.js cardMessage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookUrl, lookOptions } from '../../public/js/ui/seatArt.js';
import { cardMessage } from '../../public/js/ui/playerCard.js';

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
