// 确认入场 — the public queue's offer as a full-screen takeover, and its sounds (2026-11-05, the user: 「匹配到人之后需要添加动效和
// 音效。重写现在的静态确认页面」; docs/history/0.3.3.md 「匹配成功确认页」): the takeover's model (ui/matchOffer.js — the seat slots,
// the countdown, the remembered window, the columns, the tracker of the moments after an offer ends and what is shown),
// the cues (ui/offerCues.js — one listener, never twice), the synthesized sounds (ui/offerSynth.js, through audio.synth into
// the SFX channel) and the audio manager's keepAwake (a hidden tab hears the SFX only while an offer stands).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offerSeats, offerClock, offerWindow, offerColumns, offerFull, offerTrack, offerView, offerSize,
  OFFER_URGENT_S, OFFER_BROKEN_MS, OFFER_FOUND_MS, OFFER_LEAVE_MS } from '../../public/js/ui/matchOffer.js';
import { offerCueStep, offerTick, installOfferCues, OFFER_CUES } from '../../public/js/ui/offerCues.js';
import { playOfferSynth, OFFER_SYNTHS, OFFER_RISE_S } from '../../public/js/ui/offerSynth.js';
import { AudioManager } from '../../public/js/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const offer = (o = {}) => ({ state: 'offered', ticketId: 't1', offerId: 'o1', required: 4, acceptedCount: 0, accepted: false, deadline: 30_000, ...o });

test('the seat slots: mine first, lit once my accept is in; the others light in order with the count', () => {
  assert.deepEqual(offerSeats(4, 0, false), [{ me: true, lit: false }, { me: false, lit: false }, { me: false, lit: false }, { me: false, lit: false }]);
  assert.deepEqual(offerSeats(4, 2, false).map((s) => s.lit), [false, true, true, false]);
  assert.deepEqual(offerSeats(4, 2, true).map((s) => s.lit), [true, true, false, false]);
  assert.deepEqual(offerSeats(4, 4, true).map((s) => s.lit), [true, true, true, true]);
  assert.equal(offerSeats(20, 25, false).filter((s) => s.lit).length, 19, 'never more than the others');
  assert.equal(offerSeats(0, 0, false).length, 1);
  assert.equal(offerSeats(8, -3, false).filter((s) => s.lit).length, 0);
});

test('the countdown: seconds, the share left, urgent for the last five seconds before my accept', () => {
  assert.deepEqual(offerClock(30, 30, false), { seconds: 30, frac: 1, urgent: false });
  assert.deepEqual(offerClock(15, 30, false), { seconds: 15, frac: 0.5, urgent: false });
  assert.equal(offerClock(OFFER_URGENT_S, 30, false).urgent, true);
  assert.equal(offerClock(1, 30, false).urgent, true);
  assert.equal(offerClock(0, 30, false).urgent, false, 'over');
  assert.equal(offerClock(3, 30, true).urgent, false, 'confirmed: nothing to hurry');
  assert.equal(offerClock(40, 30, false).frac, 1);
});

test('the window is what was left when this page first saw the offer, kept per offer', () => {
  assert.equal(offerWindow('w-a', 30), 30);
  assert.equal(offerWindow('w-a', 12), 30, 'a re-mounted takeover keeps its bar');
  assert.equal(offerWindow('w-b', 12), 12, 'first seen late: that is the window');
  assert.equal(offerWindow('w-b', 20), 20, 'never below what is left');
  assert.equal(offerWindow(null, 7), 7);
  for (let i = 0; i < 40; i++) offerWindow(`w-many-${i}`, 30);
  assert.equal(offerWindow('w-a', 5), 5, 'bounded: old offers are forgotten');
});

test('the seat row: one row on a desktop (20 make one narrow row), two rows on a phone past 8', () => {
  for (const n of [4, 8, 12, 16, 20]) assert.equal(offerColumns(n), n);
  assert.deepEqual([4, 8, 12, 16, 20].map((n) => offerColumns(n, true)), [4, 8, 6, 8, 10]);
  assert.equal(offerSize({ required: 20 }), 20);
  assert.equal(offerSize({ required: 5 }), 4, 'not a player capacity: the four-seat default');
  assert.equal(offerSize(null), 4);
});

test('everyone in: allocationPending, or the count full with mine among it', () => {
  assert.equal(offerFull(offer()), false);
  assert.equal(offerFull(offer({ acceptedCount: 4, accepted: false })), false);
  assert.equal(offerFull(offer({ acceptedCount: 4, accepted: true })), true);
  assert.equal(offerFull(offer({ acceptedCount: 3, accepted: true, allocationPending: true })), true);
  assert.equal(offerFull({ state: 'queued', allocationPending: true }), false);
});

test('the tracker: the offer, then 搜寻成功 over the room, 本次匹配未成立 with its reason, the cut-away after leaving', () => {
  const m = { offer: null, hold: null };
  offerTrack(m, offer(), 0, true);
  assert.deepEqual(offerView(m, offer(), 0), { stage: 'offer', queue: offer(), reason: null });
  const full = offer({ acceptedCount: 4, accepted: true, allocationPending: true });
  offerTrack(m, full, 10, true);
  assert.equal(offerView(m, full, 10).stage, 'found');
  offerTrack(m, { state: 'matched', code: 'ABCD' }, 100, true);
  const found = offerView(m, { state: 'matched' }, 101);
  assert.equal(found.stage, 'found');
  assert.equal(found.held, true);
  assert.equal(found.queue.acceptedCount, 4);
  assert.equal(offerView(m, { state: 'matched' }, 100 + OFFER_FOUND_MS), null, 'then the room alone');

  const b = { offer: null, hold: null };
  offerTrack(b, offer({ offerId: 'o2', acceptedCount: 2, accepted: true }), 0, true);
  offerTrack(b, { state: 'queued', reason: 'peer_cancelled' }, 50, true);
  let v = offerView(b, { state: 'queued', reason: 'peer_cancelled' }, 60);
  assert.equal(v.stage, 'broken');
  assert.equal(v.reason, 'peer_cancelled');
  assert.equal(v.queue.offerId, 'o2', 'the offer as it was shown');
  offerTrack(b, { state: 'queued', reason: 'peer_cancelled', waitingCount: 3 }, 70, true);
  assert.equal(offerView(b, { state: 'queued' }, 80).stage, 'broken', 'a later update of the waiting ticket keeps it');
  assert.equal(offerView(b, { state: 'queued' }, 50 + OFFER_BROKEN_MS), null);
  offerTrack(b, offer({ offerId: 'o3' }), 0, true);
  offerTrack(b, { state: 'idle', reason: 'unconfirmed' }, 10, false);
  v = offerView(b, { state: 'idle', reason: 'unconfirmed' }, 20);
  assert.equal(v.stage, 'broken', 'out with a reason: shown, reduced motion or not (it says why)');
  offerTrack(b, offer({ offerId: 'o4' }), 30, true);
  assert.equal(offerView(b, offer({ offerId: 'o4' }), 31).stage, 'offer', 'a new offer drops the kept moment');

  const l = { offer: null, hold: null };
  offerTrack(l, offer({ offerId: 'o5' }), 0, true);
  offerTrack(l, { state: 'idle', reason: 'cancelled' }, 10, true);
  assert.equal(offerView(l, { state: 'idle' }, 11).stage, 'leave');
  assert.equal(offerView(l, { state: 'idle' }, 10 + OFFER_LEAVE_MS), null);
  const still = { offer: null, hold: null };
  offerTrack(still, offer({ offerId: 'o6' }), 0, false);
  offerTrack(still, { state: 'idle', reason: 'cancelled' }, 10, false);
  assert.equal(offerView(still, { state: 'idle' }, 11), null, 'reduced motion: no cut-away');
  offerTrack(still, offer({ offerId: 'o7' }), 0, false);
  offerTrack(still, { state: 'matched' }, 10, false);
  assert.equal(offerView(still, { state: 'matched' }, 11), null);
  assert.equal(offerView({ offer: null, hold: null }, { state: 'queued' }, 0), null, 'no offer, nothing shown');
});

test('the cues of each update: arrival once per offer, acceptances, mine, all ready, a broken offer', () => {
  let s = offerCueStep(null, { state: 'queued' });
  assert.deepEqual(s.cues, []);
  s = offerCueStep(null, offer());
  assert.deepEqual(s.cues, ['arrive']);
  assert.deepEqual(offerCueStep(s.memo, offer()).cues, [], 'a re-sent state (reconnect, re-render) is no new event');
  s = offerCueStep(s.memo, offer({ acceptedCount: 1 }));
  assert.deepEqual(s.cues, ['peer']);
  s = offerCueStep(s.memo, offer({ acceptedCount: 2, accepted: true }));
  assert.deepEqual(s.cues, ['mine'], 'my own accept is not a teammate\'s');
  s = offerCueStep(s.memo, offer({ acceptedCount: 3, accepted: true }));
  assert.deepEqual(s.cues, ['peer']);
  const last = offerCueStep(s.memo, offer({ acceptedCount: 4, accepted: true }));
  assert.deepEqual(last.cues, ['peer', 'allReady'], 'the count full: everyone in');
  assert.deepEqual(offerCueStep(last.memo, offer({ acceptedCount: 4, accepted: true, allocationPending: true })).cues, []);
  assert.deepEqual(offerCueStep(last.memo, { state: 'matched' }).cues, [], 'heard already');
  assert.deepEqual(offerCueStep(s.memo, { state: 'matched' }).cues, ['allReady'], 'matched before the full count was heard');

  let b = offerCueStep(null, offer({ offerId: 'x' }));
  b = offerCueStep(b.memo, offer({ offerId: 'x', acceptedCount: 3, accepted: true }));
  assert.deepEqual(b.cues, ['peer', 'mine'], 'both in one update');
  assert.deepEqual(offerCueStep(b.memo, { state: 'queued', reason: 'declined' }).cues, ['broken']);
  assert.deepEqual(offerCueStep(b.memo, { state: 'idle', reason: 'unconfirmed' }).cues, ['broken'], 'out with a reason');
  assert.deepEqual(offerCueStep(b.memo, { state: 'idle', reason: 'cancelled' }).cues, [], 'leaving by choice: no cue');
  assert.deepEqual(offerCueStep(b.memo, offer({ offerId: 'y' })).cues, ['arrive'], 'a new offer');
  assert.deepEqual(offerCueStep(null, offer({ allocationPending: true })).cues, ['allReady'], 'first seen already full');
  assert.equal(offerCueStep(b.memo, offer({ offerId: 'x', acceptedCount: 1 })).memo.count, 3, 'counts never go back');
});

test('the countdown ticks 5 … 1 once each, only before my accept', () => {
  const q = offer({ deadline: 10_000 });
  const memo = offerCueStep(null, q).memo;
  assert.equal(offerTick(memo, q, 0), null, '10 s left');
  assert.equal(offerTick(memo, q, 5_000), 5);
  assert.equal(offerTick({ ...memo, tick: 5 }, q, 5_400), null, 'each second once');
  assert.equal(offerTick({ ...memo, tick: 5 }, q, 6_100), 4);
  assert.equal(offerTick({ ...memo, tick: 2 }, q, 9_500), 1);
  assert.equal(offerTick(memo, q, 10_000), null, 'over');
  assert.equal(offerTick(memo, { ...q, accepted: true }, 7_000), null, 'confirmed');
  assert.equal(offerTick(memo, { ...q, allocationPending: true }, 7_000), null);
  assert.equal(offerTick(memo, { ...q, offerId: 'other' }, 7_000), null);
  assert.equal(offerTick(null, q, 7_000), null);
});

test('installOfferCues plays the cues, keeps the context awake while an offer stands, ticks on its timer', () => {
  let state = { queue: { state: 'queued' } };
  const subs = new Set();
  const store = { getState: () => state, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  const set = (queue) => { const prev = state; state = { ...state, queue }; for (const fn of subs) fn(state, prev); };
  const played = [], awake = [];
  let now = 0, timerFn = null, stopped = 0;
  const off = installOfferCues({ ...store, play: (cue, volume) => played.push([cue, volume]), awake: (on) => awake.push(on), now: () => now,
    every: (fn) => { timerFn = fn; return 7; }, stop: (id) => { assert.equal(id, 7); stopped++; timerFn = null; } });
  assert.deepEqual(played, []);
  set(offer({ deadline: 8_000 }));
  assert.deepEqual(played, [['arrive', OFFER_CUES.arrive]]);
  assert.equal(awake.at(-1), true);
  now = 3_200; timerFn();
  assert.deepEqual(played.at(-1), ['tick', OFFER_CUES.tick], '5 s left');
  timerFn();
  assert.equal(played.length, 2, 'once per second');
  set(offer({ deadline: 8_000, acceptedCount: 1 }));
  assert.deepEqual(played.at(-1), ['peer', OFFER_CUES.peer]);
  set(offer({ deadline: 8_000, acceptedCount: 2, accepted: true }));
  assert.deepEqual(played.at(-1), ['mine', OFFER_CUES.mine]);
  now = 6_100; timerFn();
  assert.equal(played.at(-1)[0], 'mine', 'no ticks once confirmed');
  set(offer({ deadline: 8_000, acceptedCount: 4, accepted: true, allocationPending: true }));
  assert.deepEqual(played.slice(-2).map((x) => x[0]), ['peer', 'allReady']);
  set({ state: 'matched' });
  assert.equal(awake.at(-1), false);
  assert.equal(stopped, 1);
  off();
  assert.equal(subs.size, 0);
});

/** A Web Audio context that records what a cue builds. */
function fakeCtx() {
  const made = { osc: 0, noise: 0, gain: 0, filter: 0, starts: [], stops: [], outs: 0 };
  class Param { constructor() { this.value = 1; this.events = []; } setValueAtTime(v, t) { this.events.push(['set', v, t]); } linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); } exponentialRampToValueAtTime(v, t) { assert.ok(v > 0, 'exponential ramps never reach 0'); this.events.push(['exp', v, t]); } setTargetAtTime() {} cancelScheduledValues() {} }
  class Node { connect(n) { if (n === out) made.outs++; return n; } disconnect() {} }
  const out = new Node();
  const ctx = {
    currentTime: 2, sampleRate: 8000,
    createOscillator() { made.osc++; const o = new Node(); o.frequency = new Param(); o.start = (t) => made.starts.push(t); o.stop = (t) => made.stops.push(t); return o; },
    createGain() { made.gain++; const g = new Node(); g.gain = new Param(); return g; },
    createBiquadFilter() { made.filter++; const f = new Node(); f.frequency = new Param(); f.Q = new Param(); return f; },
    createBuffer(ch, len) { const data = new Float32Array(len); return { getChannelData: () => data }; },
    createBufferSource() { made.noise++; const s = new Node(); s.start = (t) => made.starts.push(t); s.stop = (t) => made.stops.push(t); return s; },
  };
  return { ctx, out, made };
}

test('every cue is drawn in code into the SFX output: the arrival lands its impact OFFER_RISE_S after the riser', () => {
  assert.deepEqual(Object.keys(OFFER_CUES).sort(), [...OFFER_SYNTHS].sort());
  for (const name of OFFER_SYNTHS) {
    const { ctx, out, made } = fakeCtx();
    const len = playOfferSynth(ctx, out, name, OFFER_CUES[name]);
    assert.ok(len > 0 && len < 1.2, `${name}: ${len}`);
    assert.ok(made.outs > 0, `${name} reaches the output`);
    assert.ok(made.starts.every((t) => t >= 2), `${name} starts from now`);
    assert.equal(made.starts.length, made.stops.length, `${name}: every source stops`);
    assert.ok(Math.max(...made.stops) <= 2 + len + 0.2, `${name}: stops within its length`);
  }
  const { ctx, out, made } = fakeCtx();
  playOfferSynth(ctx, out, 'arrive', 1);
  assert.ok(made.starts.some((t) => Math.abs(t - (2.005 + OFFER_RISE_S)) < 1e-9), 'the impact at the slam');
  assert.equal(playOfferSynth(ctx, out, 'nope', 1), 0);
});

function fakeWindow() {
  const listeners = new Map();
  const calls = { suspend: 0, resume: 0 };
  class Param { constructor() { this.value = 1; } setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } exponentialRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node { constructor() { super(); this.playbackRate = new Param(); } start() {} stop() {} }
  class Ctx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    createBuffer() { return {}; }
    decodeAudioData(ab, ok) { ok({ duration: 1 }); }
    resume() { calls.resume++; this.state = 'running'; return Promise.resolve(); }
    suspend() { calls.suspend++; this.state = 'suspended'; return Promise.resolve(); }
  }
  const document = { hidden: false, addEventListener(t, fn) { listeners.set(`doc:${t}`, fn); } };
  return {
    calls, document,
    win: { AudioContext: Ctx, document, addEventListener(t, fn) { listeners.set(t, fn); }, removeEventListener(t) { listeners.delete(t); } },
    fire(t) { listeners.get(t)?.(); },
  };
}

test('audio.synth: into the SFX channel after the first gesture, never when muted or the SFX volume is 0', () => {
  const fw = fakeWindow();
  const a = new AudioManager({ win: fw.win, getManifest: () => ({ audio: { sfx: { ui: {} } } }) });
  a.install();
  const seen = [];
  const build = (ctx, out, v) => seen.push([ctx === a.ctx, out === a.sfxGain, v]);
  assert.equal(a.synth(build, 0.5), false, 'no context before a gesture');
  fw.fire('pointerdown');
  assert.equal(a.synth(build, 0.5), true);
  assert.deepEqual(seen, [[true, true, 0.5]]);
  a.setVolumes({ bgm: 0.5, sfx: 0, voice: 0.5, muted: false });
  assert.equal(a.synth(build, 0.5), false);
  a.setVolumes({ bgm: 0.5, sfx: 0.8, voice: 0.5, muted: true });
  assert.equal(a.synth(build, 0.5), false);
  a.setVolumes({ bgm: 0.5, sfx: 0.8, voice: 0.5, muted: false });
  assert.equal(a.synth(() => { throw new Error('boom'); }, 1, 'bad'), false, 'a failing cue never throws');
});

test('keepAwake: a hidden page held for an offer keeps running with the SFX channel only; let go, it suspends', async () => {
  const fw = fakeWindow();
  const a = new AudioManager({ win: fw.win, getManifest: () => ({ audio: { sfx: { ui: {} } } }) });
  a.install();
  a.keepAwake('offer', true); // before the first gesture: no context, nothing to do
  fw.fire('pointerdown');
  assert.ok(a.ctx);
  const bgm = () => a.bgmGain.gain.value, sfx = () => a.sfxGain.gain.value, voice = () => a.voiceGain.gain.value;
  const normal = { bgm: bgm(), voice: voice() };
  assert.ok(normal.bgm > 0 && normal.voice > 0);
  fw.document.hidden = true;
  fw.fire('doc:visibilitychange');
  assert.equal(fw.calls.suspend, 0, 'held: no suspend');
  assert.equal(bgm(), 0, 'music silent behind another tab');
  assert.equal(voice(), 0);
  assert.ok(sfx() > 0, 'the cues sound');
  a.keepAwake('offer', false);
  assert.equal(fw.calls.suspend, 1, 'let go while hidden: suspended as before');
  a.keepAwake('offer', true);
  assert.equal(a.ctx.state, 'running', 'a new offer behind another tab wakes it');
  fw.document.hidden = false;
  fw.fire('doc:visibilitychange');
  assert.equal(bgm(), normal.bgm, 'visible: the music is back');
  assert.equal(voice(), normal.voice);
  a.keepAwake('offer', false);
  assert.equal(bgm(), normal.bgm);
  const before = fw.calls.suspend;
  fw.document.hidden = true;
  fw.fire('doc:visibilitychange');
  assert.equal(fw.calls.suspend, before + 1, 'unheld: a hidden page suspends as it always did');
});

test('the takeover is mounted once over every screen; the queue column holds 搜寻成功 under it; styles linked', () => {
  const main = read('public/js/main.js');
  assert.match(main, /<\$\{Screen\} key=\$\{route\} \/>`\}\n {4}<\$\{OfferTakeover\} \/>/);
  assert.equal(main.match(/installOfferStage\(/g)?.length, 1);
  assert.equal(main.match(/installOfferCues\(/g)?.length, 1);
  const mm = read('public/js/ui/matchmaking.js');
  assert.match(mm, /if \(queue\.state === 'offered'\) \{\n {4}return html`<\$\{FoundPanel\} class=\$\{cls\} seats=\$\{capacity\} text=\$\{t\('队友已集结，请确认入场'\)\} \/>`;/);
  assert.match(read('public/index.html'), /href="\/css\/screens\/match-offer.css"/);
  const css = read('public/css/screens/match-offer.css');
  assert.match(css, /\.mo \{ --u: min\(calc\(100vw \/ 192\), calc\(100vh \/ 108\)\);/);
  assert.match(css, /z-index: 77/, 'over the sheets (54) and the connection banner (75), under dialogs (80) and toasts (90)');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.sp-reduced-motion \.mo/);
  assert.match(css, /@media \(max-height: 520px\)/);
  assert.match(css, /@media \(max-aspect-ratio: 3\/4\)/);
});
