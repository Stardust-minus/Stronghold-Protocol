import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectionStatus, PingPill } from '../../public/js/ui/components.js';
import { experimentalOptions, experimentalSummary, ExperimentalOptions } from '../../public/js/ui/experimental.js';
import { setLang, setMessages } from '../../shared/i18n.js';
import { loadSummary, scopedClusterLoad, ServerStatusModal } from '../../public/js/ui/serverStatus.js';
import { gameDisplayName } from '../../public/js/serviceTelemetry.js';

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
  assert.equal(loadSummary(game).caption, '叙拉古');
  const view = ServerStatusModal({ open: true, clusterLoad: game, scope: 'game' });
  assert.equal(view.props.title, '叙拉古');
  assert.doesNotMatch(JSON.stringify(view), /secret-host|private-node|private-epoch/);
  const pill = PingPill({ ms: 20, status: 'online', loadState: 'normal', clusterLoad: game, scope: 'game' });
  assert.match(JSON.stringify(pill), /叙拉古/);
});

test('site names cover the exact sixteen slots in order without changing wire labels or adding a notice', () => {
  const names = ['罗德岛', '企鹅物流', '莱茵生命', '黑钢国际', '喀兰贸易', '龙门', '卡西米尔', '乌萨斯',
    '炎', '拉特兰', '萨尔贡', '哥伦比亚', '叙拉古', '萨米', '伊比利亚', '卡兹戴尔'];
  const cluster = { scope: 'cluster', nodes: names.map((_, index) => node(index + 1)) };
  const before = JSON.stringify(cluster);
  const view = ServerStatusModal({ open: true, clusterLoad: cluster });
  const rows = collect(view, v => v.type === 'tr').slice(1);
  assert.deepEqual(rows.map(row => collect(row, v => v.props?.scope === 'row')[0].props.children), names);
  for (let slot = 1; slot <= 16; slot++) {
    const label = node(slot).label, game = { scope: 'game', nodes: [node(slot)] };
    assert.equal(gameDisplayName(label), names[slot - 1]);
    assert.equal(loadSummary(game).caption, names[slot - 1]);
    assert.equal(ServerStatusModal({ open: true, clusterLoad: game, scope: 'game' }).props.title, names[slot - 1]);
    assert.equal(scopedClusterLoad(game, 'game').nodes[0].label, label);
  }
  assert.equal(JSON.stringify(cluster), before);
  assert.equal(new Set(names).size, 16);
  assert.equal(gameDisplayName('game-17'), '对战 17');
  assert.equal(gameDisplayName('game-256'), '对战 256');
  for (const label of [null, undefined, 1, 'game-001', 'game-00', 'game-257', 'game-01\n', 'private-node', '罗德岛']) assert.equal(gameDisplayName(label), null);
  const notices = JSON.parse(source('../../data/announcements.json'));
  assert.equal(notices.length, 2);
  assert.equal(notices[0].title, '0.2.1 更新：干员时装与实验性多人');
  assert.doesNotMatch(notices.flatMap(notice => notice.paragraphs).join('\n'), /节点更名|服务器更名|罗德岛|企鹅物流/);
});

for (const lang of ['en', 'ja', 'ko', 'zh-TW']) test(`all sixteen display names follow the ${lang} catalog`, t => {
  const catalog = JSON.parse(source(`../../public/i18n/${lang}.json`));
  const names = Array.from({ length: 16 }, (_, index) => gameDisplayName(node(index + 1).label));
  setMessages(lang, catalog); setLang(lang); t.after(() => setLang('zh'));
  for (let index = 0; index < names.length; index++) {
    assert.equal(typeof catalog[names[index]], 'string');
    assert.equal(gameDisplayName(node(index + 1).label), catalog[names[index]]);
  }
});

test('partial or unavailable cluster metrics never claim normal', () => {
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), { ...node(2), status: 'unavailable' }] }).state, 'unknown');
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), { ...node(2), loadDetails: null }] }).state, 'unknown');
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), node(2, 'overloaded')] }).state, 'overloaded');
});

test('fork status and experimental summaries follow a language switch with unchanged rule values', (t) => {
  const english = JSON.parse(source('../../public/i18n/en.json'));
  setMessages('en', english);
  setLang('en');
  t.after(() => setLang('zh'));
  assert.match(JSON.stringify(ConnectionStatus({ status: 'online' })), /Connected/);
  assert.equal(loadSummary({ scope: 'game', nodes: [node(13)] }).caption, 'Siracusa');
  assert.equal(loadSummary({ scope: 'cluster', nodes: [node(1), node(2)] }).caption, 'Cluster 2\/2');
  const options = { revivalEnabled: false, disableSharedPool: false };
  assert.equal(experimentalSummary(options), 'Rescue Off · Shared pool On');
  assert.deepEqual(options, { revivalEnabled: false, disableSharedPool: false });
  assert.equal(ServerStatusModal({ open: true, clusterLoad: { scope: 'game', nodes: [node(13)] }, scope: 'game' }).props.title, 'Siracusa');
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
  assert.match(room, /mode=\$\{room\.mode\}/);
  assert.match(room, /net\.request\('room\.setExperimental', \{ experimental \}\)/);
});

test('room options stay with difficulty controls rather than crowding ready actions', () => {
  const room = source('../../public/js/screens/room.js');
  const settings = room.slice(room.indexOf('<div class="room-bar__left">'), room.indexOf('<div class="room-bar__center">'));
  const actions = room.slice(room.indexOf('<div class="room-bar__right">'));
  assert.match(settings, /class="room-experimental"/);
  assert.match(settings, /size="sm"/);
  assert.doesNotMatch(actions, /setExperimentalOpen|实验性选项/);
  assert.match(actions, /myReady \? t\('已就绪'\) : t\('准备就绪'\)/);
  const css = source('../../public/css/screens/room.css');
  assert.match(css, /grid-template-areas: "settings actions" "status status"/);
  assert.match(css, /grid-template-areas: "settings" "status" "actions"/);
});
