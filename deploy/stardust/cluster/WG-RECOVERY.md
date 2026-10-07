# Beta cluster WG recovery

`tools/cluster-wg-recover.py` manages only `ark-wg-cluster` and its bootstrap table `inet ak_cluster_beta_boot`. It does not use, stop or change the older WG recovery unit/interface. No default route, sysctl, CNI/Docker table, application lease, private key or live interface is replaced by a warm-start check.

## Protected inputs

Each host keeps `/etc/ark-cluster-beta-wg` root-owned mode0700, with root-owned mode0600 regular files (no links):

- `owner.json`: exact `{owner,local,publicFingerprint}`; owner is `ark-cluster-beta-wg-20261007-7DkMrv`.
- `bootstrap.json`: the same fields plus the original `bootstrapNftSha256` recorded at provisioning.
- `private.key` and `ark-wg-cluster.conf`: existing host-local key/configuration; never export, print, put in argv/environment, or commit their contents.
- `recovery.json`: created atomically by this tool; version1 pins configuration SHA256, public fingerprint, local address, boot identity, bootstrap digest and closed/handed-off phase. Handoff also pins the owning manager project.

The fixed network is core `10.253.78.2/32`, entries `.11`–`.14/32`, MTU1420, UDP51838. Core has four exact keyed peers and the four fixed public entry endpoints with keepalive25; an entry has one core peer and may learn its authenticated dynamic outer endpoint. Arbitrary peers, URLs, subnets, commands and WG post-up hooks are refused. The already-validated WG config snapshot reaches `wg setconf` through stdin, not a later mutable file reopen.

## API and lifecycle

Installed tool paths are `/opt/ark-cluster-beta/tools/`, with the same verified `cluster-host-manager.py`, `cluster-deploy.py` and `main-thread-priority.py` dependencies.

```sh
python3 -I /opt/ark-cluster-beta/tools/cluster-wg-recover.py --action start
python3 -I /opt/ark-cluster-beta/tools/cluster-wg-recover.py --action check
python3 -I /opt/ark-cluster-beta/tools/cluster-wg-recover.py --action handoff
```

Optional `--directory` and `--manager-policy` are protected external root paths, not public administration endpoints. Normal service defaults are `/etc/ark-cluster-beta-wg` and `/etc/ark-cluster-beta/host-policy.json`.

- **Already UP:** verify actual public identity, UDP port/fwmark, exact peer roster/allowedIPs/keepalives/core endpoints, address, MTU and exact routes. Verify the pinned bootstrap and, after handoff, the current manager-owned guard. Do not reset the interface, install a new closed bootstrap over active leases or rewrite application leases. The initial live bootstrap is adopted only when its original protected digest matches.
- **Cold boot:** strictly create the closed bootstrap table before interface/address/routes. A concurrently appearing table makes the native `create table` transaction fail rather than append to a foreign table. Failures leave protection closed; they do not remove an interface/table or roll back unrelated resources.
- **Explicit handoff:** acquire the same `/run/<project>.lock` as the role manager, require its root-owned exact policy/state and actual closed guard with no lease-chain rules, recheck state/kernel digests, then delete only the five unchanged bootstrap DROP rules by exact handles in one transaction. The ICMP exception, chains and table remain. Atomically record the new bootstrap digest/manager ownership. No lease is opened by this operation.

First-install/boot role ordering, before the lifecycle manager starts:

1. `ark-cluster-beta-wg.service` runs recovery `--action start`.
2. The role unit's first `ExecStartPre` runs `cluster-host-manager.py --config /etc/ark-cluster-beta/host-policy.json --action guard`.
3. Its next `ExecStartPre` runs recovery `--action handoff`.
4. The existing role manager `--action serve` starts and performs its separate exact container/thread/readiness/lease checks.

Both role units must include `/etc/ark-cluster-beta-wg` in `ReadWritePaths` alongside `/run` while retaining `ProtectSystem=strict`; their handoff `ExecStartPre` needs to publish `recovery.json`. Without that narrow writable path, metadata publication refuses and startup stays closed.

These steps are not a live-manager takeover recipe. A serving manager holds the writer lock; handoff refuses it. Do not run `--action guard` merely to inspect a live system—it closes this cluster's leases. The WG unit deliberately has no ExecStop/down/re-key command. Do not stop its Requires dependency casually while role units are serving.

## Failure boundaries and verification

External kernel/config/ownership drift refuses without flushing or replacing it. A partial cold start can require manual reconciliation; there is no broad destructive auto-repair. If kernel handoff succeeds but metadata publication fails, the verified manager guard remains closed and role startup fails. The next check deliberately refuses the mismatched phase/digest; inspect/reconcile the exact protected state under maintenance rather than deleting metadata or replaying provisioning.

Unit tests cover protected parsing, foreign preservation, first guard/late failure, warm no-op, handoff locks/open leases/drift/CAS, reboot identity and copied `/opt/.../tools` installation layout. `cluster-wg-kernel-check.py --isolated-netns --role core|edge` runs only in a fresh empty `unshare --net` namespace, verifies real WG/nft operations and sentinel preservation, and never uses host `/run` state. It uses installed WG or the hash-pinned previously prepared local test binary, not a download.

This validates startup configuration and isolated kernel behavior, **not** a whole-host reboot, real peer handshake, external reachability, traffic capacity, application state recovery or coordinator HA. Do not rerun completed `wg-prepare.py` provisioning/setup actions to install this tool.
