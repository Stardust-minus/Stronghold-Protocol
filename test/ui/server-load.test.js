import test from 'node:test';
import assert from 'node:assert/strict';
import { PingPill } from '../../public/js/ui/components.js';
import { initialState } from '../../public/js/store.js';
import { processUsageRows, ServerStatusModal } from '../../public/js/ui/serverStatus.js';

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const hit = find(child, predicate); if (hit) return hit;
  }
  return null;
}

test('latency callers without load retain the original compact pill', () => {
  const view = PingPill({ ms: 20, online: true });
  assert.equal(view.type, 'span'); assert.match(view.props.class, /ping--low/);
  assert.equal(find(view, n => n.props?.role === 'status'), null);
});

test('an online connection awaiting a fresh RTT is not labelled disconnected', () => {
  const view = PingPill({ ms: null, online: true });
  assert.match(view.props.title, /等待新测量/);
  assert.doesNotMatch(view.props.title, /未连接/);
  assert.equal(find(view, n => n.props?.name === 'signal').props.name, 'signal');
  assert.match(PingPill({ ms: null, online: false }).props.title, /未连接/);
  assert.match(PingPill({ ms: 3000 }).props.title, /WebSocket 往返响应 3000ms/);
});

test('the service control is a dialog button and process metrics never expose arbitrary health fields', () => {
  const details = { windowMs: 10000, ageMs: 1000, cpuPercent: 320, rssMiB: 1024, heapMiB: 128, eluPercent: 60, p95Ms: 22, p99Ms: 24, pid: 123, host: 'private-host' };
  const rows = processUsageRows(details);
  assert.equal(rows[0].value, '320'); assert.equal(rows[1].value, '1024');
  assert.equal(processUsageRows(null)[0].value, '--');
  assert.equal(JSON.stringify(rows).includes('private-host'), false);
  const view = PingPill({ ms: 20, loadState: 'normal', loadDetails: details, loadOpen: true, onLoadClick() {} });
  const button = find(view, n => n.type === 'button');
  assert.equal(button.props['aria-haspopup'], 'dialog'); assert.equal(button.props['aria-expanded'], 'true');
  assert.equal(ServerStatusModal({ open: true, state: 'normal', details }).props.ariaLabel, '游戏服务开销');
});

test('load is textual as well as coloured, offline and invalid values are unknown', () => {
  const labels = { normal: '正常', busy: '繁忙', overloaded: '拥堵', unknown: '未知' };
  for (const [loadState, label] of Object.entries(labels)) {
    const view = PingPill({ ms: 20, online: true, loadState });
    const status = find(view, n => n.props?.role === 'status');
    assert.equal(status.props['aria-label'], '服务器负载' + label);
    assert.match(status.props.class, new RegExp('server-load--' + loadState));
    assert.match(status.props.title, /主线程响应压力/);
  }
  for (const loadState of ['normal', {}, ['normal'], '__proto__', null]) {
    const view = PingPill({ ms: 20, online: loadState !== 'normal', loadState });
    assert.equal(find(view, n => n.props?.role === 'status').props['aria-label'], '服务器负载未知');
  }
  assert.equal(initialState.connection.loadState, 'unknown');
});
