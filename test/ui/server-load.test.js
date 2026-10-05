import test from 'node:test';
import assert from 'node:assert/strict';
import { PingPill } from '../../public/js/ui/components.js';
import { initialState } from '../../public/js/store.js';

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
