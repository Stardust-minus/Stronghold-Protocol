"""Pure injected tests: never contact Docker, nftables, proc schedulers, or WG secrets."""
import copy
from dataclasses import replace
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('wg_backend_access', Path(__file__).with_name('wg-backend-access.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
p = m.priority
REV, IMAGE, CID, NETWORK = 'a' * 40, 'sha256:' + 'b' * 64, 'c' * 64, 'e' * 64


def config(profile='beta', **changes):
    return p.Config.parse({'profile': profile, 'approved_images': [{'revision': REV, 'image_id': IMAGE}], **changes})


def info(c):
    return {'id': CID, 'name': '/' + c.container_name, 'project': c.project, 'service': c.service,
            'pid': 100, 'running': True, 'restarting': False, 'started_at': 'fixed-start', 'restarts': 0,
            'image_id': IMAGE, 'revision': REV, 'source': p.SOURCE, 'init': True, 'readonly': True,
            'privileged': False, 'cap_drop': ['ALL'], 'cap_add': None, 'security_opt': ['no-new-privileges:true'],
            'pids': 128, 'cpu_quota': 0, 'nano_cpus': 0, 'cpuset': '', 'memory': 0,
            'ports': [{'HostIp': ip, 'HostPort': str(c.health_port)} for ip in c.publish_ips]}


class FakeSystem(m.System):
    def __init__(self, c=None):
        super().__init__(c or config())
        self.info = info(self.config)
        self.image = {'id': IMAGE, 'revision': REV, 'source': p.SOURCE}
        ip, subnet = m.FIXED[self.config.profile]
        self.network = {'IPAddress': ip, 'IPPrefixLen': 24, 'IPAMConfig': {'IPv4Address': ip},
                        'NetworkID': NETWORK, 'GlobalIPv6Address': ''}
        self.extra = {'networks': {self.config.project + '_default': self.network},
                      'all_ports': {'3000/tcp': copy.deepcopy(self.info['ports'])},
                      'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}}
        self.bridge = {'id': NETWORK, 'driver': 'bridge', 'ipam': [{'Subnet': subnet}],
                       'labels': {'com.docker.compose.project': self.config.project, 'com.docker.compose.network': 'default'}}
        self.generation = p.Generation(CID, IMAGE, REV, 'fixed-start', 0, 100, 10, 101, 11)
        self.nice, self.policy, self.available = -20, p.RESET_ON_FORK, True
        self.threads = [p.Thread(102 + i, 'WorkerThread', 0, 0, 20 + i) for i in range(14)]
        self.threads.append(p.Thread(120, 'libuv-worker', 0, 0, 40))
        self.health_value = {'ok': True, 'maxRooms': 4096,
                             'combat': {'status': 'ready', 'ready': 12, 'workers': 12},
                             'trial': {'status': 'ready', 'ready': 2, 'workers': 2}}
        self.calls, self.snapshots, self.hook = [], 0, None

    def docker(self, *args):
        self.calls.append(args)
        if not self.available:
            raise p.NotReady('fixture unavailable')
        if args[:2] == ('network', 'inspect'):
            return copy.deepcopy(self.bridge)
        if args[:2] == ('image', 'inspect'):
            return copy.deepcopy(self.image)
        if 'all_ports' in args[3]:
            return copy.deepcopy(self.extra)
        if p.CID.fullmatch(args[-1]) and args[-1] != self.info['id']:
            raise p.Refused('fixture requested container ID mismatch')
        return copy.deepcopy(self.info)

    def snapshot(self, target, ready=True):
        self.snapshots += 1
        if self.hook:
            self.hook(self)
        self.inspect(target)
        if not p.health_ready(self.health_value, self.config):
            raise p.NotReady('fixture not healthy')
        result = p.Snapshot(self.generation, (p.Thread(self.generation.main_pid, 'MainThread', self.nice,
                            self.policy, self.generation.main_start), *self.threads))
        p.validate_threads(result, self.config)
        return result


# Independent native fixture, matching wg-test-host.py; native input rules have no counters.
def base_fixture():
    tag, table = 'ark-wg-test-20311230-9c3dbaa9', 'ak_wg_9c3dbaa9'
    def match(left, right, op='=='):
        return {'match': {'op': op, 'left': left, 'right': right}}
    def interface(key):
        return match({'meta': {'key': key}}, 'ark-wg-test')
    def ip(field, value):
        return match({'payload': {'protocol': 'ip', 'field': field}}, value)
    def rule(chain, expr, suffix):
        return {'rule': {'family': 'inet', 'table': table, 'chain': chain, 'expr': expr, 'comment': tag + ':' + suffix}}
    counter, accept, drop = {'counter': {'packets': 3, 'bytes': 90}}, {'accept': None}, {'drop': None}
    selector = [interface('iifname'), ip('saddr', '10.253.77.1'), ip('daddr', '10.253.77.2')]
    entries = [{'table': {'family': 'inet', 'name': table, 'handle': 77}},
               {'chain': {'family': 'inet', 'table': table, 'name': 'guard', 'handle': 1}},
               rule('guard', [*selector, ip('protocol', 'icmp'), counter, accept], 'icmp'),
               rule('guard', [*selector, match({'ct': {'key': 'state'}}, {'set': ['established', 'related']}, 'in'), counter, accept], 'established'),
               rule('guard', [counter, drop], 'deny')]
    for hook in ('input', 'forward'):
        entries.append({'chain': {'family': 'inet', 'table': table, 'name': hook, 'type': 'filter',
                                  'hook': hook, 'prio': -10, 'policy': 'accept', 'handle': len(entries)}})
    entries += [rule('input', [interface('iifname'), {'jump': {'target': 'guard'}}], 'input-interface'),
                rule('input', [ip('daddr', '10.253.77.2'), {'jump': {'target': 'guard'}}], 'input-address'),
                rule('forward', [interface('iifname'), counter, drop], 'no-forward-in'),
                rule('forward', [interface('oifname'), counter, drop], 'no-forward-out')]
    for i, item in enumerate(entries):
        if 'rule' in item:
            item['rule']['handle'] = i + 100
    manifest = {'tag': tag, 'nftTable': table, 'nftIdentity': 77, 'nftHash': m.digest(entries),
                'firewallBackend': 'nft', 'testRules': [], 'phase': 'up', 'up': True,
                'publicKey': 'non-secret-public-key-fixture', 'legacy': {'keep': [1, 2, 3]}}
    return manifest, entries


class FakeStore:
    def __init__(self, value):
        self.value = copy.deepcopy(value)
        self.saves, self.fail_once = 0, False

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, value):
        if self.fail_once:
            self.fail_once = False
            raise OSError('fixture write failed')
        self.saves += 1
        self.value = copy.deepcopy(value)


class FakeNft:
    def __init__(self, entries):
        self.entries = copy.deepcopy(entries)
        self.batches, self.hook, self.fail_once, self.snapshot_hook = [], None, False, None
        self.snapshots = 0

    def snapshot(self, table):
        self.snapshots += 1
        if self.snapshot_hook:
            self.snapshot_hook(self)
        return copy.deepcopy(self.entries)

    def apply(self, commands):
        self.batches.append(json.dumps({'nftables': commands}))
        if self.fail_once:
            self.fail_once = False
            raise m.Refused('fixture atomic transaction rejected')
        future = copy.deepcopy(self.entries)
        for command in commands:
            verb, obj = next(iter(command.items()))
            kind, item = next(iter(obj.items()))
            item = copy.deepcopy(item)
            if kind == 'chain':
                if verb == 'flush':
                    future = [entry for entry in future if not ('rule' in entry and entry['rule']['chain'] == item['name'])]
                else:
                    item['handle'] = len(future) + 1000
                    future.append({'chain': item})
            else:
                item['handle'] = len(future) + 2000
                matches = [i for i, entry in enumerate(future) if 'rule' in entry and entry['rule']['chain'] == item['chain']]
                if matches:
                    index = matches[0] if verb == 'insert' else matches[-1] + 1
                else:
                    index = next(i + 1 for i, entry in enumerate(future) if 'chain' in entry and entry['chain']['name'] == item['chain'])
                future.insert(index, {'rule': item})
        self.entries = future
        if self.hook:
            self.hook(self)


def hgy_owned_echo(nft):
    """Observed HGY closed mapping JSON; open CT-family omission is anticipated."""
    for entry in nft.entries:
        if 'rule' not in entry:
            continue
        rule = entry['rule']
        if rule['chain'] not in ('backend_beta', 'backend_core'):
            continue
        profile = rule['chain'].removeprefix('backend_')
        if rule['comment'].endswith(':mapping'):
            rule['expr'] = [
                {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}},
                {'match': {'op': '==', 'left': {'ct': {'key': 'daddr', 'dir': 'original'}}, 'right': '10.253.77.2'}},
                {'match': {'op': '==', 'left': {'ct': {'key': 'proto-dst', 'dir': 'original'}},
                           'right': 3220 if profile == 'beta' else 3120}},
                {'counter': {'packets': 0, 'bytes': 0}}, {'drop': None}]
        elif rule['comment'].endswith((':request', ':reply')):
            for expression in rule['expr']:
                left = expression.get('match', {}).get('left', {})
                if left.get('ct', {}).get('key') == 'daddr':
                    left['ct'].pop('family', None)


def accepts(owned_rules, packet):
    """Evaluate only the deliberately small generated matching grammar, not the kernel."""
    for rule in owned_rules:
        matched = True
        for expr in rule['expr']:
            if 'match' in expr:
                match = expr['match']
                kind, spec = next(iter(match['left'].items()))
                key = spec['key'] if kind == 'meta' else ((spec['protocol'], spec['field']) if kind == 'payload'
                       else ('ct', spec['key'], spec.get('dir')))
                expected = match['right']
                actual = packet.get(key)
                matched &= actual in expected['set'] if isinstance(expected, dict) else actual == expected
            if matched and 'accept' in expr:
                return True
            if matched and 'drop' in expr:
                return False
    return None


class BackendTests(unittest.TestCase):
    def setUp(self):
        # An accidental real command or scheduler mutation fails the test immediately.
        self.patchers = [patch.object(m.subprocess, 'run', side_effect=AssertionError('no real subprocess')),
                         patch.object(m.os, 'setpriority', side_effect=AssertionError('no scheduler mutation')),
                         patch.object(m.os, 'sched_setscheduler', side_effect=AssertionError('no scheduler mutation'))]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        manifest, entries = base_fixture()
        self.system, self.nft, self.store = FakeSystem(), FakeNft(entries), FakeStore(manifest)

    def run_action(self, action='guard', system=None):
        return m.Helper(system or self.system, self.nft, self.store).run(action)

    def open(self):
        self.run_action('guard')
        return self.run_action('open')

    def own_rules(self, profile='beta', chain_suffix=''):
        return [entry['rule'] for entry in self.nft.entries if 'rule' in entry
                and entry['rule']['chain'] == 'backend_' + profile + chain_suffix]

    def test_fixed_config_selectors(self):
        for profile in ('beta', 'core'):
            c = config(profile)
            self.assertEqual((c.combat_workers, c.trial_workers, c.nice), (12, 2, -20))
            self.assertEqual(c.publish_ips, ('127.0.0.1', m.LOCAL))
        for profile in ('prod', 'unknown', True):
            with self.subTest(profile=profile), self.assertRaises(m.Refused):
                m.Helper(type('Fake', (), {'config': type('Config', (), {'profile': profile})()})(), self.nft, self.store)

    def test_arbitrary_selectors_ports_ips_and_subnets_rejected(self):
        for key in ('project', 'service', 'container_name', 'health_port', 'ip', 'subnet', 'selector', 'publish_ips'):
            with self.subTest(key=key), self.assertRaises(m.Refused):
                config(**{key: 'arbitrary'})

    def test_config_immutable_pair_required(self):
        for change in ({'approved_images': []}, {'approved_images': [{'revision': 'short', 'image_id': IMAGE}]},
                       {'approved_images': [{'revision': REV, 'image_id': 'image:latest'}]}, {'nice': True}, {'nice': -10}):
            with self.subTest(change=change), self.assertRaises(m.Refused):
                config(**change)

    def test_cli_config_profile_must_match(self):
        with patch.object(m, 'read_json', return_value={'profile': 'beta', 'approved_images': [{'revision': REV, 'image_id': IMAGE}]}):
            self.assertEqual(m.load_config('ignored', 'beta').profile, 'beta')
            for profile in ('core', 'prod'):
                with self.assertRaises(m.Refused):
                    m.load_config('ignored', profile)

    def test_both_fixed_networks_valid(self):
        for profile in ('beta', 'core'):
            system = FakeSystem(config(profile))
            self.assertEqual(m.lease(system)['ip'], m.FIXED[profile][0])
            self.assertTrue(all('Env' not in args[3] and 'Cmd' not in args[3] for args in system.calls))

    def test_container_selector_and_cid_rejected(self):
        for key, value in (('id', 'short'), ('name', '/ark-proto-auth'), ('project', 'other'), ('service', 'other')):
            self.system.info = info(self.system.config)
            self.system.info[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.lease(self.system)

    def test_actual_cid_must_equal_snapshot(self):
        self.system.info['id'] = 'd' * 64
        with self.assertRaises(m.Refused):
            m.lease(self.system)

    def test_image_revision_and_source_pair_validated(self):
        for target, key, value in (('info', 'image_id', 'sha256:' + 'f' * 64), ('info', 'revision', 'f' * 40),
                                   ('info', 'source', 'other'), ('image', 'revision', 'f' * 40),
                                   ('image', 'source', 'other'), ('image', 'id', 'sha256:' + 'f' * 64)):
            system = FakeSystem()
            getattr(system, target)[key] = value
            with self.subTest(target=target, key=key), self.assertRaises(m.Refused):
                m.lease(system)

    def test_capabilities_and_security_rejected(self):
        for key, value in (('cap_add', ['SYS_NICE']), ('cap_drop', []), ('privileged', True), ('readonly', False),
                           ('init', False), ('security_opt', []), ('pids', 256)):
            system = FakeSystem()
            system.info[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.lease(system)

    def test_resource_caps_rejected(self):
        for key, value in (('cpu_quota', 1), ('nano_cpus', 1), ('memory', 1), ('cpuset', '0')):
            system = FakeSystem()
            system.info[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.lease(system)

    def test_static_ip_and_ipam_rejected(self):
        for key, value in (('IPAddress', '172.30.240.11'), ('IPPrefixLen', 16), ('IPAMConfig', None),
                           ('IPAMConfig', {'IPv4Address': '172.30.241.10'}), ('GlobalIPv6Address', 'fd00::1'),
                           ('NetworkID', 'short')):
            system = FakeSystem()
            system.network[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.lease(system)

    def test_unique_default_network_required(self):
        for networks in ({}, {'arbitrary': self.system.network},
                         {self.system.config.project + '_default': self.system.network, 'extra': self.system.network}):
            self.system.extra['networks'] = networks
            with self.assertRaises(m.Refused):
                m.lease(self.system)

    def test_network_driver_subnet_and_labels_rejected(self):
        for key, value in (('id', 'f' * 64), ('driver', 'host'), ('ipam', [{'Subnet': '172.30.0.0/16'}]),
                           ('ipam', [{'Subnet': '172.30.240.0/24'}, {'Subnet': 'fd00::/64'}]),
                           ('labels', {}), ('labels', {'com.docker.compose.project': 'other', 'com.docker.compose.network': 'default'})):
            system = FakeSystem()
            system.bridge[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.lease(system)

    def test_dual_mapping_exact(self):
        for ports in ([{'HostIp': '0.0.0.0', 'HostPort': '3220'}], self.system.info['ports'][:1],
                      [{'HostIp': '127.0.0.1', 'HostPort': '3220'}, {'HostIp': m.LOCAL, 'HostPort': '3120'}]):
            self.system.info['ports'] = ports
            with self.assertRaises(m.Refused):
                m.lease(self.system)

    def test_other_ports_and_beta_restart_forbidden(self):
        self.system.extra['all_ports']['4000/tcp'] = []
        with self.assertRaises(m.Refused):
            m.lease(self.system)
        self.system.extra['all_ports'] = {'3000/tcp': self.system.info['ports']}
        self.system.extra['restart_policy']['Name'] = 'unless-stopped'
        with self.assertRaises(m.Refused):
            m.lease(self.system)

    def test_nice_reset_and_helpers_exact(self):
        for nice, policy in ((0, p.RESET_ON_FORK), (-20, 0), (-10, 0), (-20, os.SCHED_FIFO)):
            self.system.nice, self.system.policy = nice, policy
            with self.subTest(nice=nice, policy=policy), self.assertRaises(m.Refused):
                m.lease(self.system)
        for changes in ({'nice': -20}, {'policy': p.RESET_ON_FORK}):
            system = FakeSystem()
            system.threads[0] = replace(system.threads[0], **changes)
            with self.assertRaises(m.Refused):
                m.lease(system)

    def test_restore_config_cannot_open(self):
        self.system = FakeSystem(config(nice=0))
        self.run_action()
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')

    def test_workers_and_health_counts_exact(self):
        self.system.threads.pop(0)
        with self.assertRaises(m.Refused):
            m.lease(self.system)
        for field in ('ready', 'workers', 'status'):
            system = FakeSystem()
            system.health_value['trial'][field] = 0
            with self.assertRaises(m.Refused):
                m.lease(system)

    def test_guard_without_container(self):
        self.system.available = False
        self.assertEqual(self.run_action(), {'profile': 'beta', 'state': 'closed'})
        self.assertEqual(self.system.calls, [])
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))
        self.assertEqual(self.run_action('check')['state'], 'closed')

    def test_open_requires_preexisting_guard(self):
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.nft.batches, [])

    def test_open_manifest_and_old_fields_preserved(self):
        before = copy.deepcopy(self.store.value)
        self.assertEqual(self.open()['state'], 'open')
        for key, value in before.items():
            if key != 'nftHash':
                self.assertEqual(self.store.value[key], value)
        lease = self.store.value['profiles']['beta']['lease']
        self.assertEqual((lease['container_id'], lease['ip'], lease['main_pid'], lease['network_id']),
                         (CID, '172.30.240.10', 101, NETWORK))
        self.assertEqual(self.run_action('check')['state'], 'open')

    def test_atomic_chains_complete_before_jumps(self):
        self.run_action()
        commands = json.loads(self.nft.batches[0])['nftables']
        first_jump = next(i for i, item in enumerate(commands) if 'insert' in item)
        self.assertTrue(all('insert' in item for item in commands[first_jump:]))
        self.assertEqual(sum('add' in item and 'rule' in item['add'] for item in commands[:first_jump]), 4)
        for command in commands:
            verb, obj = next(iter(command.items()))
            kind, value = next(iter(obj.items()))
            self.assertEqual(value['table'], self.store.value['nftTable'])
            self.assertNotIn(kind, ('table', 'ruleset'))
            self.assertNotIn('hook', value)
            if kind == 'rule' and 'expr' in value:
                self.assertNotIn('counter', value['expr'][-1])
                for expression in value['expr']:
                    if 'counter' in expression:
                        self.assertEqual(expression['counter'], {'packets': 0, 'bytes': 0})

    def test_open_conditions_all_conjuncts(self):
        self.open()
        request, reply = self.own_rules()[:2]
        packet = {'iifname': m.IFACE, ('ip', 'saddr'): m.PEER, ('ip', 'daddr'): '172.30.240.10',
                  ('tcp', 'dport'): 3000, ('ct', 'daddr', 'original'): m.LOCAL,
                  ('ct', 'proto-dst', 'original'): 3220, ('ct', 'state', None): 'new'}
        self.assertTrue(accepts([request], packet))
        for key, bad in (('iifname', 'eth0'), (('ip', 'saddr'), '10.253.77.3'), (('ip', 'daddr'), '172.30.240.11'),
                         (('tcp', 'dport'), 3001), (('ct', 'daddr', 'original'), '172.30.240.10'),
                         (('ct', 'proto-dst', 'original'), 3000), (('ct', 'state', None), 'related')):
            with self.subTest(key=key):
                self.assertIsNot(accepts([request], {**packet, key: bad}), True)
        response = {'oifname': m.IFACE, ('ip', 'saddr'): '172.30.240.10', ('ip', 'daddr'): m.PEER,
                    ('tcp', 'sport'): 3000, ('ct', 'daddr', 'original'): m.LOCAL,
                    ('ct', 'proto-dst', 'original'): 3220, ('ct', 'state', None): 'established'}
        self.assertTrue(accepts([reply], response))
        for key, bad in (('oifname', 'eth0'), (('ip', 'saddr'), '172.30.240.11'), (('ip', 'daddr'), '192.168.10.1'),
                         (('tcp', 'sport'), 3001), (('ct', 'daddr', 'original'), '172.30.240.10'),
                         (('ct', 'proto-dst', 'original'), 3120), (('ct', 'state', None), 'new')):
            with self.subTest(reply_key=key):
                self.assertIsNot(accepts([reply], {**response, key: bad}), True)

    def test_direct_and_mapping_guards_drop_all_interfaces(self):
        for action in ('guard', 'open'):
            self.run_action(action)
            for interface in (m.IFACE, 'eth0', 'br-lan', 'lo'):
                direct = {'iifname': interface, ('ip', 'daddr'): '172.30.240.10', ('tcp', 'dport'): 3000}
                self.assertFalse(accepts(self.own_rules(), direct))
                original = {'iifname': interface, 'nfproto': 'ipv4', 'l4proto': 'tcp', ('ct', 'daddr', 'original'): m.LOCAL,
                            ('ct', 'proto-dst', 'original'): 3220}
                self.assertFalse(accepts(self.own_rules(), original))
                self.assertFalse(accepts(self.own_rules(chain_suffix='_input'),
                                         {('ip', 'daddr'): m.LOCAL, ('tcp', 'dport'): 3220}))

    def test_mapping_ipv4_context_precedes_unchanged_original_tuple(self):
        for profile in ('beta', 'core'):
            for opened in (False, True):
                mapping = m.rules(self.store.value, profile, opened)['backend_' + profile][-1]
                self.assertEqual(mapping['expr'][:2], [
                    {'match': {'op': '==', 'left': {'meta': {'key': 'nfproto'}}, 'right': 'ipv4'}},
                    {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}}])
                self.assertEqual(mapping['expr'][2:4], [
                    {'match': {'op': '==', 'left': {'ct': {'key': 'daddr', 'dir': 'original', 'family': 'ip'}}, 'right': m.LOCAL}},
                    {'match': {'op': '==', 'left': {'ct': {'key': 'proto-dst', 'dir': 'original'}},
                               'right': 3220 if profile == 'beta' else 3120}}])

    def test_no_broad_addresses_or_unrelated_port_scope(self):
        self.open()
        text = '\n'.join(self.nft.batches)
        for forbidden in ('0.0.0.0', '192.168.', '/24', '172.30.240.0', 'flush ruleset', 'masquerade', 'snat', 'dnat'):
            self.assertNotIn(forbidden, text)
        self.assertIsNone(accepts(self.own_rules(), {('ip', 'daddr'): '172.30.240.11', ('tcp', 'dport'): 3000}))
        self.assertIsNone(accepts(self.own_rules(), {('ip', 'daddr'): '172.30.240.10', ('tcp', 'dport'): 4000}))

    def test_close_keeps_jumps_and_guards(self):
        self.open()
        self.system.available = False
        self.system.calls.clear()
        self.assertEqual(self.run_action('close')['state'], 'closed')
        self.assertEqual(self.system.calls, [])
        self.assertEqual(len(self.own_rules()), 3)
        self.assertEqual(len(self.own_rules(chain_suffix='_input')), 1)
        self.assertIsNone(self.store.value['profiles']['beta']['lease'])
        self.assertTrue(all('flush' in command or 'add' in command for command in json.loads(self.nft.batches[-1])['nftables']))

    def test_check_detects_cid_change_and_closes(self):
        self.open()
        self.system.info['id'] = 'd' * 64
        self.system.generation = replace(self.system.generation, container_id='d' * 64)
        with self.assertRaises(m.Refused):
            self.run_action('check')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_check_detects_pid_start_restart_network_change(self):
        for change in ({'main_start': 99}, {'init_start': 99}, {'main_pid': 202}, {'restarts': 1}, {'started_at': 'new'}):
            self.setUp()
            self.open()
            self.system.generation = replace(self.system.generation, **change)
            with self.subTest(change=change), self.assertRaises(m.Refused):
                self.run_action('check')
            self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.setUp()
        self.open()
        self.system.network['NetworkID'] = self.system.bridge['id'] = 'f' * 64
        with self.assertRaises(m.Refused):
            self.run_action('check')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')

    def test_generation_changes_before_open_never_authorized(self):
        self.run_action()
        def hook(system):
            if system.snapshots == 2:
                system.generation = replace(system.generation, main_start=99)
        self.system.hook = hook
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_generation_changes_after_open_immediately_closed(self):
        self.run_action()
        def hook(nft):
            self.system.generation = replace(self.system.generation, main_start=99)
        self.nft.hook = hook
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_open_existing_lease_never_retargets_new_generation(self):
        self.open()
        self.system.generation = replace(self.system.generation, main_start=99)
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')

    def test_counter_handle_and_metainfo_do_not_change_checksum(self):
        original = m.digest(self.nft.entries)
        for entry in self.nft.entries:
            value = next(iter(entry.values()))
            value['handle'] = value.get('handle', 0) + 10000
            for expr in value.get('expr', []):
                if 'counter' in expr:
                    expr['counter'].update(packets=12345, bytes=999999)
        self.assertEqual(m.digest(self.nft.entries), original)
        with patch.object(m.Nft, 'command', return_value=json.dumps({'nftables': [{'metainfo': {'version': 'different'}}, *self.nft.entries]})):
            self.assertEqual(m.digest(m.Nft().snapshot('ignored')), original)

    def test_hash_encoding_exact_original_host_algorithm(self):
        def normalize(value):
            if isinstance(value, dict):
                return {k: normalize(v) for k, v in value.items() if k not in ('handle', 'packets', 'bytes')}
            return [normalize(v) for v in value] if isinstance(value, list) else value
        self.assertEqual(m.digest(self.nft.entries), hashlib.sha256(json.dumps(normalize(self.nft.entries), sort_keys=True).encode()).hexdigest())
        self.assertNotEqual(m.digest(self.nft.entries), hashlib.sha256(json.dumps(normalize(self.nft.entries), sort_keys=True, separators=(',', ':')).encode()).hexdigest())

    def test_semantic_hash_change_refuses_and_closes_own(self):
        self.open()
        for entry in self.nft.entries:
            if 'rule' in entry and entry['rule']['chain'] == 'backend_beta':
                entry['rule']['comment'] += '-external'
                break
        with self.assertRaises(m.Refused):
            self.run_action('check')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_native_schema_change_refused_even_with_updated_hash(self):
        for change in ('priority', 'guard', 'forward-drop'):
            manifest, entries = base_fixture()
            if change == 'priority':
                next(item['chain'] for item in entries if 'chain' in item and item['chain']['name'] == 'forward')['prio'] = 0
            else:
                entries.remove(next(item for item in entries if 'rule' in item and item['rule']['chain'] == ('guard' if change == 'guard' else 'forward')))
            manifest['nftHash'] = m.digest(entries)
            self.store, self.nft = FakeStore(manifest), FakeNft(entries)
            with self.subTest(change=change), self.assertRaises(m.Refused):
                self.run_action()
            self.assertEqual(self.nft.batches, [])

    def test_jumps_must_precede_native_drops(self):
        self.open()
        first = next(item for item in self.nft.entries if 'rule' in item and item['rule']['comment'].endswith('jump-forward'))
        self.nft.entries.remove(first)
        self.nft.entries.append(first)
        self.store.value['nftHash'] = m.digest(self.nft.entries)
        with self.assertRaises(m.Refused):
            self.run_action('check')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')

    def test_foreign_table_name_or_generation_never_modified(self):
        self.open()
        for key, value in (('name', 'third_party'), ('handle', 88)):
            original = copy.deepcopy(self.nft.entries)
            next(item['table'] for item in self.nft.entries if 'table' in item)[key] = value
            self.nft.batches.clear()
            with self.subTest(key=key), self.assertRaises(m.Refused):
                self.run_action('check')
            self.assertEqual(self.nft.batches, [])
            self.nft.entries = original

    def test_hgy_closed_echo_fixture_guard_check_and_hash(self):
        self.nft.hook = hgy_owned_echo
        self.system.available = False
        self.assertEqual(self.run_action('guard')['state'], 'closed')
        mapping = self.own_rules()[-1]
        self.assertEqual(mapping['expr'][0], {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}})
        self.assertEqual(mapping['expr'][1], {'match': {'op': '==', 'left': {'ct': {'key': 'daddr', 'dir': 'original'}}, 'right': m.LOCAL}})
        before = copy.deepcopy(self.nft.entries)
        self.assertEqual(self.run_action('check')['state'], 'closed')
        self.assertEqual(self.nft.entries, before)
        self.assertEqual(self.store.value['nftHash'], m.digest(before))

    def test_hgy_open_echo_fixture_keeps_both_profiles_and_exact_conditions(self):
        self.nft.hook = hgy_owned_echo
        self.open()
        core = FakeSystem(config('core'))
        self.run_action('guard', core)
        self.run_action('open', core)
        for profile, system in (('beta', self.system), ('core', core)):
            self.assertEqual(self.run_action('check', system)['state'], 'open')
            for rule in self.own_rules(profile)[:2]:
                ct = next(expr['match']['left']['ct'] for expr in rule['expr']
                          if expr.get('match', {}).get('left', {}).get('ct', {}).get('key') == 'daddr')
                self.assertEqual(ct, {'key': 'daddr', 'dir': 'original'})
            self.assertEqual(m.owned_comparable(self.own_rules(profile), self.store.value, profile),
                             m.owned_comparable(m.rules(self.store.value, profile, True)['backend_' + profile], self.store.value, profile))
        self.assertEqual(self.store.value['nftHash'], m.digest(self.nft.entries))

    def test_hgy_echo_rejects_bad_ip_ipv6_notlocal_and_port_tuple(self):
        self.nft.hook = hgy_owned_echo
        self.open()
        baseline, manifest = copy.deepcopy(self.nft.entries), copy.deepcopy(self.store.value)
        changes = [('right', '10.253.77.3'), ('right', '172.30.240.10'), ('right', 'fd00::2'),
                   ('right', '::ffff:10.253.77.2'), ('right', {'prefix': {'addr': m.LOCAL, 'len': 24}}),
                   ('family', 'ip6'), ('family', 'ipv4'), ('dir', 'reply'), ('port', 3120),
                   ('port', {'set': [3220, 3000]}), ('nfproto', 'ipv6')]
        for field, bad in changes:
            entries = copy.deepcopy(baseline)
            mapping = next(item['rule'] for item in entries if 'rule' in item and item['rule']['comment'].endswith(':beta:mapping'))
            address = mapping['expr'][1]['match']
            if field == 'right':
                address['right'] = bad
            elif field in ('family', 'dir'):
                address['left']['ct'][field] = bad
            elif field == 'port':
                mapping['expr'][2]['match']['right'] = bad
            else:
                mapping['expr'].insert(0, m.meta('nfproto', bad))
            changed_manifest = {**manifest, 'nftHash': m.digest(entries)}
            with self.subTest(field=field, bad=bad), self.assertRaises(m.Refused):
                m.schema(changed_manifest, entries)

    def test_hgy_echo_rejects_broader_or_missing_open_states(self):
        self.nft.hook = hgy_owned_echo
        self.open()
        baseline, manifest = copy.deepcopy(self.nft.entries), copy.deepcopy(self.store.value)
        for role, broad in (('request', {'set': ['new', 'established', 'related']}),
                            ('reply', {'set': ['new', 'established']}), ('request', None), ('reply', None)):
            entries = copy.deepcopy(baseline)
            rule = next(item['rule'] for item in entries if 'rule' in item and item['rule']['comment'].endswith(':beta:' + role))
            state = next(expr for expr in rule['expr'] if expr.get('match', {}).get('left') == {'ct': {'key': 'state'}})
            if broad is None:
                rule['expr'].remove(state)
            else:
                state['match']['right'] = broad
            with self.subTest(role=role, broad=broad), self.assertRaises(m.Refused):
                m.schema({**manifest, 'nftHash': m.digest(entries)}, entries)

    def test_hgy_echo_generation_change_still_closes_own_only(self):
        self.nft.hook = hgy_owned_echo
        self.open()
        core = FakeSystem(config('core'))
        self.run_action('guard', core)
        self.run_action('open', core)
        self.system.generation = replace(self.system.generation, main_start=99)
        with self.assertRaises(m.Refused):
            self.run_action('check')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertEqual(self.store.value['profiles']['core']['state'], 'open')
        self.assertEqual(self.run_action('check', core)['state'], 'open')
        m.schema(self.store.value, self.nft.entries)

    def test_hgy_canonicalization_not_applied_to_native_or_unowned_rules(self):
        self.nft.hook = hgy_owned_echo
        self.run_action('guard')
        manifest = copy.deepcopy(self.store.value)
        mapping = copy.deepcopy(self.own_rules()[-1])
        for change in ({'chain': 'guard'}, {'comment': mapping['comment'] + ':foreign'}):
            unowned = {**mapping, **change}
            self.assertEqual(m.owned_comparable([unowned], manifest, 'beta'), m.comparable([unowned]))
        entries = copy.deepcopy(self.nft.entries)
        native_icmp = next(item['rule'] for item in entries if 'rule' in item and item['rule']['comment'].endswith(':icmp'))
        native_icmp['expr'].insert(0, m.meta('nfproto', 'ipv4'))
        with self.assertRaises(m.Refused):
            m.schema({**manifest, 'nftHash': m.digest(entries)}, entries)

    def test_tag_dynamic_but_table_suffix_fixed(self):
        m.validate_manifest(self.store.value)
        for changes in ({'tag': 'ark-wg-test-20311230-ffffffff'}, {'tag': 'malicious;'}, {'nftIdentity': True},
                        {'nftTable': 'third_party'}, {'nftHash': 'short'}, {'profiles': {'other': {}}}):
            with self.subTest(changes=changes), self.assertRaises(m.Refused):
                m.validate_manifest({**self.store.value, **changes})

    def test_profiles_coexist_and_close_only_self(self):
        self.open()
        beta = copy.deepcopy(self.own_rules())
        core = FakeSystem(config('core'))
        self.assertEqual(self.run_action('guard', core)['state'], 'closed')
        self.assertEqual(self.run_action('open', core)['state'], 'open')
        self.assertEqual(self.own_rules(), beta)
        self.assertEqual(self.run_action('check')['state'], 'open')
        self.run_action('close')
        self.assertEqual(self.store.value['profiles']['core']['state'], 'open')
        self.assertTrue(any('accept' in expr for rule in self.own_rules('core') for expr in rule['expr']))
        self.assertEqual(self.run_action('check', core)['state'], 'open')

    def test_profiles_work_in_reverse_creation_order(self):
        core = FakeSystem(config('core'))
        self.run_action('guard', core)
        self.run_action('open', core)
        self.open()
        self.run_action('check', core)
        self.run_action('check')
        m.schema(self.store.value, self.nft.entries)

    def test_atomic_failure_leaves_guard(self):
        self.run_action()
        self.nft.fail_once = True
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_manifest_write_failure_closes_opened_lease(self):
        self.run_action()
        self.store.fail_once = True
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        m.schema(self.store.value, self.nft.entries)

    def test_manifest_atomic_mode_bound_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            path.write_text(json.dumps(self.store.value))
            path.chmod(0o600)
            store = m.Store(path)
            value = store.load()
            value['extra'] = 'preserved'
            store.save(value)
            self.assertEqual(store.load()['extra'], 'preserved')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).glob('.backend-*')), [])
            with self.assertRaises(m.Refused):
                store.save({**value, 'huge': 'x' * 65536})
            path.chmod(0o644)
            with self.assertRaises(m.Refused):
                store.load()
            path.chmod(0o600)
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(m.Refused):
                m.Store(link).load()
            with self.assertRaises(m.Refused):
                m.Store(link).save(value)
            parent_link = Path(directory) / 'directory-link'
            parent_link.symlink_to(directory, target_is_directory=True)
            with self.assertRaises(m.Refused):
                m.read_json(parent_link / 'manifest.json')

    def test_config_root_owned_bounded_nonwritable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'profile': 'beta', 'approved_images': [{'revision': REV, 'image_id': IMAGE}]}))
            self.assertEqual(m.load_config(path, 'beta').profile, 'beta')
            path.chmod(0o666)
            with self.assertRaises(m.Refused):
                m.load_config(path, 'beta')
            path.chmod(0o600)
            path.write_bytes(b'x' * 65537)
            with self.assertRaises(m.Refused):
                m.load_config(path, 'beta')
            path.write_bytes(b'not-json')
            with self.assertRaises(m.Refused):
                m.load_config(path, 'beta')
            with patch.object(m.os, 'fstat', return_value=type('Stat', (), {'st_mode': 0o100600, 'st_uid': 1000, 'st_size': 1})()):
                with self.assertRaises(m.Refused):
                    m.read_json(path)

    def test_global_lock_same_for_both_cli_profiles(self):
        from contextlib import contextmanager
        locks = []
        @contextmanager
        def lock(path, *, timeout=0):
            locks.append((path, timeout))
            yield
        for profile in ('beta', 'core'):
            system = FakeSystem(config(profile))
            with patch.object(sys, 'argv', ['tool', '--profile', profile, '--config', 'ignored', '--action', 'guard']), \
                 patch.object(m, 'load_config', return_value=system.config), patch.object(m, 'System', return_value=system), \
                 patch.object(m, 'Nft', return_value=self.nft), patch.object(m, 'Store', return_value=self.store), \
                 patch.object(p, 'runtime_lock', lock), patch.object(m.signal, 'signal'), redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 0)
        self.assertEqual(locks, [(m.LOCK, m.LOCK_TIMEOUT)] * 2)

    def test_signal_after_atomic_open_closes_lease(self):
        self.run_action()
        def hook(nft):
            nft.hook = None
            raise p.Stopped()
        self.nft.hook = hook
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_hash_changed_immediately_before_open_closes_only_guard(self):
        self.run_action()
        def hook(system):
            if system.snapshots == 3:
                for entry in self.nft.entries:
                    if 'rule' in entry and entry['rule']['chain'] == 'backend_beta':
                        entry['rule']['comment'] += '-changed'
                        break
        self.system.hook = hook
        with self.assertRaises(m.Refused):
            self.run_action('open')
        self.assertEqual(self.store.value['profiles']['beta']['state'], 'closed')
        self.assertFalse(any('accept' in expr for rule in self.own_rules() for expr in rule['expr']))

    def test_manifest_concurrent_update_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            path.write_text(json.dumps(self.store.value))
            path.chmod(0o600)
            store = m.Store(path)
            initial = store.load()
            path.write_text(json.dumps({**initial, 'external': 'preserve'}))
            with self.assertRaises(m.Refused):
                store.save(initial)
            self.assertEqual(json.loads(path.read_text())['external'], 'preserve')

    def test_malformed_owned_snapshot_fixed_refusal(self):
        for entries in ([{'table': None}], [None], [{'unknown': {}}], {'nftables': []}):
            with self.subTest(entries=entries), self.assertRaises(m.Refused):
                m.schema(self.store.value, entries)
        with patch.object(m.Nft, 'command', return_value='not JSON'):
            with self.assertRaises(m.Refused):
                m.Nft().snapshot('ignored')

    def test_counter_state_order_native_rule_equivalence(self):
        for entry in self.nft.entries:
            if 'rule' in entry:
                for expr in entry['rule']['expr']:
                    if 'match' in expr and isinstance(expr['match']['right'], dict):
                        expr['match']['right']['set'].reverse()
                        expr['match']['op'] = '=='
        self.store.value['nftHash'] = m.digest(self.nft.entries)
        self.assertEqual(self.run_action()['state'], 'closed')

    def test_singleton_ct_state_string_and_flag_list_equivalence(self):
        self.open()
        for entry in self.nft.entries:
            if 'rule' in entry:
                for expr in entry['rule']['expr']:
                    if 'match' in expr and expr['match']['left'] == {'ct': {'key': 'state'}}:
                        states = expr['match']['right']['set']
                        expr['match']['right'] = states[0] if len(states) == 1 else states
        self.store.value['nftHash'] = m.digest(self.nft.entries)
        self.assertEqual(self.run_action('check')['state'], 'open')

    def test_safe_subprocess_diagnostics_and_atomic_json(self):
        result = type('Result', (), {'returncode': 1, 'stdout': 'DO-NOT-DUMP-SECRET', 'stderr': 'DO-NOT-DUMP-SECRET'})()
        output = io.StringIO()
        with patch.object(m.subprocess, 'run', return_value=result), redirect_stdout(output):
            with self.assertRaises(m.Refused) as error:
                m.Nft().command(['-a', '-j', 'list', 'table', 'inet', 'ak_wg_9c3dbaa9'])
        self.assertNotIn('SECRET', str(error.exception) + output.getvalue())
        with patch.object(m.Nft, 'command', return_value='') as command:
            m.Nft().apply([{'add': {'chain': {'family': 'inet', 'table': 'ak_wg_9c3dbaa9', 'name': 'backend_beta'}}}])
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args_list[0].args[0], ['-c', '-j', '-f', '-'])
            self.assertEqual(command.call_args_list[1].args[0], ['-j', '-f', '-'])
            self.assertEqual(command.call_args_list[0].args[1], command.call_args_list[1].args[1])


if __name__ == '__main__':
    unittest.main()
