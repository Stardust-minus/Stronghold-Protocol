// test/ui/prediction.e2e.test.js — client-side prediction under a slow link (rel26, ui/prediction.js; the owner's
// request of 2026-11-02). The real server in this process, the page's WebSocket moved behind a TCP proxy that delays
// every chunk ~150 ms each way (≈ 300 ms RTT) with jitter and, now and then, a retransmission-like stall that holds
// everything behind it. Measured for buy / deploy / withdraw / sell / refresh / freeze: how long until the shop and the
// board show the outcome — with the prediction switched off (localStorage sp.noPredict = '1', the rel25 behaviour)
// and on — and that the predicted views end exactly where the server's states do. A purchase deployed before its
// acknowledgement (its placeholder) lands on the real piece. Opt-in: SP_E2E=1 (needs Chrome).
//
//   SP_E2E=1 node --test test/ui/prediction.e2e.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';

const enabled = process.env.SP_E2E === '1' && hasChrome();
const request = (c, type, body = {}) => c.page.evaluate((type, body) => globalThis.__SP__.net.request(type, body), type, body);
const ONE_WAY_MS = 150;

/** Seeded PRNG: the link's jitter and stalls repeat from run to run. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/**
 * A TCP proxy to 127.0.0.1:`target` for the whole page (the server's CSP allows only its own origin's WebSocket). A
 * connection whose first request is a WebSocket upgrade becomes the slow link: every chunk is delayed `oneWay` ±
 * `jitter` ms in each direction, keeping the byte order (TCP), and with probability `loss` a chunk — and so everything
 * behind it — waits `stall` ms more, the head-of-line wait a lost segment's retransmission causes. Other connections
 * (the page's HTTP requests) pass straight through.
 */
function delayProxy(target, { oneWay = ONE_WAY_MS, jitter = 30, loss = 0.05, stall = 250, seed = 7 } = {}) {
  const rand = rng(seed);
  const sockets = new Set();
  let slow = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    for (const s of [client, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); s.setNoDelay(true); }
    let delayed = null;
    const pipe = (from, to) => {
      let last = 0;
      from.on('data', (buf) => {
        if (delayed === null) delayed = /\r\nupgrade:\s*websocket/i.test(buf.toString('latin1'));
        if (delayed && from === client && !pipe.counted) { pipe.counted = true; slow++; }
        if (!delayed) { to.write(buf); return; }
        const now = Date.now();
        let at = now + oneWay + (rand() * 2 - 1) * jitter;
        if (rand() < loss) at += stall;
        at = Math.max(at, last);
        last = at;
        setTimeout(() => { if (!to.destroyed) to.write(buf); }, at - now);
      });
      from.on('end', () => setTimeout(() => to.end(), Math.max(0, last - Date.now()) + 5));
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    get slowConnections() { return slow; },
    close: () => new Promise((res) => { for (const s of sockets) s.destroy(); server.close(() => res()); }),
  })));
}

let srv, proxy, savedTestMode;
before(async () => {
  if (!enabled) return;
  savedTestMode = process.env.SP_TEST_MODE;
  process.env.SP_TEST_MODE = '1';
  const { startServer } = await import('../../server/index.js');
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, matchHost: { matchOptions: { botRehearsal: 0 } } });
  proxy = await delayProxy(new URL(srv.url).port | 0);
});
after(async () => {
  if (!enabled) return;
  await proxy?.close();
  await srv?.close();
  if (savedTestMode === undefined) delete process.env.SP_TEST_MODE;
  else process.env.SP_TEST_MODE = savedTestMode;
});

/**
 * In the page: start an intent (ui/gameActions.js actions, the module the game uses) and time until the shown
 * m.private satisfies `done` (a fixed predicate: the page's CSP allows no eval); then wait for the request to settle and
 * for the server's own state (no pending intent left).
 * done: { k: 'shopChanged', before } | { k: 'sold', slot } | { k: 'onBoard', uid } | { k: 'inHand', idx, uid } |
 *       { k: 'gone', uid } | { k: 'frozen', value } | { k: 'notRolling' }
 */
const timed = (c, act, args, done) => c.page.evaluate(async (act, args, done) => {
  const { actions } = await import('/js/ui/gameActions.js');
  const { prediction } = await import('/js/ui/prediction.js');
  const S = globalThis.__SP__.store;
  const all = (p) => [...p.hand, ...p.temp, ...p.board].filter(Boolean);
  const test = (p) => {
    switch (done.k) {
      case 'shopChanged': return !!p.shop.rolling || JSON.stringify(p.shop.slots) !== done.before;
      case 'sold': return !!p.shop.slots[done.slot]?.sold;
      case 'onBoard': return p.board.some((x) => x.uid === done.uid);
      case 'inHand': return p.hand[done.idx]?.uid === done.uid;
      case 'gone': return !all(p).some((x) => x.uid === done.uid);
      case 'frozen': return !!p.shop.frozen === done.value;
      case 'notRolling': return !p.shop.rolling;
      default: return false;
    }
  };
  const t0 = performance.now();
  let t1 = null;
  const off = S.subscribe((s) => { if (t1 == null && s.match.private && test(s.match.private)) t1 = performance.now(); });
  const settled = actions[act](...args);
  if (t1 == null && test(S.get().match.private)) t1 = performance.now();
  const ok = await settled;
  for (let i = 0; i < 100 && (prediction.pending().length || S.get().match.private?.shop?.rolling); i++) await new Promise((r) => setTimeout(r, 50));
  off();
  const v = S.get().match.private;
  return { ms: t1 == null ? null : Math.round(t1 - t0), ok, funds: v.funds, pending: prediction.pending().length };
}, act, args, done);

test('under ≈300 ms RTT with jitter and stalls the shop and the board answer at once; the server agrees', { skip: !enabled, timeout: 240_000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default;
  // the page through the proxy: its WebSocket is the slow link, its HTTP requests are not delayed
  const c = new Client(puppeteer, `http://127.0.0.1:${proxy.port}`, 'predict', { prefix: 'predict' });
  try {
    await c.open('?render=fallback');
    await c.enter('Predict');
    await c.page.waitForFunction(() => globalThis.__SP__.store.get().connection?.status === 'online', { timeout: 30000 });
    assert.ok(proxy.slowConnections >= 1, 'the game socket goes through the slow link');
    await request(c, 'room.create', { mode: 'solo', difficulty: 'NORMAL', test: true, soloUnlimited: true });
    await request(c, 'room.start');
    await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing');
    await request(c, 'g.infoReady');
    await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'strategy draft');
    await request(c, 'g.band', { bandId: 'band_bldsk' });
    await c.waitFor((s) => s.phase === 'PREP', 'preparation');
    await request(c, 'g.test', { cmd: 'timers', args: { on: false } });
    await request(c, 'g.test', { cmd: 'funds', args: { amount: 80 } });
    const priv = () => c.page.evaluate(() => globalThis.__SP__.store.get().match.private);
    const setPredict = (on) => c.page.evaluate((on) => { if (on) localStorage.removeItem('sp.noPredict'); else localStorage.setItem('sp.noPredict', '1'); }, on);
    assert.equal(typeof (await priv()).ack, 'number', 'the server acknowledges intents');
    const runs = { off: {}, on: {} };

    const cycle = async (mode) => {
      await setPredict(mode === 'on');
      const r = runs[mode];
      // a refresh first (also a fresh shop to buy from)
      let v = await priv();
      r.refresh = await timed(c, 'refresh', [], { k: 'shopChanged', before: JSON.stringify(v.shop.slots) });
      // a card that completes no merge and brings no summons: every step of it is predictable (refresh again if none)
      let slot = -1;
      for (let tries = 0; tries < 5 && slot < 0; tries++) {
        if (tries) await timed(c, 'refresh', [], { k: 'notRolling' });
        v = await priv();
        const ok = await c.page.evaluate((slots, owned) => slots.map((s) => !!s && s.kind === 'chess' && !s.sold
          && !owned.includes(s.id) && !(globalThis.__SP__.data.lookup('chess', s.id)?.tokens || []).length), v.shop.slots,
        [...v.hand, ...v.temp, ...v.board].filter(Boolean).map((p) => p.id));
        slot = v.shop.slots.findIndex((s, i) => ok[i] && s.price <= v.funds);
      }
      assert.ok(slot >= 0, `a card to buy (${mode})`);
      const id = v.shop.slots[slot].id;
      const count = v.hand.filter(Boolean).length;
      r.buy = await timed(c, 'buy', [slot], { k: 'sold', slot });
      assert.equal(r.buy.ok, true);
      v = await priv();
      const bought = v.hand.find((p) => p && p.id === id && !p.predicted);
      assert.ok(bought, 'the bought piece is in the hand');
      assert.ok(v.hand.filter(Boolean).length >= count, 'nothing lost');
      const tile = await c.freeTileFor(bought.uid);
      assert.ok(tile, 'a free tile');
      r.deploy = await timed(c, 'move', [bought.uid, { area: 'board', row: tile.row, col: tile.col }], { k: 'onBoard', uid: bought.uid });
      const idx = (await priv()).hand.findIndex((p) => !p);
      r.withdraw = await timed(c, 'move', [bought.uid, { area: 'hand', idx }], { k: 'inHand', idx, uid: bought.uid });
      r.sell = await timed(c, 'sell', [bought.uid], { k: 'gone', uid: bought.uid });
      const fz = (await priv()).shop.frozen;
      r.freeze = await timed(c, 'freeze', [], { k: 'frozen', value: !fz });
      await timed(c, 'freeze', [], { k: 'frozen', value: fz });
    };

    await cycle('off');
    await cycle('on');
    const table = Object.fromEntries(Object.keys(runs.on).map((k) => [k, { off: runs.off[k]?.ms, on: runs.on[k]?.ms }]));
    t.diagnostic(`time until shown (ms): ${JSON.stringify(table)}`);
    for (const k of Object.keys(table)) {
      assert.ok(table[k].off >= 2 * ONE_WAY_MS - 80, `${k} without prediction waits for the round trip (${table[k].off} ms)`);
      assert.ok(table[k].on < 80, `${k} with prediction shows at once (${table[k].on} ms)`);
    }
    for (const r of Object.values(runs.on)) assert.equal(r.pending, 0, 'every prediction settled into the server\'s state');

    // a purchase deployed before the server answered: shown at once on its placeholder, sent with the real uid
    await setPredict(true);
    let v = await priv();
    if (!v.shop.slots.some((s) => s && s.kind === 'chess' && !s.sold && s.price <= v.funds)) { await timed(c, 'refresh', [], { k: 'notRolling' }); v = await priv(); }
    const slot = v.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold && s.price <= v.funds);
    const chain = await c.page.evaluate(async (slot) => {
      const { actions } = await import('/js/ui/gameActions.js');
      const { prediction } = await import('/js/ui/prediction.js');
      const S = globalThis.__SP__.store;
      const t0 = performance.now();
      const buying = actions.buy(slot);
      const ph = S.get().match.private.hand.find((p) => p && p.predicted);
      if (!ph) return { error: 'no placeholder' };
      // a free legal tile for it, as the drag would offer (Client.freeTileFor's placement logic, on the predicted view)
      const P = await import('/js/ui/gameLogic/placement.js');
      const C = await import('/js/ui/gameLogic/camera.js');
      const { data } = globalThis.__SP__;
      const s0 = S.get(), pv = s0.match.private, pub = s0.match.public;
      const ctx = P.placementContext({ priv: pv, stage: data.lookup('stages', pub.stageId), editable: true, field: C.deployFieldOf(pub, s0.me?.playerId ?? s0.me),
        getChess: (id) => data.lookup('chess', id), getToken: (id) => data.lookup('tokens', id), getItem: (id) => data.lookup('items', id),
        getEffect: (id) => data.lookup('effects', id), backups: data.get('backups') });
      const used = new Set(pv.board.map((p) => `${p.row},${p.col}`));
      const legal = P.boardTargets(ctx, ph.uid).legal.filter(([r, c]) => !used.has(`${r},${c}`));
      if (!legal.length) return { error: 'no target' };
      const target = { row: legal[0][0], col: legal[0][1] };
      const moving = actions.move(ph.uid, { area: 'board', row: target.row, col: target.col });
      const shownMs = S.get().match.private.board.some((p) => p.uid === ph.uid) ? Math.round(performance.now() - t0) : null;
      const [a, b] = await Promise.all([buying, moving]);
      for (let i = 0; i < 100 && prediction.pending().length; i++) await new Promise((r) => setTimeout(r, 50));
      const end = S.get().match.private;
      const landed = end.board.find((p) => p.row === target.row && p.col === target.col);
      return { shownMs, a, b, ph: ph.uid, landed: landed ? { uid: landed.uid, id: landed.id, predicted: !!landed.predicted } : null, id: ph.id, pending: prediction.pending().length };
    }, slot);
    t.diagnostic(`buy → deploy before the ack: ${JSON.stringify(chain)}`);
    assert.equal(chain.error, undefined, chain.error);
    assert.ok(chain.shownMs != null && chain.shownMs < 80, 'the placeholder is on the board at once');
    assert.equal(chain.a, true); assert.equal(chain.b, true);
    assert.ok(chain.landed && chain.landed.uid > 0 && chain.landed.id === chain.id && !chain.landed.predicted, 'the real piece stands on that tile');
    assert.equal(chain.pending, 0);
    assert.deepEqual(c.problems.filter((p) => /^pageerror/.test(p)), [], 'no page errors');
  } finally {
    await c.close();
  }
});
