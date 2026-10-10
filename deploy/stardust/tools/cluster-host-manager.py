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
import struct
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
GUARD_JOURNAL_LIMIT = 256 * 1024
CONTROL_LIMIT = 4096


def dual_ingress(policy):
    # Schema2 keeps the same independent ownership contract for every multi-instance edge.
    return policy['host_role'] == 'edge' and policy.get('ingress_instances', 1) > 1


def require(ok, diagnostic):
    if not ok:
        raise Refused(diagnostic)


def protected_read(path, *, exact_bytes=None, private=False, limit=LIMIT):
    require(type(limit) is int and 0 < limit <= GUARD_JOURNAL_LIMIT, 'invalid protected file size bound')
    path = deploy.no_symlink(path)
    for parent in path.parents:
        info = parent.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe protected file parent')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o027
                and 0 < info.st_size <= limit and (not private or stat.S_IMODE(info.st_mode) == 0o600)
                and (exact_bytes is None or info.st_size == exact_bytes), 'unsafe protected file')
        raw = os.read(fd, limit + 1)
        require(len(raw) == info.st_size, 'protected file changed during read')
        return raw
    finally:
        os.close(fd)


def protected_json(path, *, private=False, limit=LIMIT):
    try:
        return json.loads(protected_read(path, private=private, limit=limit))
    except (ValueError, UnicodeError):
        raise Refused('invalid protected policy JSON') from None


def parse_policy(value, *, profile='beta'):
    p = deploy.profiles.get_profile(profile)
    fields = {'version', 'namespace', 'host_role', 'entry', 'source_kind', 'build', 'manifest_sha256',
              'image_id', 'bundle', 'compose_file', 'compose_sha256', 'project', 'subnet',
              'wg_interface', 'wg_local', 'wg_peers', 'origin', 'targets'}
    require(isinstance(value, dict) and set(value) in (fields, fields | {'ingress_instances'}), 'invalid cluster policy fields')
    role, entry = value['host_role'], value['entry']
    count = value.get('ingress_instances', 1)
    require(type(count) is int and 1 <= count <= p.max_ingress_instances and (role == 'edge' or 'ingress_instances' not in value),
            'invalid fixed ingress instance count')
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
    require(isinstance(targets, list) and len(targets) == (17 if role == 'core' else count), 'fixed target inventory required')
    expected_services = ({'coordinator', *('game-' + format(index, '02d') for index in range(1, 17))} if role == 'core'
                         else {deploy.ingress_service(index, profile) for index in range(1, count + 1)})
    require(all(isinstance(row, dict) and isinstance(row.get('service'), str) for row in targets)
            and {row['service'] for row in targets} == expected_services, 'fixed target services required')
    for row in targets:
        require(isinstance(row, dict), 'invalid target')
        service = row['service']
        is_game = service.startswith('game-')
        wanted_role = 'game' if is_game else 'ingress' if role == 'edge' else service
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
            instance = 1 if service == 'ingress' else int(service.removeprefix('ingress-'))
            ip, port = p.ingress_ip(instance), p.ingress_host_port(instance)
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
        addresses = [target['container_ip'] for target in policy['targets']]
        output.append(rule(table, 'forward', [match(ip('daddr'), addresses[0] if len(addresses) == 1 else {'set': addresses}),
                                             match(tcp('dport'), 3000), {'drop': None}]))
        for field in ('iifname', 'oifname'):
            output.append(rule(table, 'forward', [match({'meta': {'key': field}}, iface), {'jump': {'target': 'lease'}}]))
            output.append(rule(table, 'forward', [match({'meta': {'key': field}}, iface), {'drop': None}]))
        output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), {'jump': {'target': 'lease'}}]))
        output.append(rule(table, 'output', [match({'meta': {'key': 'oifname'}}, iface), {'drop': None}]))
    return output


def validate_leases(policy, leases):
    """Dual-ingress grants require exact independent process/target generations."""
    require(isinstance(leases, dict) and set(leases) <= {row['service'] for row in policy['targets']},
            'unknown cluster lease target')
    if not dual_ingress(policy):
        return  # Preserve the existing core/single guard contract.
    targets = {row['service']: row for row in policy['targets']}
    fields = set(priority.Generation.__dataclass_fields__) | {'network_id', 'container_ip', 'runtime_sha256', 'node_generation'}
    for name, lease in leases.items():
        target = targets[name]
        require(isinstance(lease, dict) and set(lease) == fields
                and isinstance(lease['container_id'], str) and priority.CID.fullmatch(lease['container_id'])
                and isinstance(lease['network_id'], str) and priority.CID.fullmatch(lease['network_id'])
                and lease['image_id'] == policy['image_id'] and lease['revision'] == policy['build']
                and isinstance(lease['started_at'], str) and re.fullmatch(r'[ -~]{1,128}', lease['started_at'])
                and type(lease['restarts']) is int and lease['restarts'] >= 0
                and all(type(lease[key]) is int and lease[key] > 0 for key in ('init_pid', 'init_start', 'main_pid', 'main_start'))
                and lease['container_ip'] == target['container_ip'] and lease['runtime_sha256'] == target['runtime_sha256']
                and lease['node_generation'] is None, 'invalid exact ingress lease')
    require(len({row['network_id'] for row in leases.values()}) <= 1
            and len({row['container_id'] for row in leases.values()}) == len(leases)
            and len({row['main_pid'] for row in leases.values()}) == len(leases)
            and len({row['init_pid'] for row in leases.values()}) == len(leases)
            and all({left['init_pid'], left['main_pid']}.isdisjoint({right['init_pid'], right['main_pid']})
                    for left_name, left in leases.items() for right_name, right in leases.items() if left_name != right_name),
            'ingress leases must have independent generations on one bridge')


def lease_rules(policy, leases):
    p = deploy.profiles.get_profile(policy['namespace'])
    parse_policy(policy, profile=p.name)
    validate_leases(policy, leases)
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
        ports = [p.coordinator_port, *range(p.game_first_port, p.game_first_port + 16)]
        for target in policy['targets']:
            lease = leases.get(target['service'])
            if lease is None:
                continue
            bridge = 'br-' + lease['network_id'][:12]
            rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, bridge),
                match({'meta': {'key': 'oifname'}}, iface), match(ip('saddr'), target['container_ip']),
                match(ip('daddr'), p.wg_core), match(tcp('dport'), {'set': ports}), match(ct('direction'), 'original'), {'accept': None}]))
            rows.append(rule(table, 'lease', [match({'meta': {'key': 'iifname'}}, iface),
                match({'meta': {'key': 'oifname'}}, bridge), match(ip('saddr'), p.wg_core),
                match(ip('daddr'), target['container_ip']), match(ct('direction'), 'reply'),
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


def semantic_nft(value):
    """Only nft's documented IPv4/singleton-set serialization differences."""
    value = normalized(value)
    if isinstance(value, list):
        return [semantic_nft(item) for item in value]
    if not isinstance(value, dict):
        return value
    value = {key: semantic_nft(item) for key, item in value.items()}
    if set(value) == {'set'} and isinstance(value['set'], list):
        items = sorted(value['set'], key=lambda item: json.dumps(item, sort_keys=True))
        return items[0] if len(items) == 1 else {'set': items}
    expression = value.get('ct')
    if isinstance(expression, dict) and expression.get('family') == 'ip' and expression.get('key') in ('saddr', 'daddr'):
        value['ct'] = {key: item for key, item in expression.items() if key != 'family'}
        value['ct']['key'] = 'ip ' + expression['key']
    row = value.get('rule')
    if isinstance(row, dict) and isinstance(row.get('expr'), list):
        lefts = [item.get('match', {}).get('left', {}) for item in row['expr']]
        implied_ip = any(left.get('payload', {}).get('protocol') == 'ip'
                         or left.get('ct', {}).get('key') in ('ip saddr', 'ip daddr') for left in lefts)
        if implied_ip:
            ipv4_context = match({'meta': {'key': 'nfproto'}}, 'ipv4')
            row['expr'] = [item for item in row['expr'] if item != ipv4_context]
        if any(left.get('payload', {}).get('protocol') == 'tcp' for left in lefts):
            tcp_context = match({'meta': {'key': 'l4proto'}}, 'tcp')
            row['expr'] = [item for item in row['expr'] if item != tcp_context]
    return value


def semantic_nft_sha(value):
    return digest(semantic_nft(value))


def is_lease_rule(item):
    return isinstance(item.get('rule'), dict) and item['rule'].get('chain') == 'lease'


CONTAINER_OWNER_FIELDS = {'kind', 'container_id', 'image_id', 'revision', 'started_at', 'restarts'}


def container_owner(info):
    return {'kind': 'closed', 'container_id': info['id'], 'image_id': info['image_id'], 'revision': info['revision'],
            'started_at': info['started_at'], 'restarts': info['restarts']}


def validate_container_owner(policy, owner):
    require(isinstance(owner, dict) and set(owner) == CONTAINER_OWNER_FIELDS and owner['kind'] == 'closed'
            and isinstance(owner['container_id'], str) and priority.CID.fullmatch(owner['container_id'])
            and owner['image_id'] == policy['image_id'] and owner['revision'] == policy['build']
            and isinstance(owner['started_at'], str) and re.fullmatch(r'[ -~]{1,128}', owner['started_at'])
            and type(owner['restarts']) is int and owner['restarts'] >= 0, 'invalid closed container ownership')


def unadmitted_owner(policy, target):
    return {'kind': 'unadmitted', 'policy_sha256': hashlib.sha256(deploy.canonical(policy)).hexdigest(),
            'service': target['service'], 'container_name': target['container_name'], 'runtime_sha256': target['runtime_sha256']}


class Guard:
    def __init__(self, policy, nft=None, state_file=None):
        parse_policy(policy, profile=policy['namespace'])
        self.policy, self.nft = policy, nft or Nft()
        self.table = table_name(policy)
        self.state_file = Path(state_file or ('/run/' + policy['project'] + '.guard.json'))
        require(deploy.profiles.path_allowed(self.state_file, policy['namespace']), 'cross-profile guard state refused')

    def state_limit(self):
        # Expanded journals include both exact lease ledgers and the prior nft snapshot.
        return GUARD_JOURNAL_LIMIT if self.policy['namespace'] == 'formal' and self.policy.get('ingress_instances', 1) > 2 else LIMIT

    def state(self):
        return protected_json(self.state_file, private=True, limit=self.state_limit())

    def save(self, value, before):
        raw = deploy.canonical(value)
        require(0 < len(raw) <= self.state_limit(), 'owned guard journal exceeds fixed size bound')
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
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            if before is None:
                require(not self.state_file.exists(), 'guard state appeared concurrently')
            else:
                require(self.state() == before, 'guard state changed concurrently')
            os.replace(name, self.state_file)
            if dual_ingress(self.policy):
                directory_fd = os.open(self.state_file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def policy_binding(self, state):
        if dual_ingress(self.policy) or 'policy_sha256' in state:
            require(state.get('policy_sha256') == hashlib.sha256(deploy.canonical(self.policy)).hexdigest(),
                    'guard policy changed; approved closed guard replacement required')
        if dual_ingress(self.policy):
            desired = state.get('desired')
            require(isinstance(desired, dict) and set(desired) == {row['service'] for row in self.policy['targets']}
                    and all(value in ('running', 'revoked', 'stopped') for value in desired.values())
                    and type(state.get('control_epoch')) is int and state['control_epoch'] >= 0,
                    'exact persistent ingress desired state required')
            targets = {row['service']: row for row in self.policy['targets']}
            require(type(state.get('version')) is int and state['version'] == 1
                    and state.get('project') == self.policy['project'] and state.get('table') == self.table
                    and isinstance(state.get('nft_sha256'), str) and deploy.HEX64.fullmatch(state['nft_sha256'])
                    and type(state.get('guard_schema')) is int and state['guard_schema'] == 2, 'recoverable dual guard schema required')
            validate_leases(self.policy, state.get('leases'))
            for field in ('closed_owners', 'unadmitted', 'start_intents'):
                require(isinstance(state.get(field), dict) and set(state[field]) <= set(targets), 'invalid ingress ownership ledger')
            require(not set(state['closed_owners']) & set(state['leases'])
                    and not set(state['unadmitted']) & (set(state['leases']) | set(state.get('owned_leases', {})) | set(state['closed_owners'])),
                    'ambiguous ingress ownership state')
            for owner in state['closed_owners'].values():
                validate_container_owner(self.policy, owner)
            for name, owner in state['unadmitted'].items():
                require(owner == unadmitted_owner(self.policy, targets[name]), 'unapproved initial ingress admission')
            for name, intent in state['start_intents'].items():
                require(isinstance(intent, dict) and set(intent) == {'version', 'policy_sha256', 'service', 'mode', 'container'}
                        and type(intent['version']) is int and intent['version'] == 1 and intent['policy_sha256'] == self.policy_sha()
                        and intent['service'] == name and intent['mode'] in ('create', 'start')
                        and name not in state['leases'], 'invalid owned ingress start intent')
                if intent['mode'] == 'start':
                    validate_container_owner(self.policy, intent['container'])
                else:
                    require(intent['container'] is None and name in state['unadmitted'], 'initial creation requires approved unadmitted marker')

    def ledger(self, change):
        before, _current = self.create()
        self.check(before['leases'])
        value = change(before)
        require(value['leases'] == before['leases'] and value['nft_sha256'] == before['nft_sha256'], 'ownership ledger may not change grants')
        value['control_epoch'] = before['control_epoch'] + 1
        self.policy_binding(value)
        self.save(value, before)
        return value

    def owner(self, service, state=None):
        state = state or self.state()
        self.policy_binding(state)
        return (state['closed_owners'].get(service) or state.get('owned_leases', {}).get(service)
                or state['unadmitted'].get(service))

    def begin_start(self, service, info):
        selected_target(self.policy, service)
        intent = {'version': 1, 'policy_sha256': self.policy_sha(), 'service': service,
                  'mode': 'create' if info is None else 'start', 'container': None if info is None else container_owner(info)}
        def change(before):
            require(service not in before['leases'] and service not in before['start_intents'], 'start target must be closed without an outstanding intent')
            if info is None:
                require(service in before['unadmitted'] and service not in before.get('owned_leases', {})
                        and service not in before['closed_owners'], 'only explicitly unadmitted targets may be created')
            return {**before, 'start_intents': {**before['start_intents'], service: intent}}
        self.ledger(change)

    def record_owned(self, service, lease):
        validate_leases(self.policy, {service: lease})
        def change(before):
            require(service not in before['leases'] or before['leases'][service] == lease, 'cannot adopt a changed leased process')
            intent = before['start_intents'].get(service)
            if intent and intent['mode'] == 'start':
                require(lease['container_id'] == intent['container']['container_id'], 'started container identity changed')
            return {**before, 'owned_leases': {**before.get('owned_leases', {}), service: lease},
                    'closed_owners': {name: owner for name, owner in before['closed_owners'].items() if name != service},
                    'unadmitted': {name: owner for name, owner in before['unadmitted'].items() if name != service},
                    'start_intents': {name: item for name, item in before['start_intents'].items() if name != service}}
        self.ledger(change)

    def record_closed(self, service, info):
        require(info['running'] is False, 'closed ownership requires a stopped container')
        owner = container_owner(info)
        validate_container_owner(self.policy, owner)
        def change(before):
            require(service not in before['leases'], 'closed owner may not have a grant')
            return {**before, 'closed_owners': {**before['closed_owners'], service: owner},
                    'unadmitted': {name: item for name, item in before['unadmitted'].items() if name != service},
                    'start_intents': {name: item for name, item in before['start_intents'].items() if name != service}}
        self.ledger(change)

    def set_desired(self, service, desired):
        require(dual_ingress(self.policy) and desired in ('revoked', 'stopped'), 'invalid desired ingress state')
        selected_target(self.policy, service)
        before = self.state()
        self.check(before['leases'])
        self.save({**before, 'desired': {**before['desired'], service: desired},
                   'control_epoch': before['control_epoch'] + 1}, before)

    def lease_commands(self, current, leases):
        commands = []
        for item in current:
            if is_lease_rule(item):
                row = item['rule']
                require(type(row.get('handle')) is int, 'rule handle unavailable')
                commands.append({'delete': {'rule': {'family': 'inet', 'table': self.table, 'chain': 'lease', 'handle': row['handle']}}})
        commands.extend({'add': item} for item in lease_rules(self.policy, leases))
        return commands

    def transaction_shape(self, before_snapshot, leases):
        return [item for item in before_snapshot if not is_lease_rule(item)] + lease_rules(self.policy, leases)

    def recover_transaction(self, state, current, *, published=None):
        pending = state.get('pending')
        require(isinstance(pending, dict) and set(pending) == {'version', 'policy_sha256', 'before', 'after', 'before_snapshot', 'after_semantic_sha256'}
                and pending['version'] == 1 and type(pending['version']) is int
                and pending['policy_sha256'] == self.policy_sha(), 'invalid owned guard transaction')
        before, after, snapshot = pending['before'], pending['after'], pending['before_snapshot']
        require(isinstance(before, dict) and isinstance(after, dict) and 'pending' not in before and 'pending' not in after
                and isinstance(snapshot, list) and digest(snapshot) == before.get('nft_sha256')
                and {key: value for key, value in state.items() if key != 'pending'} == before,
                'guard transaction metadata changed')
        self.policy_binding(before); self.policy_binding(after)
        validate_leases(self.policy, before['leases']); validate_leases(self.policy, after['leases'])
        wanted = self.transaction_shape(snapshot, after['leases'])
        require(semantic_nft_sha(wanted) == pending['after_semantic_sha256'], 'guard transaction intent changed')
        safe = {name: lease for name, lease in before['leases'].items() if after['leases'].get(name) == lease}
        safe_shape = self.transaction_shape(snapshot, safe)
        require(current is not None and (digest(current) == before['nft_sha256']
                or semantic_nft_sha(current) in (pending['after_semantic_sha256'], semantic_nft_sha(safe_shape))),
                'unrecognized kernel drift during owned transaction')
        # Roll back only grants affected by this recorded transaction. Unchanged
        # sibling grants survive, and an interrupted close is never reopened.
        if semantic_nft_sha(current) != semantic_nft_sha(safe_shape):
            self.nft.apply(self.lease_commands(current, safe))
        current = self.nft.snapshot(self.table)
        require(semantic_nft_sha(current) == semantic_nft_sha(safe_shape), 'guard transaction rollback changed')
        desired = dict(after['desired'])
        affected = set(before['leases']) ^ set(after['leases'])
        affected |= {name for name in before['leases'] if name in after['leases'] and before['leases'][name] != after['leases'][name]}
        for name in affected:
            desired[name] = 'stopped' if before['desired'][name] == 'stopped' else 'revoked'
        retired = {**before.get('retired_leases', {}), **after.get('retired_leases', {}),
                   **{name: lease for name, lease in {**before['leases'], **after['leases']}.items() if name not in safe}}
        value = {**after, 'leases': safe, 'desired': desired, 'nft_sha256': digest(current),
                 'retired_leases': {name: lease for name, lease in retired.items() if name not in safe},
                 'control_epoch': max(before['control_epoch'], after['control_epoch']) + 1}
        # Kernel rollback already happened even if this save fails. The durable
        # pending intent still recognizes that exact safe snapshot on restart.
        self.save(value, state if published is None else published)
        return value, current

    def policy_sha(self):
        return hashlib.sha256(deploy.canonical(self.policy)).hexdigest()

    def create(self):
        current = self.nft.snapshot(self.table)
        if current is not None:
            state = self.state()
            self.policy_binding(state)
            validate_leases(self.policy, state.get('leases'))
            if dual_ingress(self.policy) and 'pending' in state:
                state, current = self.recover_transaction(state, current)
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
                 'nft_sha256': digest(current), 'leases': {},
                 **({'policy_sha256': hashlib.sha256(deploy.canonical(self.policy)).hexdigest(), 'control_epoch': 0, 'guard_schema': 2,
                     'desired': {row['service']: 'running' for row in self.policy['targets']},
                     'closed_owners': {}, 'start_intents': {},
                     'unadmitted': {row['service']: unadmitted_owner(self.policy, row) for row in self.policy['targets']}}
                    if dual_ingress(self.policy) else {})}
        self.save(state, None)
        return state, current

    def update(self, leases, *, resume=None):
        validate_leases(self.policy, leases)
        before, current = self.create()
        desired = before.get('desired')
        if dual_ingress(self.policy):
            desired = dict(desired)
            if resume is not None:
                selected_target(self.policy, resume)
                require(resume in leases and all(leases.get(name) == lease for name, lease in before['leases'].items() if name != resume)
                        and set(leases) <= set(before['leases']) | {resume}, 'resume may only publish its own ingress lease')
                desired[resume] = 'running'
            require(all(desired[name] == 'running' for name in leases), 'revoked or stopped ingress must not reopen automatically')
        else:
            require(resume is None, 'scoped resume requires dual ingress')
        require(before['nft_sha256'] == digest(current), 'owned guard drifted')
        commands = []
        for item in current:
            row = item.get('rule')
            if isinstance(row, dict) and row.get('chain') == 'lease':
                require(type(row.get('handle')) is int, 'rule handle unavailable')
                commands.append({'delete': {'rule': {'family': 'inet', 'table': self.table, 'chain': 'lease', 'handle': row['handle']}}})
        commands.extend({'add': item} for item in lease_rules(self.policy, leases))
        if commands and not dual_ingress(self.policy):
            require(digest(self.nft.snapshot(self.table)) == before['nft_sha256'], 'owned guard changed before transaction')
            self.nft.apply(commands)
        after = self.nft.snapshot(self.table)
        retired = {**before.get('retired_leases', {}),
                   **{name: lease for name, lease in before['leases'].items() if name not in leases}}
        value = {**before, **({'desired': desired, 'control_epoch': before['control_epoch'] + 1,
                               'closed_owners': {name: owner for name, owner in before['closed_owners'].items() if name not in leases},
                               'unadmitted': {name: owner for name, owner in before['unadmitted'].items() if name not in leases}}
                              if dual_ingress(self.policy) else {}),
                 'nft_sha256': digest(after), 'leases': leases,
                 'owned_leases': {**before.get('owned_leases', {}), **leases},
                 'retired_leases': ({name: lease for name, lease in retired.items() if name not in leases}
                                    if dual_ingress(self.policy)
                                    else {} if leases else before.get('leases') or before.get('retired_leases', {}))}
        if dual_ingress(self.policy) and commands:
            pending = {'version': 1, 'policy_sha256': self.policy_sha(), 'before': before, 'after': json.loads(deploy.canonical(value)),
                       'before_snapshot': current,
                       'after_semantic_sha256': semantic_nft_sha(self.transaction_shape(current, leases))}
            intent = {**before, 'pending': pending}
            try:
                self.save(intent, before)  # Durable BEFORE any opening/closing nft operation.
                require(digest(self.nft.snapshot(self.table)) == before['nft_sha256'], 'owned guard changed before transaction')
                self.nft.apply(commands)
                after = self.nft.snapshot(self.table)
                require(semantic_nft_sha(after) == pending['after_semantic_sha256'], 'owned nft transaction result changed')
                value['nft_sha256'] = digest(after)
                self.save(value, intent)
            except BaseException:
                try:
                    observed = self.state()
                    if 'pending' in observed:
                        self.recover_transaction(observed, self.nft.snapshot(self.table))
                    elif observed == value:
                        self.recover_transaction(intent, self.nft.snapshot(self.table), published=observed)
                except (Refused, deploy.Refused, OSError, ValueError):
                    pass  # Keep the durable intent; never accept unknown foreign drift.
                raise
        else:
            self.save(value, before)
        return value

    def check(self, leases):
        validate_leases(self.policy, leases)
        state, current = self.state(), self.nft.snapshot(self.table)
        self.policy_binding(state)
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


def leases_ready(policy, *, apply=False, services=None):
    return {target['service']: lease_ready(policy, target, apply=apply) for target in policy['targets']
            if services is None or target['service'] in services}


def healthy_leases(policy, expected, systems, *, services=None):
    leases = {}
    for target in policy['targets']:
        if services is not None and target['service'] not in services:
            continue
        try:
            current = lease_ready(policy, target, system=systems[target['service']])
            # A worker can recover within the same process/actor epoch; a new process cannot
            # inherit a live lease even with the same IP, config or node identifier.
            if current == expected[target['service']]:
                leases[target['service']] = current
        except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            pass
    return leases


def compose_start(policy, *, services=None):
    missing, stopped = [], []
    # Never recreate an existing name through compose. Approved live roles are preserved;
    # approved stopped roles boot through their checked immutable CIDs behind the closed guard.
    for target in policy['targets']:
        if services is not None and target['service'] not in services:
            continue
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


def process_ownership(policy, target, system=None):
    system = system or System(Config(policy, target))
    deadline = time.monotonic() + 5
    while True:
        try:
            snapshot = system.snapshot(target['container_name'], ready=False)
            info = system.last_info if getattr(system, 'last_info', None) is not None else system.inspect(snapshot.generation.container_id)
            require(info['id'] == snapshot.generation.container_id, 'closed process ownership changed')
            value = {**asdict(snapshot.generation), 'network_id': info['network_id'], 'container_ip': target['container_ip'],
                     'runtime_sha256': target['runtime_sha256'], 'node_generation': None}
            validate_leases(policy, {target['service']: value})
            return value
        except NotReady:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def inspect_optional(policy, target):
    system = System(Config(policy, target))
    try:
        return system.inspect(target['container_name'], allow_stopped=True)
    except NotReady:
        # A successful exact-name roster query distinguishes absence from Docker
        # failure/warming. Never turn a failed inspect into unchecked creation.
        result = subprocess.run(priority.DOCKER + ['container', 'ls', '-a', '--no-trunc', '--filter',
                                'name=^/' + target['container_name'] + '$', '--format', '{{json .ID}}'],
                                capture_output=True, text=True, timeout=5, env=ENV)
        require(result.returncode == 0 and len(result.stdout) <= LIMIT, 'owned container roster unavailable')
        require(not result.stdout.strip(), 'existing ingress is not safely inspectable')
        return None


def validate_owner_current(policy, target, owner, info, system=None):
    require(isinstance(owner, dict), 'explicit ingress ownership required')
    if owner.get('kind') == 'unadmitted':
        require(owner == unadmitted_owner(policy, target), 'invalid initial ingress authorization')
        return  # Genesis is explicit, scoped and still requires System's full approved baseline.
    require(info is not None, 'recorded ingress container unavailable')
    if owner.get('kind') == 'closed':
        validate_container_owner(policy, owner)
        require(info['running'] is False, 'closed ingress restarted outside manager control')
    else:
        validate_leases(policy, {target['service']: owner})
    require(info['id'] == owner['container_id'] and info['image_id'] == owner['image_id']
            and info['revision'] == owner['revision'] and info['started_at'] == owner['started_at']
            and info['restarts'] == owner['restarts'], 'ingress container generation changed')
    if info['running']:
        system = system or System(Config(policy, target))
        snapshot = system.snapshot(owner['container_id'], ready=False)
        require(asdict(snapshot.generation) == {key: owner[key] for key in priority.Generation.__dataclass_fields__},
                'ingress process generation changed')


def recover_start_intent(policy, guard, service):
    state, _current = guard.create()
    intent = state['start_intents'].get(service)
    if intent is None:
        return
    target = selected_target(policy, service)
    # Interrupted starts never auto-adopt an unrecorded running generation.
    # Close only this target, stop the exact approved CID, and retain a CLOSED
    # container ledger for a subsequent explicit start with a fresh process epoch.
    revoke(policy, guard, service)
    system = System(Config(policy, target))
    if intent['mode'] == 'start':
        info = system.inspect(intent['container']['container_id'], allow_stopped=True)
        require(info['id'] == intent['container']['container_id'], 'interrupted start CID changed')
    else:
        info = inspect_optional(policy, target)
        if info is None:
            guard.ledger(lambda before: {**before, 'start_intents': {name: item for name, item in before['start_intents'].items() if name != service}})
            return
    if info['running']:
        again = system.inspect(info['id'], allow_stopped=True)
        require(again == info, 'interrupted start rollback target changed')
        result = subprocess.run(priority.DOCKER + ['stop', '--time', '10', info['id']], capture_output=True, timeout=20, env=ENV)
        require(result.returncode == 0, 'interrupted owned start rollback failed')
    closed = system.inspect(info['id'], allow_stopped=True)
    require(closed['id'] == info['id'] and closed['running'] is False, 'interrupted start did not close')
    guard.record_closed(service, closed)


def admit_ingress(policy, guard, target):
    service = target['service']
    state, _current = guard.create()
    require(service not in state['start_intents'], 'outstanding start requires closed recovery')
    owner = guard.owner(service, state)
    info = inspect_optional(policy, target)
    validate_owner_current(policy, target, owner, info)
    if info is None or not info['running']:
        revoke(policy, guard, service)
        guard.begin_start(service, info)  # Durable BEFORE Docker changes StartedAt/CID.
        compose_start(policy, services={service})
    ownership = process_ownership(policy, target)
    guard.record_owned(service, ownership)  # Durable CLOSED generation BEFORE health/apply.
    current = lease_ready(policy, target, apply=True)
    require(lease_ready(policy, target) == current, 'ingress changed before publication')
    state, _snapshot = guard.create()
    guard.update({**state['leases'], service: current}, resume=service)
    require(lease_ready(policy, target) == current, 'ingress changed during publication')
    guard.check({**state['leases'], service: current})
    return current


def fail_ingress(policy, guard, service):
    revoke(policy, guard, service)
    if service in guard.state()['start_intents']:
        recover_start_intent(policy, guard, service)


def start_dual(policy, guard):
    state, _current = guard.create()
    network_ready(policy)
    admitted = {}
    for target in policy['targets']:
        service = target['service']
        try:
            if service in state['start_intents']:
                recover_start_intent(policy, guard, service)
            current_state = guard.state()
            if current_state['desired'][service] != 'running':
                # A closed recorded desired state is never silently resumed.
                if service in current_state['leases']:
                    revoke(policy, guard, service, desired=current_state['desired'][service])
                continue
            admitted[service] = admit_ingress(policy, guard, target)
        except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            try:
                fail_ingress(policy, guard, service)
            except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
                pass
            priority.emit('cluster-ingress-admission-failed', target=service)
            # Continue admitting/serving the sibling; failed target needs explicit resume.
    guard.check(admitted)
    return admitted


def start(policy, guard):
    if dual_ingress(policy):
        return start_dual(policy, guard)
    state = guard.update({})
    services = {name for name, desired in state['desired'].items() if desired == 'running'} if dual_ingress(policy) else None
    network_ready(policy)
    compose_start(policy, services=services) if services is not None else compose_start(policy)
    leases = leases_ready(policy, apply=True, services=services) if services is not None else leases_ready(policy, apply=True)
    network_ready(policy)
    guard.update(leases)
    # Post-open revalidation binds the complete transport/process/container identity.
    try:
        require((leases_ready(policy, services=services) if services is not None else leases_ready(policy)) == leases,
                'role changed during lease publication')
        guard.check(leases)
    except BaseException:
        guard.update({})
        raise
    return leases


def selected_target(policy, service):
    require(isinstance(service, str), 'invalid selected target')
    target = next((row for row in policy['targets'] if row['service'] == service), None)
    require(target is not None, 'unknown selected target')
    return target


def revoke(policy, guard, service, *, desired='revoked'):
    selected_target(policy, service)
    before = guard.create()[0] if dual_ingress(policy) else guard.state()
    active = before.get('leases')
    validate_leases(policy, active)
    guard.check(active)
    retained = {name: lease for name, lease in active.items() if name != service}
    if dual_ingress(policy):
        guard.set_desired(service, desired)
    guard.update(retained)
    return retained


def check_target(policy, guard, service):
    target = selected_target(policy, service)
    before = guard.state()
    active = before.get('leases')
    validate_leases(policy, active)
    guard.check(active)
    require(service in active and lease_ready(policy, target) == active[service], 'selected target lease drifted')
    guard.check(active)


def stop_dual(policy, guard, service=None):
    targets = policy['targets'] if service is None else [selected_target(policy, service)]
    for target in targets:
        name = target['service']
        if name in guard.create()[0]['start_intents']:
            recover_start_intent(policy, guard, name)
        state, _current = guard.create()
        owner = guard.owner(name, state)
        revoke(policy, guard, name, desired='stopped')
        info = inspect_optional(policy, target)
        validate_owner_current(policy, target, owner, info)
        if info is None:
            continue
        system = System(Config(policy, target))
        again = system.inspect(info['id'], allow_stopped=True)
        require(again == info, 'stop target changed after preflight')
        if info['running']:
            result = subprocess.run(priority.DOCKER + ['stop', '--time', '10', info['id']], capture_output=True, timeout=20, env=ENV)
            require(result.returncode == 0, 'owned ingress stop failed')
        closed = system.inspect(info['id'], allow_stopped=True)
        guard.record_closed(name, closed)


def stop(policy, guard, *, service=None):
    if dual_ingress(policy):
        return stop_dual(policy, guard, service)
    target = selected_target(policy, service) if service is not None else None
    before = guard.state()
    leases = before.get('owned_leases') or before.get('leases') or before.get('retired_leases', {})
    if target is None:
        if dual_ingress(policy):
            for row in policy['targets']:
                guard.set_desired(row['service'], 'stopped')
        guard.update({})
    else:
        revoke(policy, guard, service, desired='stopped')
    require(leases, 'no owned active cluster lease to stop')
    selected = []
    for target in (reversed(policy['targets']) if service is None else (target,)):
        expected = leases.get(target['service'])
        require(isinstance(expected, dict), 'stop lease missing target')
        validate_leases(policy, {target['service']: expected})
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


def control_path(policy):
    return Path('/run/' + policy['project'] + '.control/manager.sock')


def control_file(path, *, missing=False):
    path = deploy.no_symlink(path, missing=missing)
    parent = path.parent.stat()
    require(parent.st_uid == 0 and stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700,
            'protected root-only control directory required')
    for ancestor in path.parent.parents:
        info = ancestor.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe control directory ancestor')
    if path.exists():
        info = path.stat()
        require(info.st_uid == 0 and stat.S_ISSOCK(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600,
                'protected root-only control socket required')
        return info
    require(missing, 'manager-owned control socket unavailable')
    return None


def control_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate control field')
            value[key] = item
        return value
    require(isinstance(raw, bytes) and 0 < len(raw) <= CONTROL_LIMIT and raw.endswith(b'\n')
            and b'\n' not in raw[:-1], 'bounded single-frame control request required')
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise Refused('invalid control JSON') from None


def control_frame(connection):
    deadline = time.monotonic() + 2
    raw = b''
    while b'\n' not in raw:
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'control request deadline exceeded')
        connection.settimeout(remaining)
        chunk = connection.recv(CONTROL_LIMIT + 1 - len(raw))
        require(chunk, 'incomplete control request')
        raw += chunk
        require(len(raw) <= CONTROL_LIMIT, 'control request exceeds bound')
    return control_json(raw)


class ScopedControl:
    """The lifetime-lock owner alone mutates dual-ingress desired state and leases."""
    def __init__(self, policy, guard, expected, systems):
        require(dual_ingress(policy), 'scoped manager control requires dual ingress')
        self.policy, self.guard, self.expected, self.systems = policy, guard, expected, systems
        self.policy_sha256 = hashlib.sha256(deploy.canonical(policy)).hexdigest()

    def execute(self, request):
        require(isinstance(request, dict) and set(request) == {'version', 'policy_sha256', 'state_sha256', 'command', 'target', 'lease'}
                and type(request['version']) is int and request['version'] == 1
                and request['policy_sha256'] == self.policy_sha256
                and request['command'] in ('stop', 'revoke', 'resume'), 'invalid scoped control request')
        service = request['target']
        target = selected_target(self.policy, service)
        before, _snapshot = self.guard.create()
        self.guard.check(before['leases'])
        require(request['state_sha256'] == hashlib.sha256(deploy.canonical(before)).hexdigest(), 'stale scoped guard state')
        expected = self.guard.owner(service, before)
        require(isinstance(expected, dict) and request['lease'] == expected, 'stale scoped target ownership')
        system = System(Config(self.policy, target))
        info = (inspect_optional(self.policy, target) if expected.get('kind') == 'unadmitted'
                else system.inspect(expected['container_id'], allow_stopped=True))
        validate_owner_current(self.policy, target, expected, info, system)
        require(self.guard.state() == before, 'scoped guard state changed during target validation')
        if request['command'] == 'stop':
            stop(self.policy, self.guard, service=service)
        elif request['command'] == 'revoke':
            revoke(self.policy, self.guard, service)
        else:
            network_ready(self.policy)
            try:
                current = admit_ingress(self.policy, self.guard, target)
            except BaseException:
                try:
                    fail_ingress(self.policy, self.guard, service)
                except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
                    pass
                raise
            self.expected[service] = current
            self.systems[service] = System(Config(self.policy, target))
        return {'ok': True, 'active': len(self.guard.state()['leases'])}

    def refresh(self):
        before, _snapshot = self.guard.create()
        for service in tuple(before['start_intents']):
            try:
                recover_start_intent(self.policy, self.guard, service)
            except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
                priority.emit('cluster-ingress-start-recovery-refused', target=service)
        before, _snapshot = self.guard.create()
        self.guard.check(before['leases'])
        services = {name for name, desired in before['desired'].items() if desired == 'running'}
        current = healthy_leases(self.policy, self.expected, self.systems, services=services)
        if current != before['leases']:
            self.guard.update(current)
            priority.emit('cluster-leases-updated', active=len(current), configured=len(self.policy['targets']))
        return current


class ControlServer:
    def __init__(self, controller, path=None):
        self.controller = controller
        self.path = Path(path or control_path(controller.policy))
        require(deploy.profiles.path_allowed(self.path, controller.policy['namespace']), 'cross-profile control path refused')
        deploy.no_symlink(self.path.parent, missing=True)
        if not self.path.parent.exists():
            self.path.parent.mkdir(mode=0o700)
        require(control_file(self.path, missing=True) is None, 'existing or stale control socket refused')
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.identity = None
        try:
            self.socket.bind(str(self.path))
            # Parent0700 protects the brief bind-to-chmod interval too.
            self.path.chmod(0o600)
            info = control_file(self.path)
            self.identity = (info.st_dev, info.st_ino)
            self.socket.listen(4)
        except BaseException:
            self.close()
            raise

    def verify(self):
        info = control_file(self.path)
        require((info.st_dev, info.st_ino) == self.identity, 'control socket identity changed')

    def handle(self, connection):
        try:
            _pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            require(uid == 0, 'root peer required')
            reply = self.controller.execute(control_frame(connection))
        except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            reply = {'ok': False, 'reason': 'scoped control refused'}
        try:
            connection.sendall(json.dumps(reply, separators=(',', ':')).encode() + b'\n')
        except OSError:
            pass
        finally:
            connection.close()

    def poll(self, timeout):
        self.verify()
        self.socket.settimeout(timeout)
        try:
            connection, _address = self.socket.accept()
        except socket.timeout:
            return
        self.handle(connection)

    def close(self):
        self.socket.close()
        if self.identity is not None:
            info = control_file(self.path)
            require((info.st_dev, info.st_ino) == self.identity, 'refuse cleanup of replaced control socket')
            self.path.unlink()
            self.identity = None


def send_control(policy, guard, command, service, *, path=None):
    selected_target(policy, service)
    require(dual_ingress(policy) and command in ('stop', 'revoke', 'resume'), 'invalid scoped manager command')
    before = guard.state()
    guard.policy_binding(before)
    lease = guard.owner(service, before)
    require(isinstance(lease, dict), 'explicit ingress ownership unavailable')
    if lease.get('kind') == 'closed':
        validate_container_owner(policy, lease)
    elif lease.get('kind') == 'unadmitted':
        require(lease == unadmitted_owner(policy, selected_target(policy, service)), 'unapproved initial ingress target')
    else:
        validate_leases(policy, {service: lease})
    request = {'version': 1, 'policy_sha256': hashlib.sha256(deploy.canonical(policy)).hexdigest(),
               'state_sha256': hashlib.sha256(deploy.canonical(before)).hexdigest(),
               'command': command, 'target': service, 'lease': lease}
    path = Path(path or control_path(policy))
    require(deploy.profiles.path_allowed(path, policy['namespace']), 'cross-profile control path refused')
    control_file(path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        # Owned Docker start<=60s, priority/health startup<=90s, plus exact rechecks.
        connection.settimeout(240)
        connection.connect(str(path))
        _pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        require(uid == 0, 'root manager peer required')
        connection.sendall(json.dumps(request, separators=(',', ':')).encode() + b'\n')
        connection.shutdown(socket.SHUT_WR)
        raw = b''
        while b'\n' not in raw:
            chunk = connection.recv(CONTROL_LIMIT + 1 - len(raw))
            require(chunk, 'manager control reply unavailable')
            raw += chunk
            require(len(raw) <= CONTROL_LIMIT, 'manager control reply exceeds bound')
        reply = control_json(raw)
        require(isinstance(reply, dict) and set(reply) == {'ok', 'active'} and reply['ok'] is True
                and type(reply['active']) is int and 0 <= reply['active'] <= 2, 'manager refused scoped control')
    return reply


def serve_dual(policy, guard, expected, config_file, profile):
    systems = {target['service']: System(Config(policy, target)) for target in policy['targets']}
    controller = ScopedControl(policy, guard, expected, systems)
    server = ControlServer(controller)
    deadline = time.monotonic() + 5
    try:
        while True:
            server.poll(max(0.001, min(0.5, deadline - time.monotonic())))
            if time.monotonic() < deadline:
                continue
            require(load_policy(config_file, profile=profile) == policy, 'host policy changed; explicit controlled update required')
            network_ready(policy)
            controller.refresh()
            deadline = time.monotonic() + 5
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(deploy.profiles.PROFILES))
    parser.add_argument('--config', required=True)
    parser.add_argument('--action', required=True, choices=('guard', 'start', 'serve', 'check', 'stop', 'revoke', 'resume'))
    parser.add_argument('--target', help='exact approved service for check, revoke, stop or resume; never a container name or CID')
    args = parser.parse_args()
    if ((args.target is not None and args.action not in ('check', 'revoke', 'stop', 'resume'))
            or (args.action in ('revoke', 'resume') and args.target is None)):
        parser.error('target is supported only for check/revoke/stop/resume and is required for revoke/resume')
    policy, guard, owns_lock = None, None, False

    def interrupted(_number, _frame):
        raise Stopped()

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    try:
        require(os.geteuid() == 0, 'host root required; no container capability grant')
        policy = load_policy(args.config, profile=args.profile)
        if args.target is not None:
            selected_target(policy, args.target)
        guard = Guard(policy)
        if args.target is not None and dual_ingress(policy) and args.action in ('stop', 'revoke', 'resume'):
            reply = send_control(policy, guard, args.action, args.target)
            priority.emit('cluster-target-controlled', action=args.action, target=args.target, active=reply['active'])
            return 0
        require(args.action != 'resume', 'resume requires active dual-ingress manager')
        if args.action == 'check':
            # A live manager owns the writer lock. Read-only checks neither wait on it nor create guards.
            network_ready(policy)
            if args.target is None:
                guard.check(leases_ready(policy))
            else:
                check_target(policy, guard, args.target)
            priority.emit('cluster-checked', role=policy['host_role'], targets=len(policy['targets']) if args.target is None else 1)
            return 0
        # One host-local cluster writer; separate from all monolithic/WG-test locks and tables.
        with priority.runtime_lock('/run/' + policy['project'] + '.lock', timeout=15):
            owns_lock = True
            if args.action == 'guard':
                guard.update({})
            elif args.action == 'revoke':
                retained = revoke(policy, guard, args.target)
                priority.emit('cluster-target-revoked', target=args.target, active=len(retained))
            elif args.action == 'stop':
                stop(policy, guard, service=args.target)
            else:
                leases = start(policy, guard)
                priority.emit('cluster-started', role=policy['host_role'], targets=len(leases),
                              build=policy['build'], source_kind=policy['source_kind'])
                if args.action == 'serve' and dual_ingress(policy):
                    serve_dual(policy, guard, leases, args.config, args.profile)
                elif args.action == 'serve':
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
                guard.update({}) if args.target is None else revoke(policy, guard, args.target)
                closed = True
            except (Refused, OSError, ValueError):
                pass
        priority.emit('cluster-manager-stopped', leases_closed=closed, priority_retained=True)
        return 0 if closed else 1
    except (Refused, deploy.Refused, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        if guard is not None and owns_lock:
            try:
                guard.update({}) if args.target is None else revoke(policy, guard, args.target)
            except (Refused, OSError, ValueError):
                pass
        priority.emit('refused', reason='fixed cluster lifecycle refused; no secret or command output disclosed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
