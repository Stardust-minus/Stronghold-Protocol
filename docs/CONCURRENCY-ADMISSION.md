# Concurrency admission defaults

The game application's socket, online-player, identity, room, per-network room/match, AI-seat, matchmaking-entry, spectator and combat-session quantity caps default to `0`, explicitly meaning unlimited. Positive overrides remain available; every relevant admission check tests a positive cap before comparing a count. Zero is not interpreted as an already-full registry/room/queue. The health payload reports `maxRooms: 0` and remains governed by Worker readiness, not a zero capacity comparison.

An operator sets a positive cap through a `startServer()` option or `SP_MAX_CONNECTIONS`, `SP_MAX_CONNECTIONS_PER_ADDR`, `SP_MAX_ONLINE`, `SP_MAX_ROOMS`, `SP_MAX_ROOMS_PER_ADDR` and `SP_MAX_MATCHES_PER_ADDR` (`server/http/config.js`: the option wins, `0` stays unlimited, a value that is not a non-negative integer is ignored with a warning). The limits file named by `SP_ONLINE_LIMIT_FILE` (`server/onlineLimit.js`) is re-read within seconds while the server runs: `limit` is the online cap, and `maxRooms`, `maxRoomsPerAddr`, `maxMatchesPerAddr`, `maxBots` and `maxBotsPerAddr` replace those options for the next `room.create` / `room.start` / `room.addBot`; a lower cap never closes rooms, matches or AI seats that exist. The online cap refuses only new sessions (`SERVER_FULL`), never a resume. Per-network caps count internet clients only; local/LAN peers are exempt. The file's `maintenance: 1` refuses new rooms, starts and queue entries (`MAINTENANCE`) while running matches go on.

This removes artificial concurrent-count gates; it does not establish an unlimited CPU/memory/file-descriptor capacity or a measured higher player limit. No OS, proxy, authentication, container-security or live deployment settings are changed by these local defaults.

## Protections and game rules retained

- Four active player seats per match (up to 20 in an expanded-capacity room, [EXPERIMENTAL-MULTIPLAYER.md](EXPERIMENTAL-MULTIPLAYER.md)) and one live socket binding per logical player identity.
- Authentication, Origin handling, schema/name validation and the 64 KiB inbound message limit.
- Per-socket message/large-resync rate protection and slow-socket snapshot dropping/termination.
- Heartbeats, hello/queue/acceptance deadlines and normal/solo reconnect windows.
- Combat request backpressure (`maxPending:8192`), trial/background work (`maxTrials/maxTrialPending:64`) and per-worker serial trial execution. These are bounded work/safety queues, not global human/room quantity caps.

Zero admission defaults are independent of 20/10/5 Hz snapshot selection, WS compression policy and the cached service-pressure/usage projection. They require normal matched-release deployment and observation before any production capacity claim.
