// test/ui/entry-film.test.js — the entry film (ui/entryFilm.js) plays by itself (this fork, 2026-11-16: no 点击进入 card),
// never sits over a room or a match, and leaves the player's own lobby music alone. playEntryFilm runs for real on a
// small stand-in DOM (the overlay is a <dialog>, the page's loading screen and the labels plain elements; the scene
// itself is a stand-in, its pictures are ui/allianceScene.js's own, unit-tested in test/ui/alliance-scene.test.js).
// The overlay is up at once and clear over the loading screen (index.html #boot), which it keeps as the cover while
// the art loads: 加载中 comes under it after a while, the film starts by itself once the art is in and the cover goes
// under it; art that fails or never comes in takes the cover down (the title), and a tap meanwhile skips to the title.
// A session restored into a room while the cover is up takes the overlay and the cover down and a later tap plays
// nothing; one restored into a match while the film runs takes it down at once, stops the entry cue and hands the music
// back to the screen. Sound: with a running context the cue plays in time; without one the sound is tried first
// (audio.js autoStart) — the picture plays without sound when it does not start, the screen's music then waits for the
// first gesture; nothing is tried while muted. A page in a background tab keeps the cover until it is shown. holdBgm:
// with audio.lobbyTrack set nothing fades and playBgm is left alone; without it the screen's music is held and released
// from its top (with or without a context); a lobbyTrack that arrives during the hold is passed to the real playBgm at
// once. Without an art pack no film plays and the cover goes at once. A phone in portrait when the title is entered does
// not start the film after it rotates to landscape. A 规程 start plays 规程's opening (ui/regulationFilm.js) through the
// same overlay and cue, and 盟约's film without its extracted group or when its pictures do not come in (盟约's load
// from the cover on).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in browser -------------------------------------------------------------------------------------------
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.style = {}; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.id = ''; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === document.body || n === document.head; }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      add: (c) => { if (!names().includes(c)) this.className = [...names(), c].join(' '); },
      remove: (c) => { this.className = names().filter((x) => x !== c).join(' '); },
    };
  }
  append(...cs) { for (const c of cs) { c.remove(); c.parent = this; this.children.push(c); } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  set innerHTML(h) {
    this.children = [];
    for (const m of h.matchAll(/<(\w+)(?:\s+class="([^"]*)")?>([^<]*)<\/\1>/g)) { const c = new El(m[1]); c.className = m[2] || ''; c.textContent = m[3]; this.append(c); }
  }
  querySelector(sel) {
    const cls = sel.slice(1);
    const walk = (n) => { for (const c of n.children) { if (c.className.split(/\s+/).includes(cls)) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push({ fn, once: !!opts?.once }); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn); }
  dispatch(type) {
    for (const l of [...(this.listeners[type] || [])]) { if (l.once) this.removeEventListener(type, l.fn); l.fn({ type, preventDefault() {} }); }
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const winListeners = new Map(); // type → Set of handlers (the page's capture listeners)
globalThis.addEventListener = (type, fn) => { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type).add(fn); };
globalThis.removeEventListener = (type, fn) => { winListeners.get(type)?.delete(fn); };
const keyListeners = () => winListeners.get('keydown')?.size || 0;
const pressKey = () => { for (const fn of [...(winListeners.get('keydown') || [])]) fn({ type: 'keydown' }); };
const docListeners = new Map();
globalThis.document = {
  head: new El('head'), body: new El('body'), hidden: false,
  createElement: (tag) => new El(tag),
  getElementById: (id) => document.head.children.find((c) => c.id === id) || null,
  addEventListener: (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, new Set()); docListeners.get(type).add(fn); },
  removeEventListener: (type, fn) => { docListeners.get(type)?.delete(fn); },
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.innerWidth = 1600; globalThis.innerHeight = 900;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.Image = class { set src(u) { this._src = u; setTimeout(() => this.onload?.(), 0); } get src() { return this._src; } };
globalThis.fetch = async (url) => {
  const name = String(url).split('?')[0].split('/').pop();
  try { const body = readFileSync(path.join(ROOT, 'data', name), 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(body) }; } catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { playEntryFilm, holdBgm } = await import('../../public/js/ui/entryFilm.js');
const { clearSpriteLoads } = await import('../../public/js/ui/allianceScene.js');
const { store, selectRoute } = await import('../../public/js/store.js');
const { audio } = await import('../../public/js/audio.js');
const { data } = await import('../../public/js/data.js');

const overlay = () => document.body.children.find((c) => c.className.split(/\s+/).includes('spa-entry')) || null;
const isCover = (el) => el.className.split(/\s+/).includes('spa-entry--cover');
/** The page's loading screen (index.html #boot), as main.js passes it. */
function bootSplash() {
  const s = new El('div');
  s.id = 'boot';
  s.className = 'boot';
  document.body.append(s);
  return s;
}
/**
 * Image stand-ins whose loads a test settles: a URL `hold(url)` names stays pending until release(); every other one
 * loads on the next task. `asked`: every URL set, in order.
 * @param {(url: string) => boolean} hold
 */
function heldImages(hold) {
  const Real = globalThis.Image;
  const pending = [];
  const asked = [];
  globalThis.Image = class {
    set src(u) { this._src = u; asked.push(u); if (hold(u)) pending.push(this); else setTimeout(() => this.onload?.(), 0); }
    get src() { return this._src; }
  };
  return { asked, release: () => { for (const im of pending.splice(0)) im.onload?.(); }, restore: () => { globalThis.Image = Real; } };
}
/** A stand-in scene: counts its frames, knows whether it was taken down. */
function sceneSpy() {
  const spy = { mounted: 0, frames: 0, destroyed: 0 };
  spy.mount = () => { spy.mounted++; return { render: () => { spy.frames++; }, grain() {}, destroy: () => { spy.destroyed++; } }; };
  return spy;
}
/** A running Web Audio stand-in: every buffer source it makes, and what became of it. */
function runningContext() {
  const sources = [];
  const ctx = {
    state: 'running', currentTime: 0,
    createBufferSource: () => {
      const s = {
        started: null, stopped: null, starts: 0, out: null,
        connect(node) { s.out = node; },
        start(t) { s.starts += 1; s.started = t; },
        // Web Audio throws when stop is asked for a time before the scheduled start
        stop(t) {
          if (s.started != null && t < s.started) {
            const err = new Error('InvalidStateError');
            err.name = 'InvalidStateError';
            throw err;
          }
          s.stopped = t;
        },
        playsAt(t) {
          if (s.started == null || t < s.started) return false;
          if (s.stopped != null && s.stopped <= t) return false;
          if (s.out && s.out.connected === false) return false;
          return true;
        },
      };
      sources.push(s);
      return s;
    },
    createGain: () => { const g = { gain: { value: 1, setTargetAtTime() {} }, connected: true, connect() {}, disconnect() { g.connected = false; } }; return g; },
  };
  return { ctx, sources };
}
const enterRoom = () => store.set((s) => ({ session: { ...s.session, entered: true }, room: { id: 'r1', players: [] } }));
const enterMatch = () => store.set((s) => ({ session: { ...s.session, entered: true }, room: { id: 'r1', inMatch: true, players: [] } }));
const PROTO = Object.getPrototypeOf(audio);
const realPlayBgm = PROTO.playBgm;
const until = async (fn, ms = 2000) => { for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20); };

beforeEach(() => {
  clearSpriteLoads();
  store.reset();
  document.body.children = [];
  document.hidden = false;
  docListeners.clear();
  delete audio.playBgm;
  delete audio.autoStart;
  PROTO.playBgm = realPlayBgm;
  Object.assign(audio, { ctx: null, lobbyTrack: null, lastBgmKey: 'lobby', wantBgm: null, volumes: { ...(audio.volumes || {}), muted: false } });
});

test('the overlay is up at once, clear over the loading screen; a session restored into a room takes both down, a later tap plays nothing', async () => {
  const keysBefore = keyListeners();
  const spy = sceneSpy();
  const splash = bootSplash();
  await playEntryFilm({ mount: spy.mount, splash });
  const el = overlay();
  assert.ok(el && el.open, 'the overlay is up before the art is in');
  assert.ok(isCover(el), 'clear: the loading screen under it is the cover');
  assert.equal(el.querySelector('.spa-entry__gate'), null, 'no 点击进入 card');
  assert.equal(splash.attrs['data-entry-film'], 'cover', 'the loading screen is the film\'s now (main.js leaves it up)');
  assert.equal(keyListeners(), keysBefore + 1, 'a key skips from the cover on');

  enterRoom();
  assert.equal(selectRoute(store.get()), 'room');
  assert.equal(overlay(), null, 'the overlay is gone at once');
  assert.equal(el.open, false);
  assert.equal(splash.isConnected, false, 'and the loading screen with it (nothing over the room)');
  assert.equal(keyListeners(), keysBefore, 'and nothing listens for keys any more');

  el.dispatch('pointerdown');
  pressKey();
  await sleep(800);
  assert.equal(spy.mounted, 0, 'the film never starts');
  assert.equal(overlay(), null);
});

test('the film starts by itself once its art is in; a session restored into a match takes it down at once, stops the cue, hands the music back', async () => {
  const { ctx, sources } = runningContext();
  Object.assign(audio, { ctx, sfxGain: {}, _buffer: async () => ({ duration: 1 }), _fadeOutBgm() {} });
  const played = [];
  PROTO.playBgm = function (key) { played.push(key); };
  const spy = sceneSpy();
  const splash = bootSplash();
  const keysBefore = keyListeners();
  await playEntryFilm({ mount: spy.mount, splash });
  const el = overlay();
  assert.ok(el, 'the overlay is up');
  await until(() => spy.frames > 0);
  assert.equal(spy.mounted, 1, 'the film runs without a tap');
  assert.ok(spy.frames > 0);
  assert.equal(isCover(el), false, 'black under the film');
  await until(() => !splash.isConnected, 1000);
  assert.equal(splash.isConnected, false, 'the cover goes under the film\'s first frames');
  const cue = sources[0];
  assert.ok(cue && cue.started != null, 'the entry cue is scheduled');
  assert.ok(Object.prototype.hasOwnProperty.call(audio, 'playBgm'), 'the screen\'s music is held');
  audio.playBgm('battle'); // the match screen asks for its music (audio.js follows the route)
  assert.deepEqual(played, [], 'held while the film runs');

  enterMatch();
  assert.equal(selectRoute(store.get()), 'game');
  assert.equal(overlay(), null, 'the overlay is gone at once (no fade over the match)');
  assert.equal(spy.destroyed, 1, 'the scene is taken down');
  assert.equal(cue.out.connected, false, 'the cue gain is disconnected');
  assert.ok(cue.stopped != null && cue.stopped >= cue.started, 'stop is not before the scheduled start');
  ctx.currentTime = cue.started + 1;
  assert.equal(cue.playsAt(ctx.currentTime), false, 'the cue is not heard after leaving');
  assert.equal(cue.starts, 1, 'nothing starts afterwards');
  assert.equal(keyListeners(), keysBefore, 'no key skips anything any more');
  assert.equal(Object.prototype.hasOwnProperty.call(audio, 'playBgm'), false, 'playBgm is audio.js\'s own again');
  assert.deepEqual(played, ['battle'], 'the match\'s music plays');
  const frames = spy.frames;
  await sleep(2600); // past the film's lobby-music moment and its end
  assert.equal(spy.frames, frames, 'no frame after the leave');
  assert.deepEqual(played, ['battle'], 'and no lobby music restarted by the film');
});

test('a skip before the entry cue starts cuts it off: no stop before its start time, nothing heard', async () => {
  const { ctx, sources } = runningContext();
  Object.assign(audio, { ctx, sfxGain: {}, _buffer: async () => ({ duration: 1 }), _fadeOutBgm() {} });
  PROTO.playBgm = function () {};
  const spy = sceneSpy();
  await playEntryFilm({ mount: spy.mount });
  await until(() => spy.frames > 0);
  const cue = sources[0];
  assert.ok(cue && cue.started > ctx.currentTime, 'the cue is scheduled ahead');
  pressKey(); // the skip, before the cue's start time
  assert.equal(cue.out.connected, false, 'the cue gain is disconnected');
  assert.ok(cue.stopped != null && cue.stopped >= cue.started, 'stop is not before the scheduled start (no throw)');
  ctx.currentTime = cue.started + 0.2;
  assert.equal(cue.playsAt(ctx.currentTime), false, 'the cue is never heard');
  await sleep(400);
  assert.equal(overlay(), null, 'the film is gone after its fade');
});

test('the entry cue is the manifest\'s URL, content hash included: the worker answers it from a finished download (GitHub #725)', async () => {
  const { ctx } = runningContext();
  const asked = [];
  Object.assign(audio, { ctx, sfxGain: {}, _buffer: async (u) => { asked.push(u); return { duration: 1 }; }, _fadeOutBgm() {} });
  PROTO.playBgm = function () {};
  const hashed = '/assets/~0123456789abcdef/audio/sfx/customse/act1autochess/act1autochess_g_ui_load.mp3';
  await data.load('assets');
  data.setView('assets', (m) => ({ ...m, audio: { ...m.audio, sfx: { ...m.audio.sfx, ui: { ...m.audio.sfx.ui, load: hashed } } } }));
  try {
    const spy = sceneSpy();
    await playEntryFilm({ mount: spy.mount });
    await until(() => spy.frames > 0);
    assert.deepEqual(asked.filter((u) => u.includes('g_ui_load')), [hashed]);
    pressKey();
    await sleep(400);
    assert.equal(overlay(), null);
  } finally { data.setView('assets', null); }
});

test('no context yet: the sound is tried before the film (audio.js autoStart); where it starts, the cue plays in time', async () => {
  const { ctx, sources } = runningContext();
  const calls = [];
  const spy = sceneSpy();
  PROTO.playBgm = function () {};
  audio.autoStart = async () => { calls.push({ overlay: !!overlay(), mounted: spy.mounted }); Object.assign(audio, { ctx, sfxGain: {}, _buffer: async () => ({ duration: 1 }), _fadeOutBgm() {} }); return true; };
  await playEntryFilm({ mount: spy.mount });
  await until(() => spy.frames > 0);
  assert.deepEqual(calls, [{ overlay: true, mounted: 0 }], 'tried once, with the cover up and before the film');
  assert.ok(sources[0] && sources[0].started != null, 'the cue is scheduled with the picture');
  pressKey();
  await sleep(400);
  assert.equal(overlay(), null);
});

test('where the sound does not start, the picture plays without it: no cue, and the screen\'s music waits for the first gesture', async () => {
  const played = [];
  PROTO.playBgm = function (key) { played.push(key); };
  let tried = 0;
  audio.autoStart = async () => { tried++; return false; }; // Firefox / Safari, or a gate that let the player in by itself
  const spy = sceneSpy();
  await playEntryFilm({ mount: spy.mount });
  await until(() => spy.frames > 0);
  assert.equal(tried, 1);
  assert.equal(spy.mounted, 1, 'the film plays anyway');
  assert.equal(audio.ctx, null, 'no context: nothing was scheduled');
  audio.playBgm('lobby'); // the title screen asks for its music meanwhile
  assert.deepEqual(played, [], 'held while the picture runs');
  pressKey(); // the first gesture: a skip (audio.js starts its context on the same gesture)
  assert.deepEqual(played, ['lobby'], 'the screen\'s music is handed to audio.js (it plays it from its top once it can)');
  await sleep(400);
  assert.equal(overlay(), null);
});

test('muted: no sound is tried before a gesture', async () => {
  let tried = 0;
  audio.autoStart = async () => { tried++; return false; };
  audio.volumes = { ...audio.volumes, muted: true };
  PROTO.playBgm = function () {};
  const spy = sceneSpy();
  await playEntryFilm({ mount: spy.mount });
  await until(() => spy.frames > 0);
  assert.equal(spy.mounted, 1);
  assert.equal(tried, 0);
  pressKey();
  await sleep(400);
});

test('a page opened in a background tab keeps the cover until it is shown, then plays', async () => {
  document.hidden = true;
  let tried = 0;
  audio.autoStart = async () => { tried++; return false; };
  PROTO.playBgm = function () {};
  const spy = sceneSpy();
  const splash = bootSplash();
  await playEntryFilm({ mount: spy.mount, splash });
  await sleep(300);
  assert.equal(spy.mounted, 0, 'nothing plays unseen');
  assert.equal(tried, 0, 'and no sound is tried behind another tab');
  assert.ok(overlay() && splash.isConnected, 'the cover waits');
  document.hidden = false;
  for (const fn of [...(docListeners.get('visibilitychange') || [])]) fn();
  await until(() => spy.frames > 0);
  assert.equal(spy.mounted, 1, 'shown: the film plays');
  assert.equal(tried, 1);
  pressKey();
  await sleep(400);
  assert.equal(overlay(), null);
});

test('holdBgm leaves the player\'s own lobby music alone: no fade, playBgm untouched', () => {
  let fades = 0;
  const a = { ctx: {}, bgmSilent: false, bgmToken: 0, lastBgmKey: 'lobby', lobbyTrack: { id: 'mine', read: async () => new ArrayBuffer(0) }, _fadeOutBgm() { fades++; }, playBgm() {} };
  const own = a.playBgm;
  assert.equal(holdBgm(a), null);
  assert.equal(fades, 0, 'nothing fades');
  assert.equal(a.bgmToken, 0, 'no start is cancelled');
  assert.equal(a.playBgm, own, 'playBgm is not replaced');
});

test('holdBgm without the player\'s own music holds the screen\'s and releases it from its top', () => {
  let fades = 0;
  const played = [];
  const proto = { playBgm(key) { played.push(key); } };
  const a = Object.assign(Object.create(proto), { ctx: {}, bgmSilent: false, bgmToken: 0, lastBgmKey: 'lobby', lobbyTrack: null, _fadeOutBgm() { fades++; } });
  const release = holdBgm(a);
  assert.equal(typeof release, 'function');
  assert.equal(fades, 1, 'the playing track fades out');
  a.playBgm('lobby');
  assert.deepEqual(played, [], 'a request meanwhile is only remembered');
  release();
  assert.deepEqual(played, ['lobby'], 'the release starts it');
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'playBgm'), false);
  release();
  assert.deepEqual(played, ['lobby'], 'once');
  // silent music: nothing to hold
  assert.equal(holdBgm(Object.assign(Object.create(proto), { ctx: {}, bgmSilent: true, lobbyTrack: null })), null);
  // before there is a context (the sound is still being tried): held the same way, the release hands the key over
  const b = Object.assign(Object.create(proto), { ctx: null, bgmSilent: false, bgmToken: 0, lastBgmKey: 'lobby', lobbyTrack: null, _fadeOutBgm() {} });
  const releaseB = holdBgm(b);
  assert.equal(typeof releaseB, 'function', 'held without a context too');
  b.playBgm('prep');
  releaseB();
  assert.deepEqual(played, ['lobby', 'prep']);
});

test('holdBgm hands a lobby track that arrives late to the real playBgm at once, without another fade', () => {
  let fades = 0;
  const played = [];
  const proto = { playBgm(key) { played.push(key); } };
  const a = Object.assign(Object.create(proto), { ctx: {}, bgmSilent: false, bgmToken: 0, lastBgmKey: 'lobby', lobbyTrack: null, _fadeOutBgm() { fades++; } });
  const release = holdBgm(a);
  assert.equal(fades, 1, 'the official track fades when the hold starts');
  a.playBgm('lobby');
  assert.deepEqual(played, [], 'still held before the player\'s file is in');
  a.lobbyTrack = { id: 'mine', read: async () => new ArrayBuffer(0) };
  a.playBgm('lobby'); // setLobbyTrack → refreshBgm, after installLobbyMedia resolves
  assert.deepEqual(played, ['lobby'], 'the real playBgm runs at once');
  assert.equal(fades, 1, 'no second fade');
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'playBgm'), false, 'the placeholder is gone');
  release();
  assert.deepEqual(played, ['lobby'], 'the release does not start the track again');
});

test('a sprite that fails to load plays no film: the cover goes, the title stays', async () => {
  const Real = globalThis.Image;
  globalThis.Image = class {
    set src(u) { this._src = u; setTimeout(() => this.onerror?.(), 30); }
    get src() { return this._src; }
  };
  const keysBefore = keyListeners();
  try {
    const spy = sceneSpy();
    const splash = bootSplash();
    await playEntryFilm({ mount: spy.mount, splash });
    assert.ok(overlay(), 'the overlay is up while the art loads');
    await until(() => !overlay(), 1500);
    assert.equal(overlay(), null, 'it goes once a sprite fails, without a tap');
    assert.ok(splash.classList.contains('is-done'), 'the cover fades: the title screen');
    assert.equal(splash.hasAttribute('data-entry-film'), false);
    assert.equal(keyListeners(), keysBefore, 'nothing listens for keys any more');
    assert.equal(spy.mounted, 0);
  } finally {
    globalThis.Image = Real;
  }
});

test('without the art pack (no sprite URL) no film plays: the cover goes at once', async () => {
  await data.load('assets');
  data.setView('assets', (m) => ({ ...m, ui: {} }));
  try {
    const spy = sceneSpy();
    const splash = bootSplash();
    await playEntryFilm({ mount: spy.mount, splash });
    await until(() => !overlay(), 1000);
    assert.equal(overlay(), null, 'the title stays uncovered');
    assert.ok(splash.classList.contains('is-done'), 'the loading screen fades as without a film');
    assert.equal(spy.mounted, 0);
  } finally { data.setView('assets', null); }
});

test('the art takes a while: 加载中 under the cover, then the film by itself once the art is in', async () => {
  const imgs = heldImages(() => true);
  try {
    const spy = sceneSpy();
    const splash = bootSplash();
    await playEntryFilm({ mount: spy.mount, splash, budget: { load: 5000, cap: 8000 } });
    const el = overlay();
    assert.ok(el && isCover(el), 'the cover is up before the art is in');
    assert.equal(el.querySelector('.spa-entry__wait').textContent, '加载中');
    assert.equal(el.querySelector('.spa-entry__skip').textContent, '点击跳过', 'a tap skips the wait');
    await until(() => imgs.asked.length >= 8, 500);
    assert.ok(imgs.asked.length >= 8, '盟约\'s pictures are loading behind it');
    assert.equal(el.className.includes('spa-entry--say'), false, 'no 加载中 at first (a warm cache: no flash)');
    await sleep(1300);
    assert.ok(el.className.includes('spa-entry--say'), '加载中 once the art takes a moment');
    assert.equal(spy.mounted, 0, 'no film before its art');
    assert.ok(splash.isConnected, 'the cover is still up');
    imgs.release();
    await until(() => spy.frames > 0);
    assert.equal(spy.mounted, 1, 'the film runs once the art is in, without a tap');
    assert.equal(el.querySelector('.spa-entry__wait'), null, 'no 加载中 over the film');
    await until(() => !splash.isConnected, 1000);
    assert.equal(splash.isConnected, false, 'the cover went under the film');
    pressKey();
    await sleep(400);
    assert.equal(overlay(), null, 'skipped');
  } finally { imgs.restore(); }
});

test('art that never comes in: the cover waits its time, then goes; nothing plays later', async () => {
  const imgs = heldImages(() => true);
  const keysBefore = keyListeners();
  try {
    const spy = sceneSpy();
    const splash = bootSplash();
    await playEntryFilm({ mount: spy.mount, splash, budget: { load: 400, cap: 3000 } });
    await sleep(200);
    assert.ok(overlay(), 'still waiting');
    await until(() => !overlay(), 1500);
    assert.equal(overlay(), null, 'the cover goes: the title screen');
    assert.ok(splash.classList.contains('is-done'));
    assert.equal(keyListeners(), keysBefore, 'nothing listens for keys any more');
    imgs.release();
    await sleep(100);
    assert.equal(spy.mounted, 0, 'art that comes in afterwards plays nothing');
  } finally { imgs.restore(); }
});

test('a tap while the art loads goes to the title', async () => {
  const imgs = heldImages(() => true);
  try {
    const spy = sceneSpy();
    const splash = bootSplash();
    await playEntryFilm({ mount: spy.mount, splash, budget: { load: 5000, cap: 8000 } });
    const el = overlay();
    await sleep(100);
    el.dispatch('pointerdown');
    assert.ok(splash.classList.contains('is-done'), 'the cover fades with the overlay');
    await sleep(400);
    assert.equal(overlay(), null, 'gone after its fade');
    imgs.release();
    await sleep(100);
    assert.equal(spy.mounted, 0, 'no film after the skip');
  } finally { imgs.restore(); }
});

test('globalThis.__SP_ENTRY_FILM__ = \'off\' (the browser suites that are not about the film) plays nothing', async () => {
  globalThis.__SP_ENTRY_FILM__ = 'off';
  try {
    const spy = sceneSpy();
    await playEntryFilm({ mount: spy.mount });
    assert.equal(overlay(), null, 'the title stays uncovered');
    assert.equal(spy.mounted, 0);
  } finally {
    delete globalThis.__SP_ENTRY_FILM__;
  }
});

test('a phone in portrait when the title is entered does not start the film after rotating to landscape', async () => {
  const prevMedia = globalThis.matchMedia;
  const prevW = globalThis.innerWidth, prevH = globalThis.innerHeight;
  globalThis.matchMedia = (q) => ({
    matches: /\bfine\b/.test(String(q)) ? false : /coarse/.test(String(q)),
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.innerWidth = 400;
  globalThis.innerHeight = 800;
  const spy = sceneSpy();
  try {
    await playEntryFilm({ mount: spy.mount });
    assert.equal(overlay(), null, 'portrait: no film');
    assert.equal(spy.mounted, 0);
    globalThis.innerWidth = 800;
    globalThis.innerHeight = 400;
    for (const type of ['resize', 'orientationchange']) {
      for (const fn of [...(winListeners.get(type) || [])]) fn();
    }
    await sleep(500);
    assert.equal(overlay(), null, 'landscape later: still no film');
    assert.equal(spy.mounted, 0);
  } finally {
    globalThis.matchMedia = prevMedia;
    globalThis.innerWidth = prevW;
    globalThis.innerHeight = prevH;
  }
});

// ---- 规程's opening (ui/regulationFilm.js) through the same runner ---------------------------------------------------
const { clearRegulationPack, REGULATION_ENTRY, ENTRY_PREFAB, ENTRY_CLIP } = await import('../../public/js/ui/regulationFilm.js');
/**
 * fetch answering the local manifest (with or without 规程's opening group) and the group's prefabs.json — the clean
 * checkout has no data/local-assets.json — and the manifest loaded again with it. Returns the undo.
 */
async function regulationGroup(present) {
  const entry = `/assets/local/${REGULATION_ENTRY}/prefabs.json`;
  const manifest = { version: 1, groups: present ? { [REGULATION_ENTRY]: { 'prefabs.json': { path: entry }, 'sprites/a.webp': { path: `/assets/local/${REGULATION_ENTRY}/sprites/a.webp` } } } : {} };
  const doc = { spPrefabs: 1, prefabs: { [ENTRY_PREFAB]: { name: ENTRY_PREFAB, children: [{ name: 'a', image: { sprite: 'a', type: 'simple', color: '#FFFFFF' } }] } }, clips: { [ENTRY_CLIP]: { len: 3.1667, wrap: 0, curves: [] } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.split('?')[0].split('/').pop() === 'local-assets.json') return { ok: true, status: 200, json: async () => manifest };
    if (u === entry) return { ok: true, status: 200, json: async () => doc };
    return realFetch(url);
  };
  clearRegulationPack();
  await data.invalidate('local');
  return async () => { globalThis.fetch = realFetch; clearRegulationPack(); await data.invalidate('local'); };
}

test('a 规程 start plays 规程\'s opening through the same overlay: its label, its scene, the cue; a key skips it', async () => {
  const restore = await regulationGroup(true);
  const { ctx, sources } = runningContext();
  Object.assign(audio, { ctx, sfxGain: {}, _buffer: async () => ({ duration: 1 }), _fadeOutBgm() {} });
  PROTO.playBgm = function () {};
  const alliance = sceneSpy();
  const regulation = sceneSpy();
  try {
    await playEntryFilm({ mount: alliance.mount, regulation: () => true, regulationMount: regulation.mount });
    const el = overlay();
    assert.ok(el, 'the overlay is up');
    assert.equal(el.attrs['aria-label'], '卫戍协议·规程');
    await until(() => regulation.frames > 0);
    assert.equal(regulation.mounted, 1, '规程\'s scene runs');
    assert.equal(alliance.mounted, 0, 'not 盟约\'s');
    assert.ok(sources[0] && sources[0].started != null, 'the load cue is scheduled');
    pressKey();
    await sleep(400);
    assert.equal(overlay(), null, 'skipped');
    assert.equal(regulation.destroyed, 1);
  } finally {
    await restore();
  }
});

// this fork (2026-11-15): the film is on by default, and 规程's opening comes only from a local-client extraction (the art
// pack and tools/fetch-assets.mjs do not carry it), so a 规程 start without it plays 盟约's film instead of nothing
test('a 规程 start without the extracted opening plays 盟约\'s film instead', async () => {
  const restore = await regulationGroup(false);
  const { ctx } = runningContext();
  Object.assign(audio, { ctx, sfxGain: {}, _buffer: async () => ({ duration: 1 }), _fadeOutBgm() {} });
  PROTO.playBgm = function () {};
  const alliance = sceneSpy();
  const regulation = sceneSpy();
  try {
    await playEntryFilm({ mount: alliance.mount, regulation: () => true, regulationMount: regulation.mount });
    const el = overlay();
    assert.ok(el, 'the overlay is up');
    await until(() => alliance.frames > 0);
    assert.equal(el.attrs['aria-label'], '卫戍协议 · 盟约');
    assert.equal(alliance.mounted, 1, '盟约\'s scene runs');
    assert.equal(regulation.mounted, 0, 'no 规程 scene without its art');
    pressKey();
    await sleep(400);
    assert.equal(overlay(), null, 'skipped');
  } finally {
    await restore();
  }
});

test('a 规程 start whose opening does not come in plays 盟约\'s film at the end of the wait, loading since the cover came up', async () => {
  const restore = await regulationGroup(true);
  const imgs = heldImages((u) => u.includes('/assets/local/'));
  const alliance = sceneSpy();
  const regulation = sceneSpy();
  try {
    await playEntryFilm({ mount: alliance.mount, regulation: () => true, regulationMount: regulation.mount, budget: { load: 300, cap: 3000 } });
    const el = overlay();
    assert.ok(el && isCover(el), 'the cover is up');
    assert.equal(el.attrs['aria-label'], '卫戍协议·规程', '规程\'s until the choice');
    const isReg = (u) => u.includes('/assets/local/');
    await until(() => imgs.asked.filter((u) => !isReg(u)).length >= 8, 500);
    assert.ok(imgs.asked.filter((u) => !isReg(u)).length >= 8, '盟约\'s pictures load with the cover up, before 规程\'s have failed');
    assert.ok(imgs.asked.findIndex(isReg) >= 0 && imgs.asked.findIndex(isReg) < imgs.asked.findIndex((u) => !isReg(u)), 'right after 规程\'s');
    await until(() => alliance.frames > 0);
    assert.equal(alliance.mounted, 1, '盟约\'s film plays at the end of the wait, by itself');
    assert.equal(regulation.mounted, 0);
    assert.equal(el.attrs['aria-label'], '卫戍协议 · 盟约');
    pressKey();
    await sleep(400);
    assert.equal(overlay(), null, 'skipped');
  } finally {
    imgs.restore();
    await restore();
  }
});
