# Response latency and server pressure

These are independent indicators. A WebSocket response time is not pure network latency, and the pressure label is not total host CPU or combat Worker utilization.

## Response-time probes

The browser sends an application-level JSON `ping` every 4000 ms and after a visible-page refresh of the measurement. It uses the existing optional `rid` field to match each pong to a pending probe; the server already echoes both `rid` and the epoch timestamp `c`, so no new protocol fields or server RPC are required.

Elapsed RTT uses a local monotonic clock (`performance.now()`), not subtraction of two `Date.now()` readings. The echoed epoch timestamp and the server timestamp remain available for the separate server-clock estimate. When a client epoch adjustment exceeds 100 ms, clock candidates from that old epoch are cleared; the lowest-RTT policy within the last 8 candidates is otherwise unchanged.

The displayed RTT remains the latest accepted measurement, not an average, minimum or RTT/2. It includes outbound/inbound network and WebSocket queues, server scheduling, and browser message-processing waits. A valid 3000 ms response is still displayed as 3000 ms. The algorithm does not discard a fresh sample simply because it is high.

Probe lifecycle:

- Match both the outstanding `rid` and its original echoed `c`; reject unmatched, duplicate and older-than-last-accepted replies.
- Reject a probe elapsed time outside `[0,15000)` ms. At most 8 pending probes are retained.
- If no accepted sample arrives for 12000 ms, clear the displayed RTT and pressure hint rather than leaving an old good value on screen. Existing newer outstanding probes remain eligible. Expiry is checked by the heartbeat/probe timer, so browser timer throttling can delay that check.
- On socket teardown or page visibility change, discard previous probes and clear RTT/pressure. On becoming visible, start a new probe.
- Hidden pages keep connection heartbeats but do not contribute visible response-time samples.
- Connection-silence detection is separate: any inbound frame can establish liveness, but does not extend an individual probe's 15-second validity. Silence detection also uses elapsed monotonic time.

The UI keeps its original numerical colour tiers (`<60`, `<200`, otherwise high) and 9999 display cap. An online connection without a current measurement shows `--` with a “waiting for a new measurement” tooltip, not “disconnected”. A tooltip identifies valid values as WebSocket round-trip response times.

## Server pressure

`server/healthMetrics.js` samples a single cached window approximately every 10000 ms. Actual window duration uses a monotonic clock; GETs and pongs read the cache without triggering an extra sample or Worker RPC.

- Main-thread ELU = `active / (active + idle)` over that window. It is not whole-process or machine CPU percentage.
- Event-loop delay p95 is the 95th percentile of the window histogram, with 20 ms sampling resolution. A baseline near 20 ms is not a 20 ms network response measurement.

| Public state | Rule, evaluated in this order |
| --- | --- |
| `unknown` / 未知 | Not ready, invalid metrics, a future sample timestamp or a cached sample older than 30000 ms. |
| `overloaded` / 拥堵 | p95≥100ms, or ELU≥0.95 and p95≥50ms. |
| `busy` / 繁忙 | ELU≥0.85 or p95≥40ms, without meeting the overloaded condition. |
| `normal` / 正常 | Otherwise, for a valid sample. |

The existing application pong carries the pressure enum and, when a valid cached sample is available, a bounded `loadDetails` projection: sample window/age, game-process CPU percentage, RSS/main-thread heap MiB, main-thread ELU percentage and event-loop p95/p99 milliseconds. No PID, host address/model/core count, total machine memory, sessions or full health response is exposed. Invalid optional measurements remain null; cold/future/stale samples have no details. No extra metrics sampler, HTTP polling or Worker RPC is added, and pong remains uncompressed.

The cluster's lobby pong also carries the public per-node summary (`clusterLoad`, one row per game node: ~6 KB uncompressed with 32 nodes). A connection gets it on its first ping, then at most once per 10 s (`server/net.js CLUSTER_LOAD_EVERY_MS`) or when its ping says `full: true` — the browser asks while the service dialog is open and while it holds no lobby summary (back from a match, whose game node answers with its own one-row `game` summary). The pongs in between say `clusterLoadSame: true` and the browser keeps the summary it has; a pong with neither clears it as before.

The lobby and battle HUD use a compact service button: hover/keyboard focus previews CPU, RSS, ELU and p95; click/tap opens the game-service details dialog. CPU includes all game threads and may exceed 100% (100% = one core), not the whole host. The dialog labels RSS and main-thread heap separately. Callers that omit loadState retain the latency-only pill. Offline or stale-client measurements clear both the enum and details.

A short response spike may coexist with a normal cached pressure label. The window can miss a brief outlier, and its label does not measure browser stalls, network congestion, compression/TCP queues or combat Worker saturation. It is a coarse main-thread responsiveness hint, not a capacity guarantee.

## Client-side prediction of prep intents (rel26)

Buying, selling, deploying / withdrawing / moving an operator, refreshing, freezing and levelling the shop used to show only when the next `m.private` arrived — one RTT, more after a lost segment (TCP holds everything behind it). Since rel26 the browser shows them at once and the server stays the only authority:

- `ui/gameLogic/predict.js` applies an intent's direct effects to the shown `m.private`: funds, the shop slots (sold, frozen; a level-up's new empty slots and next price from `m.private` `shop.next`), the hand / temp / board pieces, the deploy count. Derived panels (bonds, effects, the layer forecast, summons granted on a deployment, pieces an effect grants, stats) and anything the server's RNG decides (the cards of a refresh) wait for the server. An intent whose outcome is not certain is not predicted, or only its payment is, and waits as before: a merge-completing buy (an elite or a golden item), a sale whose equipment would overflow or merge, a move of a summon or of an operator with summons, a move onto a summon or a device, a second level-up before the first is acknowledged.
- The server echoes the `rid` of the latest such intent of a seat (`shared/protocol.js` `ACKED_INTENTS`), accepted or refused, as that seat's `m.private` `ack` (`server/match/match/platform.js`; 0 after every reconnect; not saved in checkpoints). `ui/prediction.js` replays every pending intent over each authoritative `m.private` and drops it once a state with `ack ≥ rid` arrives — that state contains it, whatever the server made of it (or 3 s after its reply without one, `SETTLE_MS`). The reply alone is not enough: under backpressure the game node writes the reply before a queued `m.private`. A refused intent is dropped with its error toast, and the next state shows the server's truth.
- A sent request is never resent (`net.js`): a socket that drops rejects it, so a predicted intent can never be applied twice. A request that times out is dropped from the replay; its outcome, if any, arrives with the server's state.
- A piece bought by prediction carries a negative placeholder uid. An intent naming it (deployed, sold, equipped before the purchase is acknowledged) is shown at once but sent only when the real uid is known (the new copy in the slot the prediction used). Intents leave in the order they were made, so everything made after such an intent waits too.
- A server without `ack` (rel25 and older) leaves the prediction off; `localStorage['sp.noPredict'] = '1'` switches it off in a browser.

## Lanes: one connection over several WebSockets (2026-11-11)

At 10–20 % loss on a player's last mile (the evening peak), one TCP connection stalls the whole stream for a
retransmission timeout every few seconds. The browser now carries its connection over 2 WebSockets by default and
takes whichever copy of a frame comes first (docs/design/network.md, Lanes; DEPLOY §12 多连接 for nginx).

Measured with `tools/lanebench.mjs` over `tools/lanebench-netns.sh`: two network namespaces on one host joined by a
veth pair, netem 20 ms each way (RTT 40 ms) and the loss in both directions; the server namespace has the entry's TCP
settings (BBR, thin-stream linear timeouts, notsent_lowat 16 KiB, retries2 8), the clients' Linux defaults (CUBIC).
12 clients per lane count ran at the same time over the same path, 180 s per row; server → client 5 frames/s
(150 / 600 / 2500 B), client → server 2/s. One-way delay in ms (20 ms is the path's own).

| Loss | Lanes | p99 | p99.9 | max | late > 1 s | gaps > 1 s per player-min | up p99 | up max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 % random | 1 | 517 | 1327 | 2406 | 0.26 % | 0.33 | 515 | 1367 |
| | 2 | 259 | 326 | 546 | 0 | 0 | 269 | 560 |
| | 3 | 40 | 261 | 508 | 0 | 0 | 21 | 288 |
| 20 % random | 1 | 2693 | 11943 | 13738 | 3.8 % | 2.9 | 1259 | 8542 |
| | 2 | 459 | 814 | 1316 | 0.06 % | 0.11 | 341 | 844 |
| | 3 | 260 | 468 | 800 | 0 | 0 | 274 | 1818 |
| 15 % in bursts¹ | 1 | 858 | 2343 | 4100 | 0.76 % | 1.0 | 614 | 3684 |
| | 2 | 460 | 689 | 1227 | 0.02 % | 0.08 | 392 | 915 |
| | 3 | 313 | 568 | 2512 | 0.07 % | 0.03 | 295 | 1912 |

¹ netem Gilbert–Elliott `gemodel 5% 25% 90% 0%`: bursts of 4 packets on average, 15 % overall.

- No run lost a connection with 2 or 3 lanes, and no bundle closed for a gap. The single-lane upstream varies a lot
  between runs (20 %: p99 0.9–16 s, max 3–34 s): a client TCP whose resends are lost backs off 1, 2, 4 … s.
- Before joins replayed (shared/lanes.js, Joining replays) the upstream max at 20 % was 5.8 s with 2 lanes and 19 s
  with 3: frames sent before the join opened waited for the first lane's backoff.
- The entry's route tweak `rto_min 50ms quickack 1` (measured before join replay, downstream p99 / p99.9) halves the
  tail again: 20 % random 1 lane 2052 / 5956 → 764 / 3052, 2 lanes 460 / 1249 → 217 / 462, 3 lanes 260 / 492 → 131 /
  243; bursts 1 lane 950 / 2528 → 432 / 1106, 2 lanes 512 / 1375 → 213 / 425, 3 lanes 322 / 542 → 160 / 261. Two
  lanes with it are about three without it.
- A single host, a fixed RTT and Linux clients: phones and Windows have other TCP stacks, and real loss is neither
  this random nor this regular. The comparison between lane counts is the result, not the absolute numbers.

## Network quality reports (2026-11-11)

To decide on lines and lane counts from real players instead of a lab path, every page reports once a minute what it
measured (C→S `net.q`, `shared/netQuality.js`, `public/js/netQuality.js`): application ping round trips (visible page
only), how much later the second / third lane copy of each server frame came than the first (the delay one connection
alone would have added), lanes lost / replaced as stalled / refused, reconnects and offline time. It is never answered.

- The server (`server/netQuality.js`) takes at most one report per socket per 30 s after hello, classifies the client
  address once against `SP_ISP_FILE` (`tools/isp-table.mjs`: 中国电信 / 联通 / 移动 / 教育网 / other in China from
  gaoyifan/china-operator-ip, provinces from metowolf/iplist) and drops it. It sums per ISP × device × lane count and,
  separately, per province × ISP; `/healthz` `netq` carries the sums since start. No address, session, name or city is
  kept, and the label sets are fixed (36 and at most 192 groups).
- The monitoring collector exports them as `sp_netq_*` counters (buckets with `le` in ms); the public dashboard
  `stronghold-netq.json` (uid `sp-netq`, `/monitor/net`) shows them per ISP, per lane count and per province next to
  the entry's TCP retransmission ratio (node-exporter netstat). A province (× ISP) averaging under 3 reporting pages
  over the hour is not shown, so no cell stands for one player.
- Limits: the copy delay is relative to the first copy, so it underestimates a single connection when both copies are
  late (a join's first seconds) and needs lanes — a single-lane page reports round trips and reconnects only. Provinces
  are IPv4 only and partial (an IPv6 player, or an address in no list, is `xx`), and a mobile network's addresses often
  locate to the provincial capital or the operator's gateway. City level is not collected: inaccurate for mobile
  networks, too many series, and one or two players per city and ISP would make a minute series personal.

## PREP intent grace (2026-11-11)

A timed PREP ends `PREP_INTENT_GRACE_MS` (1500 ms; Match option `prepGraceMs`, 0 … 5000) after its published deadline;
`m.public.deadline` and the countdown are unchanged. An intent sent just before the countdown ran out was refused as
WRONG_PHASE when the last mile delayed it, and the rel26 prediction then rolled the board back when the battle
started; within the grace it counts. Restored checkpoints re-arm the same way (`armPrepDeadline`).

## Local regression checks

```sh
node --test test/client-latency.test.js test/client-static.test.js test/server-load.test.js test/ui/server-load.test.js test/health-metrics.test.js
node --test test/ui/prediction.test.js
node --test test/ws-lanes.test.js test/match/prep-grace.test.js
SP_E2E=1 CHROME_PATH=… node --test test/ui/lanes.e2e.test.js
```

The tests cover independent epoch/elapsed clocks, matched replies, duplicates, old replies, lifecycle expiry, retained real high samples, reconnect/visibility resets, bounded pending probes, pressure boundaries and actual browser-style WebSocket transport; `test/ui/prediction.test.js` covers the prediction, its reconciliation, the server's `ack` and parity with the real `PlayerState`. Local UI/browser verification is separate from unit assertions; neither implies production deployment.
