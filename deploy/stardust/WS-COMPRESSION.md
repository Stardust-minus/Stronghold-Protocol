# Bounded WebSocket compression

Formal activation:2026-10-06 14:30:23+08, source7e019ee3/image10c94333; see `releases/v013-ws-compression-20261006-7e019ee3-r2.json`. Beta remains its previous C1 version. Public WSS negotiation and per-frame policy were actually verified; early-round snapshots at most226bytes correctly stayed plain, while large events/field/damage frames compressed. This release also updates the separately versioned welcome announcement; the feature itself does not change other game data or frontend resources.

`SP_WS_COMPRESSION=on` opts this game process into the verified transport preset. The default is `off`; any other value is refused before workers or listeners start. This is not an HTTP gzip setting or a hot reload.

Preset: level 6, memLevel 5, server window 12 (4 KiB), 512-byte threshold, both directions without context takeover, and a ws zlib concurrency limit of 8. Leave the process-wide libuv pool at its existing/default size 4; this limit does not create eight threads or change the 12+2 combat/trial pool.

Only `b.snap`, `b.ev`, `m.field`, and `m.damage` are eligible for server compression. Credential-bearing `welcome`, unknown/control messages, presence, private state and saved result replay default to `compress: false`, even if large. Already-encoded Worker frames retain the trusted message-type decision without parsing JSON again. Backpressure, inbound decompressed 64 KiB maximum, admission, rate limits and session behavior remain unchanged. Clients without the extension still receive ordinary messages.

## Evidence and boundaries

Local Node24 tests and an isolated replay on the actual Hangzhou Gold6548Y+ used two deterministic real-engine fixtures, not production traffic. In the 500-active-viewer transport replay, limit8/pool4 reduced total CPU from83.8% to74.0% and main CPU from34.3% to29.8% of one logical core compared with limit4/pool4. All compression cases saved68.1% of WS frame bytes. Increasing the actual pool to8/16 did not meaningfully improve delivery p99 and increased CPU. Observed short-run RSS was higher with larger in-flight limits; long-term fragmentation/stability is not proved.

The measurement excludes full-game simulation, TLS, WAN and WG, and500 active viewers is not500 online identities. It is not a prediction that all Jiaxing WAN traffic falls by68%. The game's original pool/default scheduling policy is unchanged: only Main is nice-20/reset-on-fork, other threads remain0, no container CAP_SYS_NICE or game CPU/memory hard caps.

## Activation and rollback

Use a fixed tested commit/image pair, record the actual deployed image ID and append only its approved pair to the owned core profile. Add the flag to the fixed runtime.env and Compose environment with byte/hash CAS and fresh backups. Stop/start only the approved core manager; stopping it closes its own WG lease and stops its own game. Do not stop/restart WG, other managers, auth, resolver, OpenResty or unrelated services.

A game restart loses in-memory matches. Immediate maintenance requires explicit user authorization; an approval to develop or push is not that authorization. Old image/configuration and its allowlist pair remain rollback materials, not recovery of lost matches. The flag may be returned tooff in a later authorized restart, or the matched old image/config restored.

No frontend, package/lock, shared/data or public resource changes are required by this feature. Existing private JS/CSS and assets may be reused only after fixed-commit byte/tree equality is proved; do not upload or overwrite immutable resources merely to change this server-only option. Authentication keys, verifier and TLS are a separate unchanged release line.
