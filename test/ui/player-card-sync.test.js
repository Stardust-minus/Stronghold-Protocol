// test/ui/player-card-sync.test.js — feedback #78: the whole display card (ui/playerCard.js) goes out through the sync engine
// (ui/loadoutSync.js installPlayerCardSync) after every welcome and change, in or out of a room, so a doctor who goes
// through matchmaking shows the same card; RATE / TIMEOUT / OFFLINE are retried, BAD_MSG stops only that card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { installPlayerCardSync, SYNC_DEBOUNCE_MS, RETRY_MS } from '../../public/js/ui/loadoutSync.js';

const ticks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const WISADEL = 'char_1035_wisdel', HEIDI = 'char_4045_heidi';
const EMPTY = { charId: '', avatar: '', bg: '', trophies: 0, look: '', avatarLook: '' };

function harness({ card = {}, chess = [] } = {}) {
  const listeners = new Map(), pending = new Map();
  let time = 0, timerId = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++timerId; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    async advance(ms) {
      time += ms;
      for (const [id, task] of [...pending]) if (task.at <= time) { pending.delete(id); task.fn(); await ticks(); }
      await ticks();
    },
  };
  const net = {
    status: 'online', sent: [], failures: [],
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    emit(name, msg = {}) { listeners.get(name)?.(msg); },
    async request(t, fields) {
      net.sent.push({ t, ...fields });
      const code = net.failures.shift();
      if (code) throw Object.assign(new Error(code), { code });
      return { t: 'ok' };
    },
  };
  const target = createStore({ ...EMPTY, sync: 'idle', ...card });
  const content = createStore({ cs: null, status: 'idle' });
  const app = createStore({ room: null });
  const sync = installPlayerCardSync({ net, timers, target, content, app, listChess: () => chess });
  return { net, timers, target, ...sync };
}

test('after a welcome with no room at all: the card goes out, and again after the next welcome', async (t) => {
  const h = harness({ card: { charId: WISADEL, look: 'char_1035_wisdel_game_9' } });
  t.after(h.dispose);
  h.net.emit('welcome');
  await h.timers.advance(50);
  assert.deepEqual(h.net.sent, [{ t: 'room.card', ...EMPTY, charId: WISADEL, look: 'char_1035_wisdel_game_9' }]);
  h.net.emit('welcome');
  await h.timers.advance(50);
  assert.equal(h.net.sent.length, 2);
});

test('every part of the card is an edit: look, avatar, avatar look, background', async (t) => {
  const h = harness();
  t.after(h.dispose);
  for (const patch of [{ charId: HEIDI }, { look: 'e1' }, { avatar: WISADEL }, { avatarLook: 'e1' }]) {
    h.target.set(patch);
    await h.timers.advance(SYNC_DEBOUNCE_MS);
  }
  assert.deepEqual(h.net.sent.at(-1), { t: 'room.card', ...EMPTY, charId: HEIDI, look: 'e1', avatar: WISADEL, avatarLook: 'e1' });
  assert.equal(h.net.sent.length, 4);
  assert.equal(h.target.get().sync, 'synced');
});

test('RATE, TIMEOUT and OFFLINE do not end the sync (the room screen\'s effect gave up for good after the first)', async (t) => {
  const h = harness();
  t.after(h.dispose);
  h.net.failures.push('RATE', 'TIMEOUT', 'OFFLINE');
  h.target.set({ charId: HEIDI });
  await h.timers.advance(SYNC_DEBOUNCE_MS);
  for (let i = 0; i < 3; i++) await h.timers.advance(RETRY_MS);
  assert.equal(h.net.sent.length, 4);
  assert.equal(h.target.get().sync, 'synced');
  h.target.set({ look: 'e1' });
  await h.timers.advance(SYNC_DEBOUNCE_MS);
  assert.equal(h.net.sent.at(-1).look, 'e1', 'and the next edit still goes out');
});

test('BAD_MSG stops that card, not the sync; a pick the page does not list goes out as \'\' and the pref keeps it', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const h = harness({ card: { charId: 'char_x_plugin' } });
  t.after(h.dispose);
  h.net.emit('welcome');
  await h.timers.advance(50);
  assert.equal(h.net.sent.at(-1).charId, '');
  assert.equal(h.target.get().charId, 'char_x_plugin');
  h.net.failures.push('BAD_MSG');
  h.target.set({ charId: HEIDI });
  await h.timers.advance(SYNC_DEBOUNCE_MS);
  await h.timers.advance(RETRY_MS * 3);
  assert.equal(h.net.sent.length, 2, 'no retry loop');
  assert.equal(h.target.get().sync, 'error');
  h.target.set({ charId: WISADEL });
  await h.timers.advance(SYNC_DEBOUNCE_MS);
  assert.equal(h.net.sent.at(-1).charId, WISADEL);
  assert.equal(h.target.get().sync, 'synced');
});

test('the operators of the chess on screen count too (a plugin room\'s)', async (t) => {
  const h = harness({ card: { charId: 'char_x_plugin' }, chess: [{ charId: 'char_x_plugin', name: 'X', rarity: 6 }] });
  t.after(h.dispose);
  h.net.emit('welcome');
  await h.timers.advance(50);
  assert.equal(h.net.sent.at(-1).charId, 'char_x_plugin');
});
