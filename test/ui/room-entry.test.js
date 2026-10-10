import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERR } from '../../shared/constants.js';
import { joinRoom } from '../../public/js/screens/lobby.js';

const code = 'ABCD';
function rig(reply = ERR.ROOM_STARTED) {
  const sent = [], dialogs = [];
  const state = { me: { playerId: 'observer', token: 'test-session' }, session: { entered: true }, room: null, queue: { state: 'idle' } };
  const connection = { status: 'online', async request(type, fields) {
    sent.push({ type, fields });
    if (type === 'room.join' && reply) throw { code: reply };
  } };
  const confirm = async options => { dialogs.push(options); return true; };
  return { sent, dialogs, state, connection, options: { connection, confirm, getState: () => state } };
}

test('an unstarted room still admits a player without a spectator prompt', async () => {
  const r = rig(null);
  assert.equal(await joinRoom(code, r.options), true);
  assert.deepEqual(r.sent, [{ type: 'room.join', fields: { code } }]);
  assert.deepEqual(r.dialogs, []);
});

test('a started room offers explicit spectatorship using the exact original code', async () => {
  const r = rig();
  assert.equal(await joinRoom(code, r.options), true);
  assert.deepEqual(r.sent, [{ type: 'room.join', fields: { code } }, { type: 'room.spectate', fields: { code } }]);
  assert.equal(r.dialogs.length, 1);
  assert.equal(r.dialogs[0].title, '同盟已开始模拟');
  assert.ok(r.dialogs[0].text.includes(code));
  assert.equal(r.dialogs[0].okText, '观战');
  assert.equal(r.dialogs[0].cancelText, '取消');
});

test('cancelling the prompt never takes a spectator seat', async () => {
  const r = rig();
  r.options.confirm = async () => false;
  assert.equal(await joinRoom(code, r.options), false);
  assert.equal(r.sent.length, 1);
});

test('other join failures do not silently become spectator attempts', async () => {
  for (const error of [ERR.ROOM_NOT_FOUND, ERR.ROOM_FULL, ERR.ALREADY, ERR.BAD_TARGET, 'TIMEOUT', 'OFFLINE']) {
    const r = rig(error);
    await assert.rejects(joinRoom(code, r.options), e => e.code === error);
    assert.equal(r.sent.length, 1);
    assert.equal(r.dialogs.length, 0);
  }
});

test('late spectator admission failures are reported rather than claiming a successful join', async () => {
  const r = rig();
  const original = r.connection.request;
  r.connection.request = async (type, fields) => {
    await original(type, fields);
    throw { code: ERR.ROOM_NOT_FOUND };
  };
  await assert.rejects(joinRoom(code, r.options), e => e.code === ERR.ROOM_NOT_FOUND);
  assert.equal(r.sent.at(-1).type, 'room.spectate');
});

for (const [name, change] of [
  ['a different player', r => { r.state.me = { ...r.state.me, playerId: 'new-player' }; }],
  ['a different session token', r => { r.state.me = { ...r.state.me, token: 'another-test-session' }; }],
  ['another room', r => { r.state.room = { code: 'OTHER1' }; }],
  ['queued matchmaking', r => { r.state.queue = { state: 'queued' }; }],
  ['an offered match', r => { r.state.queue = { state: 'offered' }; }],
  ['a closed connection', r => { r.connection.status = 'offline'; }],
  ['the title screen', r => { r.state.session.entered = false; }],
]) {
  test(`confirmation becomes stale after ${name}: no spectator request`, async () => {
    const r = rig();
    r.options.confirm = async () => { change(r); return true; };
    assert.equal(await joinRoom(code, r.options), false);
    assert.equal(r.sent.length, 1);
  });
}

test('an already stale entry does not send either intent or show a prompt', async () => {
  for (const change of [r => { r.state.room = { code }; }, r => { r.state.me.playerId = null; }, r => { r.state.queue.state = 'queued'; }]) {
    const r = rig(); change(r);
    assert.equal(await joinRoom(code, r.options), false);
    assert.deepEqual(r.sent, []); assert.deepEqual(r.dialogs, []);
  }
});

test('manual joining and invitation auto-join use the same explicit started-room flow', () => {
  const lobby = readFileSync(new URL('../../public/js/screens/lobby.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../public/js/main.js', import.meta.url), 'utf8');
  assert.match(lobby, /run\('join', \(\) => joinRoom\(k\)\)/);
  assert.match(main, /await joinRoom\(code\)/);
  assert.match(lobby, /!busy && !pendingJoin && overlay == null/, 'an invitation confirmation is not covered by an automatic announcement');
  assert.match(lobby, /net\.request\('room\.spectate', \{ code: k \}\)/, 'the dedicated spectator action stays direct');
});
