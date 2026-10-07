"""Protected local cluster generation/role guards; no SSH or production mutations."""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
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
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-role-tests-', dir='/root' if os.geteuid() == 0 else None))
        os.chmod(self.root, 0o700)
        self.addCleanup(shutil.rmtree, self.root)

    def generate(self, name='core', role='core', entry=1):
        return deploy.generate(self.root / name, image=IMAGE, build=BUILD, manifest_sha256=MANIFEST,
                               source_kind='tree', role=role, entry=entry, profile=self.profile)

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
    def system_fixture(self, role='game', stopped=False):
        policy = self.generate('fixture-' + role, role='edge' if role == 'ingress' else 'core')
        target = self.target(policy, role)
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


if __name__ == '__main__':
    unittest.main()
