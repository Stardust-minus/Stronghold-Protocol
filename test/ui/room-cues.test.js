// Waiting-room sounds (feedback #10 / #14): ui/roomCues.js picks the official cue for a room-state change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomCue, cueGate, seatedHumans } from '../../public/js/ui/roomCues.js';

const seat = (playerId, extra = {}) => ({ playerId, name: playerId, isBot: false, ready: false, connected: true, ...extra });
const room = (seats, extra = {}) => ({ code: 'ABCD', inMatch: false, seats, ...extra });

test('seatedHumans leaves out bots and empty seats', () => {
  assert.deepEqual([...seatedHumans(room([seat('me'), null, seat('b1', { isBot: true }), seat('p2')]))], ['me', 'p2']);
});

test('entering a room, another doctor joining or leaving', () => {
  const r1 = room([seat('me')]);
  assert.equal(roomCue(null, r1, 'me'), 'joinRoom', 'I enter a room');
  assert.equal(roomCue(r1, room([seat('me'), seat('p2')]), 'me'), 'joinRoom', 'a doctor joins');
  assert.equal(roomCue(room([seat('me'), seat('p2')]), r1, 'me'), 'disconnect', 'a doctor leaves');
  assert.equal(roomCue(room([seat('me'), seat('p2')]), room([seat('me'), seat('p3')]), 'me'), 'joinRoom', 'a swap: the join wins');
  assert.equal(roomCue(room([seat('me')], { code: 'OLD1' }), r1, 'me'), 'joinRoom', 'another room');
});

test('no cue for bots, flips, matches, a restored room or a room I only watch', () => {
  const r1 = room([seat('me'), seat('p2')]);
  assert.equal(roomCue(r1, room([seat('me'), seat('p2'), seat('b1', { isBot: true })]), 'me'), null, 'a bot added');
  assert.equal(roomCue(r1, room([seat('me', { ready: true }), seat('p2', { connected: false })]), 'me'), null, 'ready / connected flips');
  assert.equal(roomCue(r1, { ...r1, inMatch: true }, 'me'), null, 'the match starts');
  assert.equal(roomCue({ ...r1, inMatch: true }, room([seat('me')]), 'me'), null, 'back from a match with a seat gone');
  assert.equal(roomCue(null, r1, 'me', { quiet: true }), null, 'the first state after a welcome');
  assert.equal(roomCue(null, room([seat('p2')]), 'me'), null, 'a room I watch');
  assert.equal(roomCue(r1, null, 'me'), null);
});

test('cueGate: one cue of a kind a second', () => {
  const gate = cueGate(1000);
  assert.equal(gate('joinRoom', 0), true);
  assert.equal(gate('joinRoom', 500), false);
  assert.equal(gate('disconnect', 500), true, 'another kind');
  assert.equal(gate('joinRoom', 1000), true);
});

test('main.js plays the cue from onRoomState; the room screen plays the cancel (准备 is audio.js\'s room-wide cue)', () => {
  const main = readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /roomCue\(prevRoom, room, myId, \{ quiet: roomCueQuiet \}\)/);
  assert.match(main, /function onWelcome\(msg\) \{\n  roomCueQuiet = true;/);
  const roomJs = readFileSync(new URL('../../public/js/screens/room.js', import.meta.url), 'utf8');
  // the ready edge sounds once for every member, the sender too (audio.js installAudio, upstream 3868e24d): not here again
  assert.match(roomJs, /if \(!ready\) audio\.sfx\('back'/);
  assert.doesNotMatch(roomJs, /audio\.sfx\(ready \? 'ready'/);
});
