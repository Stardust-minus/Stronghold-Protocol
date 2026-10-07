#!/usr/bin/env python3
"""Root-only fixed-profile cluster lifecycle, precise WG leases and main-TID policy."""
import argparse
from dataclasses import asdict, dataclass
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_priority', BASE / 'main-thread-priority.py')
priority = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = priority
spec.loader.exec_module(priority)
spec = importlib.util.spec_from_file_location('cluster_deploy', BASE / 'cluster-deploy.py')
deploy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = deploy
spec.loader.exec_module(deploy)
Refused, NotReady, Stopped = priority.Refused, priority.NotReady, priority.Stopped
ENV = priority.DOCKER_ENV
PROTOCOL = 1
LIMIT = 65536


def require(ok, diagnostic):
    if not ok:
        raise Refused(diagnostic)


def protected_read(path, *, exact_bytes=None, private=False):
    path = deploy.no_symlink(path)
    for parent in path.parents:
        info = parent.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe protected file parent')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o027
                and 0 < info.st_size <= LIMIT and (not private or stat.S_IMODE(info.st_mode) == 0o600)
                and (exact_bytes is None or info.st_size == exact_bytes), 'unsafe protected file')
        raw = os.read(fd, LIMIT + 1)
        require(len(raw) == info.st_size, 'protected file changed during read')
        return raw
    finally:
        os.close(fd)


def protected_json(path, *, private=False):
    try:
        return json.loads(protected_read(path, private=private))
    except (ValueError, UnicodeError):
        raise Refused('invalid protected policy JSON') from None


def parse_policy(value, *, profile='beta'):
    p = deploy.profiles.get_profile(profile)
    require(isinstance(value, dict) and set(value) == {
        'version', 'namespace', 'host_role', 'entry', 'source_kind', 'build', 'manifest_sha256',
        'image_id', 'bundle', 'compose_file', 'compose_sha256', 'project', 'subnet',
        'wg_interface', 'wg_local', 'wg_peers', 'origin', 'targets'}, 'invalid cluster policy fields')
    role, entry = value['host_role'], value['entry']
    require(type(value['version']) is int and value['version'] == 1 and value['namespace'] == p.name
            and role in ('core', 'edge') and type(entry) is int and entry in range(1, 5), 'invalid fixed cluster role')
    require(value['source_kind'] in ('commit', 'tree') and deploy.HEX40.fullmatch(str(value['build']))
            and deploy.HEX64.fullmatch(str(value['manifest_sha256']))
            and (value['source_kind'] != 'tree' or value['build'] == value['manifest_sha256'][:40])
            and deploy.IMAGE.fullmatch(str(value['image_id']))
            and deploy.HEX64.fullmatch(str(value['compose_sha256'])), 'invalid immutable source identity')
    bundle = Path(value['bundle'])
    require(bundle.is_absolute() and str(bundle) == os.path.abspath(bundle)
            and all(bundle != repo and repo not in bundle.parents for repo in deploy.FORBIDDEN_REPOS)
            and deploy.profiles.path_allowed(bundle, profile)
            and value['compose_file'] == str(bundle / 'compose.json'), 'invalid protected bundle location')
    project = p.core_project if role == 'core' else p.edge_project(entry)
    require(value['project'] == project and value['subnet'] == (p.core_subnet if role == 'core' else p.edge_subnet)
            and value['wg_interface'] == p.wg_interface and value['origin'] == p.origin
            and value['wg_local'] == (p.wg_core if role == 'core' else p.wg_peers[entry - 1])
            and value['wg_peers'] == (list(p.wg_peers) if role == 'core' else [p.wg_core]), 'fixed cluster network required')
    targets = value['targets']
    require(isinstance(targets, list) and len(targets) == (17 if role == 'core' else 1), 'fixed target inventory required')
    expected_services = {'coordinator', *('game-' + format(index, '02d') for index in range(1, 17))} if role == 'core' else {'ingress'}
    require({row.get('service') for row in targets if isinstance(row, dict)} == expected_services, 'fixed target services required')
    for row in targets:
        require(isinstance(row, dict), 'invalid target')
        service = row['service']
        is_game = service.startswith('game-')
        wanted_role = 'game' if is_game else service
        required = {'role', 'project', 'service', 'container_name', 'container_ip', 'mappings', 'runtime_file',
                    'runtime_sha256', 'combat_workers', 'trial_workers'} | ({'node_id', 'key_file', 'public_slot'} if is_game else set())
        require(set(row) == required and row['role'] == wanted_role and row['project'] == project
                and row['container_name'] == project + '-' + service
                and deploy.HEX64.fullmatch(str(row['runtime_sha256']))
                and row['runtime_file'] == str(bundle / 'runtime' / service / 'runtime.json')
                and type(row['combat_workers']) is int and type(row['trial_workers']) is int
                and (row['combat_workers'], row['trial_workers']) == ((8, 2) if is_game else (0, 0)), 'invalid fixed target identity')
        if is_game:
            index = int(service[5:])
            require(row['node_id'] == service and type(row['public_slot']) is int and row['public_slot'] == index
                    and row['key_file'] == str(bundle / 'keys' / (service + '.key')), 'invalid node key or slot binding')
            ip, port = p.core_ip(10 + index), p.game_first_port + index - 1
        elif service == 'coordinator':
            ip, port = p.core_ip(2), p.coordinator_port
        else:
            ip, port = p.edge_ip, p.ingress_port
        maps = [{'container_port': 3000, 'host_ip': host, 'host_port': port}
                for host in (('127.0.0.1', p.wg_core) if role == 'core' else ('127.0.0.1',))]
        if service == 'coordinator':
            maps.append({'container_port': 3001, 'host_ip': '127.0.0.1', 'host_port': p.end_port})
        require(row['container_ip'] == ip and row['mappings'] == maps, 'fixed port and address mappings required')
    return value


def load_policy(file, *, profile='beta'):
    require(deploy.profiles.path_allowed(Path(file), profile), 'cross-profile policy path refused')
    policy = parse_policy(protected_json(file, private=True), profile=profile)
    raw = protected_read(policy['compose_file'], private=True)
    require(hashlib.sha256(raw).hexdigest() == policy['compose_sha256'], 'Compose identity changed')
    compose = json.loads(raw)
    require(compose.get('name') == policy['project'] and set(compose.get('services', {})) == {row['service'] for row in policy['targets']}
            and compose.get('networks') == deploy.network(policy['subnet']), 'fixed Compose inventory required')
    for row in policy['targets']:
        current = protected_read(row['runtime_file'])
        require(hashlib.sha256(current).hexdigest() == row['runtime_sha256'], 'runtime configuration identity changed')
        directory = Path(row['runtime_file']).parent
        keys = ()
        if row['role'] == 'game':
            protected_read(row['key_file'], exact_bytes=32)
            keys = (row['key_file'] + ':/run/secrets/game.key:ro',)
        elif row['role'] == 'coordinator':
            for index in range(1, 17):
                protected_read(Path(policy['bundle']) / 'keys' / ('game-' + format(index, '02d') + '.key'), exact_bytes=32)
            keys = (str(Path(policy['bundle']) / 'keys') + ':/run/secrets:ro',)
        expected = deploy.service(row['role'], row['container_name'], directory,
                                  image=policy['image_id'], build=policy['build'], kind=policy['source_kind'],
                                  manifest=policy['manifest_sha256'], profile=profile, ip=row['container_ip'],
                                  ports=[f'{item["host_ip"]}:{item["host_port"]}:{item["container_port"]}' for item in row['mappings']],
                                  secrets_mounts=keys)
        require(compose['services'][row['service']] == expected, 'Compose service differs from fixed security baseline')
    return policy


@dataclass(frozen=True)
class Config:
    policy: dict
    target: dict
    nice: int = -20
    startup_timeout_seconds: int = 90

    @property
    def worker_count(self):
        return self.combat_workers + self.trial_workers

    @property
    def combat_workers(self):
        return self.target['combat_workers']

    @property
    def trial_workers(self):
        return self.target['trial_workers']

    @property
    def container_name(self):
        return self.target['container_name']


def bridge_ipam_matches(value, subnet, *, profile='beta'):
    p = deploy.profiles.get_profile(profile)
    if subnet not in (p.core_subnet, p.edge_subnet) or not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        return False
    row = dict(value[0])
    # Docker API versions differ only in whether the unset allocation range is
    # omitted or emitted as an empty string. Never erase a real range/extra field.
    if row.get('IPRange') == '':
        row.pop('IPRange')
    return row == {'Subnet': subnet, 'Gateway': subnet.split('/')[0].rsplit('.', 1)[0] + '.1'}


def runtime_health_ready(value, target, build):
    if target['role'] == 'game':
        if not isinstance(value, dict) or value.get('nodeId') != target['node_id'] or value.get('build') != build \
                or type(value.get('publicSlot')) is not int or value['publicSlot'] != target['public_slot'] \
                or type(value.get('protocol')) is not int or value['protocol'] != PROTOCOL or value.get('ready') is not True or value.get('streamMarkers') is not True \
                or not isinstance(value.get('generation'), str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}', value['generation']):
            return False
        health = value.get('health')
        return isinstance(health, dict) and all(
            isinstance(health.get(name), dict) and health[name].get('status') == 'ready'
            and type(health[name].get('workers')) is int and type(health[name].get('ready')) is int
            and health[name]['workers'] == count and health[name]['ready'] == count
            for name, count in (('combat', 8), ('trial', 2)))
    if target['role'] == 'coordinator':
        return (isinstance(value, dict) and value.get('ok') is True and type(value.get('version')) is int and value['version'] == PROTOCOL
                and type(value.get('maxRooms')) is int and value['maxRooms'] == 0
                and isinstance(value.get('combat'), dict) and value['combat'].get('backend') == 'inline'
                and type(value['combat'].get('workers')) is int and value['combat']['workers'] == 0 and isinstance(value.get('trial'), dict)
                and type(value['trial'].get('workers')) is int and value['trial']['workers'] == 0 and value['trial'].get('status') == 'disabled')
    # A relay has no public/native HTTP health API. This is listener readiness, not TLS/password acceptance.
    return value == {'http_status': 404, 'websocket_upgrade': True}


class System(priority.System):
    def __init__(self, config):
        super().__init__(config)
        self.node_generation = None
        self.last_info = None
        self.image_cache, self.network_cache = {}, {}

    def inspect(self, target, *, allow_stopped=False):
        row, policy = self.config.target, self.config.policy
        info = self.docker('container', 'inspect', '--format', priority.formatter({
            **priority.INSPECT_FIELDS, 'all_ports': '.NetworkSettings.Ports', 'port_bindings': '.HostConfig.PortBindings', 'networks': '.NetworkSettings.Networks',
            'restart_policy': '.HostConfig.RestartPolicy', 'mounts': '.Mounts', 'cmd': '.Config.Cmd', 'user': '.Config.User',
            'role': '(index .Config.Labels "cn.stardust.cluster.role")',
            'namespace': '(index .Config.Labels "cn.stardust.cluster.namespace")',
            'kind': '(index .Config.Labels "cn.stardust.cluster.source-kind")',
            'manifest': '(index .Config.Labels "cn.stardust.cluster.manifest-sha256")'}), target)
        require(priority.CID.fullmatch(str(info.get('id', ''))) and (not priority.CID.fullmatch(target) or info['id'] == target), 'container identity mismatch')
        image = self.image_cache.get(policy['image_id'])
        if image is None:
            image = self.docker('image', 'inspect', '--format', priority.formatter({**priority.IMAGE_FIELDS,
                'kind': '(index .Config.Labels "cn.stardust.cluster.source-kind")',
                'manifest': '(index .Config.Labels "cn.stardust.cluster.manifest-sha256")'}), policy['image_id'])
            self.image_cache[policy['image_id']] = image
        require(info.get('name') == '/' + row['container_name'] and info.get('project') == row['project']
                and info.get('service') == row['service'] and info.get('role') == row['role'] and info.get('namespace') == policy['namespace']
                and info.get('source') == deploy.SOURCE and info.get('revision') == policy['build']
                and info.get('kind') == policy['source_kind'] and info.get('manifest') == policy['manifest_sha256']
                and info.get('image_id') == policy['image_id'] and image.get('id') == policy['image_id']
                and image.get('source') == deploy.SOURCE and image.get('revision') == policy['build']
                and image.get('kind') == policy['source_kind'] and image.get('manifest') == policy['manifest_sha256'], 'container source/image/role not approved')
        stopped = info.get('running') is False and info.get('restarting') is False and info.get('pid') == 0
        if not (allow_stopped and stopped) and (info.get('running') is not True or info.get('restarting') is not False
                                               or type(info.get('pid')) is not int or info['pid'] <= 0):
            raise NotReady('owned role not running')
        require(info.get('init') is True and info.get('readonly') is True and info.get('privileged') is False
                and set(info.get('cap_drop') or []) == {'ALL'} and not info.get('cap_add')
                and set(info.get('security_opt') or []) & {'no-new-privileges', 'no-new-privileges:true'}
                and info.get('pids') == 128 and info.get('user') == '1000:1000'
                and info.get('restart_policy') == {'Name': 'no', 'MaximumRetryCount': 0}
                and info.get('cmd') == ['node', 'server/cluster/start.mjs', '--config', '/run/config/runtime.json']
                and all(info.get(field) == 0 for field in ('cpu_quota', 'nano_cpus', 'memory'))
                and info.get('cpuset') == '', 'role security/resource baseline mismatch')
        ports = {}
        for item in row['mappings']:
            ports.setdefault(str(item['container_port']) + '/tcp', []).append({'HostIp': item['host_ip'], 'HostPort': str(item['host_port'])})
        actual = info.get('port_bindings') if stopped else info.get('all_ports')
        require(isinstance(actual, dict) and set(actual) == set(ports)
                and all(sorted(actual[key] or [], key=lambda item: (item.get('HostIp', ''), item.get('HostPort', '')))
                        == sorted(rows, key=lambda item: (item['HostIp'], item['HostPort'])) for key, rows in ports.items()), 'exact role port mapping required')
        networks = info.get('networks')
        require(isinstance(networks, dict) and set(networks) == {row['project'] + '_default'}, 'single fixed bridge required')
        net = networks[row['project'] + '_default']
        require(isinstance(net, dict) and (stopped and not net.get('IPAddress') or net.get('IPAddress') == row['container_ip'])
                and (stopped or net.get('IPPrefixLen') == 24) and not net.get('GlobalIPv6Address')
                and isinstance(net.get('IPAMConfig'), dict) and net['IPAMConfig'].get('IPv4Address') == row['container_ip']
                and (stopped or priority.CID.fullmatch(str(net.get('NetworkID', '')))), 'fixed container network identity required')
        network_target = row['project'] + '_default' if stopped else net['NetworkID']
        network = self.network_cache.get(network_target)
        if network is None:
            network = self.docker('network', 'inspect', '--format', priority.formatter({
                'id': '.Id', 'driver': '.Driver', 'ipam': '.IPAM.Config', 'labels': '.Labels', 'options': '.Options'}), network_target)
            if not stopped:
                self.network_cache[network_target] = network
        require(priority.CID.fullmatch(str(network.get('id', ''))) and (stopped or network.get('id') == net['NetworkID'])
                and network.get('driver') == 'bridge' and network.get('options') in (None, {})
                and bridge_ipam_matches(network.get('ipam'), policy['subnet'], profile=policy['namespace'])
                and isinstance(network.get('labels'), dict)
                and network['labels'].get('com.docker.compose.project') == row['project']
                and network['labels'].get('com.docker.compose.network') == 'default', 'fixed bridge subnet required')
        mounts = info.get('mounts')
        expected = {(str(Path(row['runtime_file']).parent), '/run/config')}
        if row['role'] == 'game':
            expected.add((row['key_file'], '/run/secrets/game.key'))
        elif row['role'] == 'coordinator':
            expected.add((str(Path(policy['bundle']) / 'keys'), '/run/secrets'))
        require(isinstance(mounts, list) and len(mounts) == len(expected)
                and all(item.get('Type') == 'bind' and item.get('RW') is False for item in mounts)
                and {(item.get('Source'), item.get('Destination')) for item in mounts} == expected, 'exact read-only role mounts required')
        require(hashlib.sha256(protected_read(row['runtime_file'])).hexdigest() == row['runtime_sha256'], 'runtime config identity changed')
        # Docker classic assembles Mounts from a map; identical bind mounts may
        # appear in different order between reads. Keep every validated row/field,
        # canonicalizing only this unordered collection before generation fencing.
        self.last_info = {**info, 'mounts': sorted(mounts, key=lambda item: (item['Destination'], item['Source'])),
                          'network_id': network['id'], 'ip': row['container_ip']}
        return self.last_info

    def health(self):
        target = self.config.target
        port = next(item['host_port'] for item in target['mappings'] if item['host_ip'] == '127.0.0.1' and item['container_port'] == 3000)
        try:
            if target['role'] == 'game':
                key = protected_read(target['key_file'], exact_bytes=32)
                request_id, nonce, timestamp = secrets.token_hex(16), secrets.token_hex(16), str(time.time_ns() // 1_000_000)
                body = json.dumps({'id': request_id, 'op': 'status', 'payload': {}}, separators=(',', ':')).encode()
                prefix = f'stronghold-rpc-v1\nPOST\n/_cluster/rpc\n{target["node_id"]}\n{timestamp}\n{nonce}\n'
                mac = hmac.new(key, prefix.encode() + hashlib.sha256(body).hexdigest().encode(), hashlib.sha256).hexdigest()
                headers = {'content-type': 'application/json', 'x-ark-cluster-scope': target['node_id'],
                           'x-ark-cluster-time': timestamp, 'x-ark-cluster-nonce': nonce, 'x-ark-cluster-signature': mac}
                status, raw = http_request(port, 'POST', '/_cluster/rpc', body, headers)
                reply = json.loads(raw)
                require(status == 200 and isinstance(reply, dict) and reply.get('ok') is True and reply.get('id') == request_id,
                        'private health authentication/reply refused')
                value = reply.get('value')
                if runtime_health_ready(value, target, self.config.policy['build']):
                    self.node_generation = value['generation']
            elif target['role'] == 'coordinator':
                status, raw = http_request(port, 'GET', '/healthz')
                require(status == 200, 'coordinator health unavailable')
                value = json.loads(raw)
            else:
                status, _ = http_request(port, 'GET', '/healthz')
                value = {'http_status': status, 'websocket_upgrade': websocket_upgrade(port, self.config.policy['origin'])}
            if not runtime_health_ready(value, target, self.config.policy['build']):
                raise NotReady('exact role health not ready')
        except (OSError, ValueError, http.client.HTTPException):
            raise NotReady('role health transport unavailable') from None


def http_request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read(LIMIT + 1)
        require(len(raw) <= LIMIT, 'role health reply exceeds bound')
        return response.status, raw
    finally:
        connection.close()


def websocket_upgrade(port, origin):
    # Test a protocol upgrade only; no hello, session, ticket, Cookie or game intent.
    import base64
    nonce = base64.b64encode(secrets.token_bytes(16)).decode()
    expected = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request('GET', '/ws', headers={'Origin': origin, 'Connection': 'Upgrade', 'Upgrade': 'websocket',
                                                'Sec-WebSocket-Key': nonce, 'Sec-WebSocket-Version': '13'})
        response = connection.getresponse()
        return response.status == 101 and response.getheader('Sec-WebSocket-Accept') == expected
    finally:
        connection.close()


def match(left, right, op='=='):
    return {'match': {'op': op, 'left': left, 'right': right}}


def ip(field):
    return {'payload': {'protocol': 'ip', 'field': field}}


def tcp(field):
    return {'payload': {'protocol': 'tcp', 'field': field}}


def ct(field, direction=None):
    return {'ct': {'key': field, **({'dir': direction} if direction else {}), **({'family': 'ip'} if field in ('saddr', 'daddr') else {})}}


def rule(table, chain, expressions):
    # libnftables requires explicit protocol context before ORIGINAL tuple fields;
    # IPv4 payload comparisons alone do not establish it on every shipped version.
    contexts = []
    lefts = [item.get('match', {}).get('left', {}) for item in expressions]
    if any(left.get('payload', {}).get('protocol') == 'ip' or left.get('ct', {}).get('family') == 'ip' for left in lefts):
        contexts.append(match({'meta': {'key': 'nfproto'}}, 'ipv4'))
    if any(left.get('payload', {}).get('protocol') == 'tcp' or left.get('ct', {}).get('key') in ('proto-src', 'proto-dst') for left in lefts):
        contexts.append(match({'meta': {'key': 'l4proto'}}, 'tcp'))
    return {'rule': {'family': 'inet', 'table': table, 'chain': chain, 'expr': [*contexts, *expressions]}}


def table_name(policy):
    return deploy.profiles.get_profile(policy['namespace']).table(policy['host_role'])


def base_rules(policy):
    p = deploy.profiles.get_profile(policy['namespace'])
    parse_policy(policy, profile=p.name)
    table, iface, local, peers = table_name(policy), policy['wg_interface'], policy['wg_local'], policy['wg_peers']
    output = []
    output.append(rule(table, 'input', [match({'meta': {'key': 'iifname'}}, iface), match(ip('saddr'), {'set': peers}),
                                        match(ip('daddr'), local), match({'meta': {'key': 'l4proto'}}, 'icmp'), {'accept': None}]))
    output.append(rule(table, 'input', [match({'meta': {'key': 'iifname'}}, iface), {'jump': {'target': 'lease'}}]))
    output.append(rule(table, 'input', [match({'meta': {'key': 'iifname'}}, iface), {'drop': None}]))
    output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), match(ip('saddr'), local),
                                         match(ip('daddr'), {'set': peers}), match({'meta': {'key': 'l4proto'}}, 'icmp'), {'accept': None}]))
    if policy['host_role'] == 'core':
        addresses = [target['container_ip'] for target in policy['targets']]
        games = [target['container_ip'] for target in policy['targets'] if target['role'] == 'game']
        output.append(rule(table, 'forward', [match(ip('daddr'), {'set': addresses}), match(tcp('dport'), {'set': [3000, 3001]}),
                                             {'jump': {'target': 'lease'}}]))
        output.append(rule(table, 'forward', [match(ip('daddr'), {'set': addresses}), match(tcp('dport'), {'set': [3000, 3001]}), {'drop': None}]))
        output.append(rule(table, 'forward', [match(ip('saddr'), {'set': addresses}), match({'meta': {'key': 'oifname'}}, iface),
                                             {'jump': {'target': 'lease'}}]))
        # No unspecified cluster egress or tunnel forwarding is enabled.
        for field in ('iifname', 'oifname'):
            output.append(rule(table, 'forward', [match({'meta': {'key': field}}, iface), {'drop': None}]))
        output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), {'drop': None}]))
    else:
        output.append(rule(table, 'forward', [match(ip('daddr'), p.edge_ip), match(tcp('dport'), 3000), {'drop': None}]))
        for field in ('iifname', 'oifname'):
            output.append(rule(table, 'forward', [match({'meta': {'key': field}}, iface), {'jump': {'target': 'lease'}}]))
            output.append(rule(table, 'forward', [match({'meta': {'key': field}}, iface), {'drop': None}]))
        output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), {'jump': {'target': 'lease'}}]))
        output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), {'drop': None}]))
    return output


def lease_rules(policy, leases):
    p = deploy.profiles.get_profile(policy['namespace'])
    parse_policy(policy, profile=p.name)
    table, iface, rows = table_name(policy), policy['wg_interface'], []
    if policy['host_role'] == 'core':
        # Container-to-container RPC remains private to the verified owned bridge.
        if leases:
            network_ids = {lease['network_id'] for lease in leases.values()}
            require(len(network_ids) == 1, 'all core roles must use the same verified bridge')
            bridge = 'br-' + next(iter(network_ids))[:12]
            games = [target['container_ip'] for target in policy['targets'] if target['role'] == 'game']
            rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, bridge), match(ip('saddr'), p.core_ip(2)),
                                             match(ip('daddr'), {'set': games}), match(tcp('dport'), 3000), {'accept': None}]))
            rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, bridge), match(ip('saddr'), {'set': games}),
                                             match(ip('daddr'), p.core_ip(2)), match(tcp('dport'), 3001), {'accept': None}]))
        for target in policy['targets']:
            if target['service'] not in leases:
                continue
            for mapping in target['mappings']:
                if mapping['host_ip'] != p.wg_core:
                    continue
                common = [match(ct('saddr', 'original'), {'set': policy['wg_peers']}),
                          match(ct('daddr', 'original'), p.wg_core),
                          match(ct('proto-dst', 'original'), mapping['host_port'])]
                rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, iface),
                    match(ip('saddr'), {'set': policy['wg_peers']}), match(ip('daddr'), target['container_ip']),
                    match(tcp('dport'), mapping['container_port']), match(ct('direction'), 'original'),
                    *common, {'accept': None}]))
                rows.append(rule(table, 'lease', [match({'meta': {'key': 'oifname'}}, iface),
                    match(ip('saddr'), target['container_ip']), match(ip('daddr'), {'set': policy['wg_peers']}),
                    match(tcp('sport'), mapping['container_port']), match(ct('direction'), 'reply'),
                    match(ct('state'), {'set': ['established']}), *common, {'accept': None}]))
    elif leases:
        lease = leases['ingress']
        bridge = 'br-' + lease['network_id'][:12]
        ports = [p.coordinator_port, *range(p.game_first_port, p.game_first_port + 16)]
        rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, bridge),
            match({'meta': {'key': 'oifname'}}, iface), match(ip('saddr'), p.edge_ip),
            match(ip('daddr'), p.wg_core), match(tcp('dport'), {'set': ports}), match(ct('direction'), 'original'), {'accept': None}]))
        rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, iface),
            match({'meta': {'key': 'oifname'}}, bridge), match(ip('saddr'), p.wg_core),
            match(ip('daddr'), p.edge_ip), match(ct('direction'), 'reply'),
            match(ct('state'), {'set': ['established']}), match(ct('daddr', 'original'), p.wg_core),
            match(ct('proto-dst', 'original'), {'set': ports}), {'accept': None}]))
        # Host Nginx gated HTTP reads/control and TCP probes use the same exact peer/ports.
        rows.append(rule(table, 'lease', [match({'meta': {'key': 'oifname'}}, iface), match(ip('saddr'), policy['wg_local']),
            match(ip('daddr'), p.wg_core), match(tcp('dport'), {'set': ports}), match(ct('direction'), 'original'), {'accept': None}]))
        rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, iface), match(ip('saddr'), p.wg_core),
            match(ip('daddr'), policy['wg_local']), match(ct('direction'), 'reply'),
            match(ct('state'), {'set': ['established']}), match(ct('daddr', 'original'), p.wg_core),
            match(ct('proto-dst', 'original'), {'set': ports}), {'accept': None}]))
    return rows


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items() if key not in ('handle', 'packets', 'bytes')}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value


def digest(value):
    return hashlib.sha256(json.dumps(normalized(value), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Nft:
    def command(self, args, data=None, *, missing=False):
        try:
            result = subprocess.run(['/usr/sbin/nft', *args], input=data, capture_output=True, text=True, timeout=5, env=ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise Refused('owned nft operation unavailable') from None
        if missing and result.returncode:
            # A separate list of all tables distinguishes absence from a failed nft query.
            listing = self.command(['-j', 'list', 'tables'])
            require(not any(row.get('table', {}).get('family') == 'inet' and row.get('table', {}).get('name') == args[-1]
                            for row in json.loads(listing)['nftables']), 'owned nft query failed')
            return None
        require(result.returncode == 0 and len(result.stdout) <= 1048576, 'owned nft operation failed')
        return result.stdout

    def snapshot(self, table):
        raw = self.command(['-a', '-j', 'list', 'table', 'inet', table], missing=True)
        if raw is None:
            return None
        value = json.loads(raw)
        require(isinstance(value, dict) and isinstance(value.get('nftables'), list), 'invalid nft snapshot')
        return [row for row in value['nftables'] if 'metainfo' not in row]

    def apply(self, commands):
        def modern_ct(value):
            if isinstance(value, list):
                return [modern_ct(item) for item in value]
            if not isinstance(value, dict):
                return value
            value = {key: modern_ct(item) for key, item in value.items()}
            expression = value.get('ct')
            if isinstance(expression, dict) and expression.get('family') == 'ip' and expression.get('key') in ('saddr', 'daddr'):
                value['ct'] = {key: item for key, item in expression.items() if key != 'family'}
                value['ct']['key'] = 'ip ' + expression['key']
            return value
        # libnftables1.1 uses key="ip daddr"; Ubuntu22's1.0 accepts family="ip".
        # Try only compile checks, then apply exactly the accepted representation once.
        legacy = json.dumps({'nftables': commands})
        raw = json.dumps({'nftables': modern_ct(commands)})
        try:
            self.command(['-c', '-j', '-f', '-'], raw)
        except Refused:
            if raw == legacy:
                raise
            self.command(['-c', '-j', '-f', '-'], legacy)
            raw = legacy
        self.command(['-j', '-f', '-'], raw)


class Guard:
    def __init__(self, policy, nft=None, state_file=None):
        parse_policy(policy, profile=policy['namespace'])
        self.policy, self.nft = policy, nft or Nft()
        self.table = table_name(policy)
        self.state_file = Path(state_file or ('/run/' + policy['project'] + '.guard.json'))
        require(deploy.profiles.path_allowed(self.state_file, policy['namespace']), 'cross-profile guard state refused')

    def state(self):
        return protected_json(self.state_file, private=True)

    def save(self, value, before):
        if before is None:
            require(not self.state_file.exists(), 'guard state appeared concurrently')
        else:
            require(self.state() == before, 'guard state changed concurrently')
        parent = self.state_file.parent.stat()
        require(parent.st_uid == 0 and not parent.st_mode & 0o022, 'unsafe guard state parent')
        fd, name = tempfile.mkstemp(prefix='.ark-cluster-', dir=self.state_file.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(deploy.canonical(value))
                output.flush()
                os.fsync(output.fileno())
            if before is None:
                require(not self.state_file.exists(), 'guard state appeared concurrently')
            else:
                require(self.state() == before, 'guard state changed concurrently')
            os.replace(name, self.state_file)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def create(self):
        current = self.nft.snapshot(self.table)
        if current is not None:
            state = self.state()
            require(state.get('version') == 1 and state.get('project') == self.policy['project']
                    and state.get('table') == self.table and state.get('nft_sha256') == digest(current), 'owned guard changed externally')
            return state, current
        require(not self.state_file.exists(), 'guard state exists without its kernel table')
        commands = [{'add': {'table': {'family': 'inet', 'name': self.table}}}]
        for name in ('input', 'forward', 'output'):
            commands.append({'add': {'chain': {'family': 'inet', 'table': self.table, 'name': name,
                                              'type': 'filter', 'hook': name, 'prio': -20, 'policy': 'accept'}}})
        commands.append({'add': {'chain': {'family': 'inet', 'table': self.table, 'name': 'lease'}}})
        commands.extend({'add': item} for item in base_rules(self.policy))
        self.nft.apply(commands)
        current = self.nft.snapshot(self.table)
        state = {'version': 1, 'project': self.policy['project'], 'table': self.table,
                 'nft_sha256': digest(current), 'leases': {}}
        self.save(state, None)
        return state, current

    def update(self, leases):
        before, current = self.create()
        require(before['nft_sha256'] == digest(current), 'owned guard drifted')
        commands = []
        for item in current:
            row = item.get('rule')
            if isinstance(row, dict) and row.get('chain') == 'lease':
                require(type(row.get('handle')) is int, 'rule handle unavailable')
                commands.append({'delete': {'rule': {'family': 'inet', 'table': self.table, 'chain': 'lease', 'handle': row['handle']}}})
        commands.extend({'add': item} for item in lease_rules(self.policy, leases))
        if commands:
            require(digest(self.nft.snapshot(self.table)) == before['nft_sha256'], 'owned guard changed before transaction')
            self.nft.apply(commands)
        after = self.nft.snapshot(self.table)
        value = {**before, 'nft_sha256': digest(after), 'leases': leases,
                 'owned_leases': {**before.get('owned_leases', {}), **leases},
                 'retired_leases': {} if leases else before.get('leases') or before.get('retired_leases', {})}
        self.save(value, before)
        return value

    def check(self, leases):
        state, current = self.state(), self.nft.snapshot(self.table)
        require(current is not None and state.get('project') == self.policy['project'] and state.get('table') == self.table
                and state.get('leases') == leases and state.get('nft_sha256') == digest(current), 'active cluster lease drifted')
        return state


def network_ready(policy):
    result = subprocess.run(['/usr/sbin/ip', '-j', 'address', 'show', 'dev', policy['wg_interface']],
                            capture_output=True, text=True, timeout=5, env=ENV)
    require(result.returncode == 0 and len(result.stdout) <= LIMIT, 'cluster WG interface unavailable')
    addresses = json.loads(result.stdout)
    require(len(addresses) == 1 and addresses[0].get('ifname') == policy['wg_interface']
            and {(row.get('local'), row.get('prefixlen')) for row in addresses[0].get('addr_info', []) if row.get('family') == 'inet'}
            == {(policy['wg_local'], 32)}, 'exact cluster WG address required')
    wg = next((file for file in ('/usr/bin/wg', '/opt/ark-wg-test/bin/wg') if Path(file).is_file()), None)
    require(wg is not None, 'verified host WG binary unavailable')
    binary = deploy.no_symlink(wg).stat()
    require(binary.st_uid == 0 and not binary.st_mode & 0o022, 'unsafe WG binary')
    result = subprocess.run([wg, 'show', policy['wg_interface'], 'allowed-ips'],
                            capture_output=True, text=True, timeout=5, env=ENV)
    require(result.returncode == 0 and len(result.stdout) <= LIMIT, 'cluster WG peers unavailable')
    allowed = []
    for line in result.stdout.splitlines():
        public, separator, ips = line.partition('\t')
        require(separator and re.fullmatch(r'[A-Za-z0-9+/]{43}=', public), 'invalid cluster WG peer metadata')
        allowed.append(ips)
    require(sorted(allowed) == sorted(peer + '/32' for peer in policy['wg_peers']), 'only exact cluster WG peer /32 routes allowed')
    for peer in policy['wg_peers']:
        result = subprocess.run(['/usr/sbin/ip', '-j', 'route', 'get', peer], capture_output=True, text=True, timeout=5, env=ENV)
        require(result.returncode == 0 and len(result.stdout) <= LIMIT, 'cluster WG route unavailable')
        routes = json.loads(result.stdout)
        require(len(routes) == 1 and routes[0].get('dev') == policy['wg_interface'] and routes[0].get('dst') == peer
                and routes[0].get('prefsrc', routes[0].get('src')) == policy['wg_local'], 'exact cluster WG route required')


def lease_ready(policy, target, *, apply=False, system=None):
    config = Config(policy, target)
    system = system or System(config)
    if apply:
        result = priority.Helper(system).run(target['container_name'])
        require(result['configured'], 'main-TID policy not applied')
    snapshot = system.snapshot(target['container_name'])
    priority.validate_threads(snapshot, config)
    require(snapshot.main.nice == -20 and snapshot.main.policy == os.SCHED_OTHER | priority.RESET_ON_FORK,
            'main-TID policy not applied')
    info = system.last_info
    require(isinstance(info, dict) and info['id'] == snapshot.generation.container_id, 'role metadata changed')
    return {**asdict(snapshot.generation), 'network_id': info['network_id'],
            'container_ip': target['container_ip'], 'runtime_sha256': target['runtime_sha256'],
            'node_generation': system.node_generation if target['role'] == 'game' else None}


def leases_ready(policy, *, apply=False):
    return {target['service']: lease_ready(policy, target, apply=apply) for target in policy['targets']}


def healthy_leases(policy, expected, systems):
    leases = {}
    for target in policy['targets']:
        try:
            current = lease_ready(policy, target, system=systems[target['service']])
            # A worker can recover within the same process/actor epoch; a new process cannot
            # inherit a live lease even with the same IP, config or node identifier.
            if current == expected[target['service']]:
                leases[target['service']] = current
        except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            pass
    return leases


def compose_start(policy):
    missing, stopped = [], []
    # Never recreate an existing name through compose. Approved live roles are preserved;
    # approved stopped roles boot through their checked immutable CIDs behind the closed guard.
    for target in policy['targets']:
        result = subprocess.run(priority.DOCKER + ['container', 'inspect', '--format', '{{json .Id}}', target['container_name']],
                                capture_output=True, text=True, timeout=5, env=ENV)
        if result.returncode:
            missing.append(target['service'])
            continue
        current = System(Config(policy, target)).inspect(target['container_name'], allow_stopped=True)
        require(current['id'] == json.loads(result.stdout), 'existing container name changed')
        if current['running'] is False:
            stopped.append(current['id'])
    for cid in stopped:
        result = subprocess.run(priority.DOCKER + ['start', cid], capture_output=True, timeout=60, env=ENV)
        require(result.returncode == 0, 'owned stopped role startup failed')
    if not missing:
        return
    result = subprocess.run(priority.DOCKER + ['compose', '--project-name', policy['project'], '-f', policy['compose_file'],
                            'up', '-d', '--no-deps', *missing], capture_output=True, timeout=120, env=ENV)
    require(result.returncode == 0, 'owned cluster Compose startup failed')


def start(policy, guard):
    guard.update({})
    network_ready(policy)
    compose_start(policy)
    leases = leases_ready(policy, apply=True)
    network_ready(policy)
    guard.update(leases)
    # Post-open revalidation binds the complete transport/process/container identity.
    try:
        require(leases_ready(policy) == leases, 'role changed during lease publication')
        guard.check(leases)
    except BaseException:
        guard.update({})
        raise
    return leases


def stop(policy, guard):
    before = guard.state()
    leases = before.get('owned_leases') or before.get('leases') or before.get('retired_leases', {})
    guard.update({})
    require(leases, 'no owned active cluster lease to stop')
    selected = []
    for target in reversed(policy['targets']):
        expected = leases.get(target['service'])
        require(isinstance(expected, dict), 'stop lease missing target')
        system = System(Config(policy, target))
        info = system.inspect(expected['container_id'], allow_stopped=True)
        require(info['id'] == expected['container_id'] and info['image_id'] == expected['image_id']
                and info['started_at'] == expected['started_at'] and info['restarts'] == expected['restarts'], 'stop generation changed')
        selected.append((system, expected, info))
    for system, expected, before_info in selected:
        info = system.inspect(expected['container_id'], allow_stopped=True)
        require(info == before_info, 'stop target changed after preflight')
        if info['running'] is False:
            continue
        result = subprocess.run(priority.DOCKER + ['stop', '--time', '10', expected['container_id']],
                                capture_output=True, timeout=20, env=ENV)
        require(result.returncode == 0, 'owned cluster stop failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(deploy.profiles.PROFILES))
    parser.add_argument('--config', required=True)
    parser.add_argument('--action', required=True, choices=('guard', 'start', 'serve', 'check', 'stop'))
    args = parser.parse_args()
    policy, guard, owns_lock = None, None, False

    def interrupted(_number, _frame):
        raise Stopped()

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    try:
        require(os.geteuid() == 0, 'host root required; no container capability grant')
        policy = load_policy(args.config, profile=args.profile)
        guard = Guard(policy)
        if args.action == 'check':
            # A live manager owns the writer lock. Read-only checks neither wait on it nor create guards.
            network_ready(policy)
            guard.check(leases_ready(policy))
            priority.emit('cluster-checked', role=policy['host_role'], targets=len(policy['targets']))
            return 0
        # One host-local cluster writer; separate from all monolithic/WG-test locks and tables.
        with priority.runtime_lock('/run/' + policy['project'] + '.lock', timeout=15):
            owns_lock = True
            if args.action == 'guard':
                guard.update({})
            elif args.action == 'check':
                network_ready(policy)
                guard.check(leases_ready(policy))
            elif args.action == 'stop':
                stop(policy, guard)
            else:
                leases = start(policy, guard)
                priority.emit('cluster-started', role=policy['host_role'], targets=len(leases),
                              build=policy['build'], source_kind=policy['source_kind'])
                if args.action == 'serve':
                    systems = {target['service']: System(Config(policy, target)) for target in policy['targets']}
                    published = leases
                    while True:
                        time.sleep(5)
                        # Shared policy/tunnel/table drift closes this cluster only. A single
                        # role fault withdraws only that role's exact lease, not healthy games/control.
                        require(load_policy(args.config, profile=args.profile) == policy, 'host policy changed; explicit controlled update required')
                        network_ready(policy)
                        guard.check(published)
                        current = healthy_leases(policy, leases, systems)
                        if current != published:
                            guard.update(current)
                            published = current
                            priority.emit('cluster-leases-updated', active=len(current), configured=len(leases))
        return 0
    except Stopped:
        closed = False
        if guard is not None and owns_lock:
            try:
                guard.update({})
                closed = True
            except (Refused, OSError, ValueError):
                pass
        priority.emit('cluster-manager-stopped', leases_closed=closed, priority_retained=True)
        return 0 if closed else 1
    except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        if guard is not None and owns_lock:
            try:
                guard.update({})
            except (Refused, OSError, ValueError):
                pass
        priority.emit('refused', reason='fixed cluster lifecycle refused; no secret or command output disclosed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
