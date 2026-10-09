#!/usr/bin/env python3
"""Run ONLY under a NEW `unshare --net` namespace; never touches host net tables."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_kernel_host', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-netns', action='store_true')
    parser.add_argument('--profile', choices=tuple(host.deploy.profiles.PROFILES), default='beta')
    parser.add_argument('--ingress-instances', type=int, choices=(1, 2), default=1)
    parser.add_argument('--tmp-parent', default='/root')
    args = parser.parse_args()
    if not args.isolated_netns:
        raise SystemExit('isolated network namespace required')
    # Parent namespace must differ, and a fresh namespace must contain no host interfaces/tables.
    if os.geteuid() != 0 or os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise SystemExit('host namespace refused')
    nft = host.Nft()
    tables = json.loads(nft.command(['-j', 'list', 'tables']))['nftables']
    if any('table' in row for row in tables):
        raise SystemExit('namespace is not empty')
    root = Path(tempfile.mkdtemp(prefix='ark-cluster-kernel-', dir=args.tmp_parent))
    os.chmod(root, 0o700)
    try:
        # A foreign sentinel models Docker/CNI/other services. Its exact table bytes must remain unchanged.
        nft.apply([{'add': {'table': {'family': 'inet', 'name': 'foreign_sentinel'}}},
                   {'add': {'chain': {'family': 'inet', 'table': 'foreign_sentinel', 'name': 'input',
                                      'type': 'filter', 'hook': 'input', 'prio': 100, 'policy': 'accept'}}},
                   {'add': {'rule': {'family': 'inet', 'table': 'foreign_sentinel', 'chain': 'input',
                                     'expr': [{'counter': {'packets': 0, 'bytes': 0}}, {'accept': None}]}}}])
        foreign_before = host.digest(nft.snapshot('foreign_sentinel'))
        cases = 0
        for role in ('core', 'edge'):
            policy = host.deploy.generate(root / role, image='sha256:' + 'b' * 64,
                                          build='a' * 40, manifest_sha256='a' * 64,
                                          source_kind='tree', role=role, profile=args.profile,
                                          ingress_instances=args.ingress_instances if role == 'edge' else 1)
            guard = host.Guard(policy, nft=nft, state_file=root / (role + '-guard.json'))
            closed = guard.update({})
            assert not closed['leases']
            cases += 1
            leases = {row['service']: {'network_id': 'd' * 64, 'container_id': format(index, '064x'),
                                      'image_id': policy['image_id'], 'revision': policy['build'],
                                      'started_at': 'test-only-' + str(index), 'restarts': 0,
                                      'init_pid': 1000 + index, 'init_start': 100 + index,
                                      'main_pid': 2000 + index, 'main_start': 200 + index,
                                      'container_ip': row['container_ip'], 'runtime_sha256': row['runtime_sha256'],
                                      'node_generation': None}
                      for index, row in enumerate(policy['targets'], 1)}
            opened = guard.update(leases)
            guard.check(leases)
            assert opened['leases'] == leases
            cases += 1
            if host.dual_ingress(policy):
                for service in ('ingress', 'ingress-02'):
                    retained = host.revoke(policy, guard, service)
                    assert retained == {name: lease for name, lease in leases.items() if name != service}
                    guard.check(retained)
                    assert guard.state()['desired'][service] == 'revoked'
                    guard.update(leases, resume=service)
                    guard.check(leases)
                    cases += 1
                retained = host.revoke(policy, guard, 'ingress')
                save = guard.save; failed = []
                def fail_publication(value, before):
                    if before is not None and 'pending' in before and not failed:
                        failed.append(True); raise OSError('injected kernel publication write failure')
                    return save(value, before)
                guard.save = fail_publication
                try:
                    try:
                        guard.update(leases, resume='ingress')
                        raise AssertionError('publication failure not injected')
                    except OSError:
                        pass
                finally:
                    guard.save = save
                guard.check(retained)
                assert not any('pending' in key for key in guard.state())
                cases += 1
                apply = nft.apply; fired = []
                previous_handler = signal.getsignal(signal.SIGTERM)
                def interrupted(_number, _frame):
                    raise host.Stopped()
                signal.signal(signal.SIGTERM, interrupted)
                def terminate_after_apply(commands):
                    apply(commands)
                    if not fired:
                        fired.append(True); signal.raise_signal(signal.SIGTERM)
                nft.apply = terminate_after_apply
                try:
                    try:
                        guard.update(leases, resume='ingress')
                        raise AssertionError('SIGTERM gap not injected')
                    except host.Stopped:
                        pass
                finally:
                    nft.apply = apply
                    signal.signal(signal.SIGTERM, previous_handler)
                guard.check(retained)
                cases += 1
                recover = guard.recover_transaction
                def crash_publication(value, before):
                    if before is not None and 'pending' in before: raise OSError('simulated killed writer')
                    return save(value, before)
                def unavailable(*_args, **_kwargs):
                    raise OSError('writer unavailable')
                guard.save, guard.recover_transaction = crash_publication, unavailable
                try:
                    try:
                        guard.update(leases, resume='ingress')
                        raise AssertionError('crash gap not injected')
                    except OSError:
                        pass
                finally:
                    guard.save, guard.recover_transaction = save, recover
                assert 'pending' in guard.state()
                nft.apply([{'add': {'rule': {'family': 'inet', 'table': guard.table, 'chain': 'lease',
                                            'expr': [{'counter': {'packets': 0, 'bytes': 0}}]}}}])
                foreign = [row['rule']['handle'] for row in nft.snapshot(guard.table)
                           if row.get('rule', {}).get('chain') == 'lease'
                           and any('counter' in expr for expr in row.get('rule', {}).get('expr', []))]
                assert len(foreign) == 1
                drift = host.digest(nft.snapshot(guard.table))
                try:
                    guard.create()
                    raise AssertionError('journal accepted foreign drift')
                except host.Refused:
                    pass
                assert host.digest(nft.snapshot(guard.table)) == drift
                cases += 1
                # Remove ONLY this fixture's exact injected counter row; not a recovery bypass.
                nft.apply([{'delete': {'rule': {'family': 'inet', 'table': guard.table, 'chain': 'lease', 'handle': foreign[0]}}}])
                guard.create(); guard.check(retained)
                assert 'pending' not in guard.state()
                cases += 1
                guard.update(leases, resume='ingress')
            guard.update({})
            guard.check({})
            assert not any(row.get('rule', {}).get('chain') == 'lease' for row in nft.snapshot(guard.table))
            cases += 1
            guard.update(leases)
            # Foreign changes inside the owned table are NOT silently overwritten or flushed.
            nft.apply([{'add': {'rule': {'family': 'inet', 'table': guard.table, 'chain': 'lease',
                                         'expr': [{'counter': {'packets': 0, 'bytes': 0}}]}}}])
            try:
                guard.update({})
                raise AssertionError('guard overwrote external drift')
            except host.Refused:
                pass
            cases += 1
            assert host.digest(nft.snapshot('foreign_sentinel')) == foreign_before
            cases += 1
        print(json.dumps({'event': 'cluster-isolated-kernel-check', 'profile': args.profile,
                          'ingressInstances': args.ingress_instances, 'cases': cases, 'passed': cases,
                          'scope': 'new netns nft grammar/closed-open-close/CAS/foreign-table preservation',
                          'trafficAcceptance': False}))
        return 0
    finally:
        shutil.rmtree(root)


if __name__ == '__main__':
    raise SystemExit(main())
