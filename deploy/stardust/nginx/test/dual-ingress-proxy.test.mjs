// WS-only copy preparation and opt-in real local OpenResty routing. Echo relays are not game/Worker fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { prepareDualIngressProxy } from '../../tools/prepare-dual-ingress-proxy.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const sources = { formal: readFileSync(path.join(directory, 'ark-proto.conf'), 'utf8'), beta: readFileSync(path.join(directory, 'ark-proto-beta.conf'), 'utf8') };
for (const [profile, source] of Object.entries(sources)) test(profile + ' preparation changes only reviewed WS upstreams, preserving HTTP/auth/private/material directives byte-for-byte', () => {
  const r = prepareDualIngressProxy(source, { profile });
  assert.equal(r.manifest.activated, false); assert.equal(r.manifest.ingressInstances, 2);
  assert.equal(r.manifest.existingSocketsMigrated, false); assert.equal(r.manifest.deploymentPortsMatchProfile, true);
  assert.deepEqual(r.manifest.endpoints, profile === 'formal' ? ['172.30.246.2:3000', '172.30.246.3:3000'] : ['127.0.0.1:35301', '127.0.0.1:35302']);
  assert.deepEqual(r.manifest.publishedPorts, profile === 'formal' ? [35401, 35402] : [35301, 35302]);
  assert.equal(r.manifest.upstreamTransport, profile === 'formal' ? 'container-direct' : 'loopback');
  // lanes (docs/DEPLOY.md「多连接」): one group's connections hash to one ingress
  const head = r.vhost.slice(0, r.vhost.indexOf('\n\n'));
  assert.match(head, /map \$http_sec_websocket_protocol \$\w+_route \{\n    "~sp\\\.lanes1\\\.\(\[A-Za-z0-9_-\]\{22\}\)\\\." \$1;\n    default \$request_id;\n\}/);
  assert.ok(head.includes(`hash $${r.manifest.upstream}_route;`)); assert.doesNotMatch(head, /keepalive|ip_hash|least_conn/);
  let restored = r.vhost.slice(r.vhost.indexOf('\n\n') + 2);
  const previous = r.manifest.webSocketLocations[0].previousUpstream;
  assert.ok(r.manifest.webSocketLocations.every(x => x.previousUpstream === previous));
  restored = restored.replaceAll(`proxy_pass http://${r.manifest.upstream};\n        proxy_next_upstream error timeout;\n        proxy_next_upstream_tries 2;`, `proxy_pass http://${previous};`);
  assert.equal(restored, source, 'no unrelated location, gate, Origin, headers, timeout, provider or HTTP backend changed');
  assert.equal(r.manifest.webSocketLocations.length, profile === 'formal' ? 2 : 1);
});

test('re-preparation also replaces the earlier least_conn block (before lanes) with the lanes hash', () => {
  const fresh = prepareDualIngressProxy(sources.formal, {});
  const head = fresh.vhost.slice(0, fresh.vhost.indexOf('\n\n') + 2);
  const servers = head.split('\n').filter(line => line.startsWith('    server ')).join('\n');
  const legacy = `# New handshakes only; established WebSockets stay on their original ingress.\nupstream ${fresh.manifest.upstream} {\n    least_conn;\n${servers}\n}\n\n`;
  assert.equal(prepareDualIngressProxy(legacy + fresh.vhost.slice(head.length), { replacePrepared: true }).vhost, fresh.vhost);
  assert.equal(prepareDualIngressProxy(fresh.vhost, { replacePrepared: true }).vhost, fresh.vhost);
});

test('Formal explicit profile ports retain direct bypass; custom ports remain unapproved loopback fixtures', () => {
  const formal = prepareDualIngressProxy(sources.formal, { ports: [35401, 35402] });
  assert.deepEqual(formal.manifest.endpoints, ['172.30.246.2:3000', '172.30.246.3:3000']);
  assert.equal(formal.manifest.deploymentPortsMatchProfile, true);
  assert.doesNotMatch(formal.vhost.slice(0, formal.vhost.indexOf('\n\n')), /127\.0\.0\.1:3540/);
  const fixture = prepareDualIngressProxy(sources.formal, { ports: [42001, 42002] });
  assert.deepEqual(fixture.manifest.endpoints, ['127.0.0.1:42001', '127.0.0.1:42002']);
  assert.equal(fixture.manifest.deploymentPortsMatchProfile, false);
  assert.equal(fixture.manifest.upstreamTransport, 'loopback');
});

test('Formal eight-instance preparation preserves all non-WS bytes and exact profile ports', () => {
  const source = sources.formal, r = prepareDualIngressProxy(source, { ingressInstances: 8 });
  assert.equal(r.manifest.activated, false); assert.equal(r.manifest.ingressInstances, 8);
  assert.deepEqual(r.manifest.endpoints, Array.from({ length: 8 }, (_, i) => `172.30.246.${i + 2}:3000`));
  assert.deepEqual(r.manifest.publishedPorts, Array.from({ length: 8 }, (_, i) => 35401 + i));
  assert.deepEqual(r.manifest.services, ['ingress', 'ingress-02', 'ingress-03', 'ingress-04', 'ingress-05', 'ingress-06', 'ingress-07', 'ingress-08']);
  assert.equal(r.manifest.upstreamTransport, 'container-direct'); assert.equal(r.manifest.existingSocketsMigrated, false);
  let restored = r.vhost.slice(r.vhost.indexOf('\n\n') + 2);
  for (const location of r.manifest.webSocketLocations) {
    restored = restored.replace(`proxy_pass http://${r.manifest.upstream};\n        proxy_next_upstream error timeout;\n        proxy_next_upstream_tries 2;`, `proxy_pass http://${location.previousUpstream};`);
  }
  assert.equal(restored, source);
  for (const ingressInstances of [0, 1, 9, true, '8', 2.5]) assert.throws(() => prepareDualIngressProxy(source, { ingressInstances }));
  assert.throws(() => prepareDualIngressProxy(sources.beta, { profile: 'beta', ingressInstances: 8 }));
  assert.throws(() => prepareDualIngressProxy(source, { ingressInstances: 8, ports: [35401, 35402] }));
});

test('quoted/commented braces and non-BMP comments retain source offsets', () => {
  const source = '# 🔒 { location = /ws { proxy_pass http://ignored; } }\n' + sources.formal.replace('proxy_buffering off;', 'set $test_note "brace } # not a directive";\n        proxy_buffering off;');
  const r = prepareDualIngressProxy(source);
  assert.equal(r.manifest.webSocketLocations.length, 2);
  assert.ok(r.vhost.includes('# 🔒 { location = /ws { proxy_pass http://ignored; } }'));
  assert.ok(r.vhost.includes('set $test_note "brace } # not a directive";'));
});

test('ambiguous, ungated, duplicate, unexpected and already-prepared inputs are refused', () => {
  const source = sources.formal;
  for (const input of ['', source.replace('auth_request /_gate/check;', 'auth_request off;'),
    source.replaceAll("if ($http_origin != 'https://ark-proto.stardust.matce.cn') { return 403; }", ''),
    source.replace('proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;', 'auth_request off;\n        proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;'),
    source + '\nlocation = /ws { proxy_pass http://wrong; }',
    source.replace('/_release/v012-alliance-20261004/ws {', '/_release/unreviewed/ws {'),
    source.replace('proxy_buffering off;', 'proxy_next_upstream off;\n        proxy_buffering off;'),
    source.replace('proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;', 'proxy_pass http://127.0.0.1:35401;\n        proxy_buffering off;'),
    prepareDualIngressProxy(source).vhost]) assert.throws(() => prepareDualIngressProxy(input));
  for (const ports of [[1, 2], [35401], [35401, 35401], [35401, '35402'], [35401, 35402, 35403], [35401, 65536]]) assert.throws(() => prepareDualIngressProxy(source, { ports }));
  assert.throws(() => prepareDualIngressProxy(source, { profile: 'unknown' }));
});

// WG-era Formal backends as installed (the repository template still names the old monolith port).
const wgFormal = sources.formal.replace('upstream ark_proto_game_backend {\n    server 127.0.0.1:3120;',
  'upstream ark_proto_ingress_backend {\n    server 172.30.246.2:3000;\n    keepalive 32;\n    keepalive_timeout 4s;\n}\n'
  + 'upstream ark_proto_game_backend {\n    server 10.253.79.2:35400;');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
// Same bytes as cluster-local-stack.py's stack-summary.json (Python sort_keys/indent=2), with fixture identities.
function stackSummary(gameNodes, count, edit = value => value) {
  const base = gameNodes <= 16 ? 30 : 50;
  return JSON.stringify(sorted(edit({ version: 1, profile: 'formal', prepared: true, activated: false, project: 'ark-cluster-formal-local',
    coreBundle: '/opt/ark-cluster-formal/bundles/core-fixture', coreComposeSha256: 'd'.repeat(64), composeSha256: 'c'.repeat(64),
    imageId: 'sha256:' + 'b'.repeat(64), build: 'a'.repeat(40), sourceKind: 'tree', manifestSha256: 'a'.repeat(64), gameNodes,
    ingress: Array.from({ length: count }, (_, i) => ({ service: i ? `ingress-${String(i + 1).padStart(2, '0')}` : 'ingress',
      container_ip: `172.30.245.${base + i + 1}`, host_port: gameNodes <= 16 ? 35401 + i : 35451 + i })),
    coordinatorPort: 35400, hostManagerLeases: false })), null, 2) + '\n';
}
const local = (summary, options = {}) => prepareDualIngressProxy(wgFormal, { topology: 'local', stackSummary: summary, ...options });
const range = (first, count, format = x => x) => Array.from({ length: count }, (_, i) => format(first + i));
// Undo exactly the generated WS block/triples and the recorded backend addresses.
function restore(r) {
  let text = r.vhost.slice(r.vhost.indexOf('\n\n') + 2);
  for (const location of r.manifest.webSocketLocations) {
    text = text.replace(`proxy_pass http://${r.manifest.upstream};\n        proxy_next_upstream error timeout;\n        proxy_next_upstream_tries 2;`, `proxy_pass http://${location.previousUpstream};`);
  }
  for (const row of r.manifest.backendRetargets) {
    text = text.replace(`upstream ${row.upstream} {\n    server ${row.target}`, `upstream ${row.upstream} {\n    server ${row.previous}`);
  }
  return text;
}

test('stack summary fixture matches the Python generator bytes', () => {
  assert.equal(stackSummary(16, 2), `{
  "activated": false,
  "build": "${'a'.repeat(40)}",
  "composeSha256": "${'c'.repeat(64)}",
  "coordinatorPort": 35400,
  "coreBundle": "/opt/ark-cluster-formal/bundles/core-fixture",
  "coreComposeSha256": "${'d'.repeat(64)}",
  "gameNodes": 16,
  "hostManagerLeases": false,
  "imageId": "sha256:${'b'.repeat(64)}",
  "ingress": [
    {
      "container_ip": "172.30.245.31",
      "host_port": 35401,
      "service": "ingress"
    },
    {
      "container_ip": "172.30.245.32",
      "host_port": 35402,
      "service": "ingress-02"
    }
  ],
  "manifestSha256": "${'a'.repeat(64)}",
  "prepared": true,
  "profile": "formal",
  "project": "ark-cluster-formal-local",
  "sourceKind": "tree",
  "version": 1
}
`);
});

test('Formal local topology takes eight sixteen-node stack ingress at .31-.38 and retargets the known WG backends', () => {
  const r = local(stackSummary(16, 8));
  assert.equal(r.manifest.topology, 'local'); assert.equal(r.manifest.ingressInstances, 8);
  assert.deepEqual(r.manifest.endpoints, range(31, 8, i => `172.30.245.${i}:3000`));
  assert.deepEqual(r.manifest.publishedPorts, range(35401, 8));
  assert.deepEqual(r.manifest.services, ['ingress', ...range(2, 7, i => `ingress-0${i}`)]);
  assert.equal(r.manifest.upstreamTransport, 'container-direct'); assert.equal(r.manifest.deploymentPortsMatchProfile, true);
  assert.equal(r.manifest.stackSummary.gameNodes, 16); assert.equal(r.manifest.stackSummary.sha256.length, 64);
  assert.deepEqual(r.manifest.backendRetargets, [
    { upstream: 'ark_proto_game_backend', previous: '10.253.79.2:35400', target: '172.30.245.2:3000', changed: true },
    { upstream: 'ark_proto_ingress_backend', previous: '172.30.246.2:3000', target: '172.30.245.31:3000', changed: true }]);
  assert.equal(r.manifest.existingHttpAuthPrivateAndMaterialPathsUnchanged, false);
  assert.equal(r.manifest.tlsListen, null); assert.equal(r.manifest.replacedPreparedUpstream, null);
  assert.ok(r.vhost.includes('upstream ark_proto_game_backend {\n    server 172.30.245.2:3000;\n    keepalive 32;\n'));
  assert.ok(r.vhost.includes('upstream ark_proto_ingress_backend {\n    server 172.30.245.31:3000;\n    keepalive 32;\n    keepalive_timeout 4s;\n}'));
  assert.doesNotMatch(r.vhost, /10\.253\.79\.|172\.30\.246\./);
  assert.match(r.vhost, /\n    listen 443 ssl;\n    listen \[::\]:443 ssl;\n/);
  assert.equal(restore(r), wgFormal, 'only the WS block/triples and the two backend addresses changed');
});

test('Formal local topology accepts sixteen thirty-two-node ingress at .51-.66 and the eight-instance layout', () => {
  const r = local(stackSummary(32, 16));
  assert.equal(r.manifest.ingressInstances, 16);
  assert.deepEqual(r.manifest.endpoints, range(51, 16, i => `172.30.245.${i}:3000`));
  assert.deepEqual(r.manifest.publishedPorts, range(35451, 16));
  assert.equal(r.manifest.services[15], 'ingress-16');
  assert.equal(r.manifest.backendRetargets[1].target, '172.30.245.51:3000');
  assert.equal(r.vhost.slice(0, r.vhost.indexOf('\n\n')).match(/^    server /gm).length, 16);
  assert.equal(restore(r), wgFormal);
  const eight = local(stackSummary(32, 8), { ingressInstances: 8 });
  assert.deepEqual(eight.manifest.endpoints, range(51, 8, i => `172.30.245.${i}:3000`));
  assert.deepEqual(eight.manifest.publishedPorts, range(35451, 8));
  assert.throws(() => local(stackSummary(32, 8), { ingressInstances: 2 }));
  // WG keeps its own maximum.
  assert.throws(() => prepareDualIngressProxy(wgFormal, { ingressInstances: 16 }));
  assert.throws(() => prepareDualIngressProxy(wgFormal, { ingressInstances: 9 }));
});

test('local topology is Formal-only and the stack summary must be the exact fixed layout', () => {
  assert.throws(() => prepareDualIngressProxy(sources.beta, { profile: 'beta', topology: 'local', stackSummary: stackSummary(16, 2) }), /Formal-only/);
  assert.throws(() => prepareDualIngressProxy(wgFormal, { topology: 'local' }));
  assert.throws(() => prepareDualIngressProxy(wgFormal, { stackSummary: stackSummary(16, 2) }));
  assert.throws(() => prepareDualIngressProxy(wgFormal, { topology: 'direct' }));
  assert.throws(() => local(stackSummary(16, 2), { ports: [35401, 35402] }));
  const edits = [
    value => ({ ...value, ingress: value.ingress.map((row, i) => i ? { ...row, container_ip: '172.30.245.52' } : row) }),
    value => ({ ...value, ingress: value.ingress.map((row, i) => i ? { ...row, host_port: 35452 } : row) }),
    value => ({ ...value, ingress: value.ingress.map((row, i) => i ? { ...row, container_ip: '172.30.246.3' } : row) }),
    value => ({ ...value, ingress: value.ingress.map((row, i) => i ? { ...row, service: 'ingress-03' } : row) }),
    value => ({ ...value, ingress: value.ingress.map((row, i) => i ? { ...row, extra: true } : row) }),
    value => ({ ...value, ingress: [...value.ingress].reverse() }),
    value => ({ ...value, gameNodes: 24 }), value => ({ ...value, gameNodes: '16' }), value => ({ ...value, profile: 'beta' }),
    value => ({ ...value, project: 'ark-cluster-formal-core' }), value => ({ ...value, activated: true }),
    value => ({ ...value, coordinatorPort: 35300 }), value => ({ ...value, hostManagerLeases: true }), value => ({ ...value, extra: 1 }),
  ];
  for (const edit of edits) assert.throws(() => local(stackSummary(16, 2, edit)));
  // A thirty-two-node summary may not claim the sixteen-node addresses/ports, nor the reverse.
  assert.throws(() => local(stackSummary(32, 2, value => ({ ...value, gameNodes: 16 }))));
  assert.throws(() => local(stackSummary(16, 2, value => ({ ...value, gameNodes: 32 }))));
  for (const [nodes, count] of [[16, 1], [16, 9], [32, 1], [32, 17]]) assert.throws(() => local(stackSummary(nodes, count)));
  const valid = stackSummary(16, 2);
  for (const text of [JSON.stringify(JSON.parse(valid)), valid.trimEnd(), valid.replace('"activated": false,', '"activated": true,\n  "activated": false,'), '', 'null', '[]']) {
    assert.throws(() => local(text));
  }
});

test('the online-cap directory from --online-limit-dir is accepted only as an absolute path and changes nothing else', () => {
  const capped = stackSummary(32, 16, value => ({ ...value, onlineLimitDir: '/opt/ark-cluster-formal/limits' }));
  assert.ok(capped.includes('  "onlineLimitDir": "/opt/ark-cluster-formal/limits",\n  "prepared": true,'), 'sorted where Python puts it');
  const plain = local(stackSummary(32, 16), { tlsListenBacklog: 4096 }), withCap = local(capped, { tlsListenBacklog: 4096 });
  assert.equal(withCap.vhost, plain.vhost);
  assert.notEqual(withCap.manifest.stackSummary.sha256, plain.manifest.stackSummary.sha256);
  for (const dir of ['limits', '', 5, null, ['/x']]) assert.throws(() => local(stackSummary(32, 16, value => ({ ...value, onlineLimitDir: dir }))), /Unexpected local stack summary/);
  assert.throws(() => local(stackSummary(32, 16, value => ({ ...value, onlineLimitDirs: '/x' }))), /Unexpected local stack summary/);
});

test('backend retargets compare-and-replace one known server and keep its parameters', () => {
  const summary = stackSummary(16, 2);
  const handEdited = wgFormal.replace('server 10.253.79.2:35400;', 'server 127.0.0.1:35400;').replace('server 172.30.246.2:3000;', 'server 172.30.245.31:3000;');
  assert.deepEqual(prepareDualIngressProxy(handEdited, { topology: 'local', stackSummary: summary }).manifest.backendRetargets, [
    { upstream: 'ark_proto_game_backend', previous: '127.0.0.1:35400', target: '172.30.245.2:3000', changed: true },
    { upstream: 'ark_proto_ingress_backend', previous: '172.30.245.31:3000', target: '172.30.245.31:3000', changed: false }]);
  const already = wgFormal.replace('server 10.253.79.2:35400;', 'server 172.30.245.2:3000;');
  const done = prepareDualIngressProxy(already, { topology: 'local', stackSummary: summary });
  assert.equal(done.manifest.backendRetargets[0].changed, false);
  const params = wgFormal.replace('server 10.253.79.2:35400;', 'server 10.253.79.2:35400 max_fails=0;');
  assert.ok(prepareDualIngressProxy(params, { topology: 'local', stackSummary: summary }).vhost.includes('server 172.30.245.2:3000 max_fails=0;\n    keepalive 32;'));
  const withoutIngressBackend = sources.formal.replace('server 127.0.0.1:3120;', 'server 10.253.79.2:35400;');
  assert.deepEqual(prepareDualIngressProxy(withoutIngressBackend, { topology: 'local', stackSummary: summary }).manifest.backendRetargets.map(row => row.upstream),
    ['ark_proto_game_backend']);
  for (const input of [
    sources.formal, // Unknown monolith port.
    wgFormal.replace('server 10.253.79.2:35400;', 'server 10.253.79.3:35400;'),
    wgFormal.replace('server 10.253.79.2:35400;', 'server 10.253.79.2:35400;\n    server 10.253.79.2:35400 backup;'),
    wgFormal.replace('server 172.30.246.2:3000;', 'server 172.30.246.3:3000;'),
    wgFormal.replace('server 172.30.246.2:3000;', 'server 172.30.245.51:3000;\n    server 172.30.246.2:3000;'),
    wgFormal + '\nupstream ark_proto_game_backend {\n    server 10.253.79.2:35400;\n}\n',
    wgFormal.replace('upstream ark_proto_game_backend {', 'upstream ark_proto_game_backend_old {'),
  ]) assert.throws(() => prepareDualIngressProxy(input, { topology: 'local', stackSummary: summary }));
  // WG preparation never touches HTTP backends.
  const wg = prepareDualIngressProxy(wgFormal);
  assert.deepEqual(wg.manifest.backendRetargets, []); assert.equal(wg.manifest.existingHttpAuthPrivateAndMaterialPathsUnchanged, true);
  assert.ok(wg.vhost.includes('server 10.253.79.2:35400;'));
});

test('TLS listen backlog rewrites exactly the two 443 listens, idempotently, and refuses conflicting options', () => {
  for (const options of [{}, { topology: 'local', stackSummary: stackSummary(32, 16) }]) {
    const r = prepareDualIngressProxy(wgFormal, { ...options, tlsListenBacklog: 4096 });
    assert.deepEqual(r.manifest.tlsListen, { backlog: 4096, reuseport: true, rewritten: ['443', '[::]:443'], unchanged: [] });
    assert.match(r.vhost, /\n    listen 443 ssl reuseport backlog=4096;\n    listen \[::\]:443 ssl reuseport backlog=4096;\n/);
    assert.match(r.vhost, /\n    listen 80;\n    listen \[::\]:80;\n/);
    assert.equal(r.vhost.match(/reuseport/g).length, 2);
    const plain = prepareDualIngressProxy(wgFormal, options);
    assert.equal(r.vhost.replaceAll(' reuseport backlog=4096;', ';'), plain.vhost);
  }
  const tuned = wgFormal.replace('listen 443 ssl;', 'listen 443 ssl reuseport backlog=4096;').replace('listen [::]:443 ssl;', 'listen [::]:443 ssl reuseport backlog=4096;');
  const again = prepareDualIngressProxy(tuned, { tlsListenBacklog: 4096 });
  assert.deepEqual(again.manifest.tlsListen.unchanged, ['443', '[::]:443']); assert.deepEqual(again.manifest.tlsListen.rewritten, []);
  assert.equal(again.vhost, prepareDualIngressProxy(wgFormal, { tlsListenBacklog: 4096 }).vhost);
  const half = wgFormal.replace('listen 443 ssl;', 'listen 443 ssl reuseport backlog=4096;');
  assert.deepEqual(prepareDualIngressProxy(half, { tlsListenBacklog: 4096 }).manifest.tlsListen.rewritten, ['[::]:443']);
  for (const input of [
    wgFormal.replace('listen 443 ssl;', 'listen 443 ssl http2;'),
    wgFormal.replace('listen 443 ssl;', 'listen 443 ssl reuseport;'),
    wgFormal.replace('listen 443 ssl;', 'listen 443 ssl reuseport backlog=511;'),
    wgFormal.replace('listen 443 ssl;', 'listen 443  ssl;'),
    wgFormal.replace('listen 443 ssl;', 'listen 0.0.0.0:443 ssl;'),
    wgFormal.replace('listen 443 ssl;', 'listen 443 ssl;\n    listen 443 ssl;'),
    wgFormal.replace('    listen [::]:443 ssl;\n', ''),
  ]) assert.throws(() => prepareDualIngressProxy(input, { tlsListenBacklog: 4096 }));
  for (const tlsListenBacklog of [8192, 511, '4096', true, 0]) assert.throws(() => prepareDualIngressProxy(wgFormal, { tlsListenBacklog }));
});

test('explicit re-preparation replaces only an exact earlier generator block and keeps refusing anything else', () => {
  const summary16 = stackSummary(16, 8), summary32 = stackSummary(32, 16);
  const wg2 = prepareDualIngressProxy(wgFormal), wg8 = prepareDualIngressProxy(wgFormal, { ingressInstances: 8 });
  assert.throws(() => prepareDualIngressProxy(wg2.vhost), /already present/);
  assert.throws(() => prepareDualIngressProxy(wgFormal, { replacePrepared: true }), /exact earlier/);
  assert.throws(() => prepareDualIngressProxy(wgFormal, { replacePrepared: 'yes' }));
  const rerun = prepareDualIngressProxy(wg2.vhost, { ingressInstances: 8, replacePrepared: true });
  assert.equal(rerun.vhost, wg8.vhost);
  assert.deepEqual(rerun.manifest.replacedPreparedUpstream, { topology: 'wg', endpoints: wg2.manifest.endpoints });
  assert.ok(rerun.manifest.webSocketLocations.every(row => row.previousUpstream === 'ark_cluster_formal_ingress_ws'));
  // WG -> local, then a sixteen-node local stack -> thirty-two nodes, all converge on a fresh preparation.
  const fresh16 = local(summary16), fresh32 = local(summary32, { tlsListenBacklog: 4096 });
  assert.equal(prepareDualIngressProxy(wg8.vhost, { topology: 'local', stackSummary: summary16, replacePrepared: true }).vhost, fresh16.vhost);
  const grown = prepareDualIngressProxy(fresh16.vhost, { topology: 'local', stackSummary: summary32, replacePrepared: true, tlsListenBacklog: 4096 });
  assert.equal(grown.vhost, fresh32.vhost);
  assert.equal(grown.manifest.replacedPreparedUpstream.topology, 'local');
  assert.deepEqual(grown.manifest.backendRetargets.map(row => [row.previous, row.changed]), [['172.30.245.2:3000', false], ['172.30.245.31:3000', true]]);
  const fixedPoint = prepareDualIngressProxy(fresh32.vhost, { topology: 'local', stackSummary: summary32, replacePrepared: true, tlsListenBacklog: 4096 });
  assert.equal(fixedPoint.vhost, fresh32.vhost);
  assert.ok(fixedPoint.manifest.backendRetargets.every(row => !row.changed));
  assert.deepEqual(fixedPoint.manifest.tlsListen.unchanged, ['443', '[::]:443']);
  // A local block is never silently re-labelled WG; custom/edited/partial outputs are not "exact earlier" outputs.
  assert.throws(() => prepareDualIngressProxy(fresh16.vhost, { replacePrepared: true }));
  const custom = prepareDualIngressProxy(wgFormal, { ports: [42001, 42002] });
  for (const input of [
    custom.vhost,
    wg2.vhost.replace('172.30.246.3:3000', '172.30.246.4:3000'),
    wg2.vhost.replace('max_fails=1 fail_timeout=5s;\n}', 'max_fails=1 fail_timeout=5s;\n    server 172.30.246.4:3000;\n}'),
    '# reviewed\n' + wg2.vhost,
    wg2.vhost.replace(`proxy_pass http://ark_cluster_formal_ingress_ws;\n        proxy_next_upstream error timeout;\n        proxy_next_upstream_tries 2;`, 'proxy_pass http://ark_proto_game_backend;'),
    wg2.vhost.replace('proxy_next_upstream_tries 2;', 'proxy_next_upstream_tries 3;'),
    wg2.vhost + '\nupstream ark_cluster_formal_ingress_ws { server 127.0.0.1:1; }\n',
  ]) assert.throws(() => prepareDualIngressProxy(input, { ingressInstances: 2, replacePrepared: true }));
  assert.throws(() => prepareDualIngressProxy(fresh16.vhost.replace('172.30.245.38:3000', '172.30.245.39:3000'), { topology: 'local', stackSummary: summary32, replacePrepared: true }));
});

const binary = process.env.DUAL_INGRESS_NGINX_BIN;
const enabled = process.env.DUAL_INGRESS_NGINX_SMOKE === '1' && !!binary;
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGQUIT');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); await exit; clearTimeout(timeout);
}

for (const ingressInstances of [2, 8]) test(`REAL isolated OpenResty with ${ingressInstances} relays keeps HTTP/gate separate and survives one relay loss`, { skip: !enabled, timeout: 45000 }, async t => {
  const scratch = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : fileURLToPath(new URL('../../../../.cache/stardust/', import.meta.url));
  const dir = await fs.mkdtemp(path.join(scratch, 'dual-ingress-proxy-'));
  await fs.mkdir(path.join(dir, 'logs'));
  const origin = 'http://dual-ingress.local', clients = [], fixtures = []; let nginx, log = '';
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await stop(nginx);
    for (const fixture of fixtures) {
      for (const ws of fixture.wss?.clients || []) ws.terminate();
      await new Promise(resolve => fixture.server.close(resolve));
    }
  });
  const main = http.createServer((req, res) => {
    if (req.url === '/check') { res.writeHead(req.headers.cookie === 'local-proof=1' ? 204 : 401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('UNCHANGED_HTTP_BACKEND:' + req.url);
  });
  main.listen(0, '127.0.0.1'); await once(main, 'listening'); fixtures.push({ server: main });
  for (let i = 0; i < ingressInstances; i++) {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
    wss.on('connection', ws => { ws.send(JSON.stringify({ echoRelay: i })); ws.on('message', data => ws.send(data)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); fixtures.push({ server, wss });
  }
  const port = await freePort(), mainPort = main.address().port;
  const source = `upstream original_http { server 127.0.0.1:${mainPort}; }\nmap $http_upgrade $ws_connection { default upgrade; '' ''; }\nserver {\nlisten 127.0.0.1:${port};\nauth_request /_gate/check;\nadd_header Cache-Control "private, no-store" always;\nproxy_http_version 1.1;\nproxy_set_header Host $host;\nproxy_set_header X-Real-IP $remote_addr;\nproxy_set_header X-Forwarded-For $remote_addr;\nproxy_set_header CF-Connecting-IP "";\nproxy_set_header Forwarded "";\nproxy_set_header Upgrade $http_upgrade;\nproxy_set_header Connection $ws_connection;\nlocation = /_gate/check { internal; auth_request off; proxy_pass http://original_http/check; proxy_pass_request_body off; proxy_set_header Content-Length ""; }\nlocation = /ws {\n  if ($http_origin != '${origin}') { return 403; }\n  proxy_pass http://original_http;\n  proxy_buffering off;\n  proxy_read_timeout 3600s;\n  proxy_send_timeout 3600s;\n}\nlocation / { proxy_pass http://original_http; }\n}\n`;
  const prepared = prepareDualIngressProxy(source, { ingressInstances, ports: fixtures.slice(1).map(f => f.server.address().port) });
  const luaLib = process.env.DUAL_INGRESS_NGINX_LUALIB;
  const lua = luaLib ? `lua_package_path "${luaLib}/?.lua;${luaLib}/?/init.lua;;"; lua_package_cpath "${luaLib}/?.so;;";` : '';
  const config = `user root;\nworker_processes 1;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 128; }\nhttp { ${lua} access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; ${prepared.vhost} }\n`;
  const conf = path.join(dir, 'nginx.conf'); await fs.writeFile(conf, config, { flag: 'wx' });
  const loader = process.env.DUAL_INGRESS_NGINX_LOADER, libs = process.env.DUAL_INGRESS_NGINX_LIBRARIES;
  const command = loader || binary, prefix = loader ? ['--library-path', libs, binary] : [];
  execFileSync(command, [...prefix, '-p', dir, '-c', conf, '-t'], { timeout: 10000 });
  nginx = spawn(command, [...prefix, '-p', dir, '-c', conf, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx.stderr.on('data', data => { log += data; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 6000;
  for (;;) {
    if (nginx.exitCode !== null) throw new Error('Local OpenResty exited: ' + log);
    try { if ((await fetch(url + '/data/config.json')).status === 401) break; } catch {}
    if (Date.now() > deadline) throw new Error('Local OpenResty did not start: ' + log);
    await delay(20);
  }
  for (const uri of ['/', '/js/main.js', '/data/config.json', '/client-build']) {
    const anon = await fetch(url + uri); assert.equal(anon.status, 401); assert.match(anon.headers.get('cache-control'), /no-store/);
    const allowed = await fetch(url + uri, { headers: { cookie: 'local-proof=1' } });
    assert.equal(await allowed.text(), 'UNCHANGED_HTTP_BACKEND:' + uri);
  }
  async function connect(headers = { origin, cookie: 'local-proof=1' }) {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { headers }); clients.push(ws);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WS handshake timeout')); }, 5000);
      ws.once('message', data => { clearTimeout(timeout); resolve({ ws, relay: JSON.parse(data).echoRelay }); });
      ws.once('unexpected-response', (req, response) => { clearTimeout(timeout); response.resume(); resolve({ refused: response.statusCode }); });
      ws.on('error', error => { clearTimeout(timeout); reject(error); });
    });
  }
  assert.equal((await connect({ origin })).refused, 401);
  assert.equal((await connect({ origin: 'http://wrong.local', cookie: 'local-proof=1' })).refused, 403);
  const active = [];
  for (let i = 0; i < ingressInstances * 3; i++) active.push(await connect());
  assert.deepEqual(active.map(x => x.relay).sort((a, b) => a - b),
    Array.from({ length: ingressInstances }, (_, i) => [i, i, i]).flat());
  for (const ws of fixtures[2].wss.clients) ws.terminate();
  await new Promise(resolve => fixtures[2].server.close(resolve));
  const survivor = active.find(x => x.relay === 0).ws;
  const echoed = once(survivor, 'message'); survivor.send('surviving-old-ws'); assert.equal((await echoed)[0].toString(), 'surviving-old-ws');
  for (let i = 0; i < 3; i++) {
    const relay = (await connect()).relay; assert.notEqual(relay, 1);
    assert.ok(relay >= 0 && relay < ingressInstances);
  }
  await fs.writeFile(path.join(dir, 'native-proxy-result.json'), JSON.stringify({ ok: true, localOnly: true, echoFixtureNotGameWorker: true, ingressInstances, initialDistribution: active.map(x => x.relay), healthyEstablishedSocketPreserved: true, newHandshakeFallback: true, anonymous401: true, invalidOrigin403: true, httpBackendUnchanged: true, productionAccessed: false, nginxLog: log }, null, 2) + '\n', { flag: 'wx' });
  t.diagnostic('Real local OpenResty result retained at ' + dir + '; echo fixtures are NOT actual game/Worker proof');
});
