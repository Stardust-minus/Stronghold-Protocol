import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectionStatus, PingPill } from '../../public/js/ui/components.js';
import { experimentalOptions, ExperimentalOptions } from '../../public/js/ui/experimental.js';
import { loadSummary, scopedClusterLoad, ServerStatusModal } from '../../public/js/ui/serverStatus.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const details = { windowMs: 10000, ageMs: 1000, cpuPercent: 320, rssMiB: 1024, heapMiB: 128, eluPercent: 60, p95Ms: 22, p99Ms: 24 };
const node = (slot, loadState = 'normal') => ({ label: `game-${String(slot).padStart(2, '0')}`, status: 'ready', loadState, loadDetails: details });
function collect(view, predicate) {
  if (Array.isArray(view)) return view.flatMap(child => collect(child, predicate));
  if (!view || typeof view !== 'object') return [];
  return [...(predicate(view) ? [view] : []), ...collect(view.props?.children, predicate)];
}

test('connection statuses share a compact, textual state component', () => {
  for (const status of ['idle', 'connecting', 'connected', 'handshaking', 'online', 'reconnecting', 'closed']) {
    const view = ConnectionStatus({ status });
    assert.equal(view.props.role, 'status');
    assert.match(view.props.class, /connection-status--(on|waiting|off)/);
  }
});

test('lobby lists all sixteen rows but battle rejects a cluster-scoped sample', () => {
  const cluster = { scope: 'cluster', nodes: Array.from({ length: 16 }, (_, i) => node(i + 1)) };
  assert.equal(loadSummary(cluster).caption, '集群 16/16');
  const lobby = ServerStatusModal({ open: true, clusterLoad: cluster });
  assert.equal(lobby.props.title, '对战集群');
  assert.equal(collect(lobby, view => view.type === 'tr').length, 17);
  assert.equal(scopedClusterLoad(cluster, 'game'), null);
  const battle = ServerStatusModal({ open: true, clusterLoad: cluster, scope: 'game', details });
  assert.equal(collect(battle, view => view.type === 'tr').length, 0);
  assert.doesNotMatch(JSON.stringify(battle), /320/);
});

test('battle status names only its owner and ignores injected internal metadata', () => {
  const game = { scope: 'game', nodes: [{ ...node(13), pid: 222, host: 'secret-host', url: 'http://private-node', generation: 'private-epoch' }] };
  assert.equal(loadSummary(game).caption, '对战 13');
  const view = ServerStatusModal({ open: true, clusterLoad: game, scope: 'game' });
  assert.equal(view.props.title, '对战 13');
  assert.doesNotMatch(JSON.stringify(view), /secret-host|private-node|private-epoch/);
  const pill = PingPill({ ms: 20, status: 'online', loadState: 'normal', clusterLoad: game, scope: 'game' });
  assert.match(JSON.stringify(pill), /对战 13/);
});

test('partial or unavailable cluster metrics never claim normal', () => {
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), { ...node(2), status: 'unavailable' }] }).state, 'unknown');
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), { ...node(2), loadDetails: null }] }).state, 'unknown');
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), node(2, 'overloaded')] }).state, 'overloaded');
});

test('experimental switches default off and send immutable full options only when editable', () => {
  assert.deepEqual(experimentalOptions({ revivalEnabled: 1, disableSharedPool: 'true' }), { revivalEnabled: false, disableSharedPool: false });
  const value = { revivalEnabled: false, disableSharedPool: false }, changes = [];
  const view = ExperimentalOptions({ open: true, value, editable: true, onChange: next => changes.push(next) });
  const switches = collect(view, v => v.props?.role === 'switch');
  switches[0].props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(changes, [{ revivalEnabled: true, disableSharedPool: false }]);
  assert.deepEqual(value, { revivalEnabled: false, disableSharedPool: false });
  for (const props of [{ editable: false }, { editable: true, busy: true }]) {
    const locked = ExperimentalOptions({ open: true, value, onChange: next => changes.push(next), ...props });
    for (const control of collect(locked, v => v.props?.role === 'switch')) {
      assert.equal(control.props.disabled, true);
      control.props.onChange({ currentTarget: { checked: true } });
    }
  }
  assert.equal(changes.length, 1);
});

test('experimental options are room-only and lobby creation uses server defaults', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  assert.doesNotMatch(lobby, /ExperimentalOptions|experimentalSummary|setExperimental|setOverlay\('experimental'\)/);
  assert.match(lobby, /net\.request\('room\.create', \{ mode: roomMode, difficulty \}\)/);
  const room = source('../../public/js/screens/room.js');
  assert.match(room, /editable=\$\{facts\.isHost && online\}/);
  assert.match(room, /net\.request\('room\.setExperimental', \{ experimental \}\)/);
});

test('room options stay with difficulty controls rather than crowding ready actions', () => {
  const room = source('../../public/js/screens/room.js');
  const settings = room.slice(room.indexOf('<div class="room-bar__left">'), room.indexOf('<div class="room-bar__center">'));
  const actions = room.slice(room.indexOf('<div class="room-bar__right">'));
  assert.match(settings, /class="room-experimental"/);
  assert.match(settings, /size="sm"/);
  assert.doesNotMatch(actions, /setExperimentalOpen|实验性选项/);
  assert.match(actions, /myReady \? '已就绪' : '准备就绪'/);
  const css = source('../../public/css/screens/room.css');
  assert.match(css, /grid-template-areas: "settings actions" "status status"/);
  assert.match(css, /grid-template-areas: "settings" "status" "actions"/);
});
