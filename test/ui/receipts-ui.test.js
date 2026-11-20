// Match receipts on the page (docs/history/0.4.0.md §37.276; ui/receipts.js, ui/stats.js): a receipt lands on its record
// (and survives compaction, a merge and an export), the export carries the identity and the import reads it back, the
// ELO numbers take help only from this identity's receipts and each version its own, the 规程 card counts receipts, and
// the connection wiring (id.token, m.receipt, room.trophies, room.elo { rec, rc }). Throwaway keys; fake storage and net.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { compactRecord, exportStats, importStats, mergeStats, normalizeRecord, recordReceipt, loadStats, saveStats, emptyStats } from '../../public/js/ui/stats.js';
import { cardTrophies, eloReceipts, idStore, installReceipts, otherIdentity, receiptRev, takeReceipt, trophyReceipts } from '../../public/js/ui/receipts.js';
import { eloRecords } from '../../public/js/ui/eloRecords.js';
import { eloMine } from '../../public/js/ui/eloPanel.js';
import { installEloSync, eloStore } from '../../public/js/ui/loadoutSync.js';
import { createStore } from '../../public/js/store.js';
import { createIdentity, parseKeyring } from '../../server/identity.js';
import { createReceipts } from '../../server/resultReceipts.js';
import { eloKey } from '../../shared/elo.js';

const V2 = 'act2autochess', V3 = 'act3autochess@V3_1';
const ring = () => parseKeyring(`g1 ${randomBytes(32).toString('base64')}`);
const ids = createIdentity({ keys: ring() });
const rcs = createReceipts({ keys: ring() });
const me = ids.issue(), other = ids.issue();
let n = 0;
const rec16 = () => String(++n).padStart(16, 'r');
const receipt = (o = {}) => rcs.issue({ sub: me.sub, rec: rec16(), mode: 'coop', diff: 'ABYSS', ver: V3, w: false, rp: 12, tr: 3, ai: false, mod: false, elo: false, ...o });
let t0 = 1000;
/** A settled record of mine (ui/stats.js shape). */
const record = ({ won = false, rounds = 12, trophies = 3, version = V3, mode = 'coop', difficulty = 'ABYSS', rc = undefined } = {}) => normalizeRecord({
  id: `r1.${String(++t0)}`, t: t0, end: 'settled', victory: won, roundsPassed: won ? 14 : rounds, modeId: 'x', difficulty, roomMode: mode, selfId: 'me',
  ...(version !== V2 ? { version } : {}), ...(rc ? { rc } : {}),
  players: [{ playerId: 'me', victory: won, alive: won, roundsPassed: won ? 14 : rounds, trophies }] });

function withStorage(fn) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const clear = () => { delete globalThis.localStorage; };
  let out;
  try { out = fn(); } catch (e) { clear(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(clear);
  clear();
  return out;
}

test('a record keeps a well-formed receipt (settled only), also compacted, merged and exported', () => {
  const rc = receipt();
  assert.equal(record({ rc }).rc, rc);
  assert.equal(Object.hasOwn(record({ rc: 'rc1.junk' }), 'rc'), false);
  assert.equal(Object.hasOwn(normalizeRecord({ end: 'quit', rc, players: [{ playerId: 'me' }] }), 'rc'), false, 'a quit has none');
  assert.equal(compactRecord(record({ rc })).rc, rc);
  const plain = record(), signed = { ...plain, rc };
  assert.equal(mergeStats({ records: [plain] }, { records: [signed] }).records[0].rc, rc, 'the current copy wins, its receipt is not lost');
  const file = exportStats({ records: [signed] }, me.token);
  assert.equal(file.identity, me.token);
  assert.equal(file.records[0].rc, rc);
  assert.equal(Object.hasOwn(exportStats({ records: [signed] }, 'garbage'), 'identity'), false);
  const back = importStats(JSON.parse(JSON.stringify(file)), emptyStats());
  assert.equal(back.identity, me.token);
  assert.equal(back.stats.records[0].rc, rc);
  assert.equal(importStats({ kind: 'local-stats', records: [] }, emptyStats()).identity, null);
});

test('m.receipt lands on the newest record it fits (mode, difficulty, version, my outcome, rounds, trophies), once', () => withStorage(() => {
  const rc = receipt({ w: true, rp: 14, tr: 6 });
  const fit = record({ won: true, trophies: 6 }), older = record({ won: true, trophies: 6 }), wrong = record({ won: false });
  saveStats({ v: 3, records: [wrong, fit, older].sort((a, b) => b.t - a.t) });
  assert.equal(recordReceipt(rc), true);
  const stored = loadStats().records;
  assert.equal(stored.filter((r) => r.rc === rc).length, 1);
  assert.equal(stored.find((r) => r.rc === rc).t, Math.max(fit.t, older.t), 'the newest that fits');
  assert.equal(recordReceipt(rc), true, 'again: already there');
  assert.equal(recordReceipt(receipt({ ver: V2 })), false, 'nothing of 第二期下半 to land on');
  assert.equal(recordReceipt('nonsense'), false);
}));

test('ELO per version: a record of another version never counts, the room\'s mode, difficulty and version only', () => {
  const v2 = Array.from({ length: 10 }, () => record({ version: V2 }));
  const lists = eloRecords(v2);
  assert.deepEqual(Object.keys(lists), [eloKey('coop', 'ABYSS', V2)]);
  const none = eloMine('coop', 'ABYSS', () => v2, me.sub, V3);
  assert.equal(none.n, 0); assert.equal(none.dir, 'none'); assert.equal(none.ownN, 0, '规程 has no record at all');
  assert.ok(none.scope.startsWith('规程·序列Ⅰ·'), 'the version\'s name first');
});

test('ELO on the page: help only from this identity\'s receipts; the local records only make it harder', () => {
  const losses = Array.from({ length: 10 }, () => record());
  const plain = eloMine('coop', 'ABYSS', () => losses, me.sub, V3);
  assert.equal(plain.dir, 'none', '10 local losses without receipts: no help');
  assert.equal(plain.source, 'receipts'); assert.equal(plain.ownN, 10);
  const signed = losses.map((r) => ({ ...r, rc: receipt() }));
  const helped = eloMine('coop', 'ABYSS', () => signed, me.sub, V3);
  assert.equal(helped.dir, 'help'); assert.equal(helped.verified, 10);
  assert.equal(eloMine('coop', 'ABYSS', () => signed, other.sub, V3).dir, 'none', 'another identity\'s receipts: no help');
  const wins = Array.from({ length: 10 }, () => record({ won: true }));
  const hindered = eloMine('coop', 'ABYSS', () => [...wins, ...signed.slice(0, 2)], me.sub, V3);
  assert.equal(hindered.dir, 'hinder'); assert.equal(hindered.source, 'own');
  // what room.elo `rc` carries: this identity, the room's key, no AI-taken or plugin seat
  const mixed = [{ ...record(), rc: receipt({ sub: other.sub }) }, { ...record(), rc: receipt({ ai: true }) }, { ...record(), rc: receipt({ mod: true }) },
    { ...record({ difficulty: 'HARD' }), rc: receipt({ diff: 'HARD' }) }, { ...record(), rc: receipt({ ver: V2 }) }, ...signed.slice(0, 3)];
  // (newest first by the time each was signed: the same millisecond leaves the order open)
  assert.deepEqual(new Set(eloReceipts(mixed, 'coop', 'ABYSS', V3, me.sub)), new Set(signed.slice(0, 3).map((r) => r.rc)));
  assert.equal(eloReceipts(mixed, 'coop', 'ABYSS', V3, me.sub).length, 3);
  assert.equal(eloReceipts(Array.from({ length: 40 }, () => ({ ...record(), rc: receipt() })), 'coop', 'ABYSS', V3, me.sub).length, 30);
});

test('the 规程 card counts receipts (any identity, one per match); 二期 keeps the page\'s own count', () => {
  const list = [{ ...record({ trophies: 6 }), rc: receipt({ tr: 6 }) }, { ...record({ trophies: 4 }), rc: receipt({ tr: 4, sub: other.sub }) }, record({ trophies: 50 })];
  assert.equal(cardTrophies(list, 'act3autochess'), 10, 'the record without a receipt counts nothing there');
  assert.equal(cardTrophies(list, 'act2autochess'), null);
  assert.equal(trophyReceipts(list).length, 2);
  assert.equal(trophyReceipts([{ ...record(), rc: receipt({ tr: 0 }) }]).length, 0, 'none without trophies');
});

function fakeNet() {
  const handlers = new Map(), sent = [];
  return { sent, status: 'online',
    on(t, fn) { (handlers.get(t) || handlers.set(t, new Set()).get(t)).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn(msg); },
    request(t, fields) { sent.push({ t, ...fields }); return Promise.resolve({ t: 'ok' }); }, reconnectNow() { sent.push({ t: 'reconnect' }); } };
}
const timers = { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {} };
const settle = () => new Promise((r) => setTimeout(r, 10));

test('the connection: id.token (a fresh one is stored as the cookie), m.receipt onto its record, room.trophies after welcome', async () => {
  await withStorage(async () => {
    const rc = receipt({ tr: 5, rp: 12 });
    saveStats({ v: 3, records: [record({ trophies: 5 })] });
    const net = fakeNet(), posts = [];
    const off = installReceipts({ net, records: () => loadStats().records, timers, doFetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { status: 204 }; } });
    net.emit('id.token', { t: 'id.token', token: me.token, fresh: true });
    assert.equal(idStore.get().sub, me.sub);
    assert.equal(otherIdentity(other.token), true); assert.equal(otherIdentity(me.token), false);
    await settle();
    assert.deepEqual(posts, [{ url: '/api/identity', body: { token: me.token } }], 'a fresh identity is stored at once');
    const rev = receiptRev.get().rev;
    net.emit('m.receipt', { t: 'm.receipt', rc });
    assert.equal(loadStats().records[0].rc, rc);
    assert.ok(receiptRev.get().rev > rev);
    net.emit('welcome', { t: 'welcome' });
    await settle();
    assert.deepEqual(net.sent.filter((m) => m.t === 'room.trophies').at(-1), { t: 'room.trophies', rc: [rc] });
    assert.equal(takeReceipt('nonsense'), false);
    off();
  });
});

test('room.elo carries the room\'s key only and this identity\'s receipts of it', async () => {
  await withStorage(async () => {
    idStore.set({ token: me.token, sub: me.sub });
    const rc = receipt();
    const records = [{ ...record(), rc }, record({ version: V2 }), record({ difficulty: 'HARD' })];
    const app = createStore({ room: { code: 'ABCD', mode: 'coop', difficulty: 'ABYSS', version: V3, experimental: { elo: true }, inMatch: false } });
    const net = fakeNet();
    const target = createStore({ eloSync: 'idle', eloRev: 0 });
    const sync = installEloSync({ net, timers, target, app, records: () => records });
    net.emit('welcome', {});
    await settle();
    const msg = net.sent.find((m) => m.t === 'room.elo');
    assert.deepEqual(msg, { t: 'room.elo', rec: { [eloKey('coop', 'ABYSS', V3)]: [[0, 12]] }, rc: [rc] });
    sync.dispose();
    void eloStore;
  });
});
