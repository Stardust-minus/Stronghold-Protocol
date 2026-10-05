#!/usr/bin/env python3
"""Host-only fixed WireGuard backend leases; never ship in the game image."""
import argparse
from dataclasses import asdict
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile

SPEC = importlib.util.spec_from_file_location('wg_backend_priority', Path(__file__).with_name('main-thread-priority.py'))
priority = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = priority
SPEC.loader.exec_module(priority)
Refused = priority.Refused
MANIFEST = '/etc/ark-wg-test/manifest.json'
LOCK = '/run/ark-wg-backend-access.lock'  # Both profiles share this one root-owned flock.
IFACE, PEER, LOCAL = 'ark-wg-test', '10.253.77.1', '10.253.77.2'
FIXED = {'beta': ('172.30.240.10', '172.30.240.0/24'), 'core': ('172.30.241.10', '172.30.241.0/24')}
TAG = re.compile(r'ark-wg-test-[0-9]{8}-[0-9a-f]{8}')
LIMIT = 65536


def require(condition, diagnostic):
    if not condition:
        raise Refused(diagnostic)


def no_symlink(path):
    path = Path(os.path.abspath(path))
    for parent in (*reversed(path.parents), path):
        require(not stat.S_ISLNK(os.lstat(parent).st_mode), 'symlink path refused')
    return path


def read_json(path, private=False):
    path = no_symlink(path)
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                and info.st_size <= LIMIT and (not private or stat.S_IMODE(info.st_mode) == 0o600), 'unsafe root policy file')
        raw = os.read(fd, LIMIT + 1)
        require(len(raw) <= LIMIT, 'root policy file exceeds bound')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise Refused('invalid root policy JSON') from None
    finally:
        os.close(fd)


def load_config(path, profile):
    config = priority.Config.parse(read_json(path))
    require(profile in FIXED and config.profile == profile, 'config profile must match fixed CLI profile')
    return config


class Store:
    def __init__(self, path=MANIFEST):
        self.path, self.expected = path, None

    def load(self):
        value = read_json(self.path, private=True)
        self.expected = json.dumps(value, sort_keys=True)
        return value

    def save(self, value):
        path = no_symlink(self.path)
        before = json.dumps(read_json(path, private=True), sort_keys=True)
        require(self.expected is not None and before == self.expected, 'manifest changed concurrently')
        parent = os.stat(path.parent, follow_symlinks=False)
        require(parent.st_uid == 0 and not parent.st_mode & 0o022, 'unsafe manifest directory')
        raw = json.dumps(value, sort_keys=True).encode() + b'\n'
        require(len(raw) <= LIMIT, 'manifest exceeds bound')
        fd, name = tempfile.mkstemp(prefix='.backend-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            no_symlink(path)
            require(json.dumps(read_json(path, private=True), sort_keys=True) == before, 'manifest changed concurrently')
            os.replace(name, path)
            self.expected = json.dumps(value, sort_keys=True)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)


class System(priority.System):
    def inspect(self, target):
        info = super().inspect(target)
        extra = self.docker('container', 'inspect', '--format', priority.formatter({
            'networks': '.NetworkSettings.Networks', 'all_ports': '.NetworkSettings.Ports',
            'restart_policy': '.HostConfig.RestartPolicy'}), info['id'])
        networks = extra.get('networks')
        require(isinstance(networks, dict) and len(networks) == 1, 'exactly one fixed bridge network required')
        require(set(networks) == {self.config.project + '_default'}, 'fixed default network selector required')
        network = next(iter(networks.values()))
        ip, subnet = FIXED[self.config.profile]
        require(isinstance(network, dict) and network.get('IPAddress') == ip
                and network.get('IPPrefixLen') == 24 and not network.get('GlobalIPv6Address')
                and isinstance(network.get('IPAMConfig'), dict) and network['IPAMConfig'].get('IPv4Address') == ip
                and priority.CID.fullmatch(str(network.get('NetworkID', ''))), 'fixed static container IP required')
        network_id = network['NetworkID']
        bridge = self.docker('network', 'inspect', '--format', priority.formatter({
            'id': '.Id', 'driver': '.Driver', 'ipam': '.IPAM.Config', 'labels': '.Labels'}), network_id)
        require(bridge.get('id') == network_id and bridge.get('driver') == 'bridge'
                and isinstance(bridge.get('ipam'), list) and len(bridge['ipam']) == 1
                and isinstance(bridge['ipam'][0], dict) and bridge['ipam'][0].get('Subnet') == subnet
                and isinstance(bridge.get('labels'), dict)
                and bridge['labels'].get('com.docker.compose.project') == self.config.project
                and bridge['labels'].get('com.docker.compose.network') == 'default', 'fixed bridge subnet required')
        require(extra.get('all_ports') == {'3000/tcp': info['ports']}, 'additional port mapping refused')
        if self.config.profile == 'beta':
            require(extra.get('restart_policy') == {'Name': 'no', 'MaximumRetryCount': 0}, 'beta restart policy must be no')
        return {**info, 'network_id': network_id, 'ip': ip, 'subnet': subnet}


def lease(system):
    config = system.config
    snapshot = system.snapshot(config.container_name)
    priority.validate_threads(snapshot, config)
    require(config.nice == -20 and snapshot.main.nice == -20
            and snapshot.main.policy == os.SCHED_OTHER | priority.RESET_ON_FORK, 'main priority policy not applied')
    info = system.inspect(snapshot.generation.container_id)
    generation = snapshot.generation
    require((info['id'], info['image_id'], info['revision'], info['started_at'], info['restarts'], info['pid'])
            == (generation.container_id, generation.image_id, generation.revision, generation.started_at,
                generation.restarts, generation.init_pid), 'container generation changed')
    return {**asdict(generation), **{key: info[key] for key in ('ip', 'subnet', 'network_id')}}


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items() if key not in ('handle', 'packets', 'bytes')}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value


def digest(entries):
    # Exact wg-test-host.py encoding, including default JSON spaces and ensure_ascii.
    return hashlib.sha256(json.dumps(normalized(entries), sort_keys=True).encode()).hexdigest()


class Nft:
    def command(self, args, data=None):
        try:
            result = subprocess.run(['/usr/sbin/nft', *args], input=data, capture_output=True,
                                    text=True, timeout=5, env=priority.DOCKER_ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise Refused('owned nft operation unavailable') from None
        require(result.returncode == 0 and len(result.stdout) <= 1048576, 'owned nft operation failed')
        return result.stdout

    def snapshot(self, table):
        try:
            data = json.loads(self.command(['-a', '-j', 'list', 'table', 'inet', table]))
            entries = [item for item in data['nftables'] if 'metainfo' not in item]
        except (ValueError, TypeError, KeyError):
            raise Refused('invalid owned nft snapshot') from None
        require(all(isinstance(item, dict) and len(item) == 1 for item in entries), 'invalid owned nft entries')
        return entries

    def apply(self, commands):
        # One libnftables JSON document is one kernel transaction, not separate commands.
        text = json.dumps({'nftables': commands})
        self.command(['-c', '-j', '-f', '-'], text)
        self.command(['-j', '-f', '-'], text)


def match(left, right, op='=='):
    return {'match': {'op': op, 'left': left, 'right': right}}


def meta(key, value):
    return match({'meta': {'key': key}}, value)


def payload(protocol, field, value):
    return match({'payload': {'protocol': protocol, 'field': field}}, value)


def original(key, value):
    ct = {'key': key, 'dir': 'original'}
    if key == 'daddr':
        ct['family'] = 'ip'
    return match({'ct': ct}, value)


def states(*values):
    return match({'ct': {'key': 'state'}}, {'set': list(values)}, 'in')


def rule(table, chain, expressions, comment):
    return {'family': 'inet', 'table': table, 'chain': chain,
            'expr': [*expressions[:-1], {'counter': {'packets': 0, 'bytes': 0}}, expressions[-1]], 'comment': comment}


def rules(manifest, profile, opened):
    table, tag = manifest['nftTable'], manifest['tag']
    port = 3220 if profile == 'beta' else 3120
    ip = FIXED[profile][0]
    chain = 'backend_' + profile
    tuple_match = [original('daddr', LOCAL), original('proto-dst', port)]
    specs = []
    if opened:
        specs += [('request', [meta('iifname', IFACE), payload('ip', 'saddr', PEER), payload('ip', 'daddr', ip),
                               payload('tcp', 'dport', 3000), *tuple_match, states('new', 'established'), {'accept': None}]),
                  ('reply', [meta('oifname', IFACE), payload('ip', 'saddr', ip), payload('ip', 'daddr', PEER),
                             payload('tcp', 'sport', 3000), *tuple_match, states('established'), {'accept': None}])]
    specs += [('direct-in', [payload('ip', 'daddr', ip), payload('tcp', 'dport', 3000), {'drop': None}]),
              ('direct-out', [payload('ip', 'saddr', ip), payload('tcp', 'sport', 3000), {'drop': None}]),
              ('mapping', [meta('nfproto', 'ipv4'), meta('l4proto', 'tcp'), *tuple_match, {'drop': None}])]
    forward = [rule(table, chain, expr, tag + ':backend:' + profile + ':' + name) for name, expr in specs]
    incoming = [rule(table, chain + '_input', [payload('ip', 'daddr', LOCAL), payload('tcp', 'dport', port),
                                            {'drop': None}], tag + ':backend:' + profile + ':input-deny')]
    return {chain: forward, chain + '_input': incoming}


def native(manifest):
    table, tag = manifest['nftTable'], manifest['tag']
    selector = [meta('iifname', IFACE), payload('ip', 'saddr', PEER), payload('ip', 'daddr', LOCAL)]
    # Native counters precede the verdict. Own rules below follow that same form.
    return {'guard': [rule(table, 'guard', [*selector, payload('ip', 'protocol', 'icmp'), {'accept': None}], tag + ':icmp'),
                      rule(table, 'guard', [*selector, states('established', 'related'), {'accept': None}], tag + ':established'),
                      rule(table, 'guard', [{'drop': None}], tag + ':deny')],
            'input': [rule(table, 'input', [meta('iifname', IFACE), {'jump': {'target': 'guard'}}], tag + ':input-interface'),
                      rule(table, 'input', [payload('ip', 'daddr', LOCAL), {'jump': {'target': 'guard'}}], tag + ':input-address')],
            'forward': [rule(table, 'forward', [meta('iifname', IFACE), {'drop': None}], tag + ':no-forward-in'),
                        rule(table, 'forward', [meta('oifname', IFACE), {'drop': None}], tag + ':no-forward-out')]}


def comparable(value):
    value = normalized(value)
    if isinstance(value, dict):
        if 'expr' in value:
            value['expr'] = [item for item in value['expr'] if 'counter' not in item]
        if 'match' in value:
            require(isinstance(value['match'], dict), 'invalid owned rule expression')
            matching = value['match']
            if matching.get('left') == {'ct': {'key': 'state'}} and matching.get('op') in ('==', 'in'):
                right = matching.get('right')
                if isinstance(right, str):
                    matching['right'] = {'set': [right]}
                elif isinstance(right, list):
                    matching['right'] = {'set': right}
            if isinstance(value['match'].get('right'), dict) and 'set' in value['match']['right']:
                value['match']['right']['set'].sort()
                if value['match']['op'] == '==':
                    value['match']['op'] = 'in'
        return {key: comparable(item) for key, item in value.items()}
    return [comparable(item) for item in value] if isinstance(value, list) else value


def owned_comparable(values, manifest, profile):
    values = comparable(values)
    port = 3220 if profile == 'beta' else 3120
    address = original('daddr', LOCAL)
    without_family = original('daddr', LOCAL)
    del without_family['match']['left']['ct']['family']
    destination_port = original('proto-dst', port)
    for value in values:
        if (value.get('chain') != 'backend_' + profile or value.get('comment') not in
                {manifest['tag'] + ':backend:' + profile + ':' + role for role in ('request', 'reply', 'mapping')}):
            continue
        expressions = value.get('expr', [])
        for index in range(len(expressions) - 1):
            # Only this profile's exact IPv4 ORIGINAL tuple permits the kernel's
            # omitted family/redundant nfproto representation; all other terms remain exact.
            if expressions[index] in (address, without_family) and expressions[index + 1] == destination_port:
                expressions[index] = original('daddr', LOCAL)
                value['expr'] = [item for item in expressions if item != meta('nfproto', 'ipv4')]
                break
    return values


def identity(manifest, entries):
    require(isinstance(entries, list) and len(entries) <= 128
            and all(isinstance(item, dict) and len(item) == 1 and isinstance(next(iter(item.values())), dict)
                    for item in entries), 'invalid owned nft entries')
    tables = [item['table'] for item in entries if 'table' in item]
    require(len(tables) == 1 and tables[0].get('family') == 'inet' and tables[0].get('name') == manifest['nftTable']
            and type(tables[0].get('handle')) is int and tables[0]['handle'] == manifest['nftIdentity'],
            'owned table generation mismatch')


def validate_manifest(value):
    require(isinstance(value, dict) and isinstance(value.get('tag'), str) and TAG.fullmatch(value['tag'])
            and value.get('nftTable') == 'ak_wg_' + value['tag'][-8:]
            and type(value.get('nftIdentity')) is int and value['nftIdentity'] > 0
            and re.fullmatch(r'[0-9a-f]{64}', str(value.get('nftHash', '')))
            and value.get('firewallBackend') == 'nft' and not value.get('testRules'), 'invalid WG manifest identity')
    profiles = value.get('profiles', {})
    require(isinstance(profiles, dict) and not set(profiles) - set(FIXED), 'invalid backend profiles')
    for entry in profiles.values():
        require(isinstance(entry, dict) and set(entry) == {'state', 'lease'} and entry['state'] in ('open', 'closed')
                and (isinstance(entry['lease'], dict) if entry['state'] == 'open' else entry['lease'] is None), 'invalid backend lease')


def jump(manifest, profile, hook):
    target = 'backend_' + profile + ('_input' if hook == 'input' else '')
    return {'family': 'inet', 'table': manifest['nftTable'], 'chain': hook,
            'expr': [{'jump': {'target': target}}], 'comment': manifest['tag'] + ':backend:' + profile + ':jump-' + hook}


def schema(manifest, entries, check_hash=True):
    identity(manifest, entries)
    chains, actual = {}, {}
    for entry in entries:
        kind, value = next(iter(entry.items()))
        if kind == 'table':
            continue
        require(kind in ('chain', 'rule') and value.get('family') == 'inet' and value.get('table') == manifest['nftTable'], 'foreign owned-table schema')
        if kind == 'chain':
            require(value['name'] not in chains, 'duplicate owned chain')
            chains[value['name']] = normalized(value)
        else:
            actual.setdefault(value['chain'], []).append(value)
    expected = native(manifest)
    chain_names = set(expected)
    for profile, entry in manifest.get('profiles', {}).items():
        managed = rules(manifest, profile, entry['state'] == 'open')
        expected.update(managed)
        chain_names.update(managed)
        for hook in ('input', 'forward'):
            expected[hook].insert(0, jump(manifest, profile, hook))
    require(set(chains) == chain_names and set(actual) == set(expected), 'owned chain schema mismatch')
    for name in chain_names:
        wanted = {'family': 'inet', 'table': manifest['nftTable'], 'name': name}
        if name in ('input', 'forward'):
            wanted.update(type='filter', hook=name, prio=-10, policy='accept')
        require(chains[name] == wanted, 'owned chain hook mismatch')
        if name in ('input', 'forward'):
            # Profiles may have been added in either order; all own jumps must precede the native rules.
            n = len(manifest.get('profiles', {}))
            require(sorted(comparable(actual[name][:n]), key=lambda item: item['comment'])
                    == sorted(comparable(expected[name][:n]), key=lambda item: item['comment'])
                    and comparable(actual[name][n:]) == comparable(expected[name][n:]), 'owned jump precedence mismatch')
        else:
            profile = next((item for item in manifest.get('profiles', {}) if name == 'backend_' + item), None)
            if profile is None:
                require(comparable(actual[name]) == comparable(expected[name]), 'owned rule schema mismatch')
            else:
                require(owned_comparable(actual[name], manifest, profile) == owned_comparable(expected[name], manifest, profile),
                        'owned rule schema mismatch')
    require(not check_hash or digest(entries) == manifest['nftHash'], 'owned table hash mismatch')


class Helper:
    def __init__(self, system, nft, store):
        self.system, self.nft, self.store = system, nft, store
        self.profile = system.config.profile
        require(self.profile in FIXED, 'fixed backend profile required')
        self.manifest = None

    def transition(self, opened, generation=None, emergency=False):
        value = self.manifest
        entries = self.nft.snapshot(value['nftTable'])
        identity(value, entries)
        if not emergency:
            schema(value, entries)
        known = self.profile in value.get('profiles', {})
        commands = []
        for chain, owned_rules in rules(value, self.profile, opened).items():
            if emergency:
                definitions = [item['chain'] for item in entries if 'chain' in item and item['chain'].get('name') == chain]
                require(known and len(definitions) == 1 and not set(definitions[0]) & {'hook', 'type', 'policy'}, 'owned emergency chain unavailable')
            commands.append({('flush' if known else 'add'): {'chain': {'family': 'inet', 'table': value['nftTable'], 'name': chain}}})
            # Construct each complete regular chain before inserting any jump, in the SAME batch.
            commands.extend({'add': {'rule': item}} for item in owned_rules)
        if not known:
            commands.extend({'insert': {'rule': jump(value, self.profile, hook)}} for hook in ('input', 'forward'))
        if opened:
            require(lease(self.system) == generation, 'container generation changed immediately before opening')
            schema(value, self.nft.snapshot(value['nftTable']))
        self.nft.apply(commands)
        value.setdefault('profiles', {})[self.profile] = {'state': 'open' if opened else 'closed', 'lease': generation}
        after = self.nft.snapshot(value['nftTable'])
        identity(value, after)
        value['nftHash'] = digest(after)
        if not emergency:
            schema(value, after)
        if opened:
            require(lease(self.system) == generation, 'container generation changed after opening')
            schema(value, self.nft.snapshot(value['nftTable']))
        self.store.save(value)

    def run(self, action):
        require(action in ('guard', 'open', 'close', 'check'), 'fixed action required')
        try:
            self.manifest = self.store.load()
            validate_manifest(self.manifest)
            schema(self.manifest, self.nft.snapshot(self.manifest['nftTable']))
            entry = self.manifest.get('profiles', {}).get(self.profile)
            if action in ('guard', 'close'):
                self.transition(False)
            elif action == 'open':
                require(entry is not None, 'closed guard must be installed before open')
                generation = lease(self.system)
                require(entry['state'] != 'open' or entry['lease'] == generation, 'existing lease generation changed')
                require(lease(self.system) == generation, 'container generation changed before opening')
                self.transition(True, generation)
            else:
                require(entry is not None, 'backend guard not installed')
                if entry['state'] == 'open':
                    require(lease(self.system) == entry['lease'], 'backend lease generation changed')
                schema(self.manifest, self.nft.snapshot(self.manifest['nftTable']))
            return {'profile': self.profile, 'state': self.manifest['profiles'][self.profile]['state']}
        except (Refused, OSError, ValueError, KeyError, TypeError, priority.Stopped):
            # Never re-open on a new CID. Best effort touches ONLY this lease's regular chains.
            try:
                validate_manifest(self.manifest)
                if self.profile in self.manifest.get('profiles', {}):
                    self.transition(False, emergency=True)
            except (Refused, OSError, ValueError, KeyError, TypeError, priority.Stopped):
                pass
            raise Refused('backend refused; own lease closed where identity permitted') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, choices=tuple(FIXED))
    parser.add_argument('--config', required=True)
    parser.add_argument('--action', required=True, choices=('guard', 'open', 'close', 'check'))
    args = parser.parse_args()
    def stop(_signal, _frame):
        raise priority.Stopped()
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, stop)
    try:
        require(os.geteuid() == 0, 'host root required')
        config = load_config(args.config, args.profile)
        with priority.runtime_lock(LOCK):
            result = Helper(System(config), Nft(), Store()).run(args.action)
        priority.emit('backend-' + args.action, **result)
        return 0
    except (Refused, OSError, priority.Stopped):
        priority.emit('refused', reason='backend access refused; no command output disclosed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
