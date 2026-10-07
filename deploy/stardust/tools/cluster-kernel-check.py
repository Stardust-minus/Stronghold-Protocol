#!/usr/bin/env python3
"""Run ONLY under a NEW `unshare --net` namespace; never touches host net tables."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
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
    root = Path(tempfile.mkdtemp(prefix='ark-cluster-kernel-', dir='/root'))
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
                                          source_kind='tree', role=role, profile=args.profile)
            guard = host.Guard(policy, nft=nft, state_file=root / (role + '-guard.json'))
            closed = guard.update({})
            assert not closed['leases']
            cases += 1
            leases = {row['service']: {'network_id': 'd' * 64, 'container_id': 'c' * 64,
                                      'started_at': 'test-only', 'main_pid': 1} for row in policy['targets']}
            opened = guard.update(leases)
            guard.check(leases)
            assert opened['leases'] == leases
            cases += 1
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
        print(json.dumps({'event': 'cluster-isolated-kernel-check', 'profile': args.profile, 'cases': cases, 'passed': cases,
                          'scope': 'new netns nft grammar/closed-open-close/CAS/foreign-table preservation',
                          'trafficAcceptance': False}))
        return 0
    finally:
        shutil.rmtree(root)


if __name__ == '__main__':
    raise SystemExit(main())
