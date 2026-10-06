# Concurrency admission defaults

The game application's socket, identity, room, per-network room/match, matchmaking-entry, spectator and combat-session quantity caps default to `0`, explicitly meaning unlimited. Positive programmatic overrides remain available; every relevant admission check tests a positive cap before comparing a count. Zero is not interpreted as an already-full registry/room/queue. The health payload reports `maxRooms: 0` and remains governed by Worker readiness, not a zero capacity comparison.

This removes artificial concurrent-count gates; it does not establish an unlimited CPU/memory/file-descriptor capacity or a measured higher player limit. No OS, proxy, authentication, container-security or live deployment settings are changed by these local defaults.

## Protections and game rules retained

- Four active player seats per match and one live socket binding per logical player identity.
- Authentication, Origin handling, schema/name validation and the64KiB inbound message limit.
- Per-socket message/large-resync rate protection and slow-socket snapshot dropping/termination.
- Heartbeats, hello/queue/acceptance deadlines and normal/solo reconnect windows.
- Combat request backpressure (`maxPending:8192`), trial/background work (`maxTrials/maxTrialPending:64`) and per-worker serial trial execution. These are bounded work/safety queues, not global human/room quantity caps.

Zero admission defaults are independent of20/10/5Hz snapshot selection, WS compression policy and the cached service-pressure/usage projection. They require normal matched-release deployment and observation before any production capacity claim.
