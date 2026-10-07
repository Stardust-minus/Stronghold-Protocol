"""Root-protected fixtures only; no host interfaces, tables or remote actions."""
from contextlib import contextmanager
from copy import deepcopy
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tested_cluster_wg_recover', BASE / 'cluster-wg-recover.py')
wg = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wg
spec.loader.exec_module(wg)
PRIVATE = base64.b64encode(bytes([1]) * 32).decode()  # Synthetic, never a host credential.
PUBLIC = base64.b64encode(bytes([6]) * 32).decode()
BOOT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


def snapshot(config):
    rules = [
        ('input', [{'match': {'op': '==', 'left': {'meta': {'key': 'iifname'}}, 'right': wg.IFACE}}, {'accept': None}]),
        ('input', [{'match': {'op': '==', 'left': {'meta': {'key': 'iifname'}}, 'right': wg.IFACE}}, {'drop': None}]),
        ('input', [{'match': {'op': '==', 'left': {'payload': {'protocol': 'ip', 'field': 'daddr'}}, 'right': config.local}}, {'drop': None}]),
        ('forward', [{'match': {'op': '==', 'left': {'meta': {'key': 'iifname'}}, 'right': wg.IFACE}}, {'drop': None}]),
        ('forward', [{'match': {'op': '==', 'left': {'meta': {'key': 'oifname'}}, 'right': wg.IFACE}}, {'drop': None}]),
        ('forward', [{'match': {'op': '==', 'left': {'ct': {'key': 'ip daddr', 'dir': 'original'}}, 'right': config.local}}, {'drop': None}]),
    ]
    rows = [{'metainfo': {'json_schema_version': 1}}, {'table': {'family': 'inet', 'name': wg.TABLE, 'handle': 1}}]
    rows += [{'chain': {'family': 'inet', 'table': wg.TABLE, 'name': name, 'type': 'filter', 'hook': name, 'prio': -30, 'policy': 'accept', 'handle': index + 2}}
             for index, name in enumerate(('input', 'forward'))]
    rows += [{'rule': {'family': 'inet', 'table': wg.TABLE, 'chain': chain, 'expr': expr, 'handle': index + 10}} for index, (chain, expr) in enumerate(rules)]
    return {'nftables': rows}


class FakeNft:
    def __init__(self, system):
        self.system = system
        self.transactions = []
        self.foreign = {'name': 'unchanged-foreign', 'rules': [1, 2, 3]}

    def apply(self, commands):
        self.transactions.append(deepcopy(commands)); self.system.events.append('delete-bootstrap-drops')
        for command in commands:
            rule = command['delete']['rule']
            assert rule['family'] == 'inet' and rule['table'] == wg.TABLE
            self.system.value['nftables'] = [row for row in self.system.value['nftables'] if row.get('rule', {}).get('handle') != rule['handle']]


class FakeSystem:
    def __init__(self, config, present=False, guard=True):
        self.config, self.present = config, present
        self.value = snapshot(config) if guard else None
        self.boot, self.events, self.corrupted, self.fail_late = BOOT, [], False, False
        self.nft = FakeNft(self)

    def boot_id(self): return self.boot
    def snapshot(self): return deepcopy(self.value)
    def exists(self): return self.present
    def create_bootstrap(self, config):
        assert self.value is None
        self.events.append('closed-bootstrap'); self.value = snapshot(config)
    def preflight_absent(self, config): self.events.append('route-preflight')
    def configure(self, config):
        self.events.append('create-interface'); self.present = True
        if self.fail_late: raise wg.Refused('fixed late fixture failure')
        self.events.append('create-routes')
    def verify(self, config):
        if self.corrupted: raise wg.Refused('fixed identity fixture failure')
        self.events.append('verify-only')


class FakeManager:
    def __init__(self, local):
        self.project = 'ark-cluster-beta-core' if local == wg.CORE else 'ark-cluster-beta-edge-01'
        self.active, self.unavailable, self.locked, self.calls, self.change_at = False, False, False, 0, None
        self.value = {'version': 1, 'leases': {}, 'owned_leases': {'historical': {'container_id': 'c' * 64}}, 'retired_leases': {}}

    @contextmanager
    def lock(self):
        if self.locked: raise wg.Refused('manager already serving')
        self.locked = True
        try: yield
        finally: self.locked = False

    def check(self, closed):
        self.calls += 1
        if self.unavailable or closed and self.active: raise wg.Refused('manager guard unavailable or open')
        value = deepcopy(self.value)
        if self.change_at is not None and self.calls >= self.change_at: value['nft_sha256'] = 'changed'
        return {'project': self.project, 'state': value, 'policy': {'fixed': True}}


@unittest.skipUnless(os.geteuid() == 0, 'root-owned protected metadata required')
class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='cluster-wg-unit-', dir='/root'))
        os.chmod(self.root, 0o700); self.addCleanup(shutil.rmtree, self.root)
        self.directory = self.root / 'wg'; self.directory.mkdir(mode=0o700)

    def write(self, name, data):
        file = self.directory / name
        file.write_bytes(data if isinstance(data, bytes) else data.encode())
        file.chmod(0o600)

    def fixture(self, local=wg.CORE, *, present=False, guard=True):
        owner = {'owner': wg.OWNER, 'local': local, 'publicFingerprint': hashlib.sha256(PUBLIC.encode()).hexdigest()}
        temporary = SimpleNamespace(local=local)
        self.write('owner.json', wg.canonical(owner))
        self.write('bootstrap.json', wg.canonical({**owner, 'bootstrapNftSha256': wg.legacy_digest(snapshot(temporary))}))
        self.write('private.key', PRIVATE + '\n')
        content = '[Interface]\nPrivateKey = ' + PRIVATE + '\nListenPort = 51838\n'
        addresses = wg.EDGES if local == wg.CORE else (wg.CORE,)
        for index, address in enumerate(addresses):
            public = base64.b64encode(bytes([index + 2]) * 32).decode()
            content += '\n[Peer]\nPublicKey = ' + public + '\nAllowedIPs = ' + address + '/32\n'
            if local == wg.CORE: content += 'Endpoint = ' + wg.ENDPOINTS[address] + '\nPersistentKeepalive = 25\n'
        self.write(wg.IFACE + '.conf', content)
        config = wg.load_configuration(self.directory)
        system, manager = FakeSystem(config, present, guard), FakeManager(local)
        return config, system, manager, wg.Recovery(config, system=system, manager=manager)

    def test_core_and_edge_have_fixed_config_and_private_repr(self):
        config, _, _, _ = self.fixture()
        self.assertEqual(config.addresses, wg.EDGES); self.assertEqual(len(config.peers), 4)
        self.assertNotIn(PRIVATE, repr(config))
        config, _, _, _ = self.fixture(wg.EDGES[2])
        self.assertEqual(config.addresses, (wg.CORE,)); self.assertEqual(len(config.peers), 1)
        self.assertNotIn('Endpoint', config.peers[0])

    def test_unknown_fields_and_nonfixed_addresses_ports_endpoints_are_refused(self):
        self.fixture()
        file = self.directory / (wg.IFACE + '.conf'); original = file.read_text()
        for changed in [original + 'PostUp = unsafe\n', original.replace('/32', '/24', 1),
                        original.replace('115.231.235.78:51838', 'https://external.invalid/'),
                        original.replace('ListenPort = 51838', 'ListenPort = 51837'),
                        original.replace('10.253.78.11/32', '0.0.0.0/0'),
                        original.replace('PersistentKeepalive = 25', 'PersistentKeepalive = 24'),
                        original.replace('[Interface]', '[Peer]', 1)]:
            self.write(file.name, changed)
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        self.write(file.name, original)

    def test_duplicate_fields_peers_and_mismatched_private_file_are_refused(self):
        self.fixture()
        file = self.directory / (wg.IFACE + '.conf'); original = file.read_text()
        peer_keys = [base64.b64encode(bytes([i]) * 32).decode() for i in (2, 3)]
        for changed in [original.replace('ListenPort = 51838', 'ListenPort = 51838\nListenPort = 51838'),
                        original.replace(peer_keys[1], peer_keys[0])]:
            self.write(file.name, changed)
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        self.write(file.name, original)
        self.write('private.key', PUBLIC + '\n')
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)

    def test_unsafe_modes_links_and_oversized_configuration_are_refused(self):
        self.fixture()
        file = self.directory / (wg.IFACE + '.conf'); original = file.read_bytes()
        for mode in (0o644, 0o660, 0o700):
            file.chmod(mode)
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        file.chmod(0o600)
        saved = self.directory / 'saved'; file.rename(saved); file.symlink_to(saved)
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        file.unlink(); saved.rename(file)
        os.link(file, self.directory / 'hardlink')
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        (self.directory / 'hardlink').unlink()
        self.write(file.name, b'x' * 16385)
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        self.write(file.name, original)
        self.root.chmod(0o777)
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)

    def test_unknown_owner_and_bootstrap_metadata_are_refused(self):
        self.fixture()
        for name in ('owner.json', 'bootstrap.json'):
            original = (self.directory / name).read_bytes(); value = json.loads(original)
            value['owner'] = 'some-other-owner'; self.write(name, wg.canonical(value))
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
            self.write(name, original)
        value = json.loads((self.directory / 'owner.json').read_bytes()); value['secret'] = 'synthetic-only'
        self.write('owner.json', wg.canonical(value))
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)

    def test_bootstrap_uses_strict_create_and_never_flushes_or_deletes_a_table(self):
        config, _, _, _ = self.fixture()
        text = wg.bootstrap_text(config)
        self.assertTrue(text.startswith('create table inet ' + wg.TABLE + '\n'))
        self.assertNotIn('flush', text); self.assertNotIn('delete table', text)
        self.assertEqual(text.count(' drop\n'), 5)

    def test_cold_start_creates_closed_bootstrap_before_interface_and_routes(self):
        _, system, _, recovery = self.fixture(guard=False)
        self.assertTrue(recovery.start()['changed'])
        self.assertLess(system.events.index('closed-bootstrap'), system.events.index('create-interface'))
        self.assertLess(system.events.index('closed-bootstrap'), system.events.index('create-routes'))
        self.assertEqual(recovery.state()['phase'], 'closed')
        self.assertEqual(len(wg.bootstrap_handles(system.snapshot())), 5)
        self.assertEqual(system.nft.foreign, {'name': 'unchanged-foreign', 'rules': [1, 2, 3]})

    def test_initial_live_owned_interface_adopts_digest_without_reconfiguration(self):
        _, system, _, recovery = self.fixture(present=True)
        self.assertFalse(recovery.start()['changed'])
        self.assertEqual(system.events, ['verify-only'])
        self.assertFalse(recovery.start()['changed']); self.assertFalse(recovery.check()['changed'])
        self.assertNotIn('create-interface', system.events)
        self.assertEqual(system.nft.transactions, [])

    def test_bootstrap_or_foreign_live_interface_drift_is_never_overwritten(self):
        _, system, _, recovery = self.fixture(present=True)
        system.value['nftables'][-1]['rule']['expr'].append({'counter': {}})
        with self.assertRaises(wg.Refused): recovery.start()
        self.assertFalse(recovery.state_file.exists()); self.assertEqual(system.nft.transactions, [])
        _, system, _, recovery = self.fixture(present=True)
        system.corrupted = True
        with self.assertRaises(wg.Refused): recovery.start()
        self.assertFalse(recovery.state_file.exists()); self.assertNotIn('create-interface', system.events)

    def test_unknown_bootstrap_on_cold_start_refuses_without_any_network_mutation(self):
        _, system, _, recovery = self.fixture()
        system.value['nftables'][-1]['rule']['expr'].append({'accept': None})
        before = deepcopy(system.value)
        with self.assertRaises(wg.Refused): recovery.start()
        self.assertEqual(system.value, before); self.assertEqual(system.events, [])

    def test_late_failure_leaves_closed_guard_without_rollback_of_unrelated_resources(self):
        _, system, _, recovery = self.fixture(guard=False)
        system.fail_late = True
        with self.assertRaises(wg.Refused): recovery.start()
        self.assertEqual(len(wg.bootstrap_handles(system.snapshot())), 5)
        self.assertEqual(recovery.state()['phase'], 'closed')
        self.assertEqual(system.nft.foreign['rules'], [1, 2, 3])
        self.assertNotIn('delete-bootstrap-drops', system.events)

    def test_changed_config_is_refused_before_reopening_or_mutating_network(self):
        _, system, _, recovery = self.fixture(present=True)
        recovery.start(); system.events.clear()
        file = self.directory / (wg.IFACE + '.conf')
        self.write(file.name, file.read_text() + '\n')
        with self.assertRaises(wg.Refused): recovery.start()
        with self.assertRaises(wg.Refused): recovery.handoff()
        self.assertEqual(system.events, []); self.assertEqual(system.nft.transactions, [])

    def test_handoff_deletes_exact_five_drop_handles_only_and_keeps_owned_icmp_table(self):
        _, system, manager, recovery = self.fixture(present=True)
        recovery.start(); before = system.snapshot()
        self.assertTrue(recovery.handoff()['changed'])
        commands = system.nft.transactions[0]
        self.assertEqual(len(commands), 5)
        self.assertTrue(all(set(command) == {'delete'} and set(command['delete']) == {'rule'} for command in commands))
        self.assertTrue(all(command['delete']['rule']['table'] == wg.TABLE for command in commands))
        self.assertEqual(recovery.state()['phase'], 'handed_off')
        self.assertEqual(len([row for row in system.value['nftables'] if 'rule' in row]), 1)
        self.assertEqual(len([row for row in before['nftables'] if 'chain' in row]), len([row for row in system.value['nftables'] if 'chain' in row]))
        self.assertTrue(manager.value['owned_leases'])  # Historical identities are not active leases.
        self.assertFalse(recovery.handoff()['changed'])
        self.assertEqual(len(system.nft.transactions), 1)

    def test_open_unavailable_locked_or_changed_manager_rejects_handoff(self):
        for failure in ('active', 'unavailable', 'locked', 'changed'):
            _, system, manager, recovery = self.fixture(present=True)
            recovery.start()
            if failure == 'changed': manager.change_at = 2
            else: setattr(manager, failure, True)
            with self.assertRaises(wg.Refused): recovery.handoff()
            self.assertEqual(system.nft.transactions, [])
            recovery.state_file.unlink()

    def test_bootstrap_drift_before_handoff_is_not_repaired_or_flushed(self):
        _, system, _, recovery = self.fixture(present=True)
        recovery.start(); system.value['nftables'][-1]['rule']['expr'].append({'counter': {}})
        before = deepcopy(system.value)
        with self.assertRaises(wg.Refused): recovery.handoff()
        self.assertEqual(system.value, before); self.assertEqual(system.nft.transactions, [])

    def test_already_up_handed_off_start_preserves_live_manager_leases(self):
        _, system, manager, recovery = self.fixture(present=True)
        recovery.start(); recovery.handoff(); manager.active = True
        system.events.clear(); before = deepcopy(system.value)
        self.assertFalse(recovery.start()['changed']); self.assertFalse(recovery.check()['changed'])
        self.assertEqual(system.value, before); self.assertNotIn('closed-bootstrap', system.events)
        self.assertNotIn('create-interface', system.events)
        with self.assertRaises(wg.Refused): recovery.handoff()

    def test_same_boot_missing_active_interface_requires_manual_recovery(self):
        _, system, _, recovery = self.fixture(present=True)
        recovery.start(); recovery.handoff(); system.present = False
        with self.assertRaises(wg.Refused): recovery.start()
        self.assertEqual(len(system.nft.transactions), 1)

    def test_fresh_boot_restores_closed_bootstrap_without_resuming_prior_leases(self):
        _, system, manager, recovery = self.fixture(present=True)
        recovery.start(); recovery.handoff()
        system.boot = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; system.present = False; system.value = None; manager.active = False
        system.events.clear()
        self.assertTrue(recovery.start()['changed']); self.assertEqual(recovery.state()['phase'], 'closed')
        self.assertNotIn('manager_project', recovery.state()); self.assertEqual(system.events[0], 'closed-bootstrap')
        self.assertEqual(len(wg.bootstrap_handles(system.snapshot())), 5)

    def test_state_cas_link_or_version_drift_is_refused(self):
        _, _, _, recovery = self.fixture(present=True)
        recovery.start(); value = recovery.state(); changed = {**value, 'version': True}
        self.write('recovery.json', wg.canonical(changed))
        with self.assertRaises(wg.Refused): recovery.state()
        self.write('recovery.json', wg.canonical(value))
        with self.assertRaises(wg.Refused): recovery.save(value, {**value, 'phase': 'different'})
        file = self.directory / 'recovery.json'; saved = self.directory / 'saved-state'; file.rename(saved); file.symlink_to(saved)
        with self.assertRaises(wg.Refused): recovery.state()

    def test_handoff_metadata_publication_failure_keeps_manager_closed_and_requires_manual_reconciliation(self):
        _, system, manager, recovery = self.fixture(present=True)
        recovery.start()
        with patch.object(recovery, 'save', side_effect=wg.Refused('metadata publication failed')):
            with self.assertRaises(wg.Refused): recovery.handoff()
        self.assertFalse(manager.active); self.assertEqual(recovery.state()['phase'], 'closed')
        with self.assertRaises(wg.Refused): recovery.check()
        self.assertEqual(system.nft.foreign['rules'], [1, 2, 3])

    def test_installed_opt_tools_accept_external_metadata_without_treating_root_as_repo(self):
        self.fixture()
        install = Path(tempfile.mkdtemp(prefix='ark-cluster-wg-install-test-', dir='/opt'))
        install.chmod(0o700); self.addCleanup(shutil.rmtree, install)
        tools = install / 'tools'; tools.mkdir(mode=0o700)
        for name in ('cluster-wg-recover.py', 'cluster-host-manager.py', 'cluster-deploy.py', 'main-thread-priority.py', 'cluster-profile.py'):
            shutil.copy2(BASE / name, tools / name)
        program = '''import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('installed_wg',sys.argv[1]); module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
config=module.load_configuration(sys.argv[2]); print(json.dumps({'ok':config.local==module.CORE,'rootForbidden':module.host.deploy.REPO==pathlib.Path('/'),'knownRepoProtected':pathlib.Path('/root/projects/Stronghold-Protocol') in module.host.deploy.FORBIDDEN_REPOS}))
'''
        process = subprocess.run([sys.executable, '-I', '-c', program, str(tools / 'cluster-wg-recover.py'), str(self.directory)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout), {'ok': True, 'rootForbidden': False, 'knownRepoProtected': True})

    def test_service_templates_keep_guard_handoff_serve_order_and_narrow_metadata_write_path(self):
        cluster = BASE.parent / 'cluster'
        for role in ('core', 'edge'):
            lines = (cluster / ('ark-cluster-beta-' + role + '.service')).read_text().splitlines()
            pre = [line for line in lines if line.startswith('ExecStartPre=')]
            self.assertEqual(len(pre), 2)
            self.assertIn('cluster-host-manager.py --config /etc/ark-cluster-beta/host-policy.json --action guard', pre[0])
            self.assertIn('cluster-wg-recover.py --action handoff', pre[1])
            serve = next(line for line in lines if line.startswith('ExecStart='))
            self.assertIn('--action serve', serve)
            self.assertLess(lines.index(pre[0]), lines.index(pre[1])); self.assertLess(lines.index(pre[1]), lines.index(serve))
            writable = next(line.split('=', 1)[1].split() for line in lines if line.startswith('ReadWritePaths='))
            self.assertEqual(set(writable), {'/run', '/var/run/docker.sock', '/etc/ark-cluster-beta-wg'})
            self.assertIn('ProtectSystem=strict', lines)
            self.assertIn('Requires=docker.service ark-cluster-beta-wg.service', lines)
            self.assertFalse(any('ark-wireguard-route' in line for line in lines))
        lines = (cluster / 'ark-cluster-beta-wg.service').read_text().splitlines()
        self.assertIn('Type=oneshot', lines); self.assertIn('RemainAfterExit=yes', lines)
        self.assertIn('CapabilityBoundingSet=CAP_NET_ADMIN', lines)
        self.assertFalse(any(line.startswith('ExecStop=') or line.startswith('ExecStopPost=') for line in lines))
        self.assertIn('ReadWritePaths=/etc/ark-cluster-beta-wg /run', lines)

    def test_cli_does_not_emit_configuration_or_exception_details(self):
        self.fixture(); self.write(wg.IFACE + '.conf', 'synthetic-private-sentinel\n')
        process = subprocess.run([sys.executable, '-I', str(BASE / 'cluster-wg-recover.py'), '--directory', str(self.directory), '--action', 'start'], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertNotIn(PRIVATE, process.stdout + process.stderr)
        self.assertNotIn('synthetic-private-sentinel', process.stdout + process.stderr)
        self.assertNotIn('Traceback', process.stderr)
        self.assertEqual(json.loads(process.stdout)['event'], 'cluster-wg-refused')


if __name__ == '__main__':
    unittest.main()
