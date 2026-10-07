#!/usr/bin/env python3
"""Real TCP/DNAT guard checks in fresh parent/child netns, NEVER the host namespace."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_traffic_host', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=5, env=host.ENV)
    if result.returncode:
        raise AssertionError('isolated fixture network setup failed')
    return result.stdout


def send(process, value):
    process.stdin.write(json.dumps(value) + '\n')
    process.stdin.flush()
    line = process.stdout.readline()
    if not line:
        raise AssertionError('isolated fixture child exited')
    return json.loads(line)


def emit(value):
    print(json.dumps(value), flush=True)


def child(role):
    assert os.geteuid() == 0 and os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net')
    command('/usr/sbin/ip', 'link', 'set', 'lo', 'up')
    emit({'ready': True})
    config = json.loads(sys.stdin.readline())
    interface, address = config['interface'], config['address']
    assert interface in ('entry-peer', 'foreign-peer', 'backend-peer')
    assert address in ('10.253.78.11', '10.253.78.12', '172.30.242.11')
    command('/usr/sbin/ip', 'address', 'add', address + ('/24' if role == 'backend' else '/32'), 'dev', interface)
    command('/usr/sbin/ip', 'link', 'set', interface, 'up')
    if role == 'backend':
        command('/usr/sbin/ip', 'route', 'add', 'default', 'via', '172.30.242.1')
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((address, 3000))
        listener.listen(4)

        def echo(connection):
            try:
                while True:
                    data = connection.recv(128)
                    if not data:
                        return
                    connection.sendall(data)
            finally:
                connection.close()

        def accept():
            while True:
                connection, _ = listener.accept()
                threading.Thread(target=echo, args=(connection,), daemon=True).start()

        threading.Thread(target=accept, daemon=True).start()
    else:
        command('/usr/sbin/ip', 'route', 'add', '10.253.78.2/32', 'dev', interface, 'src', address)
        command('/usr/sbin/ip', 'route', 'add', '172.30.242.0/24', 'dev', interface, 'src', address)
        if role == 'entry':
            command('/usr/sbin/ip', 'address', 'add', '10.253.78.99/32', 'dev', interface)
    emit({'configured': True})
    connection = None
    for line in sys.stdin:
        request = json.loads(line)
        assert request['op'] in ('probe', 'persistent', 'reuse')
        if role == 'backend':
            emit({'alive': True})
            continue
        address = request.get('address', '10.253.78.2')
        port = request.get('port', 35311)
        source = request.get('source')
        assert address in ('10.253.78.2', '172.30.242.11') and port in (35311, 35312, 3000)
        assert source in (None, '10.253.78.99')
        success = False
        created = request['op'] != 'reuse'
        try:
            if created:
                connection = socket.socket()
                connection.settimeout(0.4)
                if source:
                    connection.bind((source, 0))
                connection.connect((address, port))
            connection.sendall(b'guard-fixture')
            success = connection.recv(128) == b'guard-fixture'
        except (OSError, AttributeError):
            success = False
        finally:
            if connection is not None and request['op'] != 'persistent':
                connection.close()
                connection = None
        emit({'success': success})


def main():
    assert os.geteuid() == 0 and os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net')
    nft = host.Nft()
    assert not any('table' in row for row in json.loads(nft.command(['-j', 'list', 'tables']))['nftables'])
    command('/usr/sbin/ip', 'link', 'set', 'lo', 'up')
    command('/usr/sbin/sysctl', '-w', 'net.ipv4.ip_forward=1')
    root = Path(tempfile.mkdtemp(prefix='ark-cluster-traffic-', dir='/root'))
    os.chmod(root, 0o700)
    children = []
    try:
        for role in ('entry', 'foreign', 'backend'):
            process = subprocess.Popen(['/usr/bin/unshare', '--net', sys.executable, '-I', str(Path(__file__).resolve()), '--child', role],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, env=host.ENV)
            children.append(process)
            assert json.loads(process.stdout.readline()) == {'ready': True}
        entry, foreign, backend = children
        bridge = 'br-' + 'd' * 12
        command('/usr/sbin/ip', 'link', 'add', bridge, 'type', 'bridge')
        command('/usr/sbin/ip', 'address', 'add', '172.30.242.1/24', 'dev', bridge)
        command('/usr/sbin/ip', 'link', 'set', bridge, 'up')
        fixtures = [(entry, host.deploy.WG_IFACE, 'entry-peer', '10.253.78.2', '10.253.78.11'),
                    (foreign, 'foreign0', 'foreign-peer', '10.253.79.2', '10.253.78.12'),
                    (backend, 'backend0', 'backend-peer', None, '172.30.242.11')]
        for process, local, remote, parent_ip, child_ip in fixtures:
            command('/usr/sbin/ip', 'link', 'add', local, 'type', 'veth', 'peer', 'name', remote)
            command('/usr/sbin/ip', 'link', 'set', remote, 'netns', str(process.pid))
            command('/usr/sbin/ip', 'link', 'set', local, 'up')
            if parent_ip:
                command('/usr/sbin/ip', 'address', 'add', parent_ip + '/32', 'dev', local)
                command('/usr/sbin/ip', 'route', 'add', child_ip + '/32', 'dev', local, 'src', parent_ip)
            else:
                command('/usr/sbin/ip', 'link', 'set', local, 'master', bridge)
            assert send(process, {'interface': remote, 'address': child_ip}) == {'configured': True}
        command('/usr/sbin/ip', 'route', 'add', '10.253.78.99/32', 'dev', host.deploy.WG_IFACE, 'src', '10.253.78.2')
        # Mimic Docker DNAT for the intended publish and an intentionally wrong publish.
        nft.apply([{'add': {'table': {'family': 'ip', 'name': 'fixture_dnat'}}},
                   {'add': {'chain': {'family': 'ip', 'table': 'fixture_dnat', 'name': 'prerouting',
                                      'type': 'nat', 'hook': 'prerouting', 'prio': -100}}},
                   {'add': {'rule': {'family': 'ip', 'table': 'fixture_dnat', 'chain': 'prerouting', 'expr': [
                       host.match(host.ip('daddr'), '10.253.78.2'), host.match(host.tcp('dport'), {'set': [35311, 35312]}),
                       {'dnat': {'addr': '172.30.242.11', 'port': 3000}}]}}}])
        # A later broad established ACCEPT must not defeat our earlier CLOSED lease.
        nft.apply([{'add': {'table': {'family': 'inet', 'name': 'foreign_established'}}},
                   {'add': {'chain': {'family': 'inet', 'table': 'foreign_established', 'name': 'forward',
                                      'type': 'filter', 'hook': 'forward', 'prio': 0, 'policy': 'accept'}}},
                   {'add': {'rule': {'family': 'inet', 'table': 'foreign_established', 'chain': 'forward', 'expr': [
                       host.match(host.ct('state'), {'set': ['established']}), {'accept': None}]}}}])
        foreign_before = host.digest(nft.snapshot('foreign_established'))
        policy = host.deploy.generate(root / 'core', image='sha256:' + 'b' * 64, build='a' * 40,
                                      manifest_sha256='a' * 64, source_kind='tree', role='core')
        guard = host.Guard(policy, nft=nft, state_file=root / 'guard.json')
        leases = {row['service']: {'network_id': 'd' * 64, 'container_id': 'c' * 64} for row in policy['targets']}
        cases = 0
        guard.update({})
        assert send(entry, {'op': 'probe'})['success'] is False
        cases += 1
        guard.update(leases)
        assert send(entry, {'op': 'probe'})['success'] is True
        cases += 1
        assert send(entry, {'op': 'probe', 'port': 35312})['success'] is False
        cases += 1
        assert send(entry, {'op': 'probe', 'address': '172.30.242.11', 'port': 3000})['success'] is False
        cases += 1
        assert send(entry, {'op': 'probe', 'source': '10.253.78.99'})['success'] is False
        cases += 1
        assert send(foreign, {'op': 'probe'})['success'] is False
        cases += 1
        assert send(entry, {'op': 'persistent'})['success'] is True
        guard.update({})
        assert send(entry, {'op': 'reuse'})['success'] is False
        cases += 1
        assert host.digest(nft.snapshot('foreign_established')) == foreign_before
        cases += 1
        emit({'event': 'cluster-isolated-traffic-check', 'cases': cases, 'passed': cases,
              'scope': 'fresh netns actual TCP/DNAT positive/closed/wrongport/directIP/wrongpeer/foreigninterface/established-close',
              'wireguardCryptoAcceptance': False, 'dockerIdentityAcceptance': False})
        return 0
    finally:
        for process in children:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        shutil.rmtree(root)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--child' and sys.argv[2] in ('entry', 'foreign', 'backend'):
        raise SystemExit(child(sys.argv[2]))
    if len(sys.argv) == 2 and sys.argv[1] == '--isolated-netns':
        raise SystemExit(main())
    raise SystemExit('fresh isolated namespace required')
