# Owned WireGuard boot recovery

This document describes the owned startup/recovery contract, not an installed or
verified environment. Actual host-tool revisions, protected inputs and verification
results belong in local private release records; see [record boundaries](releases/README.md).
A template or isolated bootstrap check does not establish a whole-host reboot.

## Scope and startup

- `ark-wireguard-route.service` is a root/Nice=0 oneshot, ordered after network-online
  and before the core/Beta backend managers. Both manager templates Require/After
  this unit. There is no WG stop/teardown command.
- Ship `wg-route-restore.py`, `wg-backend-access.py`, and `main-thread-priority.py`
  together at the approved host-tool revision. Do not put them in the game image.
- Recovery uses the same root-owned WG flock as the managers, with the bounded
  15-second wait. Ownership, modes, symlinks, fixed role/IP pair, public identity,
  config/tool SHA-256 pins, and routing baseline are checked before mutation.
- If the approved owned table and a fully committed/verified interface already
  exist, recovery performs read-only verification. It neither saves the manifest
  nor applies nft/route/link changes; exact core/Beta leases and CIDs remain intact.
- Only when both the interface and table are absent does bootstrap create the
  native owned nft table in an atomic transaction (`create`, not permissive `add`).
  All remembered profiles are closed and leases cleared before bringing WG up;
  that guarded state is persisted with the shared Store's compare-and-save checks.
  Managers later open only their own verified current-generation leases.
- WG configuration remains fixed to one role-specific peer `/32`, one local `/32`,
  and the approved MTU/port/endpoint. Hooks, DNS, Table, SaveConfig, additional peers,
  and broader address/AllowedIPs scopes are refused. The helper never manages
  default routes, policy routing, CNI/Docker/NAT tables, or sysctls.

## No automatic cleanup

Standard upstream `wg-quick up` arms `trap 'del_if; exit' INT TERM EXIT` after an
independent name-existence check. That cleanup can delete a foreign interface if
another privileged actor creates/replaces the same name during failed startup.

Recovery therefore runs only this fixed bash command after file verification:

```sh
/bin/bash --noprofile --norc -c 'trap() { :; }; readonly -f trap; source /opt/ark-wg-test/bin/wg-quick up /etc/ark-wg-test/ark-wg-test.conf'
```

The readonly no-op function suppresses the standard script's trap installation and
removal, including its name-only failure cleanup. Sourcing preserves its
`BASH_SOURCE[0]`, `SELF`/tool-directory PATH, and `up`/config positional arguments.
No existing WG tool bytes or manifest hash pins need to change. The command runs
with a minimal fixed environment and captured/redacted output; private input to
`wg pubkey` is stdin-only. There is no wrapper `down` action.

On failure the helper does not down/delete an interface, delete a table, or retry a
manifest write. Any committed new backend guards remain closed. A retained table
without its interface, an interface without its approved table, an incomplete
`guarded` marker, identity/schema drift, or foreign state requires manual review;
re-running recovery is not an automatic repair/rollback mechanism. Partial links
may remain up, but closed guards and refusal prevent manager startup.

This wrapper disables standard wg-quick automatic cleanup, not all possible
privileged races. It assumes the pinned standard script uses ordinary `trap` calls
and trusted root actors coordinate through the WG flock. It does not protect
against malicious root, arbitrary tool/config/network replacement, explicit
`builtin trap`/`del_if` in different tool bytes, or non-cooperating network managers.
The installed pinned script's compatibility must be reviewed before installation.
Never stop/restart the recovery unit while live managers depend on it: `Requires=`
can propagate explicit unit stops to those managers and interrupt active games.

## Verification and operational limits

The recovery tests inject files, stores, nft and host state; temporary bash fixtures
exercise source identity/arguments, success/failure exit codes, INT/TERM/HUP,
redaction, and suppression of `del_if`, with no real network command or secret read.
Related lease/manager/priority tests and systemd unit verification are separate
checks. Isolated network-none kernel fixtures should cover edge/core bootstrap,
exact repeated-state preservation, foreign-interface refusal, post-up failure and
final-store failure. Device-scoped route output may omit `dev`; that omission does
not permit an explicit wrong device or weaken the separate peer-route lookup.

A warm-start check must preserve the manifest, owned table, default routes/rules,
backend leases and current generations exactly. Enabling dependency wiring must not
implicitly restart a manager. None of these checks proves a whole-host reboot,
remote peer throughput or resilience to arbitrary privileged network changes.
