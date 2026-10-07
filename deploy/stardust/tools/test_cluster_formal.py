"""Explicit Formal profile and cross-namespace refusal; no remote or app mutations."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
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


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, BASE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


beta = load('formal_role_test_fixtures', 'test_cluster_deploy.py')
wg = load('formal_wg_tested', 'cluster-wg-recover.py')
code_fixtures = load('formal_code_test_fixtures', 'test_cluster_private_code.py')
host, deploy, code = beta.host, beta.deploy, code_fixtures.code
FORMAL = deploy.profiles.get_profile('formal')
BETA = deploy.profiles.get_profile('beta')
COMMIT = 'e' * 40


@unittest.skipUnless(os.geteuid() == 0, 'protected root-owned Formal fixtures')
class FormalIdentityTests(beta.IdentityTests):
    """Run the existing CID/RO/mount/resource/epoch fencing against Formal too."""
    profile = 'formal'


@unittest.skipUnless(os.geteuid() == 0, 'protected root-owned Formal fixtures')
class FormalProfileTests(beta.Fixture):
    profile = 'formal'

    def test_fixed_profile_is_immutable_and_unknown_names_refused(self):
        with self.assertRaises(FrozenInstanceError):
            FORMAL.wg_core = BETA.wg_core
        with self.assertRaises(TypeError):
            deploy.profiles.PROFILES['custom'] = FORMAL
        for bad in ('prod', 'core', '', None, {'name': 'formal'}):
            with self.assertRaises(ValueError):
                deploy.profiles.get_profile(bad)
        self.assertEqual(str(FORMAL.root), '/opt/ark-cluster-formal')
        self.assertEqual(str(FORMAL.policy_file), '/etc/ark-cluster-formal/host-policy.json')

    def test_commit_manifest_sixteen_games_and_four_all_route_ingresses(self):
        policy = deploy.generate(self.root / 'commit', profile='formal', image=beta.IMAGE,
                                 build=COMMIT, manifest_sha256=beta.MANIFEST,
                                 source_kind='commit', role='core')
        self.assertEqual(host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile='formal'), policy)
        with self.assertRaises(host.Refused):
            host.load_policy(Path(policy['bundle']) / 'host-policy.json')
        self.assertEqual((policy['namespace'], policy['source_kind'], policy['build']), ('formal', 'commit', COMMIT))
        self.assertEqual(policy['subnet'], '172.30.245.0/24')
        self.assertEqual(policy['wg_interface'], 'ark-wg-formal')
        self.assertEqual(policy['wg_local'], '10.253.79.2')
        self.assertEqual(len(policy['targets']), 17)
        compose = json.loads(Path(policy['compose_file']).read_bytes())
        coordinator = next(row for row in policy['targets'] if row['role'] == 'coordinator')
        self.assertEqual(coordinator['mappings'], [
            {'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': 35400},
            {'container_port': 3000, 'host_ip': '10.253.79.2', 'host_port': 35400},
            {'container_port': 3001, 'host_ip': '127.0.0.1', 'host_port': 35410}])
        runtime = json.loads(Path(coordinator['runtime_file']).read_bytes())
        self.assertEqual(runtime['snapshotHz'], 10)
        self.assertTrue(all(row['capacity'] == 0 for row in runtime['nodes']))
        for index, row in enumerate(policy['targets'][:16], 1):
            self.assertEqual(row['container_ip'], FORMAL.core_ip(10 + index))
            self.assertEqual(row['mappings'][1]['host_port'], 35410 + index)
            runtime = json.loads(Path(row['runtime_file']).read_bytes())
            self.assertEqual(runtime['coordinatorUrl'], 'http://172.30.245.2:3001')
            self.assertEqual((runtime['combatWorkers'], runtime['trialWorkers']), (8, 2))
        for row in policy['targets']:
            svc = compose['services'][row['service']]
            self.assertEqual(svc['labels']['cn.stardust.cluster.namespace'], 'formal')
            self.assertEqual(svc['labels']['cn.stardust.cluster.source-kind'], 'commit')
            self.assertEqual(svc['cap_drop'], ['ALL'])
            self.assertNotIn('cap_add', svc)
            self.assertEqual((svc['environment']['SP_COMBAT'], svc['environment']['SP_VERIFY'],
                              svc['environment']['SP_SNAPSHOT_HZ'], svc['environment']['SP_WS_COMPRESSION']),
                             ('server', 'off', '10', 'on'))
            self.assertEqual(svc['environment']['SP_COMBAT_WORKERS'], '8' if row['role'] == 'game' else '0')
            self.assertEqual(svc['environment']['SP_TRIAL_WORKERS'], '2' if row['role'] == 'game' else '0')
        for entry in range(1, 5):
            edge = self.generate('edge-' + str(entry), role='edge', entry=entry)
            self.assertEqual(edge['project'], FORMAL.edge_project(entry))
            self.assertEqual(edge['wg_local'], FORMAL.wg_peers[entry - 1])
            self.assertEqual(edge['origin'], 'https://ark-proto.stardust.matce.cn')
            target = edge['targets'][0]
            self.assertEqual(target['container_ip'], '172.30.246.2')
            self.assertEqual(target['mappings'], [{'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': 35401}])
            runtime = json.loads(Path(target['runtime_file']).read_bytes())
            self.assertEqual(runtime['origins'], [FORMAL.origin])
            self.assertEqual([row['url'] for row in runtime['nodes']],
                             ['http://10.253.79.2:' + str(port) for port in range(35411, 35427)])
            self.assertEqual(len(list((Path(edge['bundle']) / 'keys').iterdir())), 0)
            self.assertEqual(host.load_policy(Path(edge['bundle']) / 'host-policy.json', profile='formal'), edge)
        self.assertEqual((deploy.WG_CORE, deploy.CORE_SUBNET, deploy.ORIGIN),
                         (BETA.wg_core, BETA.core_subnet, BETA.origin), 'calls must never switch legacy globals')

    def test_cross_profile_network_fields_ports_bundle_paths_and_guard_state_refused(self):
        policy = self.generate()
        for field, value in (('namespace', 'beta'), ('origin', BETA.origin), ('wg_interface', BETA.wg_interface),
                             ('wg_local', BETA.wg_core), ('wg_peers', list(BETA.wg_peers)),
                             ('subnet', BETA.core_subnet), ('project', BETA.core_project)):
            changed = deepcopy(policy); changed[field] = value
            with self.subTest(field=field), self.assertRaises(host.Refused):
                host.parse_policy(changed, profile='formal')
        changed = deepcopy(policy); changed['targets'][0]['mappings'][1]['host_port'] = 35311
        with self.assertRaises(host.Refused): host.parse_policy(changed, profile='formal')
        changed = deepcopy(policy); changed['wg_interface'] = BETA.wg_interface
        for operation in (host.base_rules, lambda value: host.lease_rules(value, {}), host.Guard):
            with self.assertRaises(host.Refused): operation(changed)
        for selected, other in ((FORMAL, BETA), (BETA, FORMAL)):
            for path in other.protected_roots:
                self.assertFalse(deploy.profiles.path_allowed(path, selected.name))
            with self.assertRaises(deploy.Refused):
                deploy.generate(other.root / 'bundles/forbidden', profile=selected.name, image=beta.IMAGE,
                                build=beta.BUILD, manifest_sha256=beta.MANIFEST, source_kind='tree', role='core')
            with self.assertRaises(host.Refused):
                host.load_policy(other.policy_file, profile=selected.name)
        with self.assertRaises(host.Refused):
            host.Guard(policy, state_file='/run/ark-cluster-beta-core.guard.json')
        changed = deepcopy(policy)
        changed.update(bundle='/opt/ark-cluster-beta/bundles/wrong', compose_file='/opt/ark-cluster-beta/bundles/wrong/compose.json')
        with self.assertRaises(host.Refused): host.parse_policy(changed, profile='formal')

    def test_formal_mount_security_runtime_and_compose_drift_refused(self):
        policy = self.generate()
        runtime = Path(policy['targets'][0]['runtime_file'])
        runtime.chmod(0o640); runtime.write_bytes(runtime.read_bytes() + b' '); runtime.chmod(0o440)
        with self.assertRaises(host.Refused): host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile='formal')
        policy = self.generate('compose-drift')
        compose = Path(policy['compose_file']); original = json.loads(compose.read_bytes())
        for field, value in (('read_only', False), ('cap_add', ['SYS_NICE']), ('volumes', ['/opt/ark-cluster-beta:/run/config:ro'])):
            changed = deepcopy(original); changed['services']['game-01'][field] = value
            raw = deploy.canonical(changed); compose.write_bytes(raw)
            current = deepcopy(policy); current['compose_sha256'] = hashlib.sha256(raw).hexdigest()
            Path(policy['bundle'], 'host-policy.json').write_bytes(deploy.canonical(current))
            with self.assertRaises(host.Refused): host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile='formal')

    def test_fixed_bridge_keeps_mount_order_and_only_empty_iprange_exception(self):
        for subnet in (FORMAL.core_subnet, FORMAL.edge_subnet):
            row = {'Subnet': subnet, 'Gateway': subnet.split('/')[0].rsplit('.', 1)[0] + '.1'}
            self.assertTrue(host.bridge_ipam_matches([row], subnet, profile='formal'))
            self.assertTrue(host.bridge_ipam_matches([{**row, 'IPRange': ''}], subnet, profile='formal'))
            self.assertFalse(host.bridge_ipam_matches([{**row, 'IPRange': subnet}], subnet, profile='formal'))
            self.assertFalse(host.bridge_ipam_matches([row], subnet))
        self.assertFalse(host.bridge_ipam_matches([{'Subnet': BETA.core_subnet, 'Gateway': '172.30.242.1'}], BETA.core_subnet, profile='formal'))

    def test_exact_guards_all_sixteen_routes_and_cross_profile_packets_never_accepted(self):
        predicate = beta.PredicateTests()
        formal = self.generate()
        leases = {row['service']: {'network_id': beta.NETWORK, 'container_id': beta.CID} for row in formal['targets']}
        self.assertEqual(host.table_name(formal), 'ak_cluster_formal_core')
        for peer in FORMAL.wg_peers:
            for index in range(1, 17):
                packet = {'meta:iifname': FORMAL.wg_interface, 'meta:oifname': 'br-' + beta.NETWORK[:12],
                          'ip:saddr': peer, 'ip:daddr': FORMAL.core_ip(10 + index), 'tcp:dport': 3000,
                          'ct:current:direction': 'original', 'ct:original:saddr': peer,
                          'ct:original:daddr': FORMAL.wg_core, 'ct:original:proto-dst': FORMAL.game_first_port + index - 1}
                self.assertEqual(predicate.evaluate(formal, leases, 'forward', packet), 'accept')
                for field, wrong in (('meta:iifname', BETA.wg_interface), ('ct:original:daddr', BETA.wg_core),
                                     ('ct:original:proto-dst', BETA.game_first_port + index - 1), ('ip:saddr', BETA.wg_peers[0])):
                    self.assertEqual(predicate.evaluate(formal, leases, 'forward', {**packet, field: wrong}), 'drop')
                self.assertEqual(predicate.evaluate(formal, {}, 'forward', packet), 'drop')
        private_end = {**packet, 'ip:daddr': FORMAL.core_ip(2), 'tcp:dport': 3001, 'ct:original:proto-dst': FORMAL.end_port}
        self.assertEqual(predicate.evaluate(formal, leases, 'forward', private_end), 'drop')
        edge = self.generate('edge', role='edge')
        leases = {'ingress': {'network_id': beta.NETWORK, 'container_id': beta.CID}}
        packet = {'meta:iifname': 'br-' + beta.NETWORK[:12], 'meta:oifname': FORMAL.wg_interface,
                  'ip:saddr': FORMAL.edge_ip, 'ip:daddr': FORMAL.wg_core, 'tcp:dport': FORMAL.game_first_port,
                  'ct:current:direction': 'original'}
        self.assertEqual(predicate.evaluate(edge, leases, 'forward', packet), 'accept')
        for field, wrong in (('tcp:dport', BETA.game_first_port), ('tcp:dport', FORMAL.end_port),
                             ('ip:daddr', BETA.wg_core), ('ip:saddr', BETA.edge_ip)):
            self.assertEqual(predicate.evaluate(edge, leases, 'forward', {**packet, field: wrong}), 'drop')
        beta_policy = deploy.generate(self.root / 'beta', image=beta.IMAGE, build=beta.BUILD,
                                      manifest_sha256=beta.MANIFEST, source_kind='tree', role='edge')
        self.assertNotEqual(predicate.evaluate(beta_policy, leases, 'forward', packet), 'accept')

    def test_whole_node_priority_and_missing_reset_on_fork_rejected(self):
        policy = self.generate()
        generation = host.priority.Generation(beta.CID, beta.IMAGE, beta.BUILD, 'fixture', 0, 1, 1, 2, 2)
        for target in (policy['targets'][0], policy['targets'][-1]):
            config = host.Config(policy, target)
            threads = (host.priority.Thread(2, 'MainThread', -20, os.SCHED_OTHER | host.priority.RESET_ON_FORK, 2),
                       host.priority.Thread(3, 'node', 0, os.SCHED_OTHER, 3),
                       *(host.priority.Thread(4 + i, 'WorkerThread', 0, os.SCHED_OTHER, 4 + i) for i in range(config.worker_count)))
            good = host.priority.Snapshot(generation, threads)
            host.priority.validate_threads(good, config)
            whole_node = host.priority.Snapshot(generation, tuple(replace(row, nice=-20) for row in threads))
            with self.assertRaises(host.Refused): host.priority.validate_threads(whole_node, config)
            bad_reset = host.priority.Snapshot(generation, (replace(threads[0], policy=os.SCHED_OTHER), *threads[1:]))
            system = SimpleNamespace(snapshot=lambda _name: bad_reset)
            with self.assertRaises(host.Refused): host.lease_ready(policy, target, system=system)

    def test_installed_formal_layout_uses_sibling_module_not_cwd_or_filesystem_root(self):
        install = Path(tempfile.mkdtemp(prefix='ark-cluster-formal-install-test-', dir='/opt')); install.chmod(0o700)
        self.addCleanup(shutil.rmtree, install)
        tools = install / 'tools'; tools.mkdir(mode=0o700)
        for name in ('cluster-profile.py', 'cluster-deploy.py', 'cluster-host-manager.py', 'cluster-wg-recover.py',
                     'cluster-private-code.py', 'main-thread-priority.py'):
            shutil.copyfile(BASE / name, tools / name)
        program = '''import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('installed_formal',sys.argv[1]);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
p=m.deploy.generate(sys.argv[2],profile='formal',image='sha256:'+'b'*64,build='e'*40,manifest_sha256='a'*64,source_kind='commit',role='edge',entry=4)
assert m.load_policy(pathlib.Path(sys.argv[2])/'host-policy.json',profile='formal')==p
print(json.dumps({'profile':p['namespace'],'knownRepoProtected':pathlib.Path('/root/projects/Stronghold-Protocol') in m.deploy.FORBIDDEN_REPOS,'rootForbidden':m.deploy.REPO==pathlib.Path('/')}))
'''
        result = subprocess.run([sys.executable, '-I', '-c', program, str(tools / 'cluster-host-manager.py'), str(self.root / 'installed')],
                                cwd='/', capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'profile': 'formal', 'knownRepoProtected': True, 'rootForbidden': False})


@unittest.skipUnless(os.geteuid() == 0, 'root-protected WG fixture')
class FormalRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='formal-wg-unit-', dir='/root')); self.root.chmod(0o700)
        self.addCleanup(shutil.rmtree, self.root)
        self.directory = self.root / 'wg'; self.directory.mkdir(mode=0o700)

    def write(self, name, raw):
        file = self.directory / name; file.write_bytes(raw); file.chmod(0o600)

    def fixture(self, local=FORMAL.wg_core):
        private = base64.b64encode(bytes([1]) * 32).decode()
        owner = {'profile': 'formal', 'owner': FORMAL.wg_owner, 'local': local, 'publicFingerprint': 'f' * 64}
        self.write('owner.json', wg.canonical(owner))
        self.write('bootstrap.json', wg.canonical({**owner, 'bootstrapNftSha256': 'a' * 64}))
        self.write('private.key', (private + '\n').encode())
        raw = '[Interface]\nPrivateKey = ' + private + '\nListenPort = 51839\n'
        for index, address in enumerate(FORMAL.wg_peers if local == FORMAL.wg_core else (FORMAL.wg_core,)):
            raw += '\n[Peer]\nPublicKey = ' + base64.b64encode(bytes([index + 2]) * 32).decode() + '\nAllowedIPs = ' + address + '/32\n'
            if local == FORMAL.wg_core: raw += 'Endpoint = ' + FORMAL.endpoints[address] + '\nPersistentKeepalive = 25\n'
        self.write('ark-wg-formal.conf', raw.encode())
        return wg.load_configuration(self.directory, profile='formal')

    def snapshot(self, config):
        p, table = FORMAL, FORMAL.table('boot')
        iface = lambda field: host.match({'meta': {'key': field}}, p.wg_interface)
        rows = [{'table': {'family': 'inet', 'name': table, 'handle': 1}}]
        rows += [{'chain': {'family': 'inet', 'table': table, 'name': name, 'type': 'filter', 'hook': name, 'prio': -30, 'policy': 'accept'}} for name in ('input', 'forward')]
        rules = [('input', [iface('iifname'), host.match(host.ip('saddr'), {'set': list(config.addresses)}), host.match(host.ip('daddr'), config.local), host.match(host.ip('protocol'), 'icmp'), {'accept': None}]),
                 ('input', [iface('iifname'), {'drop': None}]), ('input', [host.match(host.ip('daddr'), config.local), {'drop': None}]),
                 ('forward', [iface('iifname'), {'drop': None}]), ('forward', [iface('oifname'), {'drop': None}]),
                 ('forward', [host.match({'ct': {'key': 'ip daddr', 'dir': 'original'}}, config.local), {'drop': None}])]
        rows += [{'rule': {'family': 'inet', 'table': table, 'chain': chain, 'expr': expr, 'handle': index + 10}} for index, (chain, expr) in enumerate(rules)]
        return {'nftables': rows}

    def test_explicit_owner_bootstrap_port_and_profile_defaults(self):
        config = self.fixture()
        self.assertEqual((config.profile, config.role, config.addresses), ('formal', 'core', FORMAL.wg_peers))
        self.assertNotIn(config.private, repr(config))
        with self.assertRaises(wg.Refused): wg.load_configuration(self.directory)
        for name in ('owner.json', 'bootstrap.json'):
            original = (self.directory / name).read_bytes()
            for field, bad in (('profile', 'beta'), ('owner', BETA.wg_owner), ('local', BETA.wg_core)):
                value = json.loads(original); value[field] = bad; self.write(name, wg.canonical(value))
                with self.assertRaises(wg.Refused): wg.load_configuration(self.directory, profile='formal')
            value = json.loads(original); value.pop('profile'); self.write(name, wg.canonical(value))
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory, profile='formal')
            self.write(name, original)
        file = self.directory / 'ark-wg-formal.conf'; original = file.read_bytes()
        for changed in (original.replace(b'51839', b'51838'), original.replace(b'10.253.79.11/32', b'10.253.78.11/32'),
                        original.replace(b'115.231.235.78:51839', b'115.231.235.78:51838'), original.replace(b'/32', b'/24')):
            self.write(file.name, changed)
            with self.assertRaises(wg.Refused): wg.load_configuration(self.directory, profile='formal')
        self.write(file.name, original)
        for entry in FORMAL.wg_peers:
            config = self.fixture(entry)
            self.assertEqual((config.role, config.addresses), ('edge', (FORMAL.wg_core,)))
            self.assertNotIn('Endpoint', config.peers[0])
            snapshot = self.snapshot(config)
            self.assertEqual(len(wg.bootstrap_handles(snapshot, profile='formal', local=entry)), 5)
            snapshot['nftables'][3]['rule']['expr'][1]['match']['right'] = FORMAL.wg_core
            self.assertEqual(len(wg.bootstrap_handles(snapshot, profile='formal', local=entry)), 5,
                             'nft singleton set/scalar equivalence must not broaden the accepted peer')

    def test_bootstrap_cross_profile_iface_addresses_broad_rule_and_table_refused(self):
        config = self.fixture(); good = self.snapshot(config)
        self.assertEqual(len(wg.bootstrap_handles(good, profile='formal', local=config.local)), 5)
        with self.assertRaises(wg.Refused): wg.bootstrap_handles(good)
        for old, new in ((FORMAL.wg_interface, BETA.wg_interface), (FORMAL.wg_core, BETA.wg_core),
                         (FORMAL.table('boot'), BETA.table('boot'))):
            changed = json.loads(json.dumps(good).replace(old, new))
            with self.assertRaises(wg.Refused): wg.bootstrap_handles(changed, profile='formal', local=config.local)
        changed = deepcopy(good); changed['nftables'][-1]['rule']['expr'] = [{'drop': None}]
        with self.assertRaises(wg.Refused): wg.bootstrap_handles(changed, profile='formal', local=config.local)
        with self.assertRaises(wg.Refused): wg.ManagerProof(config, str(BETA.policy_file))
        text = wg.bootstrap_text(config)
        self.assertIn('priority -30', text); self.assertNotIn(BETA.wg_interface, text)
        self.assertNotIn('10.253.78.', text); self.assertNotIn('flush', text)

    def test_cold_start_handoff_state_cas_and_foreign_preservation(self):
        config = self.fixture(); test = self
        class System:
            present = False
            value = None
            events = []
            foreign = {'unchanged': True}
            nft = None
            def boot_id(self): return 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
            def exists(self): return self.present
            def snapshot(self): return deepcopy(self.value)
            def create_bootstrap(self, config): self.events.append('closed-guard'); self.value = test.snapshot(config)
            def preflight_absent(self, config): self.events.append('route-preflight')
            def configure(self, config): self.events.append('configure'); self.present = True
            def verify(self, config): self.events.append('verify')
            def apply(self, commands):
                for command in commands:
                    rule = command['delete']['rule']; test.assertEqual(rule['table'], FORMAL.table('boot'))
                    self.value['nftables'] = [row for row in self.value['nftables'] if row.get('rule', {}).get('handle') != rule['handle']]
        class Manager:
            @contextmanager
            def lock(self): yield
            def check(self, closed): return {'project': FORMAL.core_project, 'state': {'leases': {}}, 'policy': {'profile': 'formal'}}
        system = System(); system.nft = system
        recovery = wg.Recovery(config, system=system, manager=Manager())
        self.assertTrue(recovery.start()['changed'])
        self.assertLess(system.events.index('closed-guard'), system.events.index('configure'))
        state = recovery.state(); self.assertEqual(state['profile'], 'formal')
        with self.assertRaises(wg.Refused): recovery.save(state, {**state, 'profile': 'beta'})
        self.assertTrue(recovery.handoff()['changed']); self.assertFalse(recovery.handoff()['changed'])
        self.assertFalse(recovery.start()['changed']); self.assertFalse(recovery.check()['changed'])
        self.assertEqual(system.foreign, {'unchanged': True})
        system.value['nftables'][-1]['rule']['expr'].append({'counter': {}})
        with self.assertRaises(wg.Refused): recovery.check()

    def test_templates_keep_root_guard_handoff_serve_and_own_service_names(self):
        for role in ('core', 'edge'):
            lines = (BASE.parent / 'cluster' / ('ark-cluster-formal-' + role + '.service')).read_text().splitlines()
            pre = [line for line in lines if line.startswith('ExecStartPre=')]
            self.assertEqual(len(pre), 2)
            self.assertIn('cluster-host-manager.py --profile formal --config /etc/ark-cluster-formal/host-policy.json --action guard', pre[0])
            self.assertIn('cluster-wg-recover.py --profile formal --action handoff', pre[1])
            self.assertIn('Requires=docker.service ark-cluster-formal-wg.service', lines)
            self.assertIn('ReadWritePaths=/run /var/run/docker.sock /etc/ark-cluster-formal-wg', lines)
            self.assertTrue(any('--profile formal' in line and '--action serve' in line for line in lines))
            self.assertFalse(any('ark-cluster-beta' in line or 'CAP_SYS_NICE' in line for line in lines))
        lines = (BASE.parent / 'cluster/ark-cluster-formal-wg.service').read_text().splitlines()
        self.assertIn('Type=oneshot', lines); self.assertIn('RemainAfterExit=yes', lines)
        self.assertIn('CapabilityBoundingSet=CAP_NET_ADMIN', lines)
        self.assertFalse(any(line.startswith('ExecStop=') for line in lines))


class FormalPrivateCodeTests(unittest.TestCase):
    setUp = code_fixtures.PrivateCodeTests.setUp
    refresh = code_fixtures.PrivateCodeTests.refresh

    def test_beta_commit_explicit_kind_and_base_revision_are_required(self):
        self.value.update(kind='commit', baseRevision=COMMIT); self.refresh()
        value = code.prepare(self.source, self.manifest, self.digest, COMMIT, self.output, source_kind='commit')
        self.assertEqual(code.verify(self.output, self.manifest, self.digest, COMMIT, source_kind='commit'), value)
        self.assertEqual((value['namespace'], value['sourceKind']), ('beta', 'commit'))
        include = (self.output / 'nginx/cluster-private-code-beta.conf').read_text()
        self.assertIn('sourceKind=commit', include); self.assertNotIn('this is NOT a Git commit', include)
        self.assertIn('$ark_beta_frame', include); self.assertIn('@ark_beta_cluster_code', include)
        self.assertIn('proxy_pass http://10.253.78.2:35300;', include)
        self.assertTrue((self.output / ('localcode/cluster-' + COMMIT + '/js/main.js')).is_file())
        with self.assertRaises(code.Refused): code.verify(self.output, self.manifest, self.digest, COMMIT)
        with self.assertRaises(code.Refused): code.verify(self.output, self.manifest, self.digest, 'b' * 40, source_kind='commit')

    def test_formal_commit_fixed_manifest_maps_prefix_fallback_and_roundtrip(self):
        self.value.update(kind='commit', baseRevision=COMMIT); self.refresh()
        value = code.prepare(self.source, self.manifest, self.digest, COMMIT, self.output, profile='formal', source_kind='commit')
        self.assertEqual(code.verify(self.output, self.manifest, self.digest, COMMIT, profile='formal', source_kind='commit'), value)
        self.assertEqual((value['namespace'], value['sourceKind'], value['build']), ('formal', 'commit', COMMIT))
        include = (self.output / 'nginx/cluster-private-code-formal.conf').read_text()
        for wanted in ('/www/sites/ark-proto.stardust.matce.cn/localcode/cluster-formal-' + COMMIT,
                       '$ark_proto_frame', '$ark_proto_csp', '@ark_formal_cluster_code', 'proxy_pass http://10.253.79.2:35400;'):
            self.assertIn(wanted, include)
        for forbidden in ('ark_beta', 'ark-proto-beta', '10.253.78.', '35300', 'add_header Access-Control-Allow-Origin'):
            self.assertNotIn(forbidden, include)
        self.assertEqual(include.count('auth_request /_gate/check;'), 7)
        self.assertTrue((self.output / ('localcode/cluster-formal-' + COMMIT + '/js/main.js')).is_file())
        with self.assertRaises(code.Refused): code.verify(self.output, self.manifest, self.digest, COMMIT)
        with self.assertRaises(code.Refused): code.verify(self.output, self.manifest, self.digest, 'b' * 40, profile='formal', source_kind='commit')
        for selected, other in ((FORMAL, BETA), (BETA, FORMAL)):
            with self.assertRaises(code.Refused):
                code.prepare(other.root / 'app', self.manifest, self.digest, COMMIT, self.root / 'new', profile=selected.name, source_kind='commit')


if __name__ == '__main__':
    unittest.main()
