"""Injected recovery tests and isolated bash fixtures; no host secrets, /run locks, nft, or WG changes."""
import base64
import copy
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('wg_route_restore', Path(__file__).with_name('wg-route-restore.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
a = m.access
RUNTIME_LOCK = m.priority.runtime_lock
PUBLIC, PEER_PUBLIC, PRIVATE = (base64.b64encode(bytes([byte]) * 32).decode() for byte in (11, 22, 33))
TOOLS = {'wg': b'fixture-wg-binary', 'wg-quick': b'fixture-wg-quick-script'}


def config_text(role, local, peer):
    text = '[Interface]\nAddress = ' + local + '/32\nListenPort = 51837\nMTU = 1420\nPrivateKey = ' + PRIVATE
    text += '\n\n[Peer]\nPublicKey = ' + PEER_PUBLIC + '\nAllowedIPs = ' + peer + '/32\n'
    if role == 'core':
        text += 'Endpoint = 115.231.235.78:51837\nPersistentKeepalive = 25\n'
    return text.encode()


def fixture(role='core', profiles=True):
    # Independently constructed original native rules, including counterless input.
    local, peer = ('10.253.77.1', '10.253.77.2') if role == 'edge' else ('10.253.77.2', '10.253.77.1')
    tag, table = 'ark-wg-test-20311230-9c3dbaa9', 'ak_wg_9c3dbaa9'
    def match(left, right, op='=='):
        return {'match': {'op': op, 'left': left, 'right': right}}
    def interface(key):
        return match({'meta': {'key': key}}, 'ark-wg-test')
    def ip(field, value):
        return match({'payload': {'protocol': 'ip', 'field': field}}, value)
    def rule(chain, expressions, suffix):
        return {'rule': {'family': 'inet', 'table': table, 'chain': chain, 'expr': expressions, 'comment': tag + ':' + suffix}}
    counter, accept, drop = {'counter': {'packets': 13, 'bytes': 90}}, {'accept': None}, {'drop': None}
    selector = [interface('iifname'), ip('saddr', peer), ip('daddr', local)]
    entries = [{'table': {'family': 'inet', 'name': table, 'handle': 77}},
               {'chain': {'family': 'inet', 'table': table, 'name': 'guard', 'handle': 1}},
               rule('guard', [*selector, ip('protocol', 'icmp'), counter, accept], 'icmp'),
               rule('guard', [*selector, match({'ct': {'key': 'state'}}, {'set': ['established', 'related']}, 'in'), counter, accept], 'established'),
               rule('guard', [counter, drop], 'deny')]
    for hook in ('input', 'forward'):
        entries.append({'chain': {'family': 'inet', 'table': table, 'name': hook, 'type': 'filter',
                                  'hook': hook, 'prio': -10, 'policy': 'accept', 'handle': len(entries)}})
    entries += [rule('input', [interface('iifname'), {'jump': {'target': 'guard'}}], 'input-interface'),
                rule('input', [ip('daddr', local), {'jump': {'target': 'guard'}}], 'input-address'),
                rule('forward', [interface('iifname'), counter, drop], 'no-forward-in'),
                rule('forward', [interface('oifname'), counter, drop], 'no-forward-out')]
    raw = config_text(role, local, peer)
    value = {'tag': tag, 'role': role, 'local': local, 'peer': peer, 'interface': 'ark-wg-test',
             'publicKey': PUBLIC, 'peerPublicKey': PEER_PUBLIC,
             'publicFingerprint': hashlib.sha256(PUBLIC.encode()).hexdigest(),
             'configHash': hashlib.sha256(raw).hexdigest(),
             'toolsSha256': {name: hashlib.sha256(content).hexdigest() for name, content in TOOLS.items()},
             'baseline': {'default': [{'dst': 'default', 'dev': 'eth0', 'gateway': '192.0.2.1'}],
                          'rules': [{'priority': 0, 'table': 'local'}, {'priority': 32766, 'table': 'main'}]},
             'nftTable': table, 'nftIdentity': 77, 'nftHash': a.digest(entries), 'firewallBackend': 'nft',
             'testRules': [], 'phase': 'up', 'up': True, 'profiles': {},
             'legacy': {'preserve': [1, 2, 3]}, 'hostname': 'fixture-host'}
    if profiles and role == 'core':
        value['profiles'] = {name: {'state': 'open', 'lease': {'container_id': name + '-exact-old-generation', 'unchanged': [9, 8]}}
                             for name in ('beta', 'core')}
        nft = FakeNft(entries)
        commands = []
        for name in value['profiles']:
            for chain, rules in a.rules(value, name, True).items():
                commands.append({'add': {'chain': {'family': 'inet', 'table': table, 'name': chain}}})
                commands.extend({'add': {'rule': rule}} for rule in rules)
            commands.extend({'insert': {'rule': a.jump(value, name, hook)}} for hook in ('input', 'forward'))
        nft.apply(commands)
        entries = nft.entries
        observed_echo(entries)
        value['nftHash'] = a.digest(entries)
    return value, entries, raw


def observed_echo(entries):
    for entry in entries:
        rule = entry.get('rule', {})
        if not rule.get('chain', '').startswith('backend_'):
            continue
        for expression in rule['expr']:
            expression.get('match', {}).get('left', {}).get('ct', {}).pop('family', None)
        rule['expr'] = [expression for expression in rule['expr'] if expression != a.meta('nfproto', 'ipv4')]


class FakeStore:
    def __init__(self, value):
        self.value, self.saves, self.fail_at, self.conflict = copy.deepcopy(value), [], None, False

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, value):
        if self.conflict:
            raise a.Refused('fixture concurrent manifest change')
        if len(self.saves) + 1 == self.fail_at:
            self.fail_at = None
            raise OSError('fixture atomic write failed')
        self.saves.append(copy.deepcopy(value))
        self.value = copy.deepcopy(value)


class FakeNft:
    def __init__(self, entries=None):
        self.entries = copy.deepcopy(entries or [])
        self.batches, self.fail, self.echo, self.after_apply = [], False, False, None

    def snapshot(self, table):
        return copy.deepcopy(self.entries)

    def apply(self, commands):
        self.batches.append(copy.deepcopy(commands))
        if self.fail:
            raise a.Refused('fixture rejected transaction')
        future = copy.deepcopy(self.entries)
        for command in commands:
            verb, obj = next(iter(command.items()))
            kind, item = next(iter(obj.items()))
            item = copy.deepcopy(item)
            if kind == 'table':
                if future or verb != 'create':
                    raise a.Refused('fixture table already exists; create refused')
                item['handle'] = 901
                future.append({'table': item})
            elif kind == 'chain':
                item['handle'] = 1000 + len(future)
                future.append({'chain': item})
            elif kind == 'rule':
                item['handle'] = 2000 + len(future)
                indexes = [index for index, entry in enumerate(future) if entry.get('rule', {}).get('chain') == item['chain']]
                index = (indexes[0] if verb == 'insert' else indexes[-1] + 1) if indexes else next(
                    index + 1 for index, entry in enumerate(future) if entry.get('chain', {}).get('name') == item['chain'])
                future.insert(index, {'rule': item})
            else:
                raise AssertionError('unexpected mutation grammar')
        if self.echo:
            observed_echo(future)
        self.entries = future
        if self.after_apply:
            self.after_apply()


class FakeHost(m.Host):
    def __init__(self, value, raw, table=True, interface=True):
        self.value = copy.deepcopy(value)
        self.table, self.interface, self.calls, self.inputs = table, interface, [], []
        self.files = {str(m.CONFIG): raw, **{str(m.TOOLS / name): content for name, content in TOOLS.items()}}
        self.uid, self.mode, self.directory_uid, self.symlink = {}, {}, 0, False
        self.live_public, self.live_peer, self.local, self.prefix = PUBLIC, PEER_PUBLIC, value['local'], 32
        self.allowed, self.route_dev, self.routes = value['peer'] + '/32', m.IFACE, None
        self.default, self.rules = copy.deepcopy(value['baseline']['default']), copy.deepcopy(value['baseline']['rules'])
        self.fail_up, self.before_up, self.after_up, self.inventory_fail = False, None, None, False
        self.link_up, self.address_output = interface, None
        self.store = None

    def read_file(self, path, private=False):
        # Exercise production owner/mode/bounds checks with fake bytes/stat/open, not a secret file.
        name = str(path)
        content = io.BytesIO(self.files[name])
        info = SimpleNamespace(st_uid=self.uid.get(name, 0), st_mode=stat.S_IFREG | self.mode.get(name, 0o600 if private else 0o755),
                               st_size=len(self.files[name]))
        def no_symlink(path):
            a.require(not self.symlink, 'fixture symlink refused')
            return Path(path)
        with patch.object(a, 'no_symlink', side_effect=no_symlink), \
             patch.object(m.os, 'stat', return_value=SimpleNamespace(st_uid=self.directory_uid, st_mode=stat.S_IFDIR | 0o755)), \
             patch.object(m.os, 'open', return_value=91), patch.object(m.os, 'fstat', return_value=info), \
             patch.object(m.os, 'read', side_effect=lambda _fd, size: content.read(size)), patch.object(m.os, 'close'):
            return super().read_file(path, private)

    def interface_exists(self):
        return self.interface

    def command(self, args, data=None):
        self.calls.append(list(args))
        if data is not None:
            self.inputs.append((list(args), data))
        if args == [str(m.TOOLS / 'wg'), 'pubkey']:
            return PUBLIC + '\n'
        if args == ['/usr/sbin/nft', '-j', 'list', 'tables']:
            a.require(not self.inventory_fail, 'fixture inventory unavailable')
            tables = [{'table': {'family': 'inet', 'name': 'foreign-untouched'}}]
            if self.table:
                tables.append({'table': {'family': 'inet', 'name': self.value['nftTable']}})
            return json.dumps({'nftables': [{'metainfo': {'version': 'fixture'}}, *tables]})
        if args == m.UP_COMMAND:
            if self.store is not None:
                if self.store.value['phase'] != 'guarded' or any(entry['state'] != 'closed' or entry['lease'] is not None
                                                               for entry in self.store.value['profiles'].values()):
                    raise AssertionError('WG started before closed guards were saved')
            if self.before_up:
                self.before_up()
            a.require(not self.interface, 'fixture foreign interface exists before WG creation')
            self.interface, self.link_up = True, True
            if self.after_up:
                self.after_up()
            a.require(not self.fail_up, 'fixture partial WG up failed')
            return ''
        if args == [str(m.TOOLS / 'wg'), 'show', m.IFACE, 'public-key']:
            return self.live_public + '\n'
        if args == [str(m.TOOLS / 'wg'), 'show', m.IFACE, 'allowed-ips']:
            return self.live_peer + '\t' + self.allowed + '\n'
        if args == ['ip', '-j', 'address', 'show', 'dev', m.IFACE]:
            if self.address_output is not None:
                return json.dumps(self.address_output)
            return json.dumps([{'ifname': m.IFACE, 'flags': ['UP'] if self.link_up else [], 'addr_info': [
                {'family': 'inet', 'local': self.local, 'prefixlen': self.prefix}]}])
        if args == ['ip', '-j', 'route', 'show', 'dev', m.IFACE]:
            return json.dumps(self.routes if self.routes is not None else [{'dst': self.value['peer'], 'dev': m.IFACE}])
        if args == ['ip', '-j', 'route', 'get', self.value['peer'], 'from', self.value['local']]:
            return json.dumps([{'dst': self.value['peer'], 'dev': self.route_dev}])
        if args == ['ip', '-j', 'route', 'show', 'default']:
            return json.dumps(self.default)
        if args == ['ip', '-j', 'rule', 'show']:
            return json.dumps(self.rules)
        raise AssertionError('unexpected command')


class RestoreTests(unittest.TestCase):
    def setUp(self):
        # Fail immediately on any accidental real command, secret read, stat, or runtime lock.
        for patcher in (patch.object(m.subprocess, 'run', side_effect=AssertionError('no real subprocess')),
                        patch.object(m.os, 'open', side_effect=AssertionError('no real filesystem open')),
                        patch.object(m.os, 'stat', side_effect=AssertionError('no real stat')),
                        patch.object(Path, 'read_bytes', side_effect=AssertionError('no real file bytes')),
                        patch.object(m.priority, 'runtime_lock', side_effect=AssertionError('no real runtime lock'))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def setup_role(self, role='core', boot=False):
        value, entries, raw = fixture(role)
        store, nft = FakeStore(value), FakeNft([] if boot else entries)
        host = FakeHost(value, raw, table=not boot, interface=not boot)
        host.store = store
        return store, nft, host

    def test_live_both_roles_idempotent_preserves_exact_leases_and_globals(self):
        constants = (a.LOCAL, a.PEER, copy.deepcopy(a.FIXED))
        for role in ('edge', 'core'):
            store, nft, host = self.setup_role(role)
            before = copy.deepcopy((store.value, nft.entries))
            for _ in range(2):
                self.assertTrue(m.restore(store, nft, host)['liveStatePreserved'])
            self.assertEqual((store.value, nft.entries), before)
            self.assertEqual((store.saves, nft.batches), ([], []))
            self.assertFalse(any(command == m.UP_COMMAND or command[:2] == ['ip', 'link'] for command in host.calls))
            self.assertEqual((host.default, host.rules), (store.value['baseline']['default'], store.value['baseline']['rules']))
            self.assertTrue(all(command[0] in ('ip', str(m.TOOLS / 'wg'), '/usr/sbin/nft') for command in host.calls))
        self.assertEqual((a.LOCAL, a.PEER, a.FIXED), constants)

    def test_boot_both_roles_closed_atomic_guards_before_up_and_fields_preserved(self):
        for role in ('edge', 'core'):
            store, nft, host = self.setup_role(role, boot=True)
            before = copy.deepcopy(store.value)
            nft.echo = True
            self.assertFalse(m.restore(store, nft, host)['liveStatePreserved'])
            self.assertTrue(host.interface)
            self.assertEqual(store.value['nftIdentity'], 901)
            self.assertEqual(store.value['nftHash'], a.digest(nft.entries))
            m.schema(store.value, nft.entries)
            for key in set(before) - {'nftIdentity', 'nftHash', 'profiles'}:
                self.assertEqual(store.value[key], before[key])
            for entry in store.value['profiles'].values():
                self.assertEqual(entry, {'state': 'closed', 'lease': None})
            self.assertEqual(len(nft.batches), 1)
            self.assertEqual(nft.batches[0][0], {'create': {'table': {'family': 'inet', 'name': store.value['nftTable']}}})
            inserted = False
            for command in nft.batches[0]:
                verb, obj = next(iter(command.items()))
                self.assertIn(verb, ('create', 'add', 'insert'))
                item = next(iter(obj.values()))
                self.assertEqual(item.get('table', item.get('name')), store.value['nftTable'])
                if verb == 'insert':
                    inserted = True
                else:
                    self.assertFalse(inserted, 'complete all chains before any jump')
                for expression in item.get('expr', []):
                    if 'counter' in expression:
                        self.assertEqual(expression['counter'], {'packets': 0, 'bytes': 0})
                    if item.get('chain', '').startswith('backend_'):
                        self.assertNotIn('accept', expression)
            self.assertEqual(store.saves[0]['phase'], 'guarded')
            self.assertFalse(store.saves[0]['up'])

    def test_roles_addresses_public_pins_profiles_and_tool_selectors_refused(self):
        changes = [{'role': 'unknown'}, {'role': True}, {'local': '10.253.77.1'}, {'peer': '10.253.77.2'},
                   {'interface': 'wg0'}, {'peerPublicKey': PUBLIC}, {'publicKey': 'invalid'},
                   {'publicFingerprint': '0' * 64}, {'nftTable': 'foreign'}, {'nftIdentity': True},
                   {'nftHash': 'short'}, {'toolsSha256': {'../wg': 'a' * 64}}, {'toolsSha256': {}},
                   {'profiles': {'unregistered': {'state': 'closed', 'lease': None}}}]
        for changeset in changes:
            store, nft, host = self.setup_role(boot=True)
            store.value.update(changeset)
            with self.subTest(changes=changeset), self.assertRaises(m.FAILURES):
                m.restore(store, nft, host)
            self.assertEqual(nft.batches, [])
            self.assertFalse(host.interface)
        store, nft, host = self.setup_role('edge', boot=True)
        store.value['profiles'] = {'beta': {'state': 'closed', 'lease': None}}
        with self.assertRaises(a.Refused):
            m.restore(store, nft, host)
        self.assertEqual(nft.batches, [])

    def test_config_tools_owner_mode_symlink_and_bounds_refused_before_mutation(self):
        for target in (str(m.CONFIG), str(m.TOOLS / 'wg'), str(m.TOOLS / 'wg-quick')):
            for change in ('owner', 'writable', 'empty', 'bytes', 'symlink', 'directory-owner', 'not-executable', 'oversize'):
                store, nft, host = self.setup_role(boot=True)
                if change == 'owner':
                    host.uid[target] = 1000
                elif change in ('writable', 'not-executable'):
                    host.mode[target] = 0o666 if change == 'writable' else 0o644
                elif change == 'empty':
                    host.files[target] = b''
                elif change == 'bytes':
                    host.files[target] += b'changed'
                elif change == 'symlink':
                    host.symlink = True
                elif change == 'directory-owner':
                    host.directory_uid = 1000
                else:
                    host.files[target] = b'x' * ((a.LIMIT if target == str(m.CONFIG) else 4194304) + 1)
                with self.subTest(target=target, change=change), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual(nft.batches, [])
                self.assertEqual(host.calls, [])

    def test_updated_config_hash_still_rejects_hooks_dns_saveconfig_scope_and_duplicate_peer(self):
        additions = ['SaveConfig = true', 'PostUp = touch /fixture', 'PreDown = true', 'DNS = 192.0.2.1',
                     'Table = 123', 'AllowedIPs = 0.0.0.0/0', 'Address = 10.253.77.2/24']
        for addition in additions + ['[Peer]\nPublicKey = ' + PEER_PUBLIC + '\nAllowedIPs = 10.253.77.1/32']:
            store, nft, host = self.setup_role(boot=True)
            host.files[str(m.CONFIG)] += (addition + '\n').encode()
            store.value['configHash'] = hashlib.sha256(host.files[str(m.CONFIG)]).hexdigest()
            with self.subTest(addition=addition), self.assertRaises(a.Refused):
                m.restore(store, nft, host)
            self.assertEqual(nft.batches, [])
        store, nft, host = self.setup_role(boot=True)
        host.files[str(m.CONFIG)] = host.files[str(m.CONFIG)].replace(b'/32', b'/24')
        store.value['configHash'] = hashlib.sha256(host.files[str(m.CONFIG)]).hexdigest()
        with self.assertRaises(a.Refused):
            m.restore(store, nft, host)

    def test_live_public_peer_allowed_local_prefix_and_route_mismatch_preserves_active_state(self):
        for role in ('edge', 'core'):
            for field, bad in (('live_public', PEER_PUBLIC), ('live_peer', PUBLIC), ('allowed', '0.0.0.0/0'),
                               ('allowed', '10.253.77.1/32 10.253.77.2/32'), ('local', '10.253.77.3'),
                               ('prefix', 24), ('route_dev', 'eth0'), ('routes', [{'dst': 'default', 'dev': m.IFACE}])):
                store, nft, host = self.setup_role(role)
                before = copy.deepcopy(store.value)
                setattr(host, field, bad)
                with self.subTest(role=role, field=field), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((store.value, nft.batches, store.saves), (before, [], []))
                self.assertTrue(host.interface)

    def test_device_scoped_route_omits_dev_but_explicit_wrong_device_still_refused(self):
        for role in ('edge', 'core'):
            for destination in ('host', 'prefix'):
                store, nft, host = self.setup_role(role)
                host.routes = [{'dst': store.value['peer'] + ('/32' if destination == 'prefix' else ''),
                                'flags': [], 'scope': 'link'}]
                before = copy.deepcopy((store.value, nft.entries))
                self.assertTrue(m.restore(store, nft, host)['liveStatePreserved'])
                self.assertEqual((store.value, nft.entries), before)
                self.assertEqual((store.saves, nft.batches), ([], []))
            for device in ('eth0', None, False, 1):
                store, nft, host = self.setup_role(role)
                host.routes = [{'dst': store.value['peer'], 'dev': device}]
                with self.subTest(role=role, device=device), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((store.saves, nft.batches), ([], []))
            store, nft, host = self.setup_role(role)
            host.routes = [{'dst': store.value['peer']}]
            host.route_dev = 'eth0'
            with self.assertRaises(a.Refused):
                m.restore(store, nft, host)
            self.assertEqual((store.saves, nft.batches), ([], []))

    def test_default_routes_or_rules_changed_refuse_before_any_mutation(self):
        for boot in (False, True):
            for role in ('edge', 'core'):
                for field in ('default', 'rules'):
                    store, nft, host = self.setup_role(role, boot=boot)
                    setattr(host, field, [{'changed': True}])
                    with self.subTest(boot=boot, role=role, field=field), self.assertRaises(a.Refused):
                        m.restore(store, nft, host)
                    self.assertEqual((nft.batches, store.saves), ([], []))

    def test_foreign_identity_hash_native_schema_or_tuple_never_modified(self):
        for role in ('edge', 'core'):
            for change in ('identity', 'name', 'flags', 'hash', 'hook', 'native-peer', 'native-deny', 'foreign-chain', 'tuple'):
                if change == 'tuple' and role == 'edge':
                    continue
                store, nft, host = self.setup_role(role)
                if change == 'identity':
                    nft.entries[0]['table']['handle'] = 99
                elif change == 'name':
                    nft.entries[0]['table']['name'] = 'foreign'
                elif change == 'flags':
                    nft.entries[0]['table']['flags'] = ['owner']
                elif change == 'hash':
                    store.value['nftHash'] = '0' * 64
                elif change == 'hook':
                    next(item['chain'] for item in nft.entries if item.get('chain', {}).get('name') == 'input')['prio'] = 0
                elif change == 'native-peer':
                    next(item['rule'] for item in nft.entries if item.get('rule', {}).get('comment', '').endswith(':icmp'))['expr'][1]['match']['right'] = '10.253.77.3'
                elif change == 'native-deny':
                    nft.entries.remove(next(item for item in nft.entries if item.get('rule', {}).get('comment', '').endswith(':deny')))
                elif change == 'foreign-chain':
                    nft.entries.append({'chain': {'family': 'inet', 'table': store.value['nftTable'], 'name': 'foreign'}})
                else:
                    mapping = next(item['rule'] for item in nft.entries if item.get('rule', {}).get('comment', '').endswith(':beta:mapping'))
                    next(expr['match'] for expr in mapping['expr'] if expr.get('match', {}).get('left', {}).get('ct', {}).get('key') == 'daddr')['right'] = '10.253.77.3'
                if change != 'hash':
                    store.value['nftHash'] = a.digest(nft.entries)
                before = copy.deepcopy(nft.entries)
                with self.subTest(role=role, change=change), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((nft.entries, nft.batches, store.saves), (before, [], []))
                self.assertTrue(host.interface)

    def test_partial_states_and_unavailable_table_inventory_refuse_without_takeover(self):
        for role in ('edge', 'core'):
            for table, interface in ((True, False), (False, True)):
                store, nft, host = self.setup_role(role)
                host.table, host.interface = table, interface
                if not table:
                    nft.entries = []
                with self.subTest(role=role, table=table), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((nft.batches, store.saves), ([], []))
                self.assertEqual(host.interface, interface)
        store, nft, host = self.setup_role(boot=True)
        host.inventory_fail = True
        with self.assertRaises(a.Refused):
            m.restore(store, nft, host)
        self.assertEqual(nft.batches, [])

    def test_atomic_boot_failure_table_race_and_manifest_cas_never_start_wg(self):
        for failure in ('atomic', 'table-race', 'manifest', 'cas', 'interface-race'):
            store, nft, host = self.setup_role(boot=True)
            if failure == 'atomic':
                nft.fail = True
            elif failure == 'table-race':
                nft.entries = [{'table': {'family': 'inet', 'name': store.value['nftTable'], 'handle': 88}}]
            elif failure == 'manifest':
                store.fail_at = 1
            elif failure == 'cas':
                store.conflict = True
                store.value['external'] = 'preserve'
            else:
                nft.after_apply = lambda: setattr(host, 'interface', True)
            with self.subTest(failure=failure), self.assertRaises(a.Refused):
                m.restore(store, nft, host)
            self.assertFalse(any(command == m.UP_COMMAND or command[:2] == ['ip', 'link'] for command in host.calls))
            if failure == 'table-race':
                self.assertEqual(nft.entries[0]['table']['handle'], 88)
            if failure == 'cas':
                self.assertEqual(store.value['external'], 'preserve')

    def test_after_boot_up_failure_mismatch_signal_or_final_write_retains_partial_closed_state(self):
        for role in ('edge', 'core'):
            for failure in ('partial-up', 'public', 'default', 'signal', 'final-write', 'malformed-address', 'malformed-route'):
                store, nft, host = self.setup_role(role, boot=True)
                if failure == 'partial-up':
                    host.fail_up = True
                elif failure == 'public':
                    host.live_public = PEER_PUBLIC
                elif failure == 'default':
                    host.after_up = lambda: setattr(host, 'default', [])
                elif failure == 'signal':
                    def stop():
                        raise m.priority.Stopped()
                    host.after_up = stop
                elif failure == 'malformed-address':
                    host.address_output = [None]
                elif failure == 'malformed-route':
                    host.routes = [None]
                else:
                    store.fail_at = 2
                with self.subTest(role=role, failure=failure), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertTrue(host.interface)
                self.assertTrue(host.link_up)
                self.assertEqual(len(nft.batches), 1)
                self.assertEqual(len(store.saves), 1, 'failure must not retry a manifest write')
                self.assertFalse(store.value['up'])
                self.assertEqual(store.value['phase'], 'guarded')
                for entry in store.value['profiles'].values():
                    self.assertEqual(entry, {'state': 'closed', 'lease': None})
                m.schema(store.value, nft.entries)
                self.assertFalse(any(command[:2] == ['ip', 'link'] for command in host.calls))
                host.table = True
                before = copy.deepcopy((store.value, nft.entries, host.interface, host.link_up))
                up_count = host.calls.count(m.UP_COMMAND)
                with self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((store.value, nft.entries, host.interface, host.link_up), before)
                self.assertEqual(host.calls.count(m.UP_COMMAND), up_count, 'partial state requires manual recovery')

    def test_foreign_interface_appearing_before_or_after_failed_up_is_never_mutated(self):
        for role in ('edge', 'core'):
            for timing in ('before-last-check', 'before-wg-creation', 'after-failed-up'):
                store, nft, host = self.setup_role(role, boot=True)
                def foreign():
                    host.interface, host.link_up = True, True
                    host.live_public, host.local, host.prefix = PEER_PUBLIC, '192.0.2.99', 24
                    host.routes = [{'dst': '192.0.2.0/24', 'dev': m.IFACE, 'protocol': 'static'}]
                if timing == 'before-last-check':
                    nft.after_apply = foreign
                elif timing == 'before-wg-creation':
                    host.before_up = foreign
                else:
                    host.after_up, host.fail_up = foreign, True
                with self.subTest(role=role, timing=timing), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertTrue(host.interface and host.link_up)
                self.assertEqual((host.live_public, host.local, host.prefix), (PEER_PUBLIC, '192.0.2.99', 24))
                self.assertEqual(host.routes, [{'dst': '192.0.2.0/24', 'dev': m.IFACE, 'protocol': 'static'}])
                self.assertFalse(any(command[:2] == ['ip', 'link'] for command in host.calls))
                self.assertEqual(host.calls.count(m.UP_COMMAND), 0 if timing == 'before-last-check' else 1)
                self.assertEqual(len(store.saves), 1)
                self.assertEqual(store.value['phase'], 'guarded')
                self.assertTrue(all(entry == {'state': 'closed', 'lease': None} for entry in store.value['profiles'].values()))
                m.schema(store.value, nft.entries)

    def test_retained_incomplete_live_markers_refused_without_mutation(self):
        for role in ('edge', 'core'):
            for change in ({'up': False}, {'up': 1}, {'phase': 'guarded'}, {'phase': 'unknown'}):
                store, nft, host = self.setup_role(role)
                store.value.update(change)
                before = copy.deepcopy((store.value, nft.entries))
                with self.subTest(role=role, change=change), self.assertRaises(a.Refused):
                    m.restore(store, nft, host)
                self.assertEqual((store.value, nft.entries), before)
                self.assertEqual((nft.batches, store.saves), ([], []))
                self.assertNotIn(m.UP_COMMAND, host.calls)

    def test_private_key_only_stdin_and_no_key_config_or_command_output_disclosed(self):
        store, nft, host = self.setup_role(boot=True)
        output = io.StringIO()
        with redirect_stdout(output):
            m.restore(store, nft, host)
        self.assertNotIn(PRIVATE, json.dumps(host.calls) + json.dumps(store.saves) + json.dumps(nft.batches) + output.getvalue())
        self.assertTrue(host.inputs)
        self.assertTrue(all(args == [str(m.TOOLS / 'wg'), 'pubkey'] and data == PRIVATE + '\n' for args, data in host.inputs))
        result = SimpleNamespace(returncode=1, stdout=PRIVATE, stderr=PRIVATE)
        with patch.object(m.subprocess, 'run', return_value=result), self.assertRaises(a.Refused) as error:
            m.Host().command([str(m.TOOLS / 'wg'), 'pubkey'], PRIVATE + '\n')
        self.assertNotIn(PRIVATE, str(error.exception))
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=PUBLIC, stderr='')) as run:
            self.assertEqual(m.Host().command(['fixture']), PUBLIC)
            self.assertEqual(run.call_args.kwargs['env']['PATH'].split(':')[0], str(m.TOOLS))

    def test_main_uses_only_shared_lock_and_redacted_failure_without_real_lock(self):
        locks = []
        @contextmanager
        def lock(path, *, timeout=0):
            locks.append((path, timeout))
            yield
        for role in ('edge', 'core'):
            store, nft, host = self.setup_role(role)
            output = io.StringIO()
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.signal, 'signal'), \
                 patch.object(m.priority, 'runtime_lock', lock), patch.object(a, 'Store', return_value=store), \
                 patch.object(a, 'Nft', return_value=nft), patch.object(m, 'Host', return_value=host), redirect_stdout(output):
                self.assertEqual(m.main(), 0)
            self.assertTrue(json.loads(output.getvalue())['liveStatePreserved'])
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.signal, 'signal'), \
                 patch.object(m.priority, 'runtime_lock', lock), patch.object(m, 'restore', side_effect=a.Refused(PRIVATE)), redirect_stdout(output):
                self.assertEqual(m.main(), 1)
            self.assertNotIn(PRIVATE, output.getvalue())
        self.assertEqual(locks, [(a.LOCK, a.LOCK_TIMEOUT)] * 4)
        self.assertEqual(a.LOCK_TIMEOUT, 15)

    def test_root_required_before_lock_store_or_commands(self):
        output = io.StringIO()
        with patch.object(m.os, 'geteuid', return_value=1000), patch.object(m.signal, 'signal'), \
             patch.object(m.priority, 'runtime_lock') as lock, patch.object(a, 'Store') as store, \
             patch.object(a, 'Nft') as nft, redirect_stdout(output):
            self.assertEqual(m.main(), 1)
        lock.assert_not_called()
        store.assert_not_called()
        nft.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['event'], 'refused')

    def test_manifest_root600_load_and_signal_close_fd_before_mutation(self):
        value, _entries, _raw = fixture()
        raw = json.dumps(value).encode()
        for uid, mode, error in ((1000, 0o600, None), (0, 0o644, None), (0, 0o600, m.priority.Stopped())):
            store = a.Store('/fixture/manifest.json')
            info = SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode, st_size=len(raw))
            with patch.object(a, 'no_symlink', return_value=Path(store.path)), \
                 patch.object(m.os, 'open', return_value=91), patch.object(m.os, 'fstat', return_value=info), \
                 patch.object(m.os, 'read', return_value=raw, side_effect=error), patch.object(m.os, 'close') as close, \
                 self.subTest(uid=uid, mode=mode, error=error), self.assertRaises(m.FAILURES):
                store.load()
            close.assert_called_once_with(91)
            self.assertIsNone(store.expected)

    def test_real_store_cas_before_write_and_before_replace_never_starts_wg(self):
        class Output(io.BytesIO):
            def fileno(self):
                return 92
        for timing in ('before-write', 'before-replace'):
            fake, nft, host = self.setup_role(boot=True)
            initial = fake.value
            external = {**copy.deepcopy(initial), 'external': 'must-remain'}
            store = a.Store('/fixture/manifest.json')
            reads = [initial, external] if timing == 'before-write' else [initial, initial, external]
            with patch.object(a, 'read_json', side_effect=[copy.deepcopy(item) for item in reads]), \
                 patch.object(a, 'no_symlink', side_effect=Path), \
                 patch.object(m.os, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)), \
                 patch.object(a.tempfile, 'mkstemp', return_value=(92, '/fixture/.backend-test')) as create, \
                 patch.object(m.os, 'fdopen', return_value=Output()), patch.object(m.os, 'fchmod'), \
                 patch.object(m.os, 'fsync'), patch.object(m.os, 'replace') as replace, \
                 patch.object(m.os.path, 'exists', return_value=False), \
                 self.subTest(timing=timing), self.assertRaises(a.Refused):
                m.restore(store, nft, host)
            self.assertEqual(create.call_count, int(timing == 'before-replace'))
            replace.assert_not_called()
            self.assertNotIn(m.UP_COMMAND, host.calls)
            self.assertFalse(host.interface)
            self.assertEqual(store.expected, json.dumps(initial, sort_keys=True))
            self.assertEqual(external['external'], 'must-remain')
            self.assertEqual(len(nft.batches), 1, 'committed closed guards are not deleted on CAS refusal')

    def test_config_read_signal_or_error_always_closes_fd(self):
        info = SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600, st_size=1)
        for error in (m.priority.Stopped(), OSError('fixture read failure')):
            with patch.object(a, 'no_symlink', return_value=m.CONFIG), \
                 patch.object(m.os, 'stat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)), \
                 patch.object(m.os, 'open', return_value=93) as opened, patch.object(m.os, 'fstat', return_value=info), \
                 patch.object(m.os, 'read', side_effect=error), patch.object(m.os, 'close') as close, \
                 self.subTest(error=error), self.assertRaises(m.FAILURES):
                m.Host().read_file(m.CONFIG, private=True)
            close.assert_called_once_with(93)
            self.assertTrue(opened.call_args.args[1] & m.os.O_NOFOLLOW)
            self.assertTrue(opened.call_args.args[1] & m.os.O_CLOEXEC)

    def test_main_real_shared_lock_timeout_and_stop_release_only_fd_without_restore(self):
        for failure in ('timeout', 'signal'):
            now = [0]
            def wait(seconds):
                if failure == 'signal':
                    raise m.priority.Stopped()
                now[0] += seconds
            output = io.StringIO()
            with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.signal, 'signal'), \
                 patch.object(m.priority, 'runtime_lock', RUNTIME_LOCK), patch.object(m.os, 'open', return_value=94) as opened, \
                 patch.object(m.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)), \
                 patch.object(m.priority.fcntl, 'flock', side_effect=BlockingIOError()), \
                 patch.object(m.priority.time, 'monotonic', side_effect=lambda: now[0]), \
                 patch.object(m.priority.time, 'sleep', side_effect=wait), patch.object(m.os, 'close') as close, \
                 patch.object(m, 'restore') as restore, redirect_stdout(output):
                self.assertEqual(m.main(), 1)
            self.assertEqual(opened.call_args.args[0], a.LOCK)
            close.assert_called_once_with(94)
            restore.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())['event'], 'refused')
            self.assertAlmostEqual(now[0], a.LOCK_TIMEOUT if failure == 'timeout' else 0)

    def test_counter_state_echo_does_not_weaken_raw_hash_or_edge_semantics(self):
        for role in ('edge', 'core'):
            store, nft, host = self.setup_role(role)
            for entry in nft.entries:
                for expression in entry.get('rule', {}).get('expr', []):
                    if 'counter' in expression:
                        expression['counter'].update(packets=123456, bytes=9999)
                    match = expression.get('match', {})
                    if match.get('left') == {'ct': {'key': 'state'}}:
                        match['right']['set'].reverse()
                        match['op'] = '=='
            store.value['nftHash'] = a.digest(nft.entries)
            self.assertTrue(m.restore(store, nft, host)['liveStatePreserved'])
            nft.entries.reverse()
            with self.assertRaises(a.Refused):
                m.restore(store, nft, host)
        store, nft, host = self.setup_role('edge')
        icmp = next(item['rule'] for item in nft.entries if item.get('rule', {}).get('comment', '').endswith(':icmp'))
        icmp['expr'].insert(0, a.meta('nfproto', 'ipv4'))
        store.value['nftHash'] = a.digest(nft.entries)
        with self.assertRaises(a.Refused):
            m.restore(store, nft, host)

    def test_service_is_root_oneshot_ordered_host_only_without_disconnect(self):
        unit = Path(__file__).resolve().parents[1] / 'systemd' / 'ark-wireguard-route.service'
        text = unit.read_text()
        for line in ('Wants=network-online.target', 'After=network-online.target',
                     'Before=ark-beta-game-backend.service ark-core-game-backend.service', 'Type=oneshot',
                     'RemainAfterExit=yes', 'User=root', 'Nice=0',
                     'ExecStart=/usr/bin/python3 -B /opt/ark-wg-test/current/wg-route-restore.py'):
            self.assertIn(line, text.splitlines())
        self.assertNotIn('ExecStop', text)
        self.assertNotIn('docker', text.lower())
        for role in ('beta', 'core'):
            manager = unit.with_name('ark-' + role + '-game-backend.service').read_text()
            self.assertIn('Requires=docker.service ark-wireguard-route.service', manager.splitlines())
            self.assertIn('After=docker.service ark-wireguard-route.service', manager.splitlines())
            self.assertNotIn('wg-quick', manager)
            self.assertNotIn('BindsTo=', manager)
            self.assertNotIn('PartOf=', manager)


class BashWrapperTests(unittest.TestCase):
    def test_fixed_wrapper_preserves_source_arguments_self_path_and_suppresses_cleanup(self):
        self.assertEqual(m.UP_COMMAND[:4], ['/bin/bash', '--noprofile', '--norc', '-c'])
        self.assertEqual(m.UP_COMMAND[4], 'trap() { :; }; readonly -f trap; '
                         'source /opt/ark-wg-test/bin/wg-quick up /etc/ark-wg-test/ark-wg-test.conf')
        endings = [('success', 'trap - INT TERM EXIT', 0), ('exit', 'exit 37', 37),
                   ('errexit', 'false', 1), ('term', 'kill -TERM "$BASHPID"', -15),
                   ('int', 'kill -INT "$BASHPID"', -2), ('hup', 'kill -HUP "$BASHPID"', -1)]
        with tempfile.TemporaryDirectory(prefix='ark-wg-bash-test-') as directory:
            script, marker = Path(directory) / 'wg-quick', Path(directory) / 'cleanup-ran'
            for case, ending, expected in endings:
                # Standard wg-quick initialization/up trap, but no network command or config read.
                script.write_text('#!/bin/bash\nset -e -o pipefail\n'
                                  'SELF="$(readlink -f "${BASH_SOURCE[0]}")"\n'
                                  'export PATH="${SELF%/*}:$PATH"\n'
                                  'ARGS=( "$@" )\n'
                                  '[[ "$SELF" == "' + str(script) + '" ]]\n'
                                  '[[ "${PATH%%:*}" == "' + directory + '" ]]\n'
                                  '[[ $# -eq 2 && $1 == up && $2 == "' + str(m.CONFIG) + '" ]]\n'
                                  '[[ ${#ARGS[@]} -eq 2 && ${ARGS[0]} == up ]]\n'
                                  'del_if() { printf cleaned > "' + str(marker) + '"; }\n'
                                  'cmd_up() {\n'
                                  "trap 'del_if; exit' INT TERM EXIT\n"
                                  "printf 'fixture-secret-output'\n"
                                  "printf 'fixture-secret-output' >&2\n" + ending + '\n}\ncmd_up\n')
                script.chmod(0o755)
                command = [*m.UP_COMMAND[:4], m.UP_COMMAND[4].replace(str(m.TOOLS / 'wg-quick'), str(script))]
                with self.subTest(case=case):
                    result = subprocess.run(command, capture_output=True, text=True, timeout=5, env=m.ENV)
                    self.assertEqual(result.returncode, expected, result.stderr)
                    self.assertFalse(marker.exists(), 'wg-quick cleanup trap must never run')
                    if expected:
                        output = io.StringIO()
                        with redirect_stdout(output), self.assertRaises(a.Refused) as error:
                            m.Host().command(command)
                        self.assertNotIn('fixture-secret-output', str(error.exception) + output.getvalue())
                        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
