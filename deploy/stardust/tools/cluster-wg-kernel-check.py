#!/usr/bin/env python3
"""WG recovery verification ONLY inside a new empty `unshare --net` namespace."""
from contextlib import nullcontext
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
spec = importlib.util.spec_from_file_location('kernel_cluster_wg', BASE / 'cluster-wg-recover.py')
wg = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wg
spec.loader.exec_module(wg)


class KernelProof:
    def __init__(self, config, root, nft):
        self.config = config
        self.policy = wg.host.deploy.generate(root / 'policy', image='sha256:' + 'b' * 64, build='a' * 40,
                                              manifest_sha256='a' * 64, source_kind='tree', role=config.role, profile=config.profile)
        self.guard = wg.host.Guard(self.policy, nft=nft, state_file=root / 'manager.guard.json')

    def lock(self):
        return nullcontext()  # Single isolated test process; never acquires host /run locks.

    def check(self, closed):
        state = self.guard.state()
        self.guard.check({} if closed else state['leases'])
        if closed:
            assert not any(row.get('rule', {}).get('chain') == 'lease' for row in self.guard.nft.snapshot(self.guard.table))
        return {'project': self.policy['project'], 'state': state, 'policy': self.policy}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--isolated-netns', action='store_true')
    parser.add_argument('--profile', choices=tuple(wg.profiles.PROFILES), default='beta')
    parser.add_argument('--role', choices=('core', 'edge'), default='core')
    args = parser.parse_args()
    if not args.isolated_netns or os.geteuid() != 0 \
            or os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise SystemExit('new isolated network namespace required')
    p = wg.profiles.get_profile(args.profile)
    prepared = BASE.parents[2] / '.cache/stardust/wg-kernel-test-tools/wg'
    if not Path('/usr/bin/wg').is_file() and not Path('/opt/ark-wg-test/bin/wg').is_file():
        # Previously prepared local kernel-test dependency, never a download/extraction cwd.
        if not prepared.is_file() or hashlib.sha256(prepared.read_bytes()).hexdigest() != 'db75235c853de9bb1c20df798ab86c9a3bc4bdf3fc66758e1aaed6f5e23973a8':
            raise SystemExit('prepared WG test dependency unavailable')
        system = wg.System(wg_binary=prepared, profile=args.profile)
    else:
        system = wg.System(profile=args.profile)
    tables = json.loads(system.nft.command(['-j', 'list', 'tables']))['nftables']
    links = json.loads(system.command([system.ip, '-j', 'link', 'show']))
    if any('table' in row for row in tables) or any(row.get('ifname') != 'lo' for row in links):
        raise SystemExit('fresh empty namespace required')
    root = Path(tempfile.mkdtemp(prefix='cluster-wg-kernel-', dir='/root'))
    root.chmod(0o700)
    try:
        directory = root / 'wg'; directory.mkdir(mode=0o700)
        private = system.command([system.wg, 'genkey']).strip()
        public = system.command([system.wg, 'pubkey'], private + '\n').strip()
        owner = {**({'profile': args.profile} if args.profile != 'beta' else {}), 'owner': p.wg_owner, 'local': p.wg_core if args.role == 'core' else p.wg_peers[0], 'publicFingerprint': hashlib.sha256(public.encode()).hexdigest()}
        content = '[Interface]\nPrivateKey = ' + private + '\nListenPort = ' + str(p.wg_port) + '\n'
        for address in (p.wg_peers if args.role == 'core' else (p.wg_core,)):
            peer_private = system.command([system.wg, 'genkey']).strip()
            peer_public = system.command([system.wg, 'pubkey'], peer_private + '\n').strip()
            content += '\n[Peer]\nPublicKey = ' + peer_public + '\nAllowedIPs = ' + address + '/32\n'
            if args.role == 'core':
                content += 'Endpoint = ' + p.endpoints[address] + '\nPersistentKeepalive = 25\n'
        for name, data in [('owner.json', wg.canonical(owner)), ('bootstrap.json', wg.canonical({**owner, 'bootstrapNftSha256': 'a' * 64})),
                           ('private.key', (private + '\n').encode()), (p.wg_interface + '.conf', content.encode())]:
            file = directory / name; file.write_bytes(data); file.chmod(0o600)
        config = wg.load_configuration(directory, profile=args.profile)
        proof = KernelProof(config, root, system.nft)
        recovery = wg.Recovery(config, system=system, manager=proof)
        system.nft.apply([{'add': {'table': {'family': 'inet', 'name': 'foreign_sentinel'}}},
                          {'add': {'chain': {'family': 'inet', 'table': 'foreign_sentinel', 'name': 'input',
                                             'type': 'filter', 'hook': 'input', 'prio': 100, 'policy': 'accept'}}}])
        sentinel = wg.host.digest(system.nft.snapshot('foreign_sentinel'))
        cases = 0
        assert recovery.start()['changed'] is True
        assert len(wg.bootstrap_handles(system.snapshot(), profile=args.profile, local=config.local)) == 5
        system.verify(config)
        cases += 1
        before = wg.host.digest(wg.entries(system.snapshot()))
        try:
            system.nft.command(['-f', '-'], wg.bootstrap_text(config))
            raise AssertionError('strict create appended to an existing table')
        except wg.Refused:
            pass
        assert wg.host.digest(wg.entries(system.snapshot())) == before
        cases += 1
        assert recovery.start()['changed'] is False and recovery.check()['changed'] is False
        assert wg.host.digest(wg.entries(system.snapshot())) == before
        cases += 1
        try:
            recovery.handoff()
            raise AssertionError('handoff accepted absent manager guard')
        except (wg.Refused, wg.host.deploy.Refused, FileNotFoundError):
            pass
        assert wg.host.digest(wg.entries(system.snapshot())) == before
        cases += 1
        proof.guard.update({})
        assert recovery.handoff()['changed'] is True
        assert recovery.state()['phase'] == 'handed_off'
        assert len([row for row in wg.entries(system.snapshot()) if 'rule' in row]) == 1
        cases += 1
        assert recovery.handoff()['changed'] is False
        assert recovery.start()['changed'] is False
        assert proof.guard.state()['leases'] == {}
        cases += 1
        # Owned-table external drift is detected, never overwritten/flushed.
        system.nft.apply([{'add': {'rule': {'family': 'inet', 'table': p.table('boot'), 'chain': 'input', 'expr': [{'counter': {'packets': 0, 'bytes': 0}}]}}}])
        drifted = wg.host.digest(wg.entries(system.snapshot()))
        try:
            recovery.start()
            raise AssertionError('bootstrap drift accepted')
        except wg.Refused:
            pass
        assert wg.host.digest(wg.entries(system.snapshot())) == drifted
        cases += 1
        assert wg.host.digest(system.nft.snapshot('foreign_sentinel')) == sentinel
        cases += 1
        print(json.dumps({'event': 'cluster-wg-isolated-kernel-check', 'profile': args.profile, 'role': args.role, 'cases': cases, 'passed': cases,
                          'scope': 'fresh-netns WG-intrinsics/nft-closed-before-create/no-op/guard-handoff/CAS/foreign-preservation',
                          'handshakeAcceptance': False, 'wholeHostReboot': False}))
    finally:
        shutil.rmtree(root)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
