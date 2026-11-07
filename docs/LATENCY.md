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

## Local regression checks

```sh
node --test test/client-latency.test.js test/client-static.test.js test/server-load.test.js test/ui/server-load.test.js test/health-metrics.test.js
node --test test/ui/prediction.test.js
```

The tests cover independent epoch/elapsed clocks, matched replies, duplicates, old replies, lifecycle expiry, retained real high samples, reconnect/visibility resets, bounded pending probes, pressure boundaries and actual browser-style WebSocket transport; `test/ui/prediction.test.js` covers the prediction, its reconciliation, the server's `ack` and parity with the real `PlayerState`. Local UI/browser verification is separate from unit assertions; neither implies production deployment.
