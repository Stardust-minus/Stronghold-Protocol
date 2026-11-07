# Server snapshot rate

`SP_SNAPSHOT_HZ=10` reduces periodic server-combat state snapshots without changing the simulation step, game speed, event-drain boundaries, damage sampling or settlement. `20` is the default and preserves the original cadence; `5` is also accepted but needs separate visual acceptance. `startServer({ snapshotHz: 10 })` and `new Match({ ..., snapshotHz: 10 })` override the environment.

On a cluster the coordinator's config `snapshotHz` (5, 10 or 20; default `10`) sets the rate of every match it assigns to a game node; `SP_SNAPSHOT_HZ` is not read there.

Since 2026-10-12 a player's own normal / 联防 field is usually not streamed at all: its browser runs it as a local display
replica checked by `b.sync` digests (docs/design/network.md, Local display replicas). This rate applies to what is still
streamed — teammates being watched, spectator seats, boss / hidden fields and replicas that fell back to the stream.

## What changes

- Simulation remains 30 ticks/game second, normally 2× game speed (about 60 steps/real second). A battle that starts after a passed 战斗 2 倍速 vote runs at 4× (about 120 steps/real second) until it ends, 联防 included.
- Events are still drained every 3 ticks. Each `b.ev` retains the original boundary, game timestamp and order, including spawn/model information.
- Lower-rate sampling occurs before snapshot/fieldMeta construction and JSON encoding, in both Worker and inline streaming paths. Event-only frames cross the Worker port without replacing the last consistent snapshot/meta cache.
- At normal 2× speed, periodic snapshots are spaced by 6 ticks for 10 Hz or 12 ticks for 5 Hz (12 and 24 ticks at 4×). The first periodic frame is immediate at the first event boundary; terminal frames and explicit state/reconnect requests bypass sampling. Explicit state requests do not change periodic cadence.
- Lower rates adapt the tick gap to the phase's configured game speed, quantized to existing event boundaries. Default 20 intentionally preserves legacy pacing for accelerated tools: it keeps the 3-tick gap at any speed, so a 4× battle streams about 40 snapshots per real second. Rates are targets under normal pacing, not guarantees against scheduling delays, catch-up, pause, resync or backpressure.
- Periodic `b.snap` sampling does not cap all WebSocket messages. Event, control, public state and damage messages keep their own policies. Worker advance requests/replies are not throttled.
- The existing client uses time-based interpolation and can consume 10 Hz snapshots without a protocol change. Its 100 ms buffer/120 ms extrapolation limit and the simplified view must be considered before choosing 5 Hz.

## Local checks

Focused transport/parity tests:

```sh
node --test test/match/snapshot-rate.test.js test/match/combat-wire.test.js test/match/combat-engine.test.js test/ws-compression.test.js
```

The native 10 Hz Worker/WS test runs with compression both `off` and `on`, checking negotiation on initial connection and reconnect, unchanged event delivery, sampled snapshot cadence and fresh metadata. Compression policy and byte-threshold tests remain separate; negotiated compression does not mean every small snapshot is compressed.

Fixed-input, localhost-only saturation comparison (run sequentially on the same host):

```sh
node tools/combatbench.mjs --workers=4 --sessions=24 --ticks=600 --batch=6 --snapshot-hz=20
node tools/combatbench.mjs --workers=4 --sessions=24 --ticks=600 --batch=6 --snapshot-hz=10
```

Compare complete `resultHash`, ordered `eventHash`, actual ticks and event batches as well as snapshot count, JSON bytes, CPU and MainThread CPU. The benchmark measures a fixed synthetic heavy workload with real simulation/Worker IPC; it does not include real WS compression/WAN transport or establish production capacity. Browser/real WS acceptance is an independent gate. Screenshots, test logs and measurements belong outside Git.
