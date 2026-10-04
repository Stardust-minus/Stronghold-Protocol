# Stardust fork working guidance

## Current development batch

- `.claude/release-progress.md` records the latest user request to push/release this verified batch first and defer further main-thread offload. Check live match counts before the first disruptive installation; the last read showed significant activity, not an empty server.

- Latest upstream sync is in progress: read `.claude/upstream-sync.md` for the retained feature checkpoint, resolved but uncommitted merge of `bdb0765`, and Linux-only validation scope. The user explicitly stopped Windows-specific adaptation/packaging.

- Read `TODO-STARDUST.md` for the resumed batch: non-disruptive server updates, online player count, pregame revival voting / teammate revival, and public multiplayer matchmaking. Announcements were explicitly cancelled and replaced by revival. The user additionally requested server-authoritative displayed-name/callsign moderation, shared with the password-gate callsign entry. Complete and verify the whole batch before the planned low-traffic game-service restart. Do not prematurely deploy the separate pacing hotfix.
- `.claude/alliance-progress.md` records the resumed batch's in-progress code, current user rules (state-preserving death cancellation, donor LP >=11), agent ownership and local tests. Read it before resuming; old exact-10/cleared-inventory revival tests are superseded.
- `.claude/compact-handoff.md` records the pre-resume local/production checkpoint, including the still-unpublished game fix and the warming-only asset standby. It supersedes historical state in `.claude/worker-notes.md`. Repository templates are not proof of which production slot is active.

## Repository and deployment boundaries

- `origin` is the user-owned Stardust-minus/Stronghold-Protocol fork; `upstream` is sganggs/Stronghold-Protocol.
- This fork's `master` is the integration branch. Develop on a feature/sync branch first; merge without rewriting published history. Commit/push only when requested.
- Development checkout: `/root/projects/Stronghold-Protocol`. Deployment customizations live in `deploy/stardust/`; read its README and UPDATE-SOP before any release work.
- A commit, merge or push is not deployment authorization. The 0.1.2 + Worker rollout is recorded in deploy/stardust/releases/v012-workers-20261004.json (runtime source 2878299); later documentation commits do not change the running image. For future releases, finish local verification and obtain explicit release-window authorization before restarting production. Never interrupt active games as a side effect of local development.
- The game keeps rooms, sessions and matches in process memory. Recreating it loses them. Auth and static services are separate; do not restart the game to change their files.
- Game image, assets, fonts and vendor must be a matched release. Upload and verify the new immutable static directory before a coordinated game release; rollback both sides together. Review new upstream resource routes, including `/media/`, rather than assuming `/assets/` remains the only path.

## User-specific constraints

- PRTS/login frontend implementation and visual verification must be done by the main assistant, not delegated to a subagent. Read-only investigation and backend work are not prohibited.
- Preserve the password gate, custom callsign, entry replay and animations unless explicitly asked to change them.
- Public static resources are intentionally unsigned with `Access-Control-Allow-Origin: *`, without credentials. This does not authorize making game code/data/API/auth/WebSocket public.
- Game runtime remains `SP_COMBAT=server`, `SP_VERIFY=off`. Do not silently restore removed game CPU/memory limits from an old Compose file.
- Do not commit or echo passwords, cookies, signing/verifier files, SSH/DNS credentials, certificates or private keys. Do not commit game art or generated vendor builds. Use explicit staging paths and review the staged diff before pushing.

## Local development and tests

- Node ESM, native HTTP + ws, no application bundler/build step. Match the surrounding code style; do not introduce frameworks or Redis for the approved Worker work.
- Use the lockfile. `npm ci` prepares client vendor via postinstall; game art/fonts are separately provisioned.
- `node deploy/stardust/tools/prepare-auth-assets.mjs` generates ignored PRTS library/font files from installed dependencies and local fonts, without network access.
- `npm test` is the unit/integration baseline. Auth tests are also runnable with `node --test deploy/stardust/auth/test/*.test.mjs`.
- Actual browser/WS smoke tests are required for gameplay/renderer changes. Run new load tests on localhost or isolated local containers, not on production.
- Worker work must preserve the synchronous/virtual-scheduler backend. Same-phase boss fields share a pool: never split shared HP/LP/ending authority across threads without an ordered design. Use generation IDs, cancel old tasks, and prevent duplicate settlement. Full internal results must retain `synthetic` and all settlement fields.
