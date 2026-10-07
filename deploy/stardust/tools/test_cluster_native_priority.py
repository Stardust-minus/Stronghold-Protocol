"""Opt-in real8+2 Node24 threads/RPC/main-only policy; Docker metadata is an injected fixture."""
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

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_native_priority_host', BASE / 'cluster-host-manager.py')
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)
ROOT = BASE.parents[2]


@unittest.skipUnless(os.environ.get('CLUSTER_NATIVE_PRIORITY') == '1' and os.geteuid() == 0,
                     'opt-in owned real Node24 process/main-TID policy check')
class NativePriorityTests(unittest.TestCase):
    profile = 'beta'
    def test_owned_eight_combat_two_trial_and_zero_other_thread_priorities(self):
        node = Path(os.environ.get('CLUSTER_NODE24', '/tmp/n24.95W3Gu/bin/node'))
        version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=5)
        self.assertEqual(version.returncode, 0)
        self.assertTrue(version.stdout.startswith('v24.'))
        root = Path(tempfile.mkdtemp(prefix='ark-cluster-native-priority-', dir='/root'))
        os.chmod(root, 0o700)
        self.addCleanup(shutil.rmtree, root)
        policy = host.deploy.generate(root / 'core', image='sha256:' + 'b' * 64,
                                      build='a' * 40, manifest_sha256='a' * 64,
                                      source_kind='tree', role='core', profile=self.profile)
        target = policy['targets'][0]
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        runtime = json.loads(Path(target['runtime_file']).read_bytes())
        runtime.update(host='127.0.0.1', port=port, keyFile=target['key_file'], coordinatorUrl='http://127.0.0.1:1')
        config = root / 'native.json'
        host.deploy.write_new(config, host.deploy.canonical(runtime), mode=0o600, gid=0)
        target = {**target, 'mappings': [{'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': port}]}
        process = subprocess.Popen([str(node), 'server/cluster/start.mjs', '--config', str(config)],
                                   cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, 'SP_COMBAT': 'server', 'SP_VERIFY': 'off', 'SP_SNAPSHOT_HZ': '10'})
        try:
            owned_pid = process.pid
            fixed = {'id': 'c' * 64, 'image_id': policy['image_id'], 'revision': policy['build'],
                     'started_at': 'injected-metadata-owned-native-process', 'restarts': 0,
                     'pid': owned_pid, 'running': True}

            class NativeSystem(host.System):
                def inspect(self, requested, **_kwargs):
                    self_test.assertIn(requested, (target['container_name'], fixed['id']))
                    if process.poll() is not None:
                        raise host.NotReady('owned native fixture exited')
                    return dict(fixed)

            self_test = self
            config_value = host.Config(policy, target)
            system = NativeSystem(config_value)
            result = host.priority.Helper(system).run(target['container_name'])
            self.assertTrue(result['configured'])
            self.assertEqual(result['main_pid'], owned_pid)
            self.assertEqual(result['main_nice'], -20)
            self.assertTrue(result['reset_on_fork'])
            snapshot = system.snapshot(target['container_name'])
            self.assertEqual(sum(thread.name == 'WorkerThread' for thread in snapshot.threads), 10)
            self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER
                                for thread in snapshot.threads if thread.tid != owned_pid))
            self.assertEqual(snapshot.main.policy, os.SCHED_OTHER | host.priority.RESET_ON_FORK)
            self.assertIsInstance(system.node_generation, str)
            self.assertGreater(len(system.node_generation), 0)
            print(json.dumps({'event': 'cluster-owned-native-priority', 'node': version.stdout.strip(),
                              'profile': self.profile, 'combatReady': 8, 'trialReady': 2, 'mainNice': -20, 'resetOnFork': True,
                              'otherThreadsNice': 0, 'dockerIdentityAcceptance': False}))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            # No diagnostic output contains raw RPC headers, node keys or game tickets.
            process.stdout.close()
            process.stderr.close()


class FormalNativePriorityTests(NativePriorityTests):
    profile = 'formal'


if __name__ == '__main__':
    unittest.main()
