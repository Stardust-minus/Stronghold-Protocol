# Fork development backlog

This file tracks product and engineering work, not live machines, deployment authorization or a history of operations. Actual release receipts, access details and acceptance logs belong in private local records. A completed code feature does not establish that an environment has deployed it.

## Follow-up work

- [ ] Complete pre-existing Japanese, Korean and Traditional Chinese UI translations. Keep strict completeness metadata/checks; do not label a scoped translation pass as a full-pack pass.
- [ ] Investigate the known reflection-chain `hookDepth` edge case separately. Preserve official golden scenarios; a fix must not silently change unrelated combat results.
- [ ] Recheck victory-return/reconnect terminal replay against the current implementation before proposing a fix; the original report predates later terminal-delivery changes.
- [ ] Extend dynamic-illustration support beyond declared static fallback where supported resources and verified rendering are available. Do not claim complete skin/skill-effect pixel parity from model loading alone.
- [ ] Gather natural expanded-party balance feedback and real-device browser coverage. Controlled short battles and phone emulation are not these results.
- [ ] Supplement compute-side performance evidence with separately authorized read-only observations. Local transport benchmarks and native health are not production-capacity proof; no production load tests or automatic profiling.

These items are independent scopes, not instructions to automatically resume archived experiments or production work.

## Implemented capabilities and contracts

### Multiplayer and recovery

- [x] Configurable4/8/12/16/20-player rooms, capacity compatibility and same-capacity/difficulty/rules party matching. Parties remain indivisible; cancellation preserves the original friend room.
- [x] In target20 co-op, ordinary stock belongs to fixed four-seat groups; deaths/leaves do not regroup them. Independent/custom inventory precedence remains.
- [x] Target20 strategy and six-option special selections allow repeats across players, once per player, while retaining authoritative turns/deadlines. Ordinary-mode contracts stay unchanged.
- [x] One frozen population-scaled unite budget, capped at300 game seconds, shared by actual eligible rounds; charge actual natural-release duration without double LP settlement or future-result consumption.
- [x] Rescue preserves existing state and eligibility; it does not reset a player's operators, equipment or economy.
- [x] One coordinator/global matching pool, whole-match game nodes and independent ingress processes; raw game transport goes directly to ingress, with generation and observer privacy fences.
- [x] Dual-ingress deployment generation and scoped, fail-closed lifecycle management. This describes the implementation, not a claim about any live topology or load capacity.

### Client and content

- [x] Unified operator presets for skill/module, ownership/stand-in, DIY/support and skins, with pure preparation, coherent memory update and legacy scoped imports. See [operator presets](docs/OPERATOR-PRESETS.md).
- [x] Skin selection/model loading and display-only fallback. Artwork, declarations, actual dynamic support and full effect parity remain distinct. See [operator skins](docs/OPERATOR-SKINS.md).
- [x] Independent UI and CN/JP/EN voice preferences shared by lobby and in-game settings; missing/failed voice falls back to CN. See [voice languages](docs/VOICE-LANGUAGES.md).
- [x] Optional intro off by default while retaining login assembly, success and entry transitions; reduced motion and gate security remain.
- [x] Lobby announcements and feedback UI; matched-version content updates rather than an unauthenticated hot-update API.

### Execution and release tooling

- [x] Server combat Workers and a separate bounded trial pool, preserving synchronous simulation, cancellation and authority.
- [x] Context-bound, whitelist-controlled WebSocket compression; compression concurrency is not Worker or libuv thread count.
- [x] Host-only Main-thread priority with reset-on-fork and exact process-generation checks; other threads remain0 and containers gain no scheduling capability.
- [x] Fixed-source export, generated-resource inventory and paired private/static release preparation. Public material consumer limits and private/auth security boundaries remain explicit.

## Working rules

- Keep official baseline JSON unchanged and distinguish full, scoped, native and browser coverage.
- Public docs retain reproducible procedures and generic examples, not machine inventories, access channels, private evidence paths or operational authorization history.
- Follow [deployment guidance](deploy/stardust/README.md); Git publication, image creation, provider writes and actual deployment each require their own authorization.
