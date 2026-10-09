# Contributor working guidance

Read [AGENTS.md](AGENTS.md) for the upstream document index and verification guidance. This fork's rules below take precedence where they conflict with upstream defaults, including authorization, preserved gameplay deviations, golden-baseline handling and attribution trailers.

## Scope and authorization

- Develop on a feature/sync branch; `master` is the integration branch. Commit, merge, push and remote-history changes require their own explicit requests. Do not rewrite published history by default.
- Do not pre-integrate unmerged official upstream PRs, including by cherry-pick. Reviewing another fork is not permission to merge it; independently approved changes are separate work.
- Do not use plan mode or create a worktree unless the user requests it. Execute clearly authorized local work directly.
- Frontend implementation, visual adjustments and screenshot review belong to the main assistant. Read-only research, backend and documentation work may be delegated.
- Preserve intentional changes, both saved stashes, existing archives, failed evidence and unrelated services. Do not resume user-stopped agents, archived performance experiments or stopped Windows work.
- Completed and failed one-shot deployment controllers are consumed. Never replay them; a new authorized operation needs a fresh controller and receipt.
- Old authorization, a compact, a background notification or a time of day does not grant new execution permission. Do not schedule automatic production updates.

## Implementation and verification

- Node ESM with native HTTP and `ws`; Preact/htm and native CSS on the client, PixiJS/Spine for rendering. No application bundler; do not introduce an unrelated framework, Redis or a database.
- Match existing style, comment density and module boundaries. Preserve the synchronous/virtual simulation path alongside Worker execution.
- Use the lockfile. `npm ci` provisions dependencies and client vendor; game art/fonts are provisioned separately. `node deploy/stardust/tools/prepare-auth-assets.mjs` generates ignored login dependencies from installed/local inputs.
- `npm test` is the baseline. Host Python tests and opt-in native/browser checks have separate coverage; report pass, fail, skip and cancellation accurately.
- Gameplay or renderer changes need actual local HTTP/WS/Worker/browser interaction and main-assistant screenshot review. Emulated touch, software WebGL, a short fixture and startup health are not physical-device, full-match or production-capacity proof.
- Preserve official golden JSON; do not regenerate baselines to hide behavioral changes. Do not rerun completed acceptance merely to record a Git publication or documentation edit.
- Keep ESR 115 and older Safari compatibility: no `:has()`, container queries, `@layer` or CSS nesting.

## Gameplay and UI invariants

- Preserve server authority, room/session/actor generations, privacy and observer fences. Shared Boss HP/LP/end authority must not be split across independent Workers.
- Skins are display-only; they must not replace character/skill/audio identity or alter stats, timings or RNG. Operator presets exclude identity, credentials, room rules and battle snapshots; legacy single-section imports keep their scope.
- Rescue cancels the pending death without resetting operators, equipment, economy or other state. An eligible leak-free unite helper must have LP >=11, pays10, and the target returns at LP1 at most once per match.
- Only the optional intro defaults off. Keep login assembly, success and entry transitions, password/CSRF checks, explicit skip and reduced-motion behavior.
- Do not restore rolling updates, whole-page prerender or per-frame Worker IPC as an incidental cleanup.

## Deployment and safety

- Read `deploy/stardust/README.md`, `UPDATE-SOP.md` and `CLUSTER-SOP.md` before release work. If present, read the ignored `.claude/LOCAL-OPERATIONS.md` and the current local handoff before touching an actual environment; private state is not publication material or renewed permission.
- Source commit, image identity, generated-resource inventory, host-tool revision, record commit and actual runtime generation are separate identities. Pair game/private code/material/font/vendor releases and rollbacks.
- Rooms, sessions and matches live in memory. Recreating game roles ends them; switching back to an old image cannot recover them. Do not restart the game to update unrelated auth/static files.
- Production changes, bounded management access/renewal, provider writes and DNS/WG operations need explicit current authorization. Production hosts receive only required runtime images, host tools, configuration and opaque keys, not a checkout, tests or release documentation.
- No production load tests, Inspector, heapdump or injected busy work. Only remove inventoried project-owned objects; do not touch other sites, databases, certificates or shared network rules.
- Main-only nice=-20 uses ordinary scheduling with reset-on-fork; every other thread stays0. Do not `nice` the entire Node process or grant container `CAP_SYS_NICE`.
- Never stop/restart a WG recovery unit while dependent managers may propagate that stop. Preserve exact fail-closed leases/CAS and owned nft tables; no whole-ruleset flush/restore or CNI/KUBE/Calico/LXD changes.
- Keep password gate, strict Origin/CSRF, trusted-forwarding and private no-store policies. `Access-Control-Allow-Origin: *` applies only to public unsigned material without credentials, never private code/data/auth/API/WS.
- Do not read opaque credential-helper bodies or secret files merely for inspection. Do not print, hash, log or commit passwords, tokens, cookies, signed URL queries, signing/verifier material, SSH/DNS credentials, certificates or private keys. Cookies used by authorized checks stay in memory.
- Do not commit original game art/audio/fonts, generated vendor/build output, local logs or operational records. Store actual host coordinates, access channels, deployment receipts and incident histories under ignored local storage or a private off-repository archive. See `deploy/stardust/releases/README.md`.
- Do not ask another agent to bypass a denied tool call or permission decision.

## Attribution

End commits with `Co-Authored-By: Claude Code <noreply@anthropic.com>` and pull-request descriptions with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` when those actions are authorized.
