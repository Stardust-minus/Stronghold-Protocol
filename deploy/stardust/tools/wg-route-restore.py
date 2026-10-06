#!/usr/bin/env python3
"""Recover only the approved host WG peer/32 and its closed owned guards after boot."""
import base64
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

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('wg_restore_access', BASE / 'wg-backend-access.py')
access = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = access
spec.loader.exec_module(access)
priority = access.priority
IFACE = 'ark-wg-test'
CONFIG = Path('/etc/ark-wg-test/ark-wg-test.conf')
TOOLS = Path('/opt/ark-wg-test/bin')
ROLES = {'edge': ('10.253.77.1', '10.253.77.2'), 'core': ('10.253.77.2', '10.253.77.1')}
ENV = {**priority.DOCKER_ENV, 'PATH': str(TOOLS) + ':/usr/sbin:/usr/bin:/sbin:/bin'}
# Fixed trusted script only: preserve BASH_SOURCE/SELF and its existing hash pins,
# but suppress wg-quick's name-only failure trap. No shell/user/manifest input.
UP_COMMAND = ['/bin/bash', '--noprofile', '--norc', '-c',
              'trap() { :; }; readonly -f trap; '
              'source /opt/ark-wg-test/bin/wg-quick up /etc/ark-wg-test/ark-wg-test.conf']
FAILURES = (access.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, priority.Stopped)


def public_key(value):
    access.require(isinstance(value, str) and len(value) == 44
                   and len(base64.b64decode(value, validate=True)) == 32, 'invalid WG key identity')


def validate_manifest(value):
    access.validate_manifest(value)
    role = value.get('role')
    access.require(isinstance(role, str) and role in ROLES
                   and (value.get('local'), value.get('peer')) == ROLES[role]
                   and value.get('interface') == IFACE, 'fixed WG role/address pair required')
    access.require(role == 'core' or not value.get('profiles'), 'backend profiles belong only to core')
    public_key(value.get('publicKey'))
    public_key(value.get('peerPublicKey'))
    access.require(value['publicKey'] != value['peerPublicKey']
                   and value.get('publicFingerprint') == hashlib.sha256(value['publicKey'].encode()).hexdigest(),
                   'WG public fingerprint changed')
    checksums = value.get('toolsSha256')
    access.require(isinstance(checksums, dict) and set(checksums) == {'wg', 'wg-quick'}
                   and all(isinstance(item, str) and re.fullmatch(r'[0-9a-f]{64}', item)
                           for item in [value.get('configHash'), *checksums.values()]), 'fixed WG file pins required')
    baseline = value.get('baseline')
    access.require(isinstance(baseline, dict) and set(baseline) == {'default', 'rules'}
                   and all(isinstance(baseline[key], list) and all(isinstance(item, dict) for item in baseline[key])
                           for key in baseline), 'invalid routing baseline')


class Host:
    def command(self, args, data=None):
        try:
            result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=20, env=ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise access.Refused('owned WG recovery command unavailable') from None
        access.require(result.returncode == 0 and len(result.stdout) <= 1048576, 'owned WG recovery command failed')
        return result.stdout

    def read_file(self, path, private=False):
        path = access.no_symlink(path)
        for parent in path.parents:
            info = os.stat(parent, follow_symlinks=False)
            access.require(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe owned WG directory')
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            limit = access.LIMIT if private else 4194304
            access.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                           and 0 < info.st_size <= limit
                           and (stat.S_IMODE(info.st_mode) == 0o600 if private else info.st_mode & 0o111),
                           'unsafe owned WG file')
            raw = bytearray()
            while len(raw) <= limit:
                block = os.read(fd, min(65536, limit + 1 - len(raw)))
                if not block:
                    break
                raw.extend(block)
            access.require(len(raw) == info.st_size and len(raw) <= limit, 'owned WG file changed while reading')
            return bytes(raw)
        finally:
            os.close(fd)

    def interface_exists(self):
        return (Path('/sys/class/net') / IFACE).exists()

    def table_exists(self, table):
        # A failed list-table command is NOT proof of absence (permissions/tool failure).
        data = json.loads(self.command(['/usr/sbin/nft', '-j', 'list', 'tables']))
        access.require(isinstance(data, dict) and isinstance(data.get('nftables'), list), 'invalid nft table inventory')
        tables = []
        for entry in data['nftables']:
            access.require(isinstance(entry, dict) and len(entry) == 1, 'invalid nft table inventory')
            if 'metainfo' in entry:
                continue
            item = entry.get('table')
            access.require(isinstance(item, dict) and isinstance(item.get('family'), str)
                           and isinstance(item.get('name'), str), 'invalid nft table inventory')
            tables.append((item['family'], item['name']))
        access.require(len(tables) == len(set(tables)), 'duplicate nft table inventory')
        return ('inet', table) in tables


def verify_files(value, host):
    raw = host.read_file(CONFIG, private=True)
    access.require(hashlib.sha256(raw).hexdigest() == value['configHash'], 'owned WG config changed')
    for name in ('wg', 'wg-quick'):
        access.require(hashlib.sha256(host.read_file(TOOLS / name)).hexdigest() == value['toolsSha256'][name],
                       'owned WG tool changed')
    # Only the existing minimal config grammar is permitted, even with an updated hash.
    sections, section = {}, None
    for line in raw.decode('ascii').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line in ('[Interface]', '[Peer]'):
            access.require(line not in sections, 'duplicate WG config section')
            section = sections[line] = {}
        else:
            access.require(section is not None and '=' in line, 'invalid WG config line')
            name, setting = (part.strip() for part in line.split('=', 1))
            access.require(name not in section and setting, 'duplicate or empty WG config field')
            section[name] = setting
    access.require(set(sections) == {'[Interface]', '[Peer]'}, 'fixed WG config sections required')
    own, peer = sections['[Interface]'], sections['[Peer]']
    peer_fields = {'PublicKey', 'AllowedIPs'}
    if value['role'] == 'core':
        peer_fields |= {'Endpoint', 'PersistentKeepalive'}
        access.require(peer.get('Endpoint') == '115.231.235.78:51837' and peer.get('PersistentKeepalive') == '25',
                       'owned WG endpoint changed')
    access.require(set(own) == {'Address', 'ListenPort', 'MTU', 'PrivateKey'} and set(peer) == peer_fields
                   and own['Address'] == value['local'] + '/32' and own['ListenPort'] == '51837' and own['MTU'] == '1420'
                   and peer['PublicKey'] == value['peerPublicKey'] and peer['AllowedIPs'] == value['peer'] + '/32',
                   'fixed WG config scope required; hooks/DNS/SaveConfig refused')
    public_key(own['PrivateKey'])
    # Private input only on stdin; never arguments, stdout diagnostics, wg dump, or logs.
    access.require(host.command([str(TOOLS / 'wg'), 'pubkey'], own['PrivateKey'] + '\n').strip() == value['publicKey'],
                   'owned WG config public identity changed')


def native(value):
    table, tag = value['nftTable'], value['tag']
    selector = [access.meta('iifname', IFACE), access.payload('ip', 'saddr', value['peer']),
                access.payload('ip', 'daddr', value['local'])]
    return {'guard': [access.rule(table, 'guard', [*selector, access.payload('ip', 'protocol', 'icmp'), {'accept': None}], tag + ':icmp'),
                      access.rule(table, 'guard', [*selector, access.states('established', 'related'), {'accept': None}], tag + ':established'),
                      access.rule(table, 'guard', [{'drop': None}], tag + ':deny')],
            'input': [access.rule(table, 'input', [access.meta('iifname', IFACE), {'jump': {'target': 'guard'}}], tag + ':input-interface'),
                      access.rule(table, 'input', [access.payload('ip', 'daddr', value['local']), {'jump': {'target': 'guard'}}], tag + ':input-address')],
            'forward': [access.rule(table, 'forward', [access.meta('iifname', IFACE), {'drop': None}], tag + ':no-forward-in'),
                        access.rule(table, 'forward', [access.meta('oifname', IFACE), {'drop': None}], tag + ':no-forward-out')]}


def schema(value, entries):
    access.identity(value, entries)
    table = next(item['table'] for item in entries if 'table' in item)
    access.require(access.normalized(table) == {'family': 'inet', 'name': value['nftTable']}, 'foreign owned table attributes')
    if value['role'] == 'core':
        # The shared module's fixed core/container selectors remain untouched.
        access.schema(value, entries)
        return
    chains, rules = {}, {}
    for entry in entries:
        kind, item = next(iter(entry.items()))
        if kind == 'table':
            continue
        access.require(kind in ('chain', 'rule') and item.get('family') == 'inet'
                       and item.get('table') == value['nftTable'], 'foreign owned-table schema')
        if kind == 'chain':
            access.require(item['name'] not in chains, 'duplicate owned chain')
            chains[item['name']] = access.normalized(item)
        else:
            rules.setdefault(item['chain'], []).append(item)
    wanted = native(value)
    access.require(set(chains) == set(rules) == set(wanted), 'owned edge chain schema mismatch')
    for name, expected in wanted.items():
        definition = {'family': 'inet', 'table': value['nftTable'], 'name': name}
        if name in ('input', 'forward'):
            definition.update(type='filter', hook=name, prio=-10, policy='accept')
        access.require(chains[name] == definition and access.comparable(rules[name]) == access.comparable(expected),
                       'owned edge guard schema mismatch')
    access.require(access.digest(entries) == value['nftHash'], 'owned table hash mismatch')


def baseline_unchanged(value, host):
    access.require(json.loads(host.command(['ip', '-j', 'route', 'show', 'default'])) == value['baseline']['default']
                   and json.loads(host.command(['ip', '-j', 'rule', 'show'])) == value['baseline']['rules'],
                   'default route or rules changed')


def verify_live(value, host):
    access.require(host.command([str(TOOLS / 'wg'), 'show', IFACE, 'public-key']).strip() == value['publicKey'],
                   'owned WG public identity changed')
    access.require(host.command([str(TOOLS / 'wg'), 'show', IFACE, 'allowed-ips']).split()
                   == [value['peerPublicKey'], value['peer'] + '/32'], 'owned WG peer scope changed')
    addresses = json.loads(host.command(['ip', '-j', 'address', 'show', 'dev', IFACE]))
    access.require(isinstance(addresses, list) and len(addresses) == 1 and isinstance(addresses[0], dict)
                   and addresses[0].get('ifname') == IFACE and isinstance(addresses[0].get('flags'), list)
                   and 'UP' in addresses[0]['flags'] and isinstance(addresses[0].get('addr_info'), list)
                   and all(isinstance(item, dict) for item in addresses[0]['addr_info'])
                   and [(item.get('family'), item.get('local'), item.get('prefixlen'))
                        for item in addresses[0]['addr_info']] == [('inet', value['local'], 32)],
                   'owned WG local address changed')
    routes = json.loads(host.command(['ip', '-j', 'route', 'show', 'dev', IFACE]))
    access.require(isinstance(routes, list) and len(routes) == 1 and isinstance(routes[0], dict)
                   and routes[0].get('dev', IFACE) == IFACE and routes[0].get('dst') in (value['peer'], value['peer'] + '/32')
                   and not routes[0].get('gateway'), 'owned WG route scope changed')
    route = json.loads(host.command(['ip', '-j', 'route', 'get', value['peer'], 'from', value['local']]))
    access.require(isinstance(route, list) and len(route) == 1 and isinstance(route[0], dict)
                   and route[0].get('dev') == IFACE, 'owned WG peer route changed')
    baseline_unchanged(value, host)


def bootstrap_commands(value):
    commands = [{'create': {'table': {'family': 'inet', 'name': value['nftTable']}}}]
    expected = native(value)
    for profile in value.get('profiles', {}):
        expected.update(access.rules(value, profile, False))
    for name, rules in expected.items():
        chain = {'family': 'inet', 'table': value['nftTable'], 'name': name}
        if name in ('input', 'forward'):
            chain.update(type='filter', hook=name, prio=-10, policy='accept')
        commands.append({'add': {'chain': chain}})
        commands.extend({'add': {'rule': rule}} for rule in rules)
    for profile in value.get('profiles', {}):
        commands.extend({'insert': {'rule': access.jump(value, profile, hook)}} for hook in ('input', 'forward'))
    return commands


def restore(store, nft, host=None):
    host = host or Host()
    value = store.load()
    validate_manifest(value)
    verify_files(value, host)
    baseline_unchanged(value, host)
    present, exists = host.table_exists(value['nftTable']), host.interface_exists()
    if present:
        schema(value, nft.snapshot(value['nftTable']))
        access.require(exists, 'WG interface absent while owned table retained; manual recovery required')
        access.require(value.get('up') is True and value.get('phase') == 'up',
                       'incomplete WG startup retained; manual recovery required')
        verify_live(value, host)
        schema(value, nft.snapshot(value['nftTable']))
        return {'ownedWgReady': True, 'interface': IFACE, 'peerOnly': True, 'liveStatePreserved': True}
    access.require(not exists, 'WG interface exists without approved guard; recovery refused')
    for entry in value.get('profiles', {}).values():
        entry.update(state='closed', lease=None)
    try:
        # create (not idempotent add) must fail atomically if another table appeared.
        nft.apply(bootstrap_commands(value))
        entries = nft.snapshot(value['nftTable'])
        tables = [item['table'] for item in entries if isinstance(item, dict) and 'table' in item]
        access.require(len(tables) == 1 and isinstance(tables[0], dict)
                       and type(tables[0].get('handle')) is int and tables[0]['handle'] > 0, 'invalid new owned table identity')
        value.update(nftIdentity=tables[0]['handle'], nftHash=access.digest(entries), up=False, phase='guarded')
        schema(value, entries)
        store.save(value)  # Shared Store retains root600, no-symlink and manifest CAS.
        verify_files(value, host)
        baseline_unchanged(value, host)
        schema(value, nft.snapshot(value['nftTable']))
        access.require(not host.interface_exists(), 'WG interface appeared during recovery')
        # Neither the wrapper nor the helper may clean up an interface by name.
        host.command(UP_COMMAND)
        verify_live(value, host)
        schema(value, nft.snapshot(value['nftTable']))
        value.update(up=True, phase='up')
        store.save(value)
    except FAILURES:
        # Name/existence/public-key checks cannot prove this invocation still owns an
        # interface. Do not set it down/delete it, run wg-quick down, retry a manifest
        # write, or delete any table. Any committed new backend guards remain closed;
        # a retained partial state is refused on the next invocation for manual review.
        raise access.Refused('owned WG recovery failed; no cleanup attempted; manual recovery required') from None
    return {'ownedWgReady': True, 'interface': IFACE, 'peerOnly': True, 'liveStatePreserved': False}


def main():
    def stop(_signal, _frame):
        raise priority.Stopped()
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, stop)
    try:
        access.require(os.geteuid() == 0, 'host root required')
        with priority.runtime_lock(access.LOCK, timeout=access.LOCK_TIMEOUT):
            value = restore(access.Store(), access.Nft())
        priority.emit('wg-restored', **value)
        return 0
    except FAILURES:
        priority.emit('refused', reason='owned WG recovery refused; no key/config/command output disclosed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
