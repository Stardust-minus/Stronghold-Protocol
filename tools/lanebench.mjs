#!/usr/bin/env node
// Lanes under loss (shared/lanes.js, docs/design/network.md, Lanes): one server, many clients with 1, 2 or 3 lanes at
// the same time over the same lossy path, so every group sees the same loss. Meant for two network namespaces joined
// by a veth pair with netem on both ends (the path is the measurement, not this script). Both ends read the same host
// clock (Date.now), so delays are one-way.
//
//   node tools/lanebench.mjs server --host 10.231.0.1 --port 18765 --seconds 200 --out server.json
//   node tools/lanebench.mjs client --url ws://10.231.0.1:18765/ws --clients 12 --lanes 1,2,3 --seconds 180 --out client.json
//
// Server → client: a game-like thin stream, DOWN_HZ frames per second (70 % 150 B, 25 % 600 B, 5 % 2500 B). Client →
// server: UP_HZ small intents. A client reconnects like net.js (backoff 500 ms × 2 up to 10 s, ±20 %; no frame for
// 15 s ⇒ dead). Reported per lane count: one-way delay percentiles both ways, frames later than 300 ms / 1 s, stream
// gaps over 1 s, logical-socket drops and the time without a socket.
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { createLaneHub, laneCounters } from '../server/wsLanes.js';
import { laneWebSocket } from '../public/js/lanes.js';

const DOWN_HZ = 5, UP_HZ = 2, DEAD_MS = 15000, GAP_MS = 1000;
const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const mode = process.argv[2];
const seconds = Number(args.seconds || 60);

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; }
function summary(delays) {
  const s = Float64Array.from(delays).sort();
  const over = (ms) => (s.length ? +((100 * s.filter((x) => x > ms).length) / s.length).toFixed(3) : null);
  return { n: s.length, p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s.length ? s[s.length - 1] : null,
    over300pct: over(300), over1000pct: over(1000) };
}
const PAD = 'x'.repeat(3000);
function padSize(r) { return r < 0.7 ? 150 : r < 0.95 ? 600 : 2500; }

if (mode === 'server') {
  const hub = createLaneHub();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: hub.handleProtocols });
  const up = new Map(); // lanes → delays
  wss.on('connection', (lane) => {
    const ws = hub.adopt(lane);
    if (!ws) return;
    let group = null, n = 0;
    const timer = setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ t: 'f', s: Date.now(), n: ++n, p: PAD.slice(0, padSize(Math.random())) }));
    }, 1000 / DOWN_HZ);
    ws.on('message', (data) => {
      const at = Date.now();
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'hello') { group = String(msg.lanes); if (!up.has(group)) up.set(group, []); }
      else if (msg.t === 'u' && group) up.get(group).push(at - msg.s);
    });
    ws.on('close', () => clearInterval(timer));
    ws.on('error', () => {});
  });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  server.listen(Number(args.port), args.host, () => console.log(`[lanebench] server on ${args.host}:${args.port}`));
  setTimeout(() => {
    const out = { up: Object.fromEntries([...up].map(([g, d]) => [g, summary(d)])), laneCounters };
    fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
    process.exit(0);
  }, seconds * 1000);
} else if (mode === 'client') {
  const groups = String(args.lanes || '1,2').split(',').map(Number);
  const perGroup = Number(args.clients || 10);
  const stop = Date.now() + seconds * 1000;
  const result = new Map();
  const clients = [];
  for (const lanes of groups) result.set(lanes, { down: [], gaps: 0, drops: 0, downMs: 0, connects: 0, laneStats: { lanesOpened: 0, lanesLost: 0, lanesStalled: 0, refusals: 0 }, modes: {} });
  const runClient = (lanes, idx) => {
    const r = result.get(lanes);
    const WS = laneWebSocket({ lanes, WebSocket, onStats: (st) => { for (const k of Object.keys(r.laneStats)) r.laneStats[k] += st[k] || 0; } });
    let attempt = 0;
    const st = { lanes, open: false, downSince: null };
    clients.push(st);
    const connect = () => {
      if (Date.now() >= stop) return;
      if (st.downSince === null) st.downSince = Date.now();
      const ws = new WS(args.url);
      st.ws = ws;
      let lastRx = 0, upTimer = null, deadTimer = null, n = 0, open = false;
      const finish = () => {
        clearInterval(upTimer); clearInterval(deadTimer);
        if (open) { r.drops++; st.downSince = Date.now(); }
        open = false; st.open = false;
        const raw = Math.min(10000, 500 * 2 ** Math.min(10, attempt++));
        setTimeout(connect, Math.max(100, raw + raw * 0.2 * (Math.random() * 2 - 1)));
      };
      ws.onopen = () => {
        open = true; st.open = true; attempt = 0; r.connects++;
        r.modes[ws.mode ?? 'plain'] = (r.modes[ws.mode ?? 'plain'] || 0) + 1;
        r.downMs += Date.now() - st.downSince;
        lastRx = Date.now();
        ws.send(JSON.stringify({ t: 'hello', lanes }));
        upTimer = setInterval(() => { try { ws.send(JSON.stringify({ t: 'u', s: Date.now(), n: ++n })); } catch { /* closing */ } }, 1000 / UP_HZ);
        deadTimer = setInterval(() => {
          if (Date.now() - lastRx > DEAD_MS) { ws.onclose = null; try { ws.close(4000, 'dead'); } catch { /* ignore */ } finish(); }
        }, 1000);
      };
      ws.onmessage = (ev) => {
        const at = Date.now();
        let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        if (msg.t !== 'f') return;
        if (lastRx && at - lastRx > GAP_MS) r.gaps++;
        lastRx = at;
        r.down.push(at - msg.s);
      };
      ws.onclose = () => finish();
      ws.onerror = () => {};
    };
    setTimeout(connect, (idx * 97) % 2000);
  };
  for (const lanes of groups) for (let i = 0; i < perGroup; i++) runClient(lanes, i);
  setTimeout(() => {
    for (const st of clients) {
      const r = result.get(st.lanes);
      if (!st.open && st.downSince !== null) r.downMs += Math.max(0, stop - st.downSince);
      if (st.open && st.ws?.stats) for (const k of Object.keys(r.laneStats)) r.laneStats[k] += st.ws.stats[k] || 0;
    }
    const out = {};
    for (const [lanes, r] of result) {
      out[lanes] = { down: summary(r.down), stalls_over_1s_per_client_min: +(r.gaps / perGroup / (seconds / 60)).toFixed(2), drops: r.drops,
        connects: r.connects, unavailablePct: +(100 * r.downMs / (perGroup * seconds * 1000)).toFixed(2), laneStats: r.laneStats, modes: r.modes };
    }
    fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
    process.exit(0);
  }, seconds * 1000 + 2000);
} else {
  console.error('usage: lanebench.mjs server|client …');
  process.exit(2);
}
