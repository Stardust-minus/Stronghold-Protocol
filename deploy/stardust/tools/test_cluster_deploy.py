"""Protected local cluster generation/role guards; no SSH or production mutations."""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tested_cluster_host', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)
deploy = host.deploy
BUILD, MANIFEST, IMAGE = 'a' * 40, 'a' * 64, 'sha256:' + 'b' * 64
CID, NETWORK = 'c' * 64, 'd' * 64


class Fixture(unittest.TestCase):
    profile = 'beta'
    def setUp(self):
        # /tmp itself is world-writable and deliberately not an approved protected-file parent.
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-role-tests-',
                                          dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root' if os.geteuid() == 0 else None)))
        os.chmod(self.root, 0o700)
        self.addCleanup(shutil.rmtree, self.root)

    def generate(self, name='core', role='core', entry=1, ingress_instances=1):
        return deploy.generate(self.root / name, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST,
                               source_kind='tree', role=role, entry=entry, profile=self.profile,
                               ingress_instances=ingress_instances)

    def target(self, policy, role='game'):
        return next(row for row in policy['targets'] if row['role'] == role)


@unittest.skipUnless(os.geteuid() == 0, 'protected root-owned policy tests require root')
class GenerationTests(Fixture):
    def installed_module(self):
        tools = self.root / 'opt/ark-cluster-beta/tools'
        tools.mkdir(parents=True)
        for name in ('cluster-deploy.py', 'cluster-host-manager.py', 'main-thread-priority.py', 'cluster-profile.py'):
            shutil.copyfile(BASE / name, tools / name)
            (tools / name).chmod(0o644)
        spec = importlib.util.spec_from_file_location('cluster_installed_host_fixture', tools / 'cluster-host-manager.py')
        installed = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = installed
        spec.loader.exec_module(installed)
        return installed

    def test_installed_layout_copy_does_not_treat_filesystem_root_as_repository(self):
        installed = self.installed_module()
        self.assertNotEqual(installed.deploy.REPO, Path('/'))
        self.assertIn(Path('/root/projects/Stronghold-Protocol'), installed.deploy.FORBIDDEN_REPOS)
        for role in ('core', 'edge'):
            bundle = self.root / ('installed-' + role)
            policy = installed.deploy.generate(bundle, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST,
                                               source_kind='tree', role=role, entry=1)
            self.assertEqual(installed.load_policy(bundle / 'host-policy.json'), policy)

    def test_installed_layout_copy_still_rejects_known_checkout_outputs_and_policies(self):
        installed = self.installed_module()
        forbidden = Path('/root/projects/Stronghold-Protocol/.cache/forbidden-installation-regression')
        with self.assertRaises(installed.deploy.Refused):
            installed.deploy.generate(forbidden, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST,
                                      source_kind='tree', role='core')
        self.assertFalse(forbidden.exists())
        policy = self.generate()
        policy['bundle'] = str(forbidden)
        policy['compose_file'] = str(forbidden / 'compose.json')
        with self.assertRaises(installed.Refused):
            installed.parse_policy(policy)

    def test_core_has_sixteen_explicit_game_configs_and_one_coordinator(self):
        policy = self.generate()
        self.assertEqual(len(policy['targets']), 17)
        self.assertEqual(host.load_policy(self.root / 'core' / 'host-policy.json'), policy)
        games = [row for row in policy['targets'] if row['role'] == 'game']
        self.assertEqual([row['public_slot'] for row in games], list(range(1, 17)))
        self.assertEqual(len({row['container_ip'] for row in games}), 16)
        self.assertEqual(len({row['mappings'][0]['host_port'] for row in games}), 16)
        for row in games:
            config = json.loads(Path(row['runtime_file']).read_bytes())
            self.assertEqual((config['combatWorkers'], config['trialWorkers']), (8, 2))
            self.assertEqual(config['publicSlot'], row['public_slot'])
            self.assertEqual(config['keyFile'], '/run/secrets/game.key')
            self.assertEqual(len(Path(row['key_file']).read_bytes()), 32)
            self.assertEqual(stat.S_IMODE(Path(row['key_file']).stat().st_mode), 0o440)
        coordinator = self.target(policy, 'coordinator')
        config = json.loads(Path(coordinator['runtime_file']).read_bytes())
        self.assertEqual([row['publicSlot'] for row in config['nodes']], list(range(1, 17)))
        self.assertTrue(all(row['capacity'] == 0 for row in config['nodes']))
        self.assertEqual(config['snapshotHz'], 10)
        self.assertNotIn('combatWorkers', config)

    def test_all_four_ingress_route_to_all_sixteen_nodes_without_keys(self):
        for entry in range(1, 5):
            with self.subTest(entry=entry):
                policy = self.generate('edge-' + str(entry), role='edge', entry=entry)
                config = json.loads(Path(policy['targets'][0]['runtime_file']).read_bytes())
                self.assertEqual([row['nodeId'] for row in config['nodes']], ['game-' + format(index, '02d') for index in range(1, 17)])
                self.assertTrue(all(set(row) == {'nodeId', 'url'} for row in config['nodes']))
                self.assertEqual(config['origins'], [deploy.ORIGIN])
                self.assertEqual(config['wsCompression'], 'on')
                self.assertEqual(list((Path(policy['bundle']) / 'keys').iterdir()), [])
                self.assertEqual(host.load_policy(Path(policy['bundle']) / 'host-policy.json'), policy)

    def test_games_cannot_read_another_nodes_key_through_mounts(self):
        policy = self.generate()
        compose = json.loads(Path(policy['compose_file']).read_bytes())
        for row in policy['targets']:
            mounts = compose['services'][row['service']]['volumes']
            if row['role'] == 'game':
                self.assertEqual(mounts[1:], [row['key_file'] + ':/run/secrets/game.key:ro'])
                self.assertNotIn(str(Path(policy['bundle']) / 'keys') + ':/run/secrets:ro', mounts)
            self.assertEqual(compose['services'][row['service']]['restart'], 'no')
            self.assertEqual(compose['services'][row['service']]['cap_drop'], ['ALL'])
            self.assertTrue(compose['services'][row['service']]['read_only'])
            self.assertEqual(compose['services'][row['service']]['pids_limit'], 128)
            self.assertNotIn('cpus', compose['services'][row['service']])
            self.assertNotIn('mem_limit', compose['services'][row['service']])

    def test_generation_does_not_overwrite_or_reuse_keys(self):
        policy = self.generate()
        before = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in (Path(policy['bundle']) / 'keys').iterdir()}
        with self.assertRaises(deploy.Refused):
            self.generate()
        self.assertEqual(before, {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in (Path(policy['bundle']) / 'keys').iterdir()})

    def test_tree_identity_is_not_reported_as_a_commit(self):
        policy = self.generate()
        self.assertEqual(policy['source_kind'], 'tree')
        summary = json.loads((Path(policy['bundle']) / 'bundle-summary.json').read_bytes())
        self.assertEqual(summary['sourceKind'], 'tree')
        self.assertFalse(summary['activated'])
        with self.assertRaises(deploy.Refused):
            deploy.generate(self.root / 'bad', image=IMAGE, build='f' * 40,
                            manifest_sha256=MANIFEST, source_kind='tree', role='core')

    def test_runtime_or_compose_drift_refuses_without_any_activation(self):
        policy = self.generate()
        file = Path(policy['targets'][0]['runtime_file'])
        os.chmod(file, 0o640)
        file.write_bytes(file.read_bytes() + b' ')
        os.chmod(file, 0o440)
        with self.assertRaises(host.Refused):
            host.load_policy(Path(policy['bundle']) / 'host-policy.json')
        policy = self.generate('core2')
        file = Path(policy['compose_file'])
        file.write_bytes(file.read_bytes() + b' ')
        with self.assertRaises(host.Refused):
            host.load_policy(Path(policy['bundle']) / 'host-policy.json')

    def test_policy_schema_network_counts_and_ports_are_fixed(self):
        policy = self.generate()
        variants = []
        for key, value in (('namespace', 'formal'), ('host_role', 'prod'), ('wg_interface', 'ark-wg-test'),
                           ('wg_local', '10.253.77.2'), ('wg_peers', ['0.0.0.0/0']), ('subnet', '172.30.241.0/24'),
                           ('project', 'ark-proto'), ('entry', True), ('image_id', 'mutable:latest')):
            changed = deepcopy(policy)
            changed[key] = value
            variants.append(changed)
        changed = deepcopy(policy)
        changed['targets'][0]['mappings'][1]['host_ip'] = '0.0.0.0'
        variants.append(changed)
        changed = deepcopy(policy)
        changed['targets'][0]['combat_workers'] = 12
        variants.append(changed)
        changed = deepcopy(policy)
        changed['targets'][0]['public_slot'] = 99
        variants.append(changed)
        changed = deepcopy(policy)
        changed['targets'].pop()
        variants.append(changed)
        for changed in variants:
            with self.subTest(changed=next((key for key in policy if policy[key] != changed[key]), '?')):
                with self.assertRaises(host.Refused):
                    host.parse_policy(changed)

    def test_world_readable_group_writable_and_symlink_files_refused(self):
        policy = self.generate()
        file = Path(policy['targets'][0]['runtime_file'])
        for mode in (0o444, 0o660, 0o666):
            with self.subTest(mode=mode):
                os.chmod(file, mode)
                with self.assertRaises(host.Refused):
                    host.protected_read(file)
        os.chmod(file, 0o440)
        link = self.root / 'alias'
        link.symlink_to(file)
        with self.assertRaises(deploy.Refused):
            host.protected_read(link)


class BridgeIpamTests(unittest.TestCase):
    def test_omitted_and_explicit_empty_iprange_are_the_same_fixed_bridge(self):
        for subnet in (deploy.CORE_SUBNET, deploy.EDGE_SUBNET):
            row = {'Subnet': subnet, 'Gateway': subnet.split('/')[0].rsplit('.', 1)[0] + '.1'}
            self.assertTrue(host.bridge_ipam_matches([row], subnet))
            explicit = {**row, 'IPRange': ''}
            self.assertTrue(host.bridge_ipam_matches([explicit], subnet))
            self.assertIn('IPRange', explicit, 'the observed Docker metadata must not be mutated')

    def test_actual_range_or_unknown_ipam_semantics_still_fail_closed(self):
        subnet = deploy.EDGE_SUBNET
        row = {'Subnet': subnet, 'Gateway': '172.30.243.1'}
        variants = [None, {}, [], [row, row], [{**row, 'IPRange': '172.30.243.0/25'}],
                    [{**row, 'IPRange': None}], [{**row, 'IPRange': False}],
                    [{**row, 'AuxiliaryAddresses': {}}], [{**row, 'unexpected': ''}],
                    [{**row, 'Subnet': deploy.CORE_SUBNET}], [{**row, 'Gateway': '172.30.243.2'}]]
        for value in variants:
            with self.subTest(value=value):
                self.assertFalse(host.bridge_ipam_matches(value, subnet))
        self.assertFalse(host.bridge_ipam_matches([row], '0.0.0.0/0'))


class HealthTests(Fixture):
    def game(self):
        return {'role': 'game', 'node_id': 'game-01', 'public_slot': 1}, {
            'nodeId': 'game-01', 'publicSlot': 1, 'build': BUILD, 'protocol': 1,
            'ready': True, 'streamMarkers': True, 'generation': 'node-new-generation',
            'health': {'combat': {'status': 'ready', 'workers': 8, 'ready': 8},
                       'trial': {'status': 'ready', 'workers': 2, 'ready': 2}}}

    def test_game_private_health_requires_every_actual_pool_worker(self):
        row, good = self.game()
        self.assertTrue(host.runtime_health_ready(good, row, BUILD))
        for pool in ('combat', 'trial'):
            for field, value in (('workers', 12), ('ready', 0), ('ready', True), ('ready', None), ('status', 'degraded'), ('status', 'unknown')):
                with self.subTest(pool=pool, field=field, value=value):
                    changed = deepcopy(good)
                    changed['health'][pool][field] = value
                    self.assertFalse(host.runtime_health_ready(changed, row, BUILD))

    def test_game_health_fences_node_build_protocol_slot_and_stream_marker(self):
        row, good = self.game()
        for field, value in (('nodeId', 'game-02'), ('build', 'b' * 40), ('protocol', 2), ('protocol', True), ('publicSlot', 2),
                             ('publicSlot', True), ('generation', ''), ('generation', 'new\n'), ('ready', False), ('streamMarkers', False)):
            with self.subTest(field=field, value=value):
                changed = deepcopy(good)
                changed[field] = value
                self.assertFalse(host.runtime_health_ready(changed, row, BUILD))

    def test_coordinator_is_worker_zero_not_monolith_twelve_plus_two(self):
        row = {'role': 'coordinator'}
        good = {'ok': True, 'version': 1, 'maxRooms': 0,
                'combat': {'backend': 'inline', 'workers': 0}, 'trial': {'workers': 0, 'status': 'disabled'}}
        self.assertTrue(host.runtime_health_ready(good, row, BUILD))
        for field, value in (('ok', False), ('version', 2), ('maxRooms', 4096), ('maxRooms', False)):
            changed = deepcopy(good)
            changed[field] = value
            self.assertFalse(host.runtime_health_ready(changed, row, BUILD))
        changed = deepcopy(good)
        changed['combat'] = {'backend': 'workers', 'workers': 12, 'ready': 12}
        self.assertFalse(host.runtime_health_ready(changed, row, BUILD))

    def test_ingress_health_is_listener_and_upgrade_not_public_health(self):
        row = {'role': 'ingress'}
        self.assertTrue(host.runtime_health_ready({'http_status': 404, 'websocket_upgrade': True}, row, BUILD))
        self.assertFalse(host.runtime_health_ready({'http_status': 200, 'websocket_upgrade': True}, row, BUILD))
        self.assertFalse(host.runtime_health_ready({'http_status': 404, 'websocket_upgrade': False}, row, BUILD))


class PredicateTests(Fixture):
    def scalar(self, value, packet):
        if not isinstance(value, dict):
            return value
        if 'set' in value:
            return set(value['set'])
        if 'meta' in value:
            key = value['meta']['key']
            return packet.get('meta:' + key, {'nfproto': 'ipv4', 'l4proto': 'tcp'}.get(key))
        if 'payload' in value:
            return packet.get(value['payload']['protocol'] + ':' + value['payload']['field'])
        if 'ct' in value:
            item = value['ct']
            return packet.get('ct:' + item.get('dir', 'current') + ':' + item['key'])
        raise AssertionError('unsupported expression')

    def evaluate(self, policy, leases, chain, packet):
        rules = [*host.base_rules(policy), *host.lease_rules(policy, leases)]
        for entry in rules:
            row = entry['rule']
            if row['chain'] != chain:
                continue
            matched = True
            for item in row['expr']:
                if 'match' in item:
                    left, right = self.scalar(item['match']['left'], packet), self.scalar(item['match']['right'], packet)
                    if left not in right if isinstance(right, set) else left != right:
                        matched = False
                        break
                elif matched:
                    if 'jump' in item:
                        result = self.evaluate(policy, leases, item['jump']['target'], packet)
                        if result is not None:
                            return result
                    if 'accept' in item:
                        return 'accept'
                    if 'drop' in item:
                        return 'drop'
            if not matched:
                continue
        return None

    def lease(self, policy):
        return {row['service']: {'network_id': NETWORK, 'container_id': CID} for row in policy['targets']}

    def core_packet(self):
        return {'meta:iifname': deploy.WG_IFACE, 'meta:oifname': 'br-' + NETWORK[:12],
                'ip:saddr': deploy.WG_PEERS[0], 'ip:daddr': '172.30.242.11',
                'tcp:dport': 3000, 'ct:current:direction': 'original',
                'ct:original:saddr': deploy.WG_PEERS[0], 'ct:original:daddr': deploy.WG_CORE,
                'ct:original:proto-dst': deploy.GAME_FIRST_PORT}

    def test_core_requires_wg_peer_original_publish_port_and_exact_target(self):
        policy = self.generate()
        leases = self.lease(policy)
        packet = self.core_packet()
        self.assertEqual(self.evaluate(policy, leases, 'forward', packet), 'accept')
        for field, value in (('meta:iifname', 'eth0'), ('ip:saddr', '10.253.78.99'),
                             ('ct:original:daddr', '172.30.242.11'), ('ct:original:proto-dst', 3000),
                             ('ip:daddr', '172.30.242.12'), ('ct:current:direction', 'reply')):
            with self.subTest(field=field, value=value):
                changed = {**packet, field: value}
                self.assertEqual(self.evaluate(policy, leases, 'forward', changed), 'drop')
        self.assertEqual(self.evaluate(policy, {}, 'forward', packet), 'drop')
        packet['ct:current:state'] = 'established'
        self.assertEqual(self.evaluate(policy, {}, 'forward', packet), 'drop')

    def test_all_four_peers_can_access_all_sixteen_nodes_without_split_realms(self):
        policy = self.generate()
        leases = self.lease(policy)
        for peer in deploy.WG_PEERS:
            for index in range(1, 17):
                packet = {**self.core_packet(), 'ip:saddr': peer, 'ct:original:saddr': peer,
                          'ip:daddr': '172.30.242.' + str(10 + index),
                          'ct:original:proto-dst': deploy.GAME_FIRST_PORT + index - 1}
                self.assertEqual(self.evaluate(policy, leases, 'forward', packet), 'accept')

    def test_private_end_port_never_has_wg_peer_lease(self):
        policy = self.generate()
        leases = self.lease(policy)
        packet = {**self.core_packet(), 'ip:daddr': '172.30.242.2', 'tcp:dport': 3001,
                  'ct:original:proto-dst': deploy.END_PORT}
        self.assertEqual(self.evaluate(policy, leases, 'forward', packet), 'drop')
        packet.update({'meta:iifname': 'br-' + NETWORK[:12], 'ip:saddr': '172.30.242.11'})
        self.assertEqual(self.evaluate(policy, leases, 'forward', packet), 'accept')

    def test_edge_only_fixed_bridge_can_forward_to_core_and_expected_ports(self):
        policy = self.generate('edge', role='edge')
        leases = self.lease(policy)
        packet = {'meta:iifname': 'br-' + NETWORK[:12], 'meta:oifname': deploy.WG_IFACE,
                  'ip:saddr': '172.30.243.2', 'ip:daddr': deploy.WG_CORE,
                  'tcp:dport': deploy.GAME_FIRST_PORT, 'ct:current:direction': 'original'}
        self.assertEqual(self.evaluate(policy, leases, 'forward', packet), 'accept')
        for field, value in (('meta:iifname', 'foreign0'), ('tcp:dport', deploy.END_PORT), ('ip:saddr', '172.30.243.3')):
            self.assertEqual(self.evaluate(policy, leases, 'forward', {**packet, field: value}), 'drop')
        self.assertEqual(self.evaluate(policy, {}, 'forward', packet), 'drop')

    def test_edge_host_reply_cannot_bypass_port_or_conntrack_scope(self):
        policy = self.generate('edge', role='edge')
        leases = self.lease(policy)
        packet = {'meta:iifname': deploy.WG_IFACE, 'ip:saddr': deploy.WG_CORE, 'ip:daddr': policy['wg_local'],
                  'ct:current:direction': 'reply', 'ct:current:state': 'established',
                  'ct:original:daddr': deploy.WG_CORE, 'ct:original:proto-dst': deploy.COORDINATOR_PORT}
        self.assertEqual(self.evaluate(policy, leases, 'input', packet), 'accept')
        self.assertEqual(self.evaluate(policy, {}, 'input', packet), 'drop')
        self.assertEqual(self.evaluate(policy, leases, 'input', {**packet, 'ct:original:proto-dst': deploy.END_PORT}), 'drop')

    def test_other_interfaces_and_services_are_not_modified(self):
        policy = self.generate()
        packet = {'meta:iifname': 'ark-wg-test', 'meta:oifname': 'eth0',
                  'ip:saddr': '10.253.77.1', 'ip:daddr': '172.30.241.10', 'tcp:dport': 3000}
        self.assertIsNone(self.evaluate(policy, self.lease(policy), 'forward', packet))
        self.assertIsNone(self.evaluate(policy, self.lease(policy), 'input', packet))


@unittest.skipUnless(os.geteuid() == 0, 'root protected Docker-metadata fixtures')
class IdentityTests(Fixture):
    def system_fixture(self, role='game', stopped=False, ingress_instances=1, instance=1):
        policy = self.generate('fixture-' + role, role='edge' if role == 'ingress' else 'core', ingress_instances=ingress_instances)
        target = (next(row for row in policy['targets'] if row['service'] == deploy.ingress_service(instance))
                  if role == 'ingress' else self.target(policy, role))
        config = host.Config(policy, target)
        ports = {}
        for row in target['mappings']:
            ports.setdefault(str(row['container_port']) + '/tcp', []).append({'HostIp': row['host_ip'], 'HostPort': str(row['host_port'])})
        mounts = [{'Type': 'bind', 'RW': False, 'Source': str(Path(target['runtime_file']).parent), 'Destination': '/run/config'}]
        if role != 'ingress':
            mounts.append({'Type': 'bind', 'RW': False, 'Source': target['key_file'] if role == 'game' else str(Path(policy['bundle']) / 'keys'),
                           'Destination': '/run/secrets/game.key' if role == 'game' else '/run/secrets'})
        info = {'id': CID, 'name': '/' + target['container_name'], 'pid': 0 if stopped else 1234,
                'running': not stopped, 'restarting': False, 'started_at': 'fixture-start', 'restarts': 0,
                'image_id': IMAGE, 'init': True, 'readonly': True, 'privileged': False, 'cap_drop': ['ALL'],
                'cap_add': [], 'security_opt': ['no-new-privileges'], 'pids': 128,
                'cpu_quota': 0, 'nano_cpus': 0, 'memory': 0, 'cpuset': '',
                'project': target['project'], 'service': target['service'], 'revision': BUILD, 'source': deploy.SOURCE,
                'all_ports': {} if stopped else ports, 'port_bindings': ports,
                'networks': {target['project'] + '_default': {'IPAddress': '' if stopped else target['container_ip'],
                    'IPPrefixLen': 0 if stopped else 24, 'GlobalIPv6Address': '',
                    'IPAMConfig': {'IPv4Address': target['container_ip']}, 'NetworkID': '' if stopped else NETWORK}},
                'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}, 'mounts': mounts,
                'cmd': ['node', 'server/cluster/start.mjs', '--config', '/run/config/runtime.json'], 'user': '1000:1000',
                'role': role, 'namespace': policy['namespace'], 'kind': 'tree', 'manifest': MANIFEST}
        image = {'id': IMAGE, 'revision': BUILD, 'source': deploy.SOURCE, 'kind': 'tree', 'manifest': MANIFEST}
        network = {'id': NETWORK, 'driver': 'bridge', 'ipam': [{'Subnet': policy['subnet'], 'Gateway': policy['subnet'].split('/')[0].rsplit('.', 1)[0] + '.1'}],
                   'labels': {'com.docker.compose.project': target['project'], 'com.docker.compose.network': 'default'}, 'options': {}}

        class FakeSystem(host.System):
            def docker(self, *args):
                return deepcopy({'container': info, 'image': image, 'network': network}[args[0]])

        system = FakeSystem(config)
        system.fixture_network = network
        return policy, target, info, system

    def test_second_ingress_never_accepts_sibling_identity_mapping_ip_or_mount(self):
        policy, target, info, system = self.system_fixture('ingress', ingress_instances=2, instance=2)
        self.assertEqual(target['service'], 'ingress-02')
        system.inspect(target['container_name'])
        original = deepcopy(info)
        sibling = policy['targets'][0]
        variants = []
        for field, value in (('service', sibling['service']), ('name', '/' + sibling['container_name'])):
            changed = deepcopy(info); changed[field] = value; variants.append(changed)
        changed = deepcopy(info); changed['all_ports']['3000/tcp'][0]['HostPort'] = str(sibling['mappings'][0]['host_port']); variants.append(changed)
        changed = deepcopy(info); changed['networks'][target['project'] + '_default']['IPAddress'] = sibling['container_ip']; variants.append(changed)
        changed = deepcopy(info); changed['mounts'][0]['Source'] = str(Path(sibling['runtime_file']).parent); variants.append(changed)
        for changed in variants:
            info.clear(); info.update(changed)
            with self.assertRaises(host.Refused): system.inspect(CID)
        info.clear(); info.update(original)
        system.inspect(target['container_name'])

    def test_second_ingress_listener_probe_uses_only_its_own_loopback_port_and_origin(self):
        policy, target, _, system = self.system_fixture('ingress', ingress_instances=2, instance=2)
        calls = []
        def http(port, method, path):
            calls.append(('http', port, method, path)); return 404, b''
        def websocket(port, origin):
            calls.append(('websocket', port, origin)); return True
        with patch.object(host, 'http_request', http), patch.object(host, 'websocket_upgrade', websocket):
            system.health()
        port = target['mappings'][0]['host_port']
        self.assertEqual(calls, [('http', port, 'GET', '/healthz'), ('websocket', port, policy['origin'])])
        self.assertNotEqual(port, policy['targets'][0]['mappings'][0]['host_port'])

    def test_ingress_observed_empty_docker_iprange_passes_exact_identity_but_real_range_does_not(self):
        _, target, _, system = self.system_fixture('ingress')
        system.fixture_network['ipam'][0]['IPRange'] = ''
        value = system.inspect(target['container_name'])
        self.assertEqual(value['id'], CID)
        self.assertEqual(value['role'], 'ingress')
        self.assertEqual(system.config.worker_count, 0)
        self.assertEqual(len(value['mounts']), 1)
        system.network_cache.clear()
        system.fixture_network['ipam'][0]['IPRange'] = '172.30.243.0/25'
        with self.assertRaises(host.Refused):
            system.inspect(target['container_name'])

    def test_game_and_coordinator_exact_metadata_accepted(self):
        for role in ('game', 'coordinator'):
            with self.subTest(role=role):
                _, target, _, system = self.system_fixture(role)
                value = system.inspect(target['container_name'])
                self.assertEqual(value['id'], CID)
                self.assertEqual(value['network_id'], NETWORK)
                self.assertEqual(system.last_info, value)

    def test_docker_classic_mount_order_is_canonical_but_all_fields_are_preserved(self):
        _, target, info, system = self.system_fixture()
        for row in info['mounts']:
            row['Propagation'] = 'rprivate'
        first = system.inspect(target['container_name'])
        info['mounts'].reverse()
        second = system.inspect(target['container_name'])
        self.assertEqual(first, second)
        self.assertEqual([row['Destination'] for row in first['mounts']], sorted(row['Destination'] for row in first['mounts']))
        self.assertTrue(all(row['Propagation'] == 'rprivate' for row in first['mounts']))
        info['mounts'][0]['Propagation'] = 'different-semantic-value'
        third = system.inspect(target['container_name'])
        self.assertNotEqual(first, third, 'real metadata changes must still trip the inherited generation fence')

    def test_reordered_mounts_do_not_allow_wrong_source_or_writable_key(self):
        _, target, info, system = self.system_fixture()
        info['mounts'].reverse()
        system.inspect(target['container_name'])
        original = deepcopy(info)
        info['mounts'][0]['Source'] = '/unexpected/source'
        with self.assertRaises(host.Refused):
            system.inspect(target['container_name'])
        info.clear()
        info.update(original)
        info['mounts'][0]['RW'] = True
        with self.assertRaises(host.Refused):
            system.inspect(target['container_name'])

    def test_stopped_owned_role_requires_explicit_cold_validation(self):
        _, target, _, system = self.system_fixture(stopped=True)
        with self.assertRaises(host.NotReady):
            system.inspect(target['container_name'])
        cold = system.inspect(target['container_name'], allow_stopped=True)
        self.assertFalse(cold['running'])
        self.assertEqual(cold['id'], CID)
        self.assertEqual(cold['network_id'], NETWORK)

    def test_identity_resource_permission_and_role_forgery_refused(self):
        _, target, info, system = self.system_fixture()
        original = deepcopy(info)
        cases = [('id', 'e' * 64), ('name', '/ark-proto'), ('project', 'ark-proto'), ('service', 'ark-proto'),
                 ('image_id', 'sha256:' + 'e' * 64), ('revision', 'e' * 40), ('source', 'other'),
                 ('role', 'coordinator'), ('namespace', 'formal' if self.profile == 'beta' else 'beta'), ('kind', 'commit'), ('manifest', 'e' * 64),
                 ('init', False), ('readonly', False), ('privileged', True), ('cap_add', ['SYS_NICE']),
                 ('cap_drop', []), ('security_opt', []), ('pids', 1024), ('cpu_quota', 10000),
                 ('nano_cpus', 1000000), ('memory', 1000000), ('cpuset', '0'), ('user', 'root'),
                 ('restart_policy', {'Name': 'always', 'MaximumRetryCount': 0}),
                 ('cmd', ['node', 'server/index.js'])]
        for field, value in cases:
            info.clear()
            info.update(deepcopy(original))
            info[field] = value
            with self.subTest(field=field):
                with self.assertRaises(host.Refused):
                    system.inspect(CID)
        info.clear()
        info.update(original)

    def test_wrong_mapping_network_and_extra_secret_mount_refused(self):
        _, target, info, system = self.system_fixture()
        original = deepcopy(info)
        changes = []
        value = deepcopy(original)
        value['all_ports']['3000/tcp'][0]['HostIp'] = '0.0.0.0'
        changes.append(value)
        value = deepcopy(original)
        value['all_ports']['9999/tcp'] = [{'HostIp': '0.0.0.0', 'HostPort': '9999'}]
        changes.append(value)
        value = deepcopy(original)
        value['networks'][target['project'] + '_default']['IPAddress'] = '172.30.242.12'
        changes.append(value)
        value = deepcopy(original)
        value['mounts'].append({'Type': 'bind', 'RW': False, 'Source': '/other/secrets', 'Destination': '/other'})
        changes.append(value)
        value = deepcopy(original)
        value['mounts'][0]['RW'] = True
        changes.append(value)
        for value in changes:
            info.clear()
            info.update(value)
            with self.assertRaises(host.Refused):
                system.inspect(CID)

    def test_single_role_failure_withdraws_only_its_lease_and_new_epoch_never_adopted(self):
        policy = self.generate()
        expected = {row['service']: {'container_id': CID, 'node_generation': 'old-epoch'} for row in policy['targets']}
        systems = {row['service']: object() for row in policy['targets']}

        def fault(_policy, row, **_kwargs):
            if row['service'] == 'game-01':
                raise host.NotReady('fixture pool warming')
            return expected[row['service']]

        with patch.object(host, 'lease_ready', fault):
            actual = host.healthy_leases(policy, expected, systems)
        self.assertEqual(len(actual), 16)
        self.assertNotIn('game-01', actual)
        self.assertIn('coordinator', actual)

        def recovered(_policy, row, **_kwargs):
            return expected[row['service']]

        with patch.object(host, 'lease_ready', recovered):
            self.assertEqual(host.healthy_leases(policy, expected, systems), expected)

        def new_epoch(_policy, row, **_kwargs):
            return {**expected[row['service']], 'node_generation': 'new-epoch'} if row['service'] == 'game-01' else expected[row['service']]

        with patch.object(host, 'lease_ready', new_epoch):
            self.assertNotIn('game-01', host.healthy_leases(policy, expected, systems))

    def test_stop_uses_all_recorded_owned_cids_and_never_container_names(self):
        policy = self.generate()
        expected = {row['service']: {'container_id': format(index, '064x'), 'image_id': IMAGE,
                                     'started_at': 'fixture-start', 'restarts': 0}
                    for index, row in enumerate(policy['targets'], start=1)}
        calls, guard_calls = [], []

        class GuardFixture:
            def state(self):
                return {'leases': {}, 'owned_leases': expected}

            def update(self, value):
                guard_calls.append(value)

        class SystemFixture:
            def __init__(self, config):
                self.target = config.target

            def inspect(self, requested, **_kwargs):
                record = expected[self.target['service']]
                self_test.assertEqual(requested, record['container_id'])
                return {'id': requested, 'image_id': record['image_id'], 'started_at': record['started_at'],
                        'restarts': 0, 'running': True}

        def run(arguments, **_kwargs):
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0)

        self_test = self
        with patch.object(host, 'System', SystemFixture), patch.object(host.subprocess, 'run', run):
            host.stop(policy, GuardFixture())
        self.assertEqual(guard_calls, [{}])
        self.assertEqual(len(calls), 17)
        self.assertEqual({call[-1] for call in calls}, {record['container_id'] for record in expected.values()})
        self.assertTrue(all(call[:len(host.priority.DOCKER)] == host.priority.DOCKER for call in calls))
        self.assertFalse(any(row['container_name'] in call for row in policy['targets'] for call in calls))

    def test_stop_epoch_mismatch_refuses_before_any_docker_stop(self):
        policy = self.generate()
        expected = {row['service']: {'container_id': format(index, '064x'), 'image_id': IMAGE,
                                     'started_at': 'fixture-start', 'restarts': 0}
                    for index, row in enumerate(policy['targets'], start=1)}
        calls = []

        class GuardFixture:
            def state(self):
                return {'owned_leases': expected}

            def update(self, value):
                self_test.assertEqual(value, {})

        class SystemFixture:
            def __init__(self, config):
                self.target = config.target

            def inspect(self, requested, **_kwargs):
                record = expected[self.target['service']]
                return {'id': requested, 'image_id': record['image_id'],
                        'started_at': 'later-generation' if self.target['service'] == 'game-01' else record['started_at'],
                        'restarts': 0, 'running': True}

        self_test = self
        with patch.object(host, 'System', SystemFixture), patch.object(host.subprocess, 'run', lambda *args, **kwargs: calls.append(args)):
            with self.assertRaises(host.Refused):
                host.stop(policy, GuardFixture())
        self.assertEqual(calls, [])

    def test_nft_modern_and_legacy_compile_selection_never_double_applies(self):
        rules = [{'add': host.rule('test', 'lease', [host.match(host.ct('daddr', 'original'), '10.253.78.2'), {'drop': None}])}]
        for legacy in (False, True):
            calls = []

            class NftFixture(host.Nft):
                def command(self, args, data=None, **_kwargs):
                    calls.append((args, json.loads(data)))
                    if legacy and '-c' in args and 'ip daddr' in data:
                        raise host.Refused('synthetic older-parser refusal')
                    return ''

            NftFixture().apply(rules)
            applications = [value for args, value in calls if '-c' not in args]
            self.assertEqual(len(applications), 1)
            self.assertEqual(len(calls), 3 if legacy else 2)


def independent_leases(policy):
    return {row['service']: {'container_id': format(index, '064x'), 'image_id': policy['image_id'],
                            'revision': policy['build'], 'started_at': 'fixture-start-' + str(index), 'restarts': 0,
                            'init_pid': 1000 + index, 'init_start': 100 + index,
                            'main_pid': 2000 + index, 'main_start': 200 + index, 'network_id': NETWORK,
                            'container_ip': row['container_ip'], 'runtime_sha256': row['runtime_sha256'],
                            'node_generation': None}
            for index, row in enumerate(policy['targets'], 1)}


class MemoryNft:
    """Only a userspace transaction fixture; never calls the kernel or Docker."""
    def __init__(self):
        self.rows = None
        self.calls = []
        self.handle = 0

    def snapshot(self, _table):
        return deepcopy(self.rows)

    def apply(self, commands):
        self.calls.append(deepcopy(commands))
        if self.rows is None:
            self.rows = []
        for command in commands:
            if 'add' in command:
                row = deepcopy(command['add'])
                if 'rule' in row:
                    self.handle += 1
                    row['rule']['handle'] = self.handle
                self.rows.append(row)
            else:
                handle = command['delete']['rule']['handle']
                self.rows = [row for row in self.rows if row.get('rule', {}).get('handle') != handle]


@unittest.skipUnless(os.geteuid() == 0, 'root-owned dual-ingress protected fixtures')
class DualIngressTests(Fixture):
    def dual(self):
        return self.generate('dual', role='edge', ingress_instances=2)

    def guard(self, policy, nft=None):
        return host.Guard(policy, nft=nft or MemoryNft(), state_file=self.root / 'dual.guard.json')

    def test_default_single_and_core_are_unchanged_and_explicit_one_is_legacy(self):
        p = deploy.profiles.get_profile(self.profile)
        for role in ('core', 'edge'):
            default = deploy.generate(self.root / ('default-' + role), image=IMAGE, build=BUILD,
                                      manifest_sha256=MANIFEST, source_kind='tree', role=role, profile=self.profile)
            explicit = self.generate('explicit-' + role, role=role, ingress_instances=1)
            self.assertNotIn('ingress_instances', default)
            self.assertNotIn('ingress_instances', explicit)
            self.assertEqual(len(default['targets']), 17 if role == 'core' else 1)
            first = deploy.canonical(default).replace(default['bundle'].encode(), b'BUNDLE')
            second = deploy.canonical(explicit).replace(explicit['bundle'].encode(), b'BUNDLE')
            # Only the Compose digest includes the independently located bind paths.
            left, right = json.loads(first), json.loads(second)
            left.pop('compose_sha256'); right.pop('compose_sha256')
            self.assertEqual(left, right)
            if role == 'edge':
                self.assertEqual(default['targets'][0]['container_ip'], p.edge_ip)
                self.assertEqual(default['targets'][0]['mappings'][0]['host_port'], p.ingress_port)
            self.assertEqual(host.load_policy(Path(default['bundle']) / 'host-policy.json', profile=self.profile), default)

    def test_four_dual_entries_have_eight_independent_targets_and_same_global_routes(self):
        p = deploy.profiles.get_profile(self.profile)
        names = set()
        for entry in range(1, 5):
            policy = self.generate('edge-' + str(entry), role='edge', entry=entry, ingress_instances=2)
            self.assertEqual(policy['ingress_instances'], 2)
            self.assertEqual([row['service'] for row in policy['targets']], ['ingress', 'ingress-02'])
            self.assertEqual(len({row['container_ip'] for row in policy['targets']}), 2)
            self.assertEqual(len({row['runtime_file'] for row in policy['targets']}), 2)
            self.assertEqual([row['mappings'][0]['host_port'] for row in policy['targets']], [p.ingress_port, p.ingress_port + 1])
            compose = json.loads(Path(policy['compose_file']).read_bytes())
            for index, target in enumerate(policy['targets'], 1):
                names.add(target['container_name'])
                runtime = json.loads(Path(target['runtime_file']).read_bytes())
                self.assertEqual(runtime['coordinatorUrl'], f'http://{p.wg_core}:{p.coordinator_port}')
                self.assertEqual(runtime['nodes'], [{'nodeId': 'game-' + format(i, '02d'),
                    'url': f'http://{p.wg_core}:{p.game_first_port + i - 1}'} for i in range(1, 17)])
                self.assertNotIn('ingressId', runtime)
                self.assertEqual((target['combat_workers'], target['trial_workers']), (0, 0))
                self.assertEqual(target['container_ip'], p.ingress_ip(index))
                service = compose['services'][target['service']]
                self.assertEqual(service['cap_drop'], ['ALL'])
                self.assertNotIn('cap_add', service)
                self.assertNotIn('cpus', service)
                self.assertNotIn('mem_limit', service)
                self.assertEqual(service['volumes'], [str(Path(target['runtime_file']).parent) + ':/run/config:ro'])
            self.assertEqual(host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile=self.profile), policy)
            summary = json.loads(Path(policy['bundle'], 'bundle-summary.json').read_bytes())
            self.assertEqual(summary['ingressInstances'], 2)
            self.assertFalse(summary['activated'])
        self.assertEqual(len(names), 8)

    def test_unsupported_counts_and_core_expansion_refuse_before_creating_output(self):
        for count in (0, 3, -1, True, False, None, '2', 2.0):
            with self.subTest(count=count), self.assertRaises(deploy.Refused):
                self.generate('invalid', role='edge', ingress_instances=count)
            self.assertFalse((self.root / 'invalid').exists())
        with self.assertRaises(deploy.Refused):
            self.generate('invalid-core', ingress_instances=2)
        self.assertFalse((self.root / 'invalid-core').exists())
        p = deploy.profiles.get_profile(self.profile)
        for count in (0, 3, True, '2'):
            with self.assertRaises(ValueError): p.ingress_ip(count)
            with self.assertRaises(ValueError): p.ingress_host_port(count)

    def test_duplicate_or_non_fixed_service_ip_port_runtime_and_counts_refused(self):
        policy = self.dual()
        variants = []
        for field in ('service', 'container_name', 'container_ip', 'mappings', 'runtime_file'):
            changed = deepcopy(policy)
            changed['targets'][1][field] = deepcopy(changed['targets'][0][field])
            variants.append(changed)
        for count in (0, 1, 3, True, '2', 2.0):
            changed = deepcopy(policy); changed['ingress_instances'] = count; variants.append(changed)
        for field, value in (('role', 'ingress-02'), ('combat_workers', 1), ('trial_workers', 1), ('node_id', 'ingress-02')):
            changed = deepcopy(policy); changed['targets'][1][field] = value; variants.append(changed)
        changed = deepcopy(policy); changed['targets'][1]['mappings'][0]['host_ip'] = '0.0.0.0'; variants.append(changed)
        for changed in variants:
            with self.assertRaises(host.Refused): host.parse_policy(changed, profile=self.profile)
        changed = deepcopy(policy); changed.pop('ingress_instances')
        with self.assertRaises(host.Refused): host.parse_policy(changed, profile=self.profile)

    def test_each_runtime_and_compose_security_baseline_remain_immutable(self):
        policy = self.dual()
        runtime = Path(policy['targets'][1]['runtime_file'])
        runtime.chmod(0o640); runtime.write_bytes(runtime.read_bytes() + b' '); runtime.chmod(0o440)
        with self.assertRaises(host.Refused): host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile=self.profile)
        policy = self.generate('dual-other', role='edge', ingress_instances=2)
        compose_file = Path(policy['compose_file'])
        compose = json.loads(compose_file.read_bytes())
        compose['services']['ingress-02']['cap_add'] = ['SYS_NICE']
        raw = deploy.canonical(compose); compose_file.write_bytes(raw)
        policy['compose_sha256'] = hashlib.sha256(raw).hexdigest()
        Path(policy['bundle'], 'host-policy.json').write_bytes(deploy.canonical(policy))
        with self.assertRaises(host.Refused): host.load_policy(Path(policy['bundle']) / 'host-policy.json', profile=self.profile)

    def test_exact_independent_lease_schema_and_target_binding(self):
        policy = self.dual()
        expected = independent_leases(policy)
        host.validate_leases(policy, expected)
        for service in expected:
            host.validate_leases(policy, {service: expected[service]})
        variants = []
        for field in expected['ingress']:
            changed = deepcopy(expected); changed['ingress'].pop(field); variants.append(changed)
        for field, value in (('container_ip', policy['targets'][1]['container_ip']), ('runtime_sha256', 'e' * 64),
                             ('container_id', 'bad'), ('network_id', 'bad'), ('image_id', 'sha256:' + 'e' * 64),
                             ('revision', 'e' * 40), ('main_pid', True), ('main_start', 0), ('restarts', True),
                             ('started_at', 'bad\n'), ('node_generation', 'foreign-epoch'), ('extra', 'refused')):
            changed = deepcopy(expected); changed['ingress'][field] = value; variants.append(changed)
        for field in ('container_id', 'main_pid', 'init_pid'):
            changed = deepcopy(expected); changed['ingress-02'][field] = changed['ingress'][field]; variants.append(changed)
        changed = deepcopy(expected); changed['ingress-02']['network_id'] = 'e' * 64; variants.append(changed)
        changed = deepcopy(expected); changed['ingress-02']['init_pid'] = changed['ingress']['main_pid']; variants.append(changed)
        changed = {'unknown': expected['ingress']}; variants.append(changed)
        changed = {'ingress': expected['ingress-02'], 'ingress-02': expected['ingress']}; variants.append(changed)
        for changed in variants:
            with self.assertRaises(host.Refused): host.lease_rules(policy, changed)

    def test_forward_and_reply_grants_close_only_the_selected_ingress(self):
        policy = self.dual()
        leases = independent_leases(policy)
        p = deploy.profiles.get_profile(self.profile)
        predicate = PredicateTests()
        for target in policy['targets']:
            name, address = target['service'], target['container_ip']
            retained = {key: value for key, value in leases.items() if key != name}
            packet = {'meta:iifname': 'br-' + NETWORK[:12], 'meta:oifname': p.wg_interface,
                      'ip:saddr': address, 'ip:daddr': p.wg_core,
                      'tcp:dport': p.game_first_port, 'ct:current:direction': 'original'}
            reply = {'meta:iifname': p.wg_interface, 'meta:oifname': 'br-' + NETWORK[:12],
                     'ip:saddr': p.wg_core, 'ip:daddr': address, 'ct:current:direction': 'reply',
                     'ct:current:state': 'established', 'ct:original:daddr': p.wg_core,
                     'ct:original:proto-dst': p.game_first_port}
            for value in (packet, reply):
                self.assertEqual(predicate.evaluate(policy, leases, 'forward', value), 'accept')
                self.assertEqual(predicate.evaluate(policy, retained, 'forward', value), 'drop')
                self.assertEqual(predicate.evaluate(policy, {}, 'forward', value), 'drop')
            sibling = next(row for row in policy['targets'] if row['service'] != name)
            self.assertEqual(predicate.evaluate(policy, retained, 'forward', {**packet, 'ip:saddr': sibling['container_ip']}), 'accept')
            self.assertEqual(predicate.evaluate(policy, retained, 'forward', {**reply, 'ip:daddr': sibling['container_ip']}), 'accept')
            for field, value in (('meta:iifname', 'foreign0'), ('tcp:dport', p.end_port), ('ip:saddr', p.ingress_ip(2).rsplit('.', 1)[0] + '.99')):
                self.assertEqual(predicate.evaluate(policy, leases, 'forward', {**packet, field: value}), 'drop')
            for field, value in (('ct:current:direction', 'original'), ('ct:original:proto-dst', p.end_port), ('ct:original:daddr', '1.2.3.4')):
                self.assertEqual(predicate.evaluate(policy, leases, 'forward', {**reply, field: value}), 'drop')
            inbound = {'meta:iifname': 'eth0', 'ip:daddr': address, 'tcp:dport': 3000}
            self.assertEqual(predicate.evaluate(policy, leases, 'forward', inbound), 'drop')
        host_rules = [row for row in host.lease_rules(policy, leases) if row['rule']['chain'] == 'lease'
                      and any(item.get('match', {}).get('right') == policy['wg_local'] for item in row['rule']['expr'])]
        self.assertEqual(len(host_rules), 2, 'shared gated host transport is not duplicated')

    def test_guard_publication_revocation_and_retirement_preserve_sibling(self):
        policy = self.dual()
        expected = independent_leases(policy)
        guard = self.guard(policy)
        state = guard.update(expected)
        self.assertEqual(state['policy_sha256'], hashlib.sha256(deploy.canonical(policy)).hexdigest())
        retained = host.revoke(policy, guard, 'ingress')
        self.assertEqual(retained, {'ingress-02': expected['ingress-02']})
        guard.check(retained)
        state = guard.state()
        self.assertEqual(state['owned_leases'], expected)
        self.assertEqual(state['retired_leases'], {'ingress': expected['ingress']})
        self.assertEqual(host.revoke(policy, guard, 'ingress'), retained)
        with self.assertRaises(host.Refused): guard.update(expected)
        guard.update(expected, resume='ingress')
        self.assertEqual(guard.state()['retired_leases'], {})
        host.revoke(policy, guard, 'ingress-02')
        self.assertEqual(guard.state()['leases'], {'ingress': expected['ingress']})

    def test_invalid_lease_refuses_before_any_guard_creation_or_change(self):
        policy = self.dual()
        guard = self.guard(policy)
        bad = independent_leases(policy); bad['ingress-02']['main_pid'] = bad['ingress']['main_pid']
        with self.assertRaises(host.Refused): guard.update(bad)
        self.assertEqual(guard.nft.calls, [])
        self.assertFalse(guard.state_file.exists())
        expected = independent_leases(policy); guard.update(expected)
        before, calls = guard.state(), len(guard.nft.calls)
        with self.assertRaises(host.Refused): guard.update(bad)
        self.assertEqual(guard.state(), before)
        self.assertEqual(len(guard.nft.calls), calls)
        with self.assertRaises(host.Refused): host.revoke(policy, guard, 'foreign')
        self.assertEqual(guard.state(), before)

    def test_unbound_legacy_or_changed_dual_policy_requires_approved_closed_replacement(self):
        legacy = self.generate('single', role='edge')
        nft = MemoryNft()
        guard = self.guard(legacy, nft); guard.update({})
        dual = self.dual()
        with self.assertRaises(host.Refused): self.guard(dual, nft).update({})
        self.assertEqual(len(nft.calls), 1)
        nft = MemoryNft()
        bound = host.Guard(dual, nft=nft, state_file=self.root / 'bound.guard.json')
        bound.update({})
        changed = deepcopy(dual); changed['targets'][0]['runtime_sha256'] = 'e' * 64
        before, calls = bound.state(), len(nft.calls)
        with self.assertRaises(host.Refused):
            host.Guard(changed, nft=nft, state_file=bound.state_file).update({})
        self.assertEqual(bound.state(), before)
        self.assertEqual(len(nft.calls), calls)

    def test_single_fault_and_new_process_epochs_never_revoke_the_healthy_sibling(self):
        policy = self.dual()
        expected = independent_leases(policy)
        systems = {name: object() for name in expected}
        for failed in expected:
            def fault(_policy, target, **_kwargs):
                if target['service'] == failed: raise host.NotReady('fixture failed')
                return expected[target['service']]
            with patch.object(host, 'lease_ready', fault):
                self.assertEqual(host.healthy_leases(policy, expected, systems),
                                 {name: lease for name, lease in expected.items() if name != failed})
            for field, value in (('container_id', 'e' * 64), ('main_start', 999), ('init_start', 999), ('started_at', 'restarted'), ('restarts', 1)):
                def changed(_policy, target, **_kwargs):
                    lease = expected[target['service']]
                    return {**lease, field: value} if target['service'] == failed else lease
                with patch.object(host, 'lease_ready', changed):
                    self.assertNotIn(failed, host.healthy_leases(policy, expected, systems))

    def test_scoped_stop_revalidates_only_recorded_cid_and_leaves_sibling_live(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        calls = []
        def stopping(args, **kwargs):
            calls.append(args); return stop(args, **kwargs)
        with patch.object(host, 'System', system), patch.object(host.subprocess, 'run', stopping):
            host.stop(policy, guard, service='ingress')
        self.assertEqual([call[-1] for call in calls], [expected['ingress']['container_id']])
        self.assertEqual(guard.state()['leases'], {'ingress-02': expected['ingress-02']})
        self.assertEqual(guard.state()['closed_owners']['ingress']['container_id'], expected['ingress']['container_id'])
        guard.check(guard.state()['leases'])

    def test_scoped_stop_epoch_failure_keeps_sibling_and_never_calls_docker_stop(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        records['ingress']['started_at'] = 'outside-manager-epoch'
        calls = []
        with patch.object(host, 'System', system), patch.object(host.subprocess, 'run', lambda *args, **kwargs: calls.append(args)):
            with self.assertRaises(host.Refused): host.stop(policy, guard, service='ingress')
        self.assertEqual(calls, [])
        self.assertEqual(guard.state()['leases'], {'ingress-02': expected['ingress-02']})

    def test_scoped_read_only_check_and_error_never_change_any_lease(self):
        policy = self.dual()
        expected = independent_leases(policy)
        guard = self.guard(policy); guard.update(expected)
        before = guard.state()
        with patch.object(host, 'lease_ready', return_value=expected['ingress-02']):
            host.check_target(policy, guard, 'ingress-02')
        with patch.object(host, 'lease_ready', return_value={**expected['ingress-02'], 'main_start': 999}):
            with self.assertRaises(host.Refused): host.check_target(policy, guard, 'ingress-02')
        self.assertEqual(guard.state(), before)


    @contextmanager
    def live_control(self, policy, guard, expected, systems):
        ready, done = threading.Event(), threading.Event()
        failures = []
        path, lock = self.root / 'manager.sock', self.root / 'lifetime.lock'
        def owner():
            try:
                with host.priority.runtime_lock(str(lock), timeout=1):
                    controller = host.ScopedControl(policy, guard, expected, systems)
                    server = host.ControlServer(controller, path=path)
                    ready.set()
                    try:
                        while not done.is_set():
                            server.poll(0.05)
                            controller.refresh()
                    finally:
                        server.close()
            except BaseException as failure:
                failures.append(failure)
                ready.set()
        thread = threading.Thread(target=owner, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(5))
        if failures: raise failures[0]
        try:
            yield path, lock
        finally:
            done.set(); thread.join(5)
            self.assertFalse(thread.is_alive())
            if failures: raise failures[0]
            self.assertFalse(path.exists())

    def control_fixture(self):
        policy = self.dual()
        expected = independent_leases(policy)
        guard = self.guard(policy); guard.update(expected)
        running = {name: True for name in expected}
        records = deepcopy(expected)
        class SystemFixture:
            def __init__(self, config): self.config = config
            def inspect(self, requested, **_kwargs):
                name = self.config.target['service']; record = records[name]
                if requested not in (record['container_id'], self.config.target['container_name']):
                    raise host.Refused('fixture selector mismatch')
                self.last_info = {'id': record['container_id'], 'image_id': record['image_id'], 'revision': record['revision'],
                                  'started_at': record['started_at'], 'restarts': record['restarts'], 'running': running[name],
                                  'network_id': record['network_id']}
                return self.last_info
            def snapshot(self, requested, **_kwargs):
                self.inspect(requested)
                name = self.config.target['service']; record = records[name]
                generation = host.priority.Generation(**{key: record[key] for key in host.priority.Generation.__dataclass_fields__})
                return host.priority.Snapshot(generation, ())
        systems = {row['service']: SystemFixture(host.Config(policy, row)) for row in policy['targets']}
        def ready(_policy, target, **_kwargs):
            if not running[target['service']]: raise host.NotReady('fixture stopped')
            return deepcopy(records[target['service']])
        def start(_policy, *, services):
            for name in services:
                if not running[name]:
                    running[name] = True
                    records[name]['started_at'] += '-resumed'
                    records[name]['main_start'] += 1000
                    records[name]['init_start'] += 1000
        def stop(args, **_kwargs):
            self.assertEqual(args[:len(host.priority.DOCKER) + 1], host.priority.DOCKER + ['stop'])
            name = next(name for name, record in records.items() if record['container_id'] == args[-1])
            running[name] = False
            return subprocess.CompletedProcess(args, 0)
        return policy, guard, expected, systems, running, records, SystemFixture, ready, start, stop

    def request(self, policy, guard, command='revoke', target='ingress'):
        before = guard.state()
        return {'version': 1, 'policy_sha256': hashlib.sha256(deploy.canonical(policy)).hexdigest(),
                'state_sha256': hashlib.sha256(deploy.canonical(before)).hexdigest(), 'command': command,
                'target': target, 'lease': guard.owner(target, before)}

    def raw_request(self, path, raw):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5); client.connect(str(path)); client.sendall(raw); client.shutdown(socket.SHUT_WR)
            result = b''
            while b'\n' not in result:
                chunk = client.recv(host.CONTROL_LIMIT + 1)
                self.assertTrue(chunk); result += chunk
            return json.loads(result)

    def test_real_manager_owned_socket_operates_under_lifetime_lock_and_resumes_only_target(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        with patch.object(host, 'System', system), patch.object(host, 'lease_ready', ready), patch.object(host, 'compose_start', start), \
                patch.object(host, 'network_ready', lambda _policy: None), patch.object(host.subprocess, 'run', stop):
            with self.live_control(policy, guard, expected, systems) as (path, lock):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                with self.assertRaises(host.Refused):
                    with host.priority.runtime_lock(str(lock), timeout=0.01): pass
                sibling = deepcopy(expected['ingress-02'])
                stale = self.request(policy, guard)
                host.send_control(policy, guard, 'revoke', 'ingress', path=path)
                self.assertTrue(running['ingress'])
                self.assertEqual(guard.state()['leases'], {'ingress-02': sibling})
                self.assertEqual(guard.state()['desired']['ingress'], 'revoked')
                before = guard.state()
                self.assertFalse(self.raw_request(path, json.dumps(stale).encode() + b'\n')['ok'])
                self.assertEqual(guard.state(), before)
                host.send_control(policy, guard, 'resume', 'ingress', path=path)
                self.assertEqual(guard.state()['leases']['ingress-02'], sibling)
                before = guard.state()
                self.assertFalse(self.raw_request(path, json.dumps(stale).encode() + b'\n')['ok'], 'ABA resume must not revive a stale request')
                self.assertEqual(guard.state(), before)
                host.send_control(policy, guard, 'stop', 'ingress', path=path)
                self.assertFalse(running['ingress'])
                self.assertTrue(running['ingress-02'])
                self.assertEqual(guard.state()['desired']['ingress'], 'stopped')
                self.assertEqual(guard.state()['leases'], {'ingress-02': sibling})
                host.send_control(policy, guard, 'resume', 'ingress', path=path)
                self.assertTrue(running['ingress'])
                self.assertNotEqual(guard.state()['leases']['ingress']['main_start'], stale['lease']['main_start'])
                self.assertEqual(guard.state()['leases']['ingress-02'], sibling)
                self.assertEqual(guard.state()['desired']['ingress'], 'running')

    def test_real_ipc_invalid_oversize_unknown_policy_generation_and_state_cas_do_not_mutate(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        with patch.object(host, 'System', system), patch.object(host, 'lease_ready', ready):
            with self.live_control(policy, guard, expected, systems) as (path, _lock):
                request = self.request(policy, guard)
                invalid = [b'invalid\n', b'x' * (host.CONTROL_LIMIT + 1) + b'\n', b'{}', b'{"version":1,"version":1}\n',
                           b'[' * 1100 + b']' * 1100 + b'\n', b'{}\n{}\n', b'\xff\n']
                for field, value in (('command', 'shell'), ('target', 'foreign'), ('policy_sha256', 'e' * 64),
                                     ('state_sha256', 'e' * 64), ('version', True), ('extra', 'refused')):
                    changed = deepcopy(request); changed[field] = value; invalid.append(json.dumps(changed).encode() + b'\n')
                changed = deepcopy(request); changed['lease']['main_start'] += 1; invalid.append(json.dumps(changed).encode() + b'\n')
                changed = deepcopy(request); changed['lease']['container_id'] = 'e' * 64; invalid.append(json.dumps(changed).encode() + b'\n')
                before, calls = guard.state(), len(guard.nft.calls)
                for raw in invalid:
                    self.assertFalse(self.raw_request(path, raw)['ok'])
                    self.assertEqual(guard.state(), before)
                    self.assertEqual(len(guard.nft.calls), calls)
                records['ingress']['main_start'] += 1
                self.assertFalse(self.raw_request(path, json.dumps(request).encode() + b'\n')['ok'])
                # The healthy loop is allowed to revoke a real changed epoch; it never adopts it.
                self.assertEqual(guard.state()['desired']['ingress'], 'running')
                self.assertEqual(guard.state()['owned_leases']['ingress'], expected['ingress'])

    def test_desired_state_survives_manager_restart_without_automatic_reopen(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        host.revoke(policy, guard, 'ingress')
        seen = []
        with patch.object(host, 'System', system), patch.object(host, 'network_ready', lambda _policy: None), patch.object(host, 'lease_ready', ready), \
                patch.object(host, 'compose_start', lambda _policy, *, services: seen.append(services)):
            leases = host.start(policy, guard)
        self.assertEqual(seen, [], 'already running healthy sibling is preserved without starting a revoked target')
        self.assertEqual(leases, {'ingress-02': expected['ingress-02']})
        self.assertEqual(guard.state()['desired']['ingress'], 'revoked')
        self.assertEqual(guard.state()['leases'], leases)

    def test_stale_socket_and_replaced_socket_are_never_unlinked_as_cleanup(self):
        policy = self.dual(); guard = self.guard(policy); expected = independent_leases(policy)
        guard.update(expected)
        controller = host.ScopedControl(policy, guard, expected, {})
        path = self.root / 'stale.sock'
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(path)); path.chmod(0o600)
        with self.assertRaises(host.Refused): host.ControlServer(controller, path=path)
        self.assertTrue(path.exists()); stale.close()
        path = self.root / 'replaced.sock'
        server = host.ControlServer(controller, path=path)
        path.unlink()
        replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        replacement.bind(str(path)); path.chmod(0o600)
        with self.assertRaises(host.Refused): server.close()
        self.assertTrue(path.exists()); replacement.close()

    def test_actual_nonroot_peer_credentials_are_rejected_without_reading_a_command(self):
        policy = self.dual(); guard = self.guard(policy); expected = independent_leases(policy)
        guard.update(expected); before = guard.state()
        server = host.ControlServer(host.ScopedControl(policy, guard, expected, {}), path=self.root / 'private.sock')
        # Abstract Unix socket is TEST-ONLY to reach SO_PEERCRED as uid65534 without
        # weakening the real private0700 directory or0600 control socket permissions.
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        address = '\0ark-nonroot-control-' + str(os.getpid()) + '-' + self.root.name
        listener.bind(address); listener.listen(1); listener.settimeout(5)
        pid = os.fork()
        if pid == 0:
            try:
                listener.close(); os.setgid(65534); os.setuid(65534)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as child:
                    child.settimeout(5); child.connect(address)
                    reply = json.loads(child.recv(host.CONTROL_LIMIT))
                    os._exit(0 if reply.get('ok') is False else 2)
            except BaseException:
                os._exit(3)
        try:
            connection, _address = listener.accept()
            server.handle(connection)
            _child, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertEqual(guard.state(), before)
            self.assertEqual(stat.S_IMODE(server.path.stat().st_mode), 0o600)
        finally:
            listener.close(); server.close()


    def test_opening_transaction_state_save_failure_rolls_back_only_new_grant(self):
        policy = self.dual(); expected = independent_leases(policy); guard = self.guard(policy)
        guard.update(expected); host.revoke(policy, guard, 'ingress')
        original = guard.save; failures = []
        def fail_publication(value, before):
            if before is not None and 'pending' in before and not failures:
                failures.append(True); raise OSError('injected final state write failure')
            return original(value, before)
        with patch.object(guard, 'save', fail_publication):
            with self.assertRaises(OSError): guard.update(expected, resume='ingress')
        retained = {'ingress-02': expected['ingress-02']}
        guard.check(retained)
        self.assertNotIn('pending', guard.state())
        self.assertEqual(guard.state()['desired']['ingress'], 'revoked')
        self.assertEqual(guard.state()['leases'], retained)

    def test_failure_after_final_rename_still_closes_only_new_opening_grant(self):
        policy = self.dual(); expected = independent_leases(policy); guard = self.guard(policy)
        guard.update(expected); host.revoke(policy, guard, 'ingress')
        original = guard.save; failures = []
        def rename_then_fail(value, before):
            original(value, before)
            if before is not None and 'pending' in before and not failures:
                failures.append(True); raise OSError('injected post-rename directory fsync failure')
        with patch.object(guard, 'save', rename_then_fail):
            with self.assertRaises(OSError): guard.update(expected, resume='ingress')
        guard.check({'ingress-02': expected['ingress-02']})
        self.assertEqual(guard.state()['desired']['ingress'], 'revoked')
        self.assertNotIn('pending', guard.state())

    def test_journal_serialization_equivalences_do_not_erase_foreign_semantics(self):
        policy = self.dual(); expected = independent_leases(policy)
        wanted = host.lease_rules(policy, expected)
        observed = deepcopy(wanted)
        for row in observed:
            expressions = row['rule']['expr']
            lefts = [item.get('match', {}).get('left', {}) for item in expressions]
            if any(left.get('payload', {}).get('protocol') == 'ip' for left in lefts):
                row['rule']['expr'] = [item for item in expressions if item != host.match({'meta': {'key': 'nfproto'}}, 'ipv4')]
            if any(left.get('payload', {}).get('protocol') == 'tcp' for left in lefts):
                row['rule']['expr'] = [item for item in row['rule']['expr'] if item != host.match({'meta': {'key': 'l4proto'}}, 'tcp')]
        self.assertEqual(host.semantic_nft_sha(wanted), host.semantic_nft_sha(observed))
        changed = deepcopy(observed); changed[0]['rule']['expr'].append({'counter': {'packets': 0, 'bytes': 0}})
        self.assertNotEqual(host.semantic_nft_sha(wanted), host.semantic_nft_sha(changed))
        changed = deepcopy(observed)
        for item in changed[0]['rule']['expr']:
            if item.get('match', {}).get('left') == host.ip('saddr'): item['match']['right'] = '1.2.3.4'
        self.assertNotEqual(host.semantic_nft_sha(wanted), host.semantic_nft_sha(changed))

    def test_durable_pending_recovers_after_persistent_metadata_failure_and_restart(self):
        policy = self.dual(); expected = independent_leases(policy); guard = self.guard(policy)
        guard.update(expected); host.revoke(policy, guard, 'ingress')
        original = guard.save
        def fail_final(value, before):
            if before is not None and 'pending' in before: raise OSError('injected publication and recovery write failure')
            return original(value, before)
        with patch.object(guard, 'save', fail_final):
            with self.assertRaises(OSError): guard.update(expected, resume='ingress')
        self.assertIn('pending', guard.state())
        pending = guard.state()['pending']
        retained = {'ingress-02': expected['ingress-02']}
        self.assertEqual(host.semantic_nft_sha(guard.nft.snapshot(guard.table)),
                         host.semantic_nft_sha(guard.transaction_shape(pending['before_snapshot'], retained)))
        restarted = host.Guard(policy, nft=guard.nft, state_file=guard.state_file)
        restarted.create(); restarted.check(retained)
        self.assertNotIn('pending', restarted.state())
        self.assertEqual(restarted.state()['policy_sha256'], guard.policy_sha())

    def test_sigterm_after_nft_success_can_close_and_restart_with_recorded_intent(self):
        policy = self.dual(); expected = independent_leases(policy); guard = self.guard(policy)
        guard.update(expected); host.revoke(policy, guard, 'ingress')
        original_apply = guard.nft.apply; fired = []
        def interrupted(commands):
            original_apply(commands)
            if not fired: fired.append(True); raise host.Stopped()
        with patch.object(guard.nft, 'apply', interrupted):
            with self.assertRaises(host.Stopped): guard.update(expected, resume='ingress')
        guard.check({'ingress-02': expected['ingress-02']})
        guard.update({})  # Manager SIGTERM cleanup must no longer reject its own transaction.
        guard.check({})
        restarted = host.Guard(policy, nft=guard.nft, state_file=guard.state_file)
        restarted.create(); restarted.check({})

    def test_crash_gap_transaction_recognizes_only_recorded_after_not_foreign_drift(self):
        policy = self.dual(); expected = independent_leases(policy); guard = self.guard(policy)
        guard.update(expected); host.revoke(policy, guard, 'ingress')
        original = guard.save
        def die_after_apply(value, before):
            if before is not None and 'pending' in before: raise OSError('simulated killed writer after nft success')
            return original(value, before)
        with patch.object(guard, 'save', die_after_apply), patch.object(guard, 'recover_transaction', side_effect=OSError('writer unavailable')):
            with self.assertRaises(OSError): guard.update(expected, resume='ingress')
        self.assertIn('pending', guard.state())
        good_snapshot = deepcopy(guard.nft.rows)
        guard.nft.rows.append({'rule': {'family': 'inet', 'table': guard.table, 'chain': 'lease', 'handle': 999999,
                                       'expr': [{'counter': {'packets': 0, 'bytes': 0}}]}})
        before, calls = guard.state(), len(guard.nft.calls)
        restarted = host.Guard(policy, nft=guard.nft, state_file=guard.state_file)
        with self.assertRaises(host.Refused): restarted.create()
        self.assertEqual(guard.state(), before); self.assertEqual(len(guard.nft.calls), calls)
        guard.nft.rows = good_snapshot  # Restore only this TEST fixture's injected foreign row.
        restarted.create(); restarted.check({'ingress-02': expected['ingress-02']})

    def test_failed_resume_keeps_new_closed_generation_and_explicit_retry_succeeds(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        with patch.object(host, 'System', system), patch.object(host, 'lease_ready', ready), patch.object(host, 'compose_start', start), \
                patch.object(host, 'network_ready', lambda _policy: None), patch.object(host.subprocess, 'run', stop):
            controller = host.ScopedControl(policy, guard, expected, systems)
            controller.execute(self.request(policy, guard, 'stop'))
            old_start = expected['ingress']['main_start']
            def bad_health(_policy, target, **kwargs):
                if target['service'] == 'ingress' and kwargs.get('apply'): raise host.NotReady('injected resume health failure')
                return ready(_policy, target, **kwargs)
            with patch.object(host, 'lease_ready', bad_health):
                with self.assertRaises(host.NotReady): controller.execute(self.request(policy, guard, 'resume'))
            owner = guard.owner('ingress')
            self.assertNotEqual(owner['main_start'], old_start)
            self.assertEqual(owner['main_start'], records['ingress']['main_start'])
            self.assertEqual(guard.state()['leases'], {'ingress-02': expected['ingress-02']})
            self.assertNotIn('ingress', guard.state()['start_intents'])
            controller = host.ScopedControl(policy, guard, {'ingress-02': expected['ingress-02']}, systems)
            controller.execute(self.request(policy, guard, 'resume'))
            self.assertEqual(guard.state()['leases']['ingress']['main_start'], owner['main_start'])
            self.assertEqual(guard.state()['leases']['ingress-02'], expected['ingress-02'])

    def test_interrupted_start_recovers_to_closed_owner_not_arbitrary_running_epoch(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        with patch.object(host, 'System', system), patch.object(host, 'lease_ready', ready), patch.object(host, 'compose_start', start), \
                patch.object(host, 'network_ready', lambda _policy: None), patch.object(host.subprocess, 'run', stop):
            controller = host.ScopedControl(policy, guard, expected, systems)
            controller.execute(self.request(policy, guard, 'stop'))
            info = system(host.Config(policy, policy['targets'][0])).inspect(records['ingress']['container_id'], allow_stopped=True)
            guard.begin_start('ingress', info)
            start(policy, services={'ingress'})  # Crash before process ownership/health publication.
            self.assertTrue(running['ingress'])
            restarted = host.Guard(policy, nft=guard.nft, state_file=guard.state_file)
            host.recover_start_intent(policy, restarted, 'ingress')
            self.assertFalse(running['ingress'])
            self.assertEqual(restarted.owner('ingress')['kind'], 'closed')
            self.assertEqual(restarted.state()['leases'], {'ingress-02': expected['ingress-02']})
            self.assertEqual(restarted.state()['start_intents'], {})
            controller = host.ScopedControl(policy, restarted, {'ingress-02': expected['ingress-02']}, systems)
            running['ingress'] = True; records['ingress']['started_at'] += '-external'
            before = restarted.state()
            with self.assertRaises(host.Refused): controller.execute(self.request(policy, restarted, 'resume'))
            self.assertEqual(restarted.state(), before)
            running['ingress'] = False; records['ingress']['started_at'] = before['closed_owners']['ingress']['started_at']
            controller.execute(self.request(policy, restarted, 'resume'))
            self.assertEqual(set(restarted.state()['leases']), {'ingress', 'ingress-02'})

    def test_initial_health_failure_keeps_sibling_admitted_and_live_uds_can_resume(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        guard.update({})
        failed = {'ingress-02'}
        def readiness(_policy, target, **kwargs):
            if target['service'] in failed: raise host.NotReady('injected initial target health failure')
            return ready(_policy, target, **kwargs)
        with patch.object(host, 'System', system), patch.object(host, 'lease_ready', readiness), patch.object(host, 'compose_start', start), \
                patch.object(host, 'network_ready', lambda _policy: None), patch.object(host.subprocess, 'run', stop):
            admitted = host.start(policy, guard)
            self.assertEqual(admitted, {'ingress': expected['ingress']})
            self.assertEqual(guard.state()['leases'], admitted)
            self.assertEqual(guard.state()['desired']['ingress-02'], 'revoked')
            with self.live_control(policy, guard, admitted, systems) as (path, _lock):
                failed.clear()
                host.send_control(policy, guard, 'resume', 'ingress-02', path=path)
                self.assertEqual(guard.state()['leases']['ingress'], expected['ingress'])
                self.assertEqual(set(guard.state()['leases']), {'ingress', 'ingress-02'})

    def test_explicit_unadmitted_marker_allows_missing_initial_target_only_after_resume(self):
        policy, guard, expected, systems, running, records, system, ready, start, stop = self.control_fixture()
        # A fresh approved CLOSED guard, not an arbitrary missing owned generation.
        guard.state_file.unlink(); guard.nft = MemoryNft(); guard.update({})
        missing = {'ingress-02'}; fail_create = {'ingress-02'}
        def optional(_policy, target):
            if target['service'] in missing: return None
            return system(host.Config(policy, target)).inspect(target['container_name'], allow_stopped=True)
        def creating(_policy, *, services):
            for name in services:
                if name in fail_create: raise host.Refused('injected initial compose failure')
                missing.discard(name); running[name] = True
        with patch.object(host, 'System', system), patch.object(host, 'inspect_optional', optional), patch.object(host, 'lease_ready', ready), \
                patch.object(host, 'compose_start', creating), patch.object(host, 'network_ready', lambda _policy: None), patch.object(host.subprocess, 'run', stop):
            admitted = host.start(policy, guard)
            self.assertEqual(set(admitted), {'ingress'})
            self.assertEqual(guard.owner('ingress-02')['kind'], 'unadmitted')
            self.assertNotIn('ingress-02', guard.state().get('owned_leases', {}))
            with self.live_control(policy, guard, admitted, systems) as (path, _lock):
                fail_create.clear()
                host.send_control(policy, guard, 'resume', 'ingress-02', path=path)
                self.assertEqual(set(guard.state()['leases']), {'ingress', 'ingress-02'})
                self.assertNotIn('ingress-02', guard.state()['unadmitted'])


class FormalDualIngressTests(DualIngressTests):
    profile = 'formal'


if __name__ == '__main__':
    unittest.main()
