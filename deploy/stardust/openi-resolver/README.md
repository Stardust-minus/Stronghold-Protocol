# OpenI public asset resolver

Backend-only, dependency-free Node 24 sidecar for public `/assets/` and `/media/` resources. It resolves a manifest-listed object through OpenI's public dataset API, validates the returned signed OSS capability, and gives the browser a **302, `Cache-Control: no-store`** redirect. Asset bytes do not traverse the sidecar. Fonts, vendor, PRTS, authentication and game routes are outside its scope.

This directory does not activate any production route or restart any existing service. Upload, byte/hash preflight, browser/MIME/Range/CORS/CSP verification and Nginx integration must finish separately before an authorized switch. Follow `../UPDATE-SOP.md`; preserve the matched game/static release and immutable mirror ID.

## Manifest and trust boundary

Mount the generator's JSON at `/run/config/openi-assets.json`, or set `ASSET_MANIFEST` to another local file. Its exact schema is:

```json
{
  "schemaVersion": 1,
  "release": "v012-workers-20261004",
  "dataset": "Stardust_minus/arknight_assets",
  "apiOrigin": "https://openi.pcl.ac.cn",
  "ossOrigin": "https://obs.cn-south-222.ai.pcl.cn",
  "ossPathPrefix": "/fefced50e2d744508e4bc7e2792e1087-urchin2/ea9189b2-1aa3-4108-ae36-9dfb0ab139f4/",
  "fallbackBase": "https://ark-asset.hanabi-ai.cn:25442/releases/v012-workers-20261004",
  "entries": [
    {
      "requestPath": "/assets/example.png",
      "fileName": "releases/NEW_IMMUTABLE_MIRROR/assets/example.png",
      "bytes": 123,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "mime": "image/png"
    }
  ]
}
```

The entry above is a schema example, not a verified inventory. The deployed manifest must contain the generator's actual bytes, hashes and MIME. These fields validate configuration and deduplication; the resolver does **not** download or verify asset bodies. The uploader/preflight must verify them first.

Origins and dataset are pinned in code. The fallback must be the trusted Ningxia origin plus `/releases/<release>`, with no query/fragment. All object names belong to one new mirror ID below `releases/<mirror>/{assets,media}/`. Paths use the existing preparation tool's safe ASCII segment convention, including square brackets; hidden/dot segments, empty segments, trailing dots and traversal are rejected. Art/audio suffixes are allowlisted for `/assets/`. `/media/` aliases are exact inventory entries, not an extension resolver.

All aliases to the same `fileName` must have identical bytes/hash/MIME. Audio objects under remote `media/` are extensionless. For example, `/assets/audio/example.mp3`, `/media/example`, and the seven explicit `/media/example.<audio extension>` aliases can point to the same `releases/<mirror>/media/example` object. No uploaded duplicate audio directory is needed.

The only upstream call is a public, unauthenticated **GET**, with native fetch and `redirect: 'manual'`:

```text
https://openi.pcl.ac.cn/api/v1/dataset/file
  ?dataset_name=Stardust_minus%2Farknight_assets
  &file_name=<URLSearchParams-encoded logical relative path>
  &parent_dir=
```

Only API status 301 is accepted. Its Location must be HTTPS on the manifest's approved OSS origin, with no port except omitted/default 443, userinfo or fragment. Its decoded pathname must equal `ossPathPrefix + fileName` exactly. Only `AWSAccessKeyId`, future integer `Expires`, `Signature`, and optional `response-content-disposition` query keys are allowed; duplicates, malformed escapes, controls and any `loginToken` or unknown key are rejected. The original signed URL string is retained unchanged in the signature cache after validation. There is no account token feature and no SDK dependency.

HTTP redirects append one fixed cache-only discriminator, `sp_request=cors` or `sp_request=display`, and send `Vary: Origin, Sec-Fetch-Mode`. The value is selected from CORS request mode/Origin presence, never copied from caller query data; all existing signed fields, the object path and expiry are untouched. The approved Signature V2 endpoint has been live-tested to accept both variants with identical file hashes. **Both normal variants still go to OBS**, not Ningxia. This prevents a display-only response (OBS omits ACAO without Origin and has no Vary) from poisoning the browser cache for a later CORS reader of the same image. Both variants reuse one upstream signing call.

This is a compatibility dependency, not an OpenI contractual promise. A file used in both modes may occupy two browser cache entries. If the provider changes query acceptance, rerun the real GET/CORS/browser checks before using it; a redirect-only service cannot detect every downstream OSS failure. Fallback covers resolver/API failure, not an arbitrary error after the browser has followed a valid redirect.

Client query strings never influence the upstream URL or cache key. Client cookies, credentials, Range and other headers are never forwarded. Unknown or malformed paths return 404 without upstream resolution or fallback. Encoded safe characters are decoded once for exact lookup; encoded path separators and double-encoded traversal are rejected before URL normalization.

## Cache, limits and failure behavior

- One in-memory signed URL per known unique `fileName`; all aliases share it. No unbounded caller-controlled cache keys.
- A URL is usable only until **Expires minus 30 seconds**. Cold misses singleflight, including aliases. At response time, an unusable/expired URL is never returned.
- A warm hit returns immediately. In the last 120 seconds before the usable cutoff (plus deterministic 0–30 second per-file jitter), it launches one background refresh. Refresh is demand-driven; idle files generate no API traffic.
- Failed refresh keeps the old URL while it remains usable. Per-file exponential failure cooldown starts at 1 second with deterministic jitter and caps at 30 seconds, preventing hot-key retry storms.
- At most **4** resolution jobs are active and **128** unique-file jobs are queued. Queued jobs time out after 5 seconds. Each API attempt times out after 5 seconds. Transient network/timeout/500/502/503/504 failures retry once with bounded backoff (maximum 2 seconds). The slot remains occupied during backoff.
- 429 establishes a global cooldown from Retry-After (integer seconds or HTTP date). If waiting exceeds the bounded retry delay, return fallback now rather than retry earlier than instructed. Cached valid URLs remain usable during cooldown.
- Queue overflow, timeout, unsupported API response, malformed/expired destination or API failure yields a temporary 302 to **the same trusted `fallbackBase + requestPath`**, without carrying caller queries. Unknown paths never fall back.
- Known HEAD requests **always** redirect to Ningxia, even if cached: OpenI's GET signature cannot authorize OSS HEAD. Known OPTIONS returns local 204 with CORS `*` and allowed methods/Range-related headers. Other methods return 405.
- All public responses and redirects are no-store, with CORS `*`, no credentials, and no response body containing a capability. Never permanently cache a signed Location.

OpenI currently gives GET-signed URLs with roughly one-hour expiry. The OSS GET/Range endpoints are publicly CORS-enabled, but default to binary MIME and reject HEAD. Only art/audio use this sidecar; JavaScript modules, fonts and PRTS must remain on their verified existing delivery path. Application/browser verification of audio, PNG/skel/atlas/OBJ/JSON remains mandatory.

## Run and verify locally

The normal executable binds `127.0.0.1:3000`. `HOST` must be an IP literal; `PORT` must be a valid port. Configuration fails closed before listening. Docker sets `HOST=0.0.0.0` for container networking; publish its host port on loopback only.

```sh
ASSET_MANIFEST=/path/to/verified/openi-assets.json node deploy/stardust/openi-resolver/server.mjs

# Offline tests, using the pinned Node 24.14.0 image already present locally.
docker run --rm --network=none \
  -v /root/projects/Stronghold-Protocol/deploy/stardust/openi-resolver:/app:ro -w /app \
  node@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 \
  sh -c 'node --test test/*.test.mjs'

# Build only this directory; no npm installation or writable runtime path is needed.
docker build --network=none --pull=false \
  -t ark-openi-resolver:local deploy/stardust/openi-resolver
# Start only an isolated local sidecar, not an existing production stack.
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:13000:3000 \
  -v /path/to/verified/openi-assets.json:/run/config/openi-assets.json:ro \
  ark-openi-resolver:local
```

Run these commands from the repository root. Docker uses the pinned base digest, `USER node`, an allowlist build context, and localhost:3000 HEALTHCHECK. It contains only `server.mjs`, not the manifest, tests, credentials or art. The mounted public-inventory JSON must be readable by container UID 1000. Memory cache needs no disk writes.

`GET /healthz` (and HEAD) accepts only a loopback TCP peer, ignores forwarding headers, omits public CORS, and reports counts for `cache`, `hits`, `misses`, actual `apiRequests`, `refreshes`, `failures`, `active`, `queued`, `fallbacks`, `entries`, and deduplicated `files`. `cache` counts currently usable URLs. Non-loopback peers receive 404. With Docker port publishing, even a host-local request can arrive from a bridge peer rather than container loopback, so a host `localhost:<published port>/healthz` check is not supported. Use the built-in container HEALTHCHECK, or query `http://127.0.0.1:3000/healthz` from inside that container via `docker exec`. **Nginx must not expose `/healthz`**: a reverse proxy's loopback peer is not proof its browser client is private. Do not log resolver Location headers; redact upstream proxy logs that would capture signed capabilities.

No request URL, query, response body, token or upstream error text is logged. Executable lifecycle logs contain only static events and the local port. SIGTERM/SIGINT abort active fetches/backoffs, clear queue/deadline timers, settle waiters and close connections.

## Testable API

Importing the module starts nothing. Default export `OpenIResolver` takes `{ manifest, fetchImpl, clock, ...limits }`; `clock` returns epoch milliseconds. `resolve(rawOriginFormTarget, method = 'GET')` returns a status and, for redirects, Location/fallback metadata. `health()` returns counts, and `close()` aborts work. The constructor accepts tighter concurrency, queue, timeout and retry bounds for isolated tests, not looser upstream limits.

`startServer({ manifest, host: '127.0.0.1', port: 0, fetchImpl, clock })` starts an ephemeral localhost server and returns `{ server, resolver, close }`. Alternatively supply `manifestPath` to exercise the mounted-file configuration. Exported validation helpers support contract/security tests. The tests use injected clocks/fetch and real localhost HTTP; they do not contact OpenI, OSS or either production host.
