// The match seed leak, closed (docs/history/0.4.0.md §37.277, server/match/secret.js): every stream of a match — setup,
// shop, waves, draft, bots, meta, the tilt's, every lazily derived draw — and every battle seed is an HMAC of the match's
// private secret, never the match seed through server/sim/rng.js deriveSeed (a reversible mix). Nothing a page is sent
// equals or reverse-mixes to a server stream's seed, the seed or a word of the secret; the battleId prefix and the
// settlement's `matchId` are another HMAC of it. The same secret plays the same match whatever the seed, and a
// checkpoint carries the secret: a restore built with it plays on identically, one built without it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, checkInvariants } from './harness.js';
import { attachRehearsalHost } from './simClient.js';
import { Match } from '../../server/match/Match.js';
import { isMatchSecret, newMatchSecret, secretSeed, secretTag, seedSecret } from '../../server/match/secret.js';
import { canSnapshot, checkSnapshot, matchState, restoreMatch, snapshotMatch } from '../../server/match/snapshot.js';
import { createRngFromState, deriveSeed } from '../../server/sim/rng.js';
import { EXPERIMENTAL_DEFAULTS } from '../../shared/experimental.js';
import { PHASE } from '../../shared/constants.js';

const STREAMS = ['setup', 'shop', 'waves', 'draft', 'bots', 'meta'];
const QUIET = { warn() {}, info() {}, error() {} };
// seeds far from the small numbers every frame is full of (a match seed of 7 would "appear" everywhere)
const SEED_SOLO = 2654435761, SEED_COOP = 3141592653;

// ---- deriveSeed, inverted: what a page holding the public code would try on every number it is sent ----
const MUL = 0x9e3779b1;
const INV = (() => { let x = MUL; for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(MUL, x)); return x >>> 0; })();
const unshift13 = (h) => { let x = h >>> 0; x ^= x >>> 13; x ^= x >>> 26; return x >>> 0; };
/** The seed `s` with deriveSeed(s, salt) === v. */
function underive(v, salt) {
  let h = v >>> 0;
  const str = String(salt);
  for (let i = str.length - 1; i >= 0; i--) h = (Math.imul(unshift13(h), INV) ^ str.charCodeAt(i)) >>> 0;
  return (h ^ 0x85ebca6b) >>> 0;
}

test('underive inverts deriveSeed (the attack the test stands for)', () => {
  assert.equal(Math.imul(MUL, INV) >>> 0, 1);
  for (const [s, salt] of [[1, 'shop'], [SEED_SOLO, 'n:3:0'], [0xffffffff, 'b1:14'], [0, 'u:7:2']]) assert.equal(underive(deriveSeed(s, salt), salt), s >>> 0);
});

/** Every seed the match derives (Match.streamSeed), salt → value, recorded from construction on. */
function spySeeds() {
  const seen = new Map();
  const orig = Match.prototype.streamSeed;
  Match.prototype.streamSeed = function (salt) { const v = orig.call(this, salt); seen.set(String(salt), v); return v; };
  return { seen, restore: () => { Match.prototype.streamSeed = orig; } };
}

/** Every client-bound frame, serialized as it leaves (unicast to a player or spectator, and every broadcast). */
function capture(h) {
  const frames = [];
  h.onSend.push((id, msg) => frames.push(JSON.stringify([id, msg])));
  h.onBroadcast.push((msg) => frames.push(JSON.stringify(['*', msg])));
  return frames;
}

/** The numbers (uint32 range) and strings of every frame, and each frame's battle seeds (spec.seed / specs[].seed). */
function scan(frames) {
  const nums = new Set(), strs = new Set(), battleSeeds = new Set();
  const walk = (v, key) => {
    if (typeof v === 'number') { if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) nums.add(v); if (key === 'seed') battleSeeds.add(v); return; }
    if (typeof v === 'string') { strs.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, null); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strs.add(k); walk(x, k); }
  };
  for (const f of frames) walk(JSON.parse(f), null);
  return { nums, strs, battleSeeds };
}

/**
 * Assert nothing in `frames` leads to a server stream: no frame value equals the match seed, a server-only derived seed
 * (every seed of `seen` that no frame carries as a battle's `seed`) or a 32-bit word of the secret; no frame number
 * un-mixes (deriveSeed, every salt the match used plus the battle salts of every round and seat) to one of them; no
 * string holds the secret or a base-36 / hex / decimal form of them; and no settlement carries a `seed`.
 */
function assertNoLeak(m, frames, seen, label) {
  const { nums, strs, battleSeeds } = scan(frames);
  const secret = m.matchSecret;
  const words = Array.from({ length: 8 }, (_, i) => Number.parseInt(secret.slice(i * 8, i * 8 + 8), 16) >>> 0);
  const named = STREAMS.map((n) => secretSeed(secret, n));
  for (const [i, n] of STREAMS.entries()) assert.equal(seen.get(n), named[i], `${label}: ${n} is the secret's`);
  const serverOnly = new Map();
  for (const [salt, v] of seen) if (!battleSeeds.has(v)) serverOnly.set(v, salt);
  assert.ok(serverOnly.size >= STREAMS.length, `${label}: server-only seeds recorded`);
  assert.ok(battleSeeds.size > 5, `${label}: battle specs were sent (${battleSeeds.size} seeds)`);
  // every battle seed a page got is one the match derived from its secret, never the seed's mix — or the fixed public seed
  // of a Final Assault rehearsal the host's page runs for an AI seat (bot.js faRehearsalSeed: no match's, the same for all)
  const derived = new Set(seen.values());
  const faSeeds = new Set();
  for (let r = 0; r <= 20; r++) for (let s = 0; s < 4; s++) faSeeds.add(deriveSeed(0xA11CE, `fa:${r}:${s}`));
  for (const v of battleSeeds) assert.ok(derived.has(v) || faSeeds.has(v), `${label}: battle seed ${v} comes from streamSeed`);
  const forbidden = new Map([[m.seed >>> 0, 'the match seed'], ...words.map((w, i) => [w, `secret word ${i}`]), ...serverOnly]);
  for (const v of nums) assert.equal(forbidden.has(v), false, `${label}: a frame carries ${forbidden.get(v)} (${v})`);
  // un-mixing: the salts the match used, and the battle salts of every round / seat / field (the old battle seeds)
  const salts = new Set([...seen.keys()]);
  for (let r = 0; r <= 20; r++) {
    for (let s = 0; s < 4; s++) { salts.add(`n:${r}:${s}`); salts.add(`preview:${r}:${s}`); }
    for (const f of ['u', 'b1', 'b2', 'h', 'h1', 'h2']) salts.add(`${f}:${r}`);
    salts.add(`u:${r}:2`);
  }
  const roots = new Map([[m.seed >>> 0, 'the match seed'], ...words.map((w, i) => [w, `secret word ${i}`]), ...named.map((v, i) => [v, STREAMS[i]])]);
  const big = [...nums].filter((v) => v >= 0x10000);
  for (const v of big) for (const salt of salts) {
    const s = underive(v, salt);
    assert.equal(roots.has(s), false, `${label}: ${v} un-mixes with '${salt}' to ${roots.get(s)}`);
  }
  // strings: the secret (or a quarter of it), and the forbidden values as base-36 / hex / decimal tokens
  const text = [...strs].join('\n');
  for (let i = 0; i < 4; i++) assert.equal(text.includes(secret.slice(i * 16, i * 16 + 16)), false, `${label}: a frame holds the secret`);
  const tokens = new Set([...forbidden.keys()].flatMap((v) => [v.toString(36), v.toString(16), String(v)]).filter((t) => t.length >= 5));
  for (const str of strs) for (const tok of str.split(/[^0-9A-Za-z]+/)) assert.equal(tokens.has(tok.toLowerCase()), false, `${label}: '${str}' names a forbidden value`);
  // the settlement and the eliminated player's own report name the match by its opaque id only
  for (const f of frames) {
    const [, msg] = JSON.parse(f);
    if (msg.t === 'm.result') { assert.equal(Object.hasOwn(msg, 'seed'), false, `${label}: m.result has no seed`); assert.equal(msg.matchId, m.battlePrefix); }
    if (msg.t === 'm.private' && msg.out) assert.equal(Object.hasOwn(msg.out, 'seed'), false, `${label}: the out report has no seed`);
  }
}

/** A whole match with the real simulation, every human on AI 托管 and LP raised so it reaches the Final Assault. */
function runWhole(o, { lp = 400 } = {}) {
  const h = makeMatch({ captureFrames: false, checkFrames: true, clientCombat: true, ...o });
  const frames = capture(h);
  const host = o.botRehearsalDelegate ? attachRehearsalHost(h) : null;
  h.autoHumans();
  const m = h.m;
  m.start();
  let boosted = false;
  h.run(() => {
    if (!boosted && m.phase === PHASE.PREP && m.round === 1) { boosted = true; for (const ps of m.players.values()) ps.lp = lp; }
    return h.ended != null;
  }, { maxSteps: 5e6 });
  assert.ok(h.ended, `${o.mode}: the match ended (${m.phase} R${m.round})`);
  assert.equal(m.errorCount, 0, JSON.stringify(m.errors.slice(0, 2)));
  checkInvariants(m);
  return { h, m, frames, host };
}

test('a whole solo (ELO room, tilted) and co-op match (AI rehearsals on the host\'s page, a spectator): no frame leads to a stream', { timeout: 300_000 }, () => {
  const ent = (wins, losses) => [...Array.from({ length: wins }, () => [1, 14]), ...Array.from({ length: losses }, () => [0, 14])];
  for (const cfg of [
    { label: 'solo', mode: 'solo', difficulty: 'NORMAL', seed: SEED_SOLO, experimental: { ...EXPERIMENTAL_DEFAULTS, elo: true },
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, elo: ent(26, 4) }] },
    { label: 'co-op', mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, seed: SEED_COOP, spectators: ['s_0'],
      botRehearsal: 2, botRehearsalDelegate: true, hostId: 'p_0' },
  ]) {
    const spy = spySeeds();
    let run;
    try { run = runWhole(cfg); } finally { spy.restore(); }
    const { m, frames, host } = run;
    assert.ok(frames.length > 100, `${cfg.label}: frames captured`);
    assert.ok(m.round >= 9, `${cfg.label}: reached the boss round (R${m.round})`);
    if (cfg.label === 'solo') {
      assert.ok(m.players.get('p_0').tilt, 'the ELO seat is tilted');
      assert.ok([...spy.seen.keys()].some((k) => k.startsWith('tilt-sp:')), 'the tilt\'s own streams were drawn');
    } else {
      assert.ok(host.tasks.length > 0, 'AI rehearsals went to the host\'s page');
      assert.ok(frames.some((f) => f.startsWith('["s_0"')), 'the spectator got frames');
      assert.ok([...spy.seen.keys()].some((k) => /^u:/.test(k)), 'a 联防 field was fought');
    }
    assert.ok(frames.some((f) => f.includes('"t":"m.result"')), `${cfg.label}: the settlement was sent`);
    assertNoLeak(m, frames, spy.seen, cfg.label);
    m.dispose();
    run.h.clients?.closeAll();
  }
});

test('the battleId prefix and matchId are an HMAC tag of the secret (and the room\'s match number), never the seed', () => {
  const S = newMatchSecret();
  const h = makeMatch({ mode: 'solo', seed: SEED_SOLO, matchSecret: S, matchNo: 3, fake: true });
  assert.equal(h.m.battlePrefix, `${secretTag(S, 'battle-prefix')}-3`);
  assert.notEqual(h.m.battlePrefix.split('-')[0], SEED_SOLO.toString(36));
  assert.ok(h.m.battlePrefix.length <= 12);
  const other = makeMatch({ mode: 'solo', seed: SEED_SOLO, matchNo: 3, fake: true, randomSecret: true });
  assert.ok(isMatchSecret(other.m.matchSecret));
  assert.notEqual(other.m.battlePrefix, h.m.battlePrefix, 'the same seed and number, another secret: another prefix');
  assert.notEqual(other.m.matchSecret, seedSecret(SEED_SOLO), 'a Match given no secret draws its own, never the seed\'s');
  for (const x of [h, other]) x.m.dispose();
});

test('the same secret plays the same match whatever the seed; another secret another match', { timeout: 120_000 }, () => {
  const S = newMatchSecret();
  const play = (o) => {
    const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, captureFrames: false, clientCombat: true, ...o });
    const frames = capture(h);
    h.autoHumans();
    h.m.start();
    h.runToEnd({ maxSteps: 5e6 });
    const out = { frames, result: JSON.stringify(h.ended), states: STREAMS.map((n) => h.m[`rng${n[0].toUpperCase()}${n.slice(1)}`].state()) };
    h.m.dispose();
    h.clients?.closeAll();
    return out;
  };
  const a = play({ seed: 11, matchSecret: S });
  const b = play({ seed: 4_000_000_011, matchSecret: S });
  assert.equal(a.frames.length, b.frames.length);
  assert.deepEqual(b.frames, a.frames, 'every frame identical: the seed feeds nothing a page sees');
  assert.equal(b.result, a.result);
  assert.deepEqual(b.states, a.states);
  const c = play({ seed: 11, matchSecret: newMatchSecret() });
  assert.notDeepEqual(c.frames, a.frames, 'another secret, another match');
  // tools and tests: a seed fixes the secret (seedSecret), so the same seed repeats the match
  const d = play({ seed: 11 });
  const e = play({ seed: 11 });
  assert.deepEqual(e.frames, d.frames);
});

test('a checkpoint carries the secret: restored with it the match plays on identically to the end; without it it is refused', { timeout: 300_000 }, () => {
  const cfg = { mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 2, seed: SEED_COOP };
  // the original draws its own secret (as a lobby's match does): only the checkpoint knows it
  const h = makeMatch({ ...cfg, randomSecret: true }).autoHumans();
  h.start();
  h.run(() => h.ended != null || (h.m.phase === PHASE.PREP && h.m.round >= 4 && canSnapshot(h.m)));
  assert.ok(!h.ended && h.m.phase === PHASE.PREP);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal(doc.matchSecret, h.m.matchSecret);
  assert.notEqual(doc.matchSecret, seedSecret(doc.seed));
  const rebuild = (o) => makeMatch({ ...cfg, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, ...o });
  // a fresh instance without the secret (its own, or the seed's) cannot go on with the document
  const own = rebuild({ randomSecret: true });
  assert.equal(checkSnapshot(own.m, doc), 'secret');
  const bySeed = rebuild({});
  assert.equal(restoreMatch(bySeed.m, doc, { createRngFromState, log: QUIET }), false);
  const without = { ...doc };
  delete without.matchSecret;
  const r = rebuild({ matchSecret: doc.matchSecret });
  assert.equal(checkSnapshot(r.m, without), 'secret');
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: QUIET }), true);
  assert.equal(r.m.battlePrefix, h.m.battlePrefix);
  assert.deepEqual(matchState(r.m), matchState(h.m), 'lossless');
  for (const ps of r.m.order) if (!ps.isBot) { r.m.onReconnect(ps.playerId); ps.autoplay = true; }
  // both play on to the end: the same rounds, the same draws, the same settlement
  const strip = (s) => { const { match, ...rest } = s; const { errors, errorCount, lastResults, simErrorLog, ...mm } = match; return { ...rest, match: mm }; };
  const nextEnd = (x, after) => x.run(() => x.ended != null || (x.m.phase === PHASE.COMBAT && x.m.round > after) || x.m.phase === PHASE.FINAL_ASSAULT);
  const round = h.m.round;
  nextEnd(h, round - 1); nextEnd(r, round - 1);
  assert.deepEqual(strip(matchState(r.m)), strip(matchState(h.m)), 'the same next prep end');
  h.runToEnd({ maxSteps: 5e6 }); r.runToEnd({ maxSteps: 5e6 });
  const res = (x) => JSON.stringify({ ...x.ended, durationMs: 0, errors: 0 });
  assert.equal(res(r), res(h), 'the same settlement');
  assert.equal(r.ended.matchId, h.ended.matchId);
  assert.deepEqual(r.logs.error, []);
  for (const x of [h, own, bySeed, r]) x.m.dispose();
});
