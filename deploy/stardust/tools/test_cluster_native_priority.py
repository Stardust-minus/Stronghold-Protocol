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
import threading
import unittest
from unittest.mock import patch

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
        root = Path(tempfile.mkdtemp(prefix='ark-cluster-native-priority-', dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root')))
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


@unittest.skipUnless(os.environ.get('CLUSTER_NATIVE_PRIORITY') == '1' and os.geteuid() == 0,
                     'opt-in two owned real Node24 ingress processes/main-TID policy check')
class DualIngressNativePriorityTests(unittest.TestCase):
    profile = 'beta'

    def test_two_actual_ingress_priorities_and_single_process_failure_isolation(self):
        node = Path(os.environ.get('CLUSTER_NODE24', '/tmp/n24.95W3Gu/bin/node'))
        version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=5)
        self.assertEqual(version.returncode, 0)
        self.assertTrue(version.stdout.startswith('v24.'))
        root = Path(tempfile.mkdtemp(prefix='ark-dual-ingress-native-', dir=os.environ.get('CLUSTER_TEST_TMPDIR', '/root')))
        root.chmod(0o700)
        self.addCleanup(shutil.rmtree, root)
        policy = host.deploy.generate(root / 'edge', image='sha256:' + 'b' * 64, build='a' * 40,
                                      manifest_sha256='a' * 64, source_kind='tree', role='edge',
                                      profile=self.profile, ingress_instances=2)
        processes, systems, leases, launch_configs = [], {}, {}, {}
        try:
            for index, original in enumerate(policy['targets'], 1):
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', 0))
                    port = listener.getsockname()[1]
                runtime = json.loads(Path(original['runtime_file']).read_bytes())
                # Only fresh local ephemeral listeners; never probe cluster/production endpoints.
                runtime.update(host='127.0.0.1', port=port, coordinatorUrl='http://127.0.0.1:1',
                               nodes=[{'nodeId': 'game-' + format(i, '02d'), 'url': 'http://127.0.0.1:1'} for i in range(1, 17)])
                config = root / ('native-' + str(index) + '.json')
                host.deploy.write_new(config, host.deploy.canonical(runtime), mode=0o600, gid=0)
                target = {**original, 'mappings': [{'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': port}]}
                process = subprocess.Popen([str(node), 'server/cluster/start.mjs', '--config', str(config)],
                                           cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           env={**os.environ, 'SP_COMBAT': 'server', 'SP_VERIFY': 'off', 'SP_SNAPSHOT_HZ': '10'})
                processes.append(process)
                fixed = {'id': format(index, '064x'), 'image_id': policy['image_id'], 'revision': policy['build'],
                         'started_at': 'injected-owned-native-ingress-' + str(index), 'restarts': 0,
                         'pid': process.pid, 'running': True, 'network_id': 'd' * 64}
                class NativeSystem(host.System):
                    def __init__(self, config, owned, metadata):
                        super().__init__(config)
                        self.owned, self.metadata = owned, metadata
                    def inspect(self, requested, **_kwargs):
                        if requested not in (self.config.target['container_name'], self.metadata['id']):
                            raise host.Refused('native fixture selector mismatch')
                        if self.owned.poll() is not None:
                            if not _kwargs.get('allow_stopped'):
                                raise host.NotReady('owned native ingress exited')
                            self.last_info = {**self.metadata, 'running': False, 'pid': 0}
                            return self.last_info
                        self.last_info = dict(self.metadata)
                        return self.last_info
                system = NativeSystem(host.Config(policy, target), process, fixed)
                result = host.priority.Helper(system).run(target['container_name'])
                self.assertTrue(result['configured'])
                snapshot = system.snapshot(target['container_name'])
                self.assertEqual(snapshot.main.nice, -20)
                self.assertEqual(snapshot.main.policy, os.SCHED_OTHER | host.priority.RESET_ON_FORK)
                self.assertEqual(sum(thread.name == 'WorkerThread' for thread in snapshot.threads), 0)
                self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER
                                    for thread in snapshot.threads if thread.tid != process.pid))
                systems[original['service']] = system
                launch_configs[original['service']] = config
                leases[original['service']] = host.lease_ready(policy, original, system=system)
            host.validate_leases(policy, leases)
            self.assertEqual(host.healthy_leases(policy, leases, systems), leases)
            sibling = leases['ingress-02']
            fixture_spec = importlib.util.spec_from_file_location('native_dual_memory_nft', BASE / 'test_cluster_deploy.py')
            fixtures = importlib.util.module_from_spec(fixture_spec)
            sys.modules[fixture_spec.name] = fixtures; fixture_spec.loader.exec_module(fixtures)
            guard = host.Guard(policy, nft=fixtures.MemoryNft(), state_file=root / 'native.guard.json')
            guard.update(leases)
            ready, done = threading.Event(), threading.Event()
            failures = []
            control_socket, control_lock = root / 'manager.sock', root / 'manager.lock'
            def stop_owned(arguments, **_kwargs):
                self.assertEqual(arguments[:len(host.priority.DOCKER) + 1], host.priority.DOCKER + ['stop'])
                owned = next(system for system in systems.values() if system.metadata['id'] == arguments[-1])
                owned.owned.terminate(); owned.owned.wait(timeout=20)
                return subprocess.CompletedProcess(arguments, 0)
            def resume_owned(_policy, *, services):
                for name in services:
                    system = systems[name]
                    if system.owned.poll() is None: continue
                    process = subprocess.Popen([str(node), 'server/cluster/start.mjs', '--config', str(launch_configs[name])],
                                               cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                               env={**os.environ, 'SP_COMBAT': 'server', 'SP_VERIFY': 'off', 'SP_SNAPSHOT_HZ': '10'})
                    processes.append(process)
                    system.owned = process
                    system.metadata = {**system.metadata, 'pid': process.pid,
                                       'started_at': system.metadata['started_at'] + '-resumed'}
            def owner():
                try:
                    with host.priority.runtime_lock(str(control_lock), timeout=1):
                        controller = host.ScopedControl(policy, guard, leases, systems)
                        server = host.ControlServer(controller, path=control_socket)
                        ready.set()
                        try:
                            while not done.is_set():
                                server.poll(0.05); controller.refresh()
                        finally:
                            server.close()
                except BaseException as failure:
                    failures.append(failure); ready.set()
            actual_lease_ready = host.lease_ready
            with patch.object(host, 'System', lambda config: systems[config.target['service']]), \
                    patch.object(host, 'network_ready', lambda _policy: None), patch.object(host, 'compose_start', resume_owned), \
                    patch.object(host.subprocess, 'run', stop_owned):
                guard.update({})
                def initial_failure(_policy, target, **kwargs):
                    if target['service'] == 'ingress-02': raise host.NotReady('injected actual initial ingress readiness failure')
                    return actual_lease_ready(_policy, target, **kwargs)
                with patch.object(host, 'lease_ready', initial_failure):
                    admitted = host.start(policy, guard)
                self.assertEqual(set(admitted), {'ingress'})
                self.assertEqual(guard.state()['desired']['ingress-02'], 'revoked')
                leases.clear(); leases.update(admitted)
                thread = threading.Thread(target=owner, daemon=True); thread.start()
                try:
                    self.assertTrue(ready.wait(5))
                    if failures: raise failures[0]
                    with self.assertRaises(host.Refused):
                        with host.priority.runtime_lock(str(control_lock), timeout=0.01): pass
                    host.send_control(policy, guard, 'resume', 'ingress-02', path=control_socket)
                    self.assertEqual(guard.state()['leases']['ingress'], admitted['ingress'])
                    self.assertEqual(set(guard.state()['leases']), {'ingress', 'ingress-02'})
                    host.send_control(policy, guard, 'revoke', 'ingress', path=control_socket)
                    self.assertIsNone(systems['ingress'].owned.poll())
                    self.assertEqual(guard.state()['leases'], {'ingress-02': sibling})
                    host.send_control(policy, guard, 'resume', 'ingress', path=control_socket)
                    old_generation = leases['ingress']['main_start']
                    host.send_control(policy, guard, 'stop', 'ingress', path=control_socket)
                    self.assertIsNotNone(systems['ingress'].owned.poll())
                    self.assertIsNone(systems['ingress-02'].owned.poll())
                    self.assertEqual(guard.state()['desired']['ingress'], 'stopped')
                    self.assertEqual(guard.state()['leases'], {'ingress-02': sibling})
                    def failed_resume(_policy, target, **kwargs):
                        if target['service'] == 'ingress' and kwargs.get('apply'):
                            raise host.NotReady('injected actual resume health/apply failure')
                        return actual_lease_ready(_policy, target, **kwargs)
                    with patch.object(host, 'lease_ready', failed_resume):
                        with self.assertRaises(host.Refused):
                            host.send_control(policy, guard, 'resume', 'ingress', path=control_socket)
                    warm_owner = guard.owner('ingress')
                    self.assertNotEqual(warm_owner['main_start'], old_generation)
                    self.assertEqual(guard.state()['leases'], {'ingress-02': sibling})
                    self.assertEqual(guard.state()['desired']['ingress'], 'revoked')
                    self.assertEqual(guard.state()['start_intents'], {})
                    host.send_control(policy, guard, 'resume', 'ingress', path=control_socket)
                    self.assertNotEqual(leases['ingress']['main_start'], old_generation)
                    self.assertEqual(guard.state()['leases']['ingress-02'], sibling)
                    snapshot = systems['ingress'].snapshot(policy['targets'][0]['container_name'])
                    self.assertEqual(snapshot.main.nice, -20)
                    self.assertEqual(snapshot.main.policy, os.SCHED_OTHER | host.priority.RESET_ON_FORK)
                    self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER
                                        for thread in snapshot.threads if thread.tid != snapshot.main.tid))
                finally:
                    done.set(); thread.join(5)
                    self.assertFalse(thread.is_alive())
                    if failures: raise failures[0]
                    self.assertFalse(control_socket.exists())
            systems['ingress'].owned.terminate(); systems['ingress'].owned.wait(timeout=20)
            self.assertEqual(host.healthy_leases(policy, leases, systems), {'ingress-02': sibling})
            self.assertIsNone(processes[1].poll())
            self.assertEqual(host.lease_ready(policy, policy['targets'][1], system=systems['ingress-02']), sibling)
            print(json.dumps({'event': 'cluster-owned-dual-ingress-native-priority', 'node': version.stdout.strip(),
                              'profile': self.profile, 'ingressProcesses': 2, 'mainNice': -20,
                              'resetOnFork': True, 'otherThreadsNice': 0, 'workersPerIngress': 0,
                              'singleProcessFailureIsolated': True, 'lifetimeWriterLock': True,
                              'managerOwnedUnixControl': True, 'scopedStopResume': True,
                              'initialFailureSiblingAdmission': True, 'failedResumeOwnershipRetry': True,
                              'dockerIdentityAcceptance': False, 'kernelTrafficAcceptance': False}))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=3)
                process.stdout.close(); process.stderr.close()


class FormalDualIngressNativePriorityTests(DualIngressNativePriorityTests):
    profile = 'formal'


if __name__ == '__main__':
    unittest.main()
