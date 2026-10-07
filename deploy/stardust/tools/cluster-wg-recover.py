#!/usr/bin/env python3
"""Restore only the explicitly selected owned WG overlay behind a closed, CAS-pinned guard."""
import argparse
from dataclasses import dataclass, field
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_wg_host', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)
Refused = host.Refused
profiles = host.deploy.profiles
_BETA = profiles.get_profile()
# Preserve the historical import API; these aliases never change on profile calls.
IFACE, TABLE, OWNER = _BETA.wg_interface, _BETA.table('boot'), _BETA.wg_owner
CORE, EDGES, ENDPOINTS = _BETA.wg_core, _BETA.wg_peers, _BETA.endpoints
HEX = re.compile(r'[a-f0-9]{64}\Z')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def require(value, message):
    if not value:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def checked_path(path):
    try:
        return host.deploy.no_symlink(path)
    except host.deploy.Refused:
        raise Refused('unsafe WG path') from None


def protected(path, limit=65536):
    path = checked_path(path)
    for parent in path.parents:
        info = parent.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe WG metadata ancestor')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                and 0 < info.st_size <= limit, 'unsafe WG protected file')
        value = os.read(fd, limit + 1)
        require(len(value) == info.st_size, 'WG protected file changed')
        return value
    finally:
        os.close(fd)


def key_valid(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=', value):
        return False
    try:
        raw = base64.b64decode(value, validate=True)
        return len(raw) == 32 and base64.b64encode(raw).decode() == value
    except ValueError:
        return False


@dataclass(frozen=True)
class Configuration:
    directory: Path
    local: str
    public_fingerprint: str
    bootstrap_digest: str
    config_digest: str
    private: str = field(repr=False)
    peers: tuple = field(repr=False)
    raw_config: bytes = field(repr=False)
    profile: str = 'beta'

    @property
    def selected(self):
        return profiles.get_profile(self.profile)

    @property
    def addresses(self):
        return self.selected.wg_peers if self.local == self.selected.wg_core else (self.selected.wg_core,)

    @property
    def role(self):
        return 'core' if self.local == self.selected.wg_core else 'edge'


def load_configuration(directory, *, profile='beta'):
    p = profiles.get_profile(profile)
    require(profiles.path_allowed(directory, profile), 'cross-profile WG directory refused')
    directory = checked_path(directory)
    info = directory.stat()
    require(directory.is_absolute() and all(directory != repo and repo not in directory.parents for repo in host.deploy.FORBIDDEN_REPOS)
            and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'unsafe WG directory')
    try:
        owner = json.loads(protected(directory / 'owner.json', 4096))
        bootstrap = json.loads(protected(directory / 'bootstrap.json', 4096))
    except (ValueError, UnicodeError):
        raise Refused('invalid WG ownership metadata') from None
    require(isinstance(owner, dict) and set(owner) == {'owner', 'local', 'publicFingerprint'} | ({'profile'} if profile != 'beta' else set())
            and owner.get('profile', 'beta') == profile
            and owner['owner'] == p.wg_owner and owner['local'] in (p.wg_core, *p.wg_peers)
            and isinstance(owner['publicFingerprint'], str) and HEX.fullmatch(owner['publicFingerprint']), 'unapproved WG owner')
    require(isinstance(bootstrap, dict) and set(bootstrap) == {*owner, 'bootstrapNftSha256'}
            and all(bootstrap.get(key) == value for key, value in owner.items())
            and isinstance(bootstrap['bootstrapNftSha256'], str) and HEX.fullmatch(bootstrap['bootstrapNftSha256']), 'unapproved bootstrap metadata')
    raw = protected(directory / (p.wg_interface + '.conf'), 16384)
    try:
        text = raw.decode('ascii')
        private = protected(directory / 'private.key', 128).decode('ascii').strip()
    except UnicodeError:
        raise Refused('invalid WG configuration encoding') from None
    require(key_valid(private), 'invalid WG private file')
    sections, current = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line in ('[Interface]', '[Peer]'):
            current = {'section': line[1:-1]}
            sections.append(current)
            continue
        require(current is not None and '=' in line and len(line) < 256, 'invalid WG configuration line')
        name, value = (item.strip() for item in line.split('=', 1))
        require(name not in current and name in ('PrivateKey', 'ListenPort', 'PublicKey', 'AllowedIPs', 'Endpoint', 'PersistentKeepalive'), 'unknown WG configuration field')
        current[name] = value
    require(sections and set(sections[0]) == {'section', 'PrivateKey', 'ListenPort'}
            and sections[0]['section'] == 'Interface' and sections[0]['PrivateKey'] == private
            and sections[0]['ListenPort'] == str(p.wg_port), 'invalid WG interface configuration')
    addresses = p.wg_peers if owner['local'] == p.wg_core else (p.wg_core,)
    require(len(sections) == len(addresses) + 1, 'exact WG peer inventory required')
    peers = []
    for row, address in zip(sections[1:], addresses):
        keys = {'section', 'PublicKey', 'AllowedIPs'} | ({'Endpoint', 'PersistentKeepalive'} if owner['local'] == p.wg_core else set())
        require(set(row) == keys and row['section'] == 'Peer' and key_valid(row['PublicKey'])
                and row['AllowedIPs'] == address + '/32', 'invalid exact WG peer')
        if owner['local'] == p.wg_core:
            require(row['Endpoint'] == p.endpoints[address] and row['PersistentKeepalive'] == '25', 'unapproved WG endpoint')
        peers.append(dict(row))
    require(len({peer['PublicKey'] for peer in peers}) == len(peers), 'duplicate WG peer key')
    return Configuration(directory, owner['local'], owner['publicFingerprint'], bootstrap['bootstrapNftSha256'],
                         hashlib.sha256(raw).hexdigest(), private, tuple(peers), raw, profile)


def bootstrap_text(config):
    p = profiles.get_profile(config.profile)
    TABLE, IFACE = p.table('boot'), p.wg_interface
    members = ', '.join(config.addresses)
    # `create` (not idempotent `add`) refuses a foreign table appearing after preflight.
    return f'''create table inet {TABLE}
add chain inet {TABLE} input {{ type filter hook input priority -30; policy accept; }}
add chain inet {TABLE} forward {{ type filter hook forward priority -30; policy accept; }}
add rule inet {TABLE} input iifname "{IFACE}" ip saddr {{ {members} }} ip daddr {config.local} ip protocol icmp accept
add rule inet {TABLE} input iifname "{IFACE}" drop
add rule inet {TABLE} input ip daddr {config.local} drop
add rule inet {TABLE} forward iifname "{IFACE}" drop
add rule inet {TABLE} forward oifname "{IFACE}" drop
add rule inet {TABLE} forward ct original ip daddr {config.local} drop
'''


def legacy_digest(value):
    # Compatibility with the initial bootstrap metadata; no private WG config here.
    value = json.loads(json.dumps(value))
    for row in value.get('nftables', []):
        for item in row.values():
            if isinstance(item, dict):
                for name in ('handle', 'flags', 'use'):
                    item.pop(name, None)
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def entries(value):
    return None if value is None else [row for row in value['nftables'] if 'metainfo' not in row]


def bootstrap_handles(snapshot, *, profile='beta', local=None):
    p = profiles.get_profile(profile)
    TABLE = p.table('boot')
    rows = entries(snapshot)
    require(rows is not None and sum('table' in row for row in rows) == 1, 'bootstrap table unavailable')
    table = next(row['table'] for row in rows if 'table' in row)
    require(table.get('family') == 'inet' and table.get('name') == TABLE, 'bootstrap table identity changed')
    chains = {row['chain']['name']: row['chain'] for row in rows if 'chain' in row}
    require(set(chains) == {'input', 'forward'} and all(
        chain.get('family') == 'inet' and chain.get('table') == TABLE and chain.get('type') == 'filter'
        and chain.get('hook') == name and chain.get('prio') == -30 and chain.get('policy') == 'accept'
        for name, chain in chains.items()), 'bootstrap chain ownership changed')
    rules = [row['rule'] for row in rows if 'rule' in row]
    require(all(set(row) <= {'table', 'chain', 'rule'} for row in rows)
            and all(rule.get('family') == 'inet' and rule.get('table') == TABLE for rule in rules), 'unexpected bootstrap object')
    drops = [rule for rule in rules if any('drop' in expr for expr in rule.get('expr', []))]
    require(len(rules) == 6 and len(drops) == 5 and all(type(rule.get('handle')) is int for rule in drops), 'exact closed bootstrap rules required')
    for rule in rules:
        for expression in rule.get('expr', []):
            match = expression.get('match', {})
            left, right = match.get('left', {}), match.get('right')
            if left.get('meta', {}).get('key') in ('iifname', 'oifname'):
                require(right == p.wg_interface, 'cross-profile bootstrap interface refused')
            if left.get('payload', {}).get('field') in ('saddr', 'daddr') or left.get('ct', {}).get('key') in ('saddr', 'daddr', 'ip saddr', 'ip daddr'):
                addresses = right.get('set', []) if isinstance(right, dict) else [right]
                require(addresses and all(address in (p.wg_core, *p.wg_peers) for address in addresses), 'cross-profile bootstrap address refused')
    if profile == 'formal':
        # New Formal metadata cannot pin a broad or Beta-scoped bootstrap even if
        # its digest matches. The existing Beta adoption/signed-byte schema stays valid.
        local = local or next((expr['match']['right'] for rule in rules for expr in rule.get('expr', [])
                              if expr.get('match', {}).get('left') == host.ip('daddr')), None)
        require(local in (p.wg_core, *p.wg_peers), 'fixed bootstrap local required')
        peers = p.wg_peers if local == p.wg_core else (p.wg_core,)
        iface = lambda field: host.match({'meta': {'key': field}}, p.wg_interface)
        wanted = [
            ('input', [iface('iifname'), host.match(host.ip('saddr'), {'set': list(peers)}),
                       host.match(host.ip('daddr'), local), host.match(host.ip('protocol'), 'icmp'), {'accept': None}]),
            ('input', [iface('iifname'), {'drop': None}]),
            ('input', [host.match(host.ip('daddr'), local), {'drop': None}]),
            ('forward', [iface('iifname'), {'drop': None}]),
            ('forward', [iface('oifname'), {'drop': None}]),
            ('forward', [host.match({'ct': {'key': 'ip daddr', 'dir': 'original'}}, local), {'drop': None}]),
        ]
        def shape(expression):
            expression = json.loads(json.dumps(expression))
            match = expression.get('match', {})
            if match.get('left') == host.ct('daddr', 'original'):
                match['left'] = {'ct': {'key': 'ip daddr', 'dir': 'original'}}
            right = match.get('right')
            # Kernel nft emits a singleton literal set as its sole scalar. This
            # changes no accepted address; all addresses were checked above.
            if isinstance(right, dict) and set(right) == {'set'}:
                match['right'] = right['set'][0] if len(right['set']) == 1 else {'set': sorted(right['set'])}
            return expression
        observed = [(rule['chain'], [shape(expr) for expr in rule.get('expr', [])]) for rule in rules]
        wanted = [(chain, [shape(expr) for expr in expressions]) for chain, expressions in wanted]
        require(observed == wanted, 'exact Formal bootstrap scopes required')
    return [{'delete': {'rule': {'family': 'inet', 'table': TABLE, 'chain': row['chain'], 'handle': row['handle']}}} for row in drops]


class System:
    def __init__(self, nft=None, wg_binary=None, *, profile='beta'):
        self.selected = profiles.get_profile(profile)
        self.nft = nft or host.Nft()
        self.wg = str(wg_binary) if wg_binary is not None else next((name for name in ('/usr/bin/wg', '/opt/ark-wg-test/bin/wg') if Path(name).is_file()), None)
        self.ip = next((name for name in ('/usr/bin/ip', '/usr/sbin/ip') if Path(name).is_file() and not Path(name).is_symlink()), None)
        require(self.wg is not None and self.ip is not None, 'WG network binary unavailable')
        for file in (self.wg, self.ip, '/usr/sbin/nft'):
            info = checked_path(file).stat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe network binary')

    def command(self, args, data=None, *, max_bytes=65536):
        try:
            result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=8, env=ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise Refused('fixed WG operation unavailable') from None
        require(result.returncode == 0 and len(result.stdout) <= max_bytes, 'fixed WG operation failed')
        return result.stdout

    def boot_id(self):
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        require(re.fullmatch(r'[a-f0-9-]{36}', value), 'invalid boot identity')
        return value

    def snapshot(self):
        raw = self.nft.command(['-a', '-j', 'list', 'table', 'inet', self.selected.table('boot')], missing=True)
        return json.loads(raw) if raw is not None else None

    def create_bootstrap(self, config):
        require(config.profile == self.selected.name, 'WG system profile mismatch')
        require(self.snapshot() is None, 'bootstrap table appeared concurrently')
        text = bootstrap_text(config)
        self.nft.command(['--check', '-f', '-'], text)
        self.nft.command(['-f', '-'], text)

    def exists(self):
        try:
            result = subprocess.run([self.ip, '-j', 'link', 'show', 'dev', self.selected.wg_interface], capture_output=True, text=True, timeout=8, env=ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise Refused('WG interface query unavailable') from None
        if result.returncode:
            require(result.stderr.strip() in (f'Device "{self.selected.wg_interface}" does not exist.', f'Cannot find device "{self.selected.wg_interface}"'), 'WG interface query failed')
            return False
        require(len(result.stdout) <= 65536, 'WG interface query oversized')
        values = json.loads(result.stdout)
        require(len(values) == 1 and values[0].get('ifname') == self.selected.wg_interface, 'WG interface query changed')
        return True

    def preflight_absent(self, config):
        require(config.profile == self.selected.name, 'WG system profile mismatch')
        addresses = json.loads(self.command([self.ip, '-j', 'address', 'show'], max_bytes=1048576))
        require(not any(item.get('local') == config.local for row in addresses for item in row.get('addr_info', [])), 'WG local address already owned elsewhere')
        for address in config.addresses:
            raw = self.command([self.ip, '-j', 'route', 'show', 'table', 'all', 'exact', address + '/32'])
            require(json.loads(raw) == [], 'WG peer route already owned elsewhere')

    def configure(self, config):
        require(config.profile == self.selected.name, 'WG system profile mismatch')
        self.command([self.ip, 'link', 'add', 'dev', self.selected.wg_interface, 'type', 'wireguard'])
        # Pass the already-validated snapshot in memory, never reopen a mutable path.
        self.command([self.wg, 'setconf', self.selected.wg_interface, '/dev/stdin'], config.raw_config.decode('ascii'))
        self.command([self.ip, 'address', 'add', config.local + '/32', 'dev', self.selected.wg_interface])
        self.command([self.ip, 'link', 'set', 'dev', self.selected.wg_interface, 'mtu', '1420'])
        self.command([self.ip, 'link', 'set', 'dev', self.selected.wg_interface, 'up'])
        for address in config.addresses:
            self.command([self.ip, 'route', 'add', address + '/32', 'dev', self.selected.wg_interface])

    def verify(self, config):
        require(config.profile == self.selected.name, 'WG system profile mismatch')
        public = self.command([self.wg, 'pubkey'], config.private + '\n').strip()
        require(key_valid(public) and hashlib.sha256(public.encode()).hexdigest() == config.public_fingerprint, 'private/public WG identity mismatch')
        current = self.command([self.wg, 'show', self.selected.wg_interface, 'public-key']).strip()
        require(current == public and self.command([self.wg, 'show', self.selected.wg_interface, 'listen-port']).strip() == str(self.selected.wg_port)
                and self.command([self.wg, 'show', self.selected.wg_interface, 'fwmark']).strip() in ('off', '0'), 'live WG interface identity changed')
        links = json.loads(self.command([self.ip, '-d', '-j', 'address', 'show', 'dev', self.selected.wg_interface]))
        require(len(links) == 1 and links[0].get('ifname') == self.selected.wg_interface and links[0].get('mtu') == 1420
                and 'UP' in links[0].get('flags', []) and links[0].get('linkinfo', {}).get('info_kind') == 'wireguard'
                and [(row.get('family'), row.get('local'), row.get('prefixlen')) for row in links[0].get('addr_info', [])]
                == [('inet', config.local, 32)], 'live WG link/address changed')
        values = {}
        for name in ('allowed-ips', 'persistent-keepalive', 'endpoints'):
            parsed = {}
            for line in self.command([self.wg, 'show', self.selected.wg_interface, name]).splitlines():
                key, separator, value = line.partition('\t')
                require(separator and key_valid(key) and key not in parsed, 'invalid live WG peer metadata')
                parsed[key] = value.strip()
            values[name] = parsed
        wanted = {peer['PublicKey']: peer['AllowedIPs'] for peer in config.peers}
        require(values['allowed-ips'] == wanted and all(set(rows) == set(wanted) for rows in values.values()), 'live WG peer roster changed')
        for peer in config.peers:
            key = peer['PublicKey']
            require(values['persistent-keepalive'][key] == ('25' if config.role == 'core' else 'off'), 'live WG keepalive changed')
            if config.role == 'core':
                require(values['endpoints'][key] == peer['Endpoint'], 'live WG core endpoint changed')
        routes = json.loads(self.command([self.ip, '-j', 'route', 'show', 'dev', self.selected.wg_interface]))
        require(len(routes) == len(config.addresses) and {row.get('dst').removesuffix('/32') for row in routes} == set(config.addresses)
                and all(row.get('scope') == 'link' and not row.get('gateway') for row in routes), 'live WG peer routes changed')
        for address in config.addresses:
            routes = json.loads(self.command([self.ip, '-j', 'route', 'get', address]))
            require(len(routes) == 1 and routes[0].get('dev') == self.selected.wg_interface and routes[0].get('dst') == address
                    and routes[0].get('prefsrc', routes[0].get('src')) == config.local, 'live WG route selection changed')


class ManagerProof:
    def __init__(self, config, file=None):
        self.config, self.file = config, file or str(config.selected.policy_file)
        require(profiles.path_allowed(self.file, config.profile), 'cross-profile manager policy refused')

    def check(self, closed):
        policy = host.load_policy(self.file, profile=self.config.profile)
        require(policy['host_role'] == self.config.role and policy['wg_local'] == self.config.local
                and policy['wg_interface'] == self.config.selected.wg_interface and policy['wg_peers'] == list(self.config.addresses), 'manager WG ownership mismatch')
        guard = host.Guard(policy)
        state = guard.state()
        require(type(state.get('version')) is int and state['version'] == 1 and isinstance(state.get('leases'), dict), 'manager lease state unavailable')
        guard.check({} if closed else state['leases'])
        if closed:
            require(not any(row.get('rule', {}).get('chain') == 'lease' for row in guard.nft.snapshot(guard.table)), 'manager lease chain is open')
        return {'project': policy['project'], 'state': state, 'policy': policy}

    def lock(self):
        policy = host.load_policy(self.file, profile=self.config.profile)
        return host.priority.runtime_lock('/run/' + policy['project'] + '.lock', timeout=1)


class Recovery:
    def __init__(self, config, system=None, manager=None):
        self.config, self.system = config, system or System(profile=config.profile)
        self.manager = manager or ManagerProof(config)
        self.state_file = config.directory / 'recovery.json'

    def state(self):
        if not self.state_file.exists() and not self.state_file.is_symlink():
            return None
        value = json.loads(protected(self.state_file, 4096))
        fields = {'version', 'owner', 'local', 'config_sha256', 'public_fingerprint', 'boot_id', 'bootstrap_sha256', 'phase'} | ({'profile'} if self.config.profile != 'beta' else set())
        require(isinstance(value, dict) and set(value) <= fields | {'manager_project'} and fields <= set(value)
                and type(value['version']) is int and value['version'] == 1 and value.get('profile', 'beta') == self.config.profile
                and value['owner'] == self.config.selected.wg_owner and value['local'] == self.config.local
                and value['config_sha256'] == self.config.config_digest and value['public_fingerprint'] == self.config.public_fingerprint
                and value['phase'] in ('closed', 'handed_off') and HEX.fullmatch(str(value['bootstrap_sha256']))
                and re.fullmatch(r'[a-f0-9-]{36}', str(value['boot_id'])), 'WG recovery identity changed')
        return value

    def save(self, value, before):
        require(self.state() == before, 'WG recovery state changed concurrently')
        fd, name = tempfile.mkstemp(prefix='.recovery-', dir=self.config.directory)
        try:
            with os.fdopen(fd, 'wb') as file:
                os.fchmod(file.fileno(), 0o600)
                file.write(canonical(value)); file.flush(); os.fsync(file.fileno())
            require(self.state() == before, 'WG recovery state changed before publication')
            os.replace(name, self.state_file)
            fd = os.open(self.config.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def make_state(self, snapshot):
        return {'version': 1, **({'profile': self.config.profile} if self.config.profile != 'beta' else {}), 'owner': self.config.selected.wg_owner, 'local': self.config.local, 'config_sha256': self.config.config_digest,
                'public_fingerprint': self.config.public_fingerprint, 'boot_id': self.system.boot_id(),
                'bootstrap_sha256': host.digest(entries(snapshot)), 'phase': 'closed'}

    def verify_guard(self, state, *, adopt=False):
        snapshot = self.system.snapshot()
        require(snapshot is not None, 'owned bootstrap guard disappeared')
        if state is None:
            require(adopt and legacy_digest(snapshot) == self.config.bootstrap_digest, 'unowned bootstrap table refused')
            bootstrap_handles(snapshot, profile=self.config.profile, local=self.config.local)
            return snapshot
        require(state['boot_id'] == self.system.boot_id() and host.digest(entries(snapshot)) == state['bootstrap_sha256'], 'bootstrap ownership drifted')
        if state['phase'] == 'closed':
            bootstrap_handles(snapshot, profile=self.config.profile, local=self.config.local)
        else:
            require(not any('drop' in expr for row in entries(snapshot) for expr in row.get('rule', {}).get('expr', [])), 'handed-off bootstrap guard changed')
            proof = self.manager.check(False)
            require(proof['project'] == state.get('manager_project'), 'handed-off manager changed')
        return snapshot

    def current_config(self):
        require(load_configuration(self.config.directory, profile=self.config.profile) == self.config, 'WG configuration changed during recovery')

    def check(self):
        self.current_config()
        state = self.state()
        require(state is not None and self.system.exists(), 'WG recovery was not initialized')
        self.verify_guard(state)
        self.system.verify(self.config)
        return {'event': 'cluster-wg-checked', 'role': self.config.role, 'phase': state['phase'], 'changed': False}

    def start(self):
        self.current_config()
        before, present = self.state(), self.system.exists()
        if present:
            snapshot = self.verify_guard(before, adopt=True)
            self.system.verify(self.config)
            if before is None:
                self.save(self.make_state(snapshot), None)
            return {'event': 'cluster-wg-ready', 'role': self.config.role, 'changed': False}
        require(before is None or before['boot_id'] != self.system.boot_id() or before['phase'] == 'closed', 'missing active WG interface requires manual recovery')
        snapshot = self.system.snapshot()
        if snapshot is None:
            self.system.create_bootstrap(self.config)  # MUST precede all interface/address/route creation.
            snapshot = self.system.snapshot()
        else:
            require((before is not None and before['phase'] == 'closed' and host.digest(entries(snapshot)) == before['bootstrap_sha256'])
                    or legacy_digest(snapshot) == self.config.bootstrap_digest, 'foreign bootstrap table refused')
        bootstrap_handles(snapshot, profile=self.config.profile, local=self.config.local)
        state = self.make_state(snapshot)
        self.save(state, before)
        self.system.preflight_absent(self.config)
        self.current_config()
        self.system.configure(self.config)
        self.system.verify(self.config)
        self.verify_guard(state)
        return {'event': 'cluster-wg-ready', 'role': self.config.role, 'changed': True}

    def handoff(self):
        # Same writer lock as the manager. A live manager cannot have its leases reset here.
        with self.manager.lock():
            self.current_config()
            state = self.state()
            require(state is not None and self.system.exists(), 'WG recovery not ready for handoff')
            self.system.verify(self.config)
            proof = self.manager.check(True)
            snapshot = self.verify_guard(state)
            if state['phase'] == 'handed_off':
                require(proof['project'] == state.get('manager_project'), 'handoff manager ownership changed')
                return {'event': 'cluster-wg-handed-off', 'role': self.config.role, 'changed': False}
            commands = bootstrap_handles(snapshot, profile=self.config.profile, local=self.config.local)
            self.current_config()
            require(self.state() == state and self.manager.check(True) == proof
                    and host.digest(entries(self.system.snapshot())) == state['bootstrap_sha256'], 'guard changed before handoff')
            self.system.nft.apply(commands)  # One atomic transaction, exact five unchanged DROP handles only.
            after = self.system.snapshot()
            wanted = [row for row in entries(snapshot) if not any('drop' in expr for expr in row.get('rule', {}).get('expr', []))]
            require(host.digest(entries(after)) == host.digest(wanted) and self.manager.check(True) == proof, 'guard changed during handoff')
            self.save({**state, 'phase': 'handed_off', 'bootstrap_sha256': host.digest(entries(after)), 'manager_project': proof['project']}, state)
            return {'event': 'cluster-wg-handed-off', 'role': self.config.role, 'changed': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(profiles.PROFILES))
    parser.add_argument('--directory')
    parser.add_argument('--manager-policy')
    parser.add_argument('--action', required=True, choices=('start', 'check', 'handoff'))
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'host root required')
        selected = profiles.get_profile(args.profile)
        config = load_configuration(args.directory or selected.wg_directory, profile=args.profile)
        recovery = Recovery(config, manager=ManagerProof(config, args.manager_policy or str(selected.policy_file)))
        # Separate WG metadata writer lock; manager lock is acquired only for explicit handoff.
        with host.priority.runtime_lock('/run/ark-cluster-' + args.profile + '-wg.lock', timeout=1):
            result = getattr(recovery, args.action)()
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, host.deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        print(json.dumps({'event': 'cluster-wg-refused', 'reason': 'fixed owned WG recovery refused; no secrets or command output disclosed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
