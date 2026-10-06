# Response latency and server pressure

These are independent indicators. A WebSocket response time is not pure network latency, and the pressure label is not total host CPU or combat Worker utilization.

## Response-time probes

The browser sends an application-level JSON `ping` every4000ms and after a visible-page refresh of the measurement. It uses the existing optional `rid` field to match each pong to a pending probe; the server already echoes both `rid` and the epoch timestamp `c`, so no new protocol fields or server RPC are required.

Elapsed RTT uses a local monotonic clock (`performance.now()`), not subtraction of two `Date.now()` readings. The echoed epoch timestamp and the server timestamp remain available for the separate server-clock estimate. When a client epoch adjustment exceeds100ms, clock candidates from that old epoch are cleared; the lowest-RTT policy within the last8 candidates is otherwise unchanged.

The displayed RTT remains the latest accepted measurement, not an average, minimum or RTT/2. It includes outbound/inbound network and WebSocket queues, server scheduling, and browser message-processing waits. A valid3000ms response is still displayed as3000ms. The algorithm does not discard a fresh sample simply because it is high.

Probe lifecycle:

- Match both the outstanding `rid` and its original echoed `c`; reject unmatched, duplicate and older-than-last-accepted replies.
- Reject a probe elapsed time outside `[0,15000)`ms. At most8 pending probes are retained.
- If no accepted sample arrives for12000ms, clear the displayed RTT and pressure hint rather than leaving an old good value on screen. Existing newer outstanding probes remain eligible. Expiry is checked by the heartbeat/probe timer, so browser timer throttling can delay that check.
- On socket teardown or page visibility change, discard previous probes and clear RTT/pressure. On becoming visible, start a new probe.
- Hidden pages keep connection heartbeats but do not contribute visible response-time samples.
- Connection-silence detection is separate: any inbound frame can establish liveness, but does not extend an individual probe's15-second validity. Silence detection also uses elapsed monotonic time.

The UI keeps its original numerical colour tiers (`<60`, `<200`, otherwise high) and9999 display cap. An online connection without a current measurement shows `--` with a “waiting for a new measurement” tooltip, not “disconnected”. A tooltip identifies valid values as WebSocket round-trip response times.

## Server pressure

`server/healthMetrics.js` samples a single cached window approximately every10000ms. Actual window duration uses a monotonic clock; GETs and pongs read the cache without triggering an extra sample or Worker RPC.

- Main-thread ELU = `active / (active + idle)` over that window. It is not whole-process or machine CPU percentage.
- Event-loop delay p95 is the95th percentile of the window histogram, with20ms sampling resolution. A baseline near20ms is not a20ms network response measurement.

| Public state | Rule, evaluated in this order |
| --- | --- |
| `unknown` / 未知 | Not ready, invalid metrics, a future sample timestamp or a cached sample older than30000ms. |
| `overloaded` / 拥堵 | p95≥100ms, or ELU≥0.95 and p95≥50ms. |
| `busy` / 繁忙 | ELU≥0.85 or p95≥40ms, without meeting the overloaded condition. |
| `normal` / 正常 | Otherwise, for a valid sample. |

The existing application pong carries the pressure enum and, when a valid cached sample is available, a bounded `loadDetails` projection: sample window/age, game-process CPU percentage, RSS/main-thread heap MiB, main-thread ELU percentage and event-loop p95/p99 milliseconds. No PID, host address/model/core count, total machine memory, sessions or full health response is exposed. Invalid optional measurements remain null; cold/future/stale samples have no details. No extra metrics sampler, HTTP polling or Worker RPC is added, and pong remains uncompressed.

The lobby and battle HUD use a compact service button: hover/keyboard focus previews CPU, RSS, ELU and p95; click/tap opens the game-service details dialog. CPU includes all game threads and may exceed100% (100%=one core), not the whole host. The dialog labels RSS and main-thread heap separately. Callers that omit loadState retain the latency-only pill. Offline or stale-client measurements clear both the enum and details.

A short response spike may coexist with a normal cached pressure label. The window can miss a brief outlier, and its label does not measure browser stalls, network congestion, compression/TCP queues or combat Worker saturation. It is a coarse main-thread responsiveness hint, not a capacity guarantee.

## Local regression checks

```sh
node --test test/client-latency.test.js test/client-static.test.js test/server-load.test.js test/ui/server-load.test.js test/health-metrics.test.js
```

The tests cover independent epoch/elapsed clocks, matched replies, duplicates, old replies, lifecycle expiry, retained real high samples, reconnect/visibility resets, bounded pending probes, pressure boundaries and actual browser-style WebSocket transport. Local UI/browser verification is separate from unit assertions; neither implies production deployment.
