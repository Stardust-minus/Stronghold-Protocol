// test/match/version-host-local.test.js — server-run combat in an official version's match host (docs/design/match.md;
// server/match/host/entry.js options.combatWorkers): its fields run on the host's own combat Workers, a declared seat gets
// b.start { local } naming the version's content and b.sync digests a process of that version's data reproduces, g.sim
// { stream } brings the stream back (encoded frames over the host's channel); no pool without Workers configured, under
// client-run combat, or in a plugin host.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMatchHosts } from '../../server/match/host/index.js';
import { validHostMessage } from '../../server/match/host/ipc.js';
import { createVersionSets } from '../../server/versions.js';
import { computeVanillaContent } from '../../server/plugins/identity.js';
import { DATA_DIR, ROOT, getData } from '../../server/data.js';
import { DATA_SHIM_JS } from '../../server/http/static.js';
import { VERSIONS } from '../../shared/versions.js';

const HELPER = fileURLToPath(new URL('../helpers/versionReplicaDigest.mjs', import.meta.url));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const vanilla = computeVanillaContent({ simDir: path.join(ROOT, 'server', 'sim'), sharedDir: path.join(ROOT, 'shared'), dataDir: DATA_DIR, shim: DATA_SHIM_JS });
const versions = createVersionSets({ enabled: VERSIONS.map((v) => v.id), vanilla, defaultData: getData({ log: quiet }), log: quiet });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-version-local-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SERVER_RUN = { clientCombat: false, botRehearsal: 0, timerScale: 0.02, combatSpeed: 4 };
const seats = () => [{ seat: 0, playerId: 'h1', name: 'H', isBot: false, connected: true },
  ...[1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI ${i}`, isBot: true, connected: true }))];

function start(hosts, id, sent, onEnd = () => {}) {
  const cs = versions.csOf(id);
  const m = hosts.create(cs, { roomCode: 'VLOC', mode: 'coop', difficulty: 'HARD', modeId: 'mode_multi_hard', seats: seats(), spectators: [], seed: 21, matchNo: 1,
    cs, requireCs: true, version: id,
    send: (pid, msg) => { sent.push([pid, msg]); return true; }, broadcast: () => {}, onEnd });
  m.start();
  return { m, cs };
}
/** The human's seat declares (or not) and leaves its play to the AI (it has units and walks through every phase). */
async function play(m, sim = true) {
  if (sim) assert.ok((await m.handle('h1', { t: 'g.sim', local: true })).ok, 'g.sim');
  assert.ok((await m.handle('h1', { t: 'g.infoReady' })).ok, 'g.infoReady');
  assert.ok((await m.handle('h1', { t: 'g.autoplay', on: true })).ok, 'g.autoplay');
}
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => { setTimeout(r, 15); });
  }
};
const framesOf = (sent, t, pred = () => true) => sent.filter(([pid, f]) => pid === 'h1' && f.t === t && pred(f)).map(([, f]) => f);

test('a version\'s fields run on its host\'s Workers: b.start { local } on its content, digests a process of its data reproduces, g.sim stream', { timeout: 120_000 }, async () => {
  const id = 'act1autochess';
  const hosts = createMatchHosts({ contents: versions, log: quiet, options: { kind: 'version', combatWorkers: 1, matchOptions: SERVER_RUN } });
  const sent = [];
  try {
    const { m, cs } = start(hosts, id, sent);
    await play(m);
    const first = await until(() => framesOf(sent, 'b.start', (f) => f.local)[0], 60_000, 'own b.start');
    assert.equal(first.authoritative, false);
    assert.equal(first.spec.cs, cs, 'a replica must load the version\'s content');
    assert.equal(first.spec.version, id);
    assert.deepEqual(hosts.stats().combat, { ready: 1, size: 1, sessions: hosts.stats().combat.sessions });
    assert.equal(framesOf(sent, 'b.snap', (f) => f.fieldId === first.fieldId).length, 0, 'no stream of a field run locally');

    // the digest check on a field of its version's units, a teammate's watched the same way
    const mate = `n:ai_1`;
    assert.ok((await m.handle('h1', { t: 'g.watch', fieldId: mate })).ok, 'g.watch');
    const watched = await until(() => framesOf(sent, 'b.start', (f) => f.local && f.fieldId === mate)[0], 30_000, 'watched b.start');
    const syncs = await until(() => { const s = framesOf(sent, 'b.sync', (f) => f.battleId === watched.battleId); return s.length >= 3 ? s : null; }, 30_000, 'b.sync digests');
    const input = path.join(tmp, 'digests.json');
    fs.writeFileSync(input, JSON.stringify({ spec: watched.spec, syncs }));
    const run = spawnSync(process.execPath, [HELPER, id, input], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.ok(out.units > 0, 'the field has units');
    assert.ok(out.compared >= 3, run.stdout);
    assert.equal(out.differed, 0, run.stdout);

    // the stream comes back: encoded frames cross the host's channel as plain ones
    assert.ok((await m.handle('h1', { t: 'g.sim', battleId: watched.battleId, stream: true })).ok, 'g.sim stream');
    await until(() => framesOf(sent, 'b.end', (f) => f.reason === 'stream' && f.battleId === watched.battleId)[0], 10_000, 'b.end stream');
    await until(() => framesOf(sent, 'b.snap', (f) => f.fieldId === mate)[0], 10_000, 'b.snap of the stream');
    const d = await m.diag();
    assert.equal(d.errorCount, 0, JSON.stringify(d.errors));
    assert.equal(d.version, id);
    m.dispose();
  } finally { hosts.close(); }
});

test('no pool: combatWorkers 0 streams inline; client-run combat and a plugin host never start one', { timeout: 60_000 }, async () => {
  const id = 'act2autochess@V2_1';
  const cases = [
    [{ kind: 'version', combatWorkers: 0, matchOptions: SERVER_RUN }, 'b.snap'],
    [{ kind: 'version', combatWorkers: 1, matchOptions: { ...SERVER_RUN, clientCombat: true } }, 'b.start'],
    [{ combatWorkers: 1, matchOptions: SERVER_RUN }, 'b.snap'],
  ];
  for (const [options, frame] of cases) {
    const hosts = createMatchHosts({ contents: versions, log: quiet, options });
    const sent = [];
    try {
      const { m } = start(hosts, id, sent);
      await play(m);
      await until(() => framesOf(sent, frame)[0], 40_000, `${frame} ${JSON.stringify(options)}`);
      assert.equal(framesOf(sent, 'b.start', (f) => f.local).length, 0);
      assert.equal(hosts.stats().combat, undefined);
      m.dispose();
    } finally { hosts.close(); }
  }
});

test('a version host that dies takes its Workers along: the match ends \'version-crash\'', { timeout: 60_000 }, async () => {
  const hosts = createMatchHosts({ contents: versions, log: quiet, options: { kind: 'version', combatWorkers: 1, matchOptions: SERVER_RUN } });
  const sent = [], ended = [];
  try {
    const { cs, m } = start(hosts, 'act1autochess@V1_1', sent, (s) => ended.push(s));
    await play(m);
    await until(() => framesOf(sent, 'b.start', (f) => f.local)[0], 30_000, 'b.start');
    const { child } = hosts._host(cs);
    child.kill('SIGKILL');
    await until(() => ended[0], 10_000, 'the end');
    assert.equal(ended[0].reason, 'version-crash');
    assert.equal(hosts.stats().workers, 0);
    assert.equal(hosts.stats().combat, undefined);
  } finally { hosts.close(); }
});

test('the host\'s combat report is checked like any host message', () => {
  assert.equal(validHostMessage({ type: 'combat', ready: 2, size: 2, sessions: 5 }), true);
  assert.equal(validHostMessage({ type: 'combat', ready: 2, size: 2 }), false);
  assert.equal(validHostMessage({ type: 'combat', ready: -1, size: 2, sessions: 0 }), false);
  assert.equal(validHostMessage({ type: 'combat', ready: 2, size: 2, sessions: 0, extra: 1 }), false);
});
