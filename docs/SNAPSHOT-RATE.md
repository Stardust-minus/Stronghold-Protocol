# Server snapshot rate (local opt-in)

`SP_SNAPSHOT_HZ=10` reduces periodic server-combat state snapshots without changing the simulation step, game speed, event-drain boundaries, damage sampling or settlement. `20` is the default and preserves the original cadence; `5` is also accepted but needs separate visual acceptance. `startServer({ snapshotHz: 10 })` and `new Match({ ..., snapshotHz: 10 })` override the environment.

This is a code option, not a deployed runtime change. No production activation, commit or push is implied by local testing.

## What changes

- Simulation remains30 ticks/game second, normally2× game speed (about60 steps/real second).
- Events are still drained every3 ticks. Each `b.ev` retains the original boundary, game timestamp and order, including spawn/model information.
- Lower-rate sampling occurs before snapshot/fieldMeta construction and JSON encoding, in both Worker and inline streaming paths. Event-only frames cross the Worker port without replacing the last consistent snapshot/meta cache.
- At normal2× speed, periodic snapshots are spaced by6 ticks for10Hz or12 ticks for5Hz. The first periodic frame is immediate at the first event boundary; terminal frames and explicit state/reconnect requests bypass sampling. Explicit state requests do not change periodic cadence.
- Lower rates adapt the tick gap to the phase's configured game speed, quantized to existing event boundaries. Default20 intentionally preserves legacy pacing for accelerated tools. Rates are targets under normal pacing, not guarantees against scheduling delays, catch-up, pause, resync or backpressure.
- Periodic `b.snap` sampling does not cap all WebSocket messages. Event, control, public state and damage messages keep their own policies. Worker advance requests/replies are not throttled.
- The existing client uses time-based interpolation and can consume10Hz snapshots without a protocol change. Its100ms buffer/120ms extrapolation limit and the simplified view must be considered before choosing5Hz.

## Local checks

Focused transport/parity tests:

```sh
node --test test/match/snapshot-rate.test.js test/match/combat-wire.test.js test/match/combat-engine.test.js test/ws-compression.test.js
```

The native10Hz Worker/WS test runs with compression both `off` and `on`, checking negotiation on initial connection and reconnect, unchanged event delivery, sampled snapshot cadence and fresh metadata. Compression policy and byte-threshold tests remain separate; negotiated compression does not mean every small snapshot is compressed.

Fixed-input, localhost-only saturation comparison (run sequentially on the same host):

```sh
node tools/combatbench.mjs --workers=4 --sessions=24 --ticks=600 --batch=6 --snapshot-hz=20
node tools/combatbench.mjs --workers=4 --sessions=24 --ticks=600 --batch=6 --snapshot-hz=10
```

Compare complete `resultHash`, ordered `eventHash`, actual ticks and event batches as well as snapshot count, JSON bytes, CPU and MainThread CPU. The benchmark measures a fixed synthetic heavy workload with real simulation/Worker IPC; it does not include real WS compression/WAN transport or establish production capacity. Browser/real WS acceptance is an independent gate. Screenshots, test logs and measurements belong outside Git.
