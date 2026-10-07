"""Opt-in ONE owned local Docker8+2 role: real UID/cgroup/health, shuffled Mounts regression."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import uuid

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('actual_cluster_docker_priority', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)


@unittest.skipUnless(os.environ.get('CLUSTER_DOCKER_PRIORITY') == '1' and os.geteuid() == 0,
                     'opt-in ONE own local Docker role; no remote operations')
class DockerPriorityTests(unittest.TestCase):
    def test_real_docker_uid1000_role_with_reordered_mounts_gets_only_main_minus_twenty(self):
        image_id = os.environ.get('CLUSTER_PRIORITY_IMAGE', 'sha256:7a4422123bfa8fba6d30c52a2bbb9db84714370b9db5f9637ce73ddd515f8b66')
        image = subprocess.run(host.priority.DOCKER + ['image', 'inspect', '--format', host.priority.formatter({
            **host.priority.IMAGE_FIELDS, 'kind': '(index .Config.Labels "cn.stardust.cluster.source-kind")',
            'manifest': '(index .Config.Labels "cn.stardust.cluster.manifest-sha256")'}) , image_id],
            capture_output=True, text=True, timeout=5, env=host.ENV)
        self.assertEqual(image.returncode, 0, 'fixed local frozen image required')
        image = json.loads(image.stdout)
        self.assertEqual(image['id'], image_id)
        self.assertEqual(image['source'], host.deploy.SOURCE)
        self.assertEqual(image['kind'], 'tree')
        self.assertEqual(image['revision'], image['manifest'][:40])
        root = Path(tempfile.mkdtemp(prefix='ark-cluster-docker-priority-', dir='/root'))
        os.chmod(root, 0o700)
        project = 'ark-cluster-priority-regression-' + uuid.uuid4().hex[:10]
        name, network_name = project + '-game-01', project + '_default'
        cid, network_id = None, None
        try:
            policy = host.deploy.generate(root / 'bundle', image=image_id, build=image['revision'],
                                          manifest_sha256=image['manifest'], source_kind='tree', role='core')
            target = policy['targets'][0]
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            # Scope the injected single-role test policy to an exclusively owned network/port.
            # The application/image, validation code, actual Docker data and health are REAL.
            policy.update(project=project, subnet='172.30.250.0/24')
            target.update(project=project, container_name=name, container_ip='172.30.250.11',
                          mappings=[{'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': port}])
            runtime_file = Path(target['runtime_file'])
            runtime = json.loads(runtime_file.read_bytes())
            runtime['coordinatorUrl'] = 'http://127.0.0.1:1'
            raw = host.deploy.canonical(runtime)
            os.chmod(runtime_file, 0o640)
            runtime_file.write_bytes(raw)
            os.chmod(runtime_file, 0o440)
            target['runtime_sha256'] = host.hashlib.sha256(raw).hexdigest()
            created = subprocess.run(host.priority.DOCKER + ['network', 'create', '--driver', 'bridge',
                '--subnet', policy['subnet'], '--gateway', '172.30.250.1',
                '--label', 'com.docker.compose.project=' + project, '--label', 'com.docker.compose.network=default', network_name],
                capture_output=True, text=True, timeout=10, env=host.ENV)
            self.assertEqual(created.returncode, 0, 'own test bridge unavailable; no unrelated network is changed')
            network_id = created.stdout.strip()
            self.assertTrue(host.priority.CID.fullmatch(network_id))
            args = host.priority.DOCKER + ['run', '-d', '--pull=never', '--name', name, '--init', '--restart=no',
                '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=128', '--user=1000:1000',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--network', network_name, '--ip', target['container_ip'],
                '--publish', '127.0.0.1:' + str(port) + ':3000',
                '--label', 'com.docker.compose.project=' + project, '--label', 'com.docker.compose.service=game-01',
                '--label', 'cn.stardust.cluster.role=game', '--label', 'cn.stardust.cluster.namespace=beta',
                '--volume', str(runtime_file.parent) + ':/run/config:ro',
                '--volume', target['key_file'] + ':/run/secrets/game.key:ro',
                image_id, 'node', 'server/cluster/start.mjs', '--config', '/run/config/runtime.json']
            created = subprocess.run(args, capture_output=True, text=True, timeout=30, env=host.ENV)
            self.assertEqual(created.returncode, 0, 'own test role startup failed')
            cid = created.stdout.strip()
            self.assertTrue(host.priority.CID.fullmatch(cid))

            class ShuffledMountSystem(host.System):
                reads = 0

                def docker(self, *arguments):
                    value = super().docker(*arguments)
                    if arguments[0] == 'container':
                        self.reads += 1
                        # Simulate the proven classic-engine map-order variation on every read.
                        value['mounts'] = sorted(value['mounts'], key=lambda row: row['Destination'], reverse=bool(self.reads % 2))
                    return value

            system = ShuffledMountSystem(host.Config(policy, target))
            result = host.priority.Helper(system).run(name)
            self.assertTrue(result['configured'])
            self.assertEqual(result['container_id'], cid)
            snapshot = system.snapshot(name)
            self.assertEqual(snapshot.main.nice, -20)
            self.assertEqual(snapshot.main.policy, os.SCHED_OTHER | host.priority.RESET_ON_FORK)
            self.assertEqual(sum(thread.name == 'WorkerThread' for thread in snapshot.threads), 10)
            self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER
                                for thread in snapshot.threads if thread.tid != snapshot.main.tid))
            status = system.read('/proc/' + str(snapshot.main.tid) + '/status')
            self.assertIn('Uid:\t1000\t1000\t1000\t1000\n', status)
            lease = host.lease_ready(policy, target, system=system)
            self.assertEqual(lease['container_id'], cid)
            self.assertEqual(lease['main_pid'], snapshot.main.tid)
            self.assertGreater(system.reads, 4)
            print(json.dumps({'event': 'owned-real-docker-priority', 'node': 'frozenNode24',
                'actualUid': 1000, 'actualCombatReady': 8, 'actualTrialReady': 2, 'mainNice': -20,
                'resetOnFork': True, 'otherThreadsNice': 0, 'alternatingMountOrder': True,
                'dockerIdentityAcceptance': True, 'fixed16ProfileAcceptance': False}))
        finally:
            # Cleanup only this newly-created immutable container/network, never a reused name.
            if cid:
                fmt = host.priority.formatter({'id': '.Id', 'name': '.Name', 'image': '.Image',
                    'project': '(index .Config.Labels "com.docker.compose.project")'})
                checked = subprocess.run(host.priority.DOCKER + ['container', 'inspect', '--format', fmt, cid],
                                         capture_output=True, text=True, timeout=5, env=host.ENV)
                if checked.returncode == 0:
                    info = json.loads(checked.stdout)
                    self.assertEqual(info, {'id': cid, 'name': '/' + name, 'image': image_id, 'project': project})
                    stopped = subprocess.run(host.priority.DOCKER + ['stop', '--time', '10', cid],
                                             capture_output=True, timeout=20, env=host.ENV)
                    self.assertEqual(stopped.returncode, 0)
                    removed = subprocess.run(host.priority.DOCKER + ['rm', cid], capture_output=True, timeout=10, env=host.ENV)
                    self.assertEqual(removed.returncode, 0)
            if network_id:
                checked = subprocess.run(host.priority.DOCKER + ['network', 'inspect', '--format', host.priority.formatter({
                    'id': '.Id', 'name': '.Name', 'labels': '.Labels', 'containers': '.Containers'}), network_id],
                    capture_output=True, text=True, timeout=5, env=host.ENV)
                self.assertEqual(checked.returncode, 0)
                info = json.loads(checked.stdout)
                self.assertEqual(info['id'], network_id)
                self.assertEqual(info['name'], network_name)
                self.assertEqual(info['labels']['com.docker.compose.project'], project)
                self.assertFalse(info['containers'])
                removed = subprocess.run(host.priority.DOCKER + ['network', 'rm', network_id], capture_output=True, timeout=10, env=host.ENV)
                self.assertEqual(removed.returncode, 0)
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
