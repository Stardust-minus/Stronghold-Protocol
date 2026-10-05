import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('main_thread_priority', Path(__file__).with_name('main-thread-priority.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
REV = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
CID = 'c' * 64
CONFIG = m.Config(((REV, IMAGE),))


def image():
    return {'id': IMAGE, 'revision': REV, 'source': m.SOURCE}


def info():
    return {'id': CID, 'name': '/ark-proto', 'project': 'ark-proto', 'service': 'ark-proto',
            'pid': 100, 'running': True, 'restarting': False, 'started_at': 'test-start', 'restarts': 0,
            'image_id': IMAGE, 'revision': REV, 'source': m.SOURCE, 'init': True, 'readonly': True,
            'privileged': False, 'cap_drop': ['ALL'], 'cap_add': None,
            'security_opt': ['no-new-privileges:true'], 'pids': 128,
            'cpu_quota': 0, 'nano_cpus': 0, 'cpuset': '', 'memory': 0,
            'ports': [{'HostIp': '127.0.0.1', 'HostPort': '3120'}]}


def health():
    return {'ok': True, 'maxRooms': 4096, 'combat': {'status': 'ready', 'workers': 6, 'ready': 6},
            'trial': {'status': 'ready', 'workers': 1, 'ready': 1}}


class FakeSystem:
    def __init__(self, config=CONFIG):
        self.config = config
        self.generation = m.Generation(CID, IMAGE, REV, 'test-start', 0, 100, 10, 101, 11)
        self.nice, self.policy = 0, os.SCHED_OTHER
        self.helpers = [m.Thread(102 + i, 'WorkerThread', 0, os.SCHED_OTHER, 20 + i) for i in range(7)]
        self.helpers.append(m.Thread(109, 'libuv-worker', 0, os.SCHED_OTHER, 30))
        self.calls = []
        self.before_snapshot = None
        self.before_mutation = None
        self.ready = True

    def snapshot(self, target, ready=True):
        if self.before_snapshot:
            self.before_snapshot(self, ready)
        if ready and not self.ready:
            raise m.NotReady('fixture not ready')
        snapshot = m.Snapshot(self.generation, (m.Thread(self.generation.main_pid, 'MainThread',
                              self.nice, self.policy, self.generation.main_start), *self.helpers))
        if ready:
            m.validate_threads(snapshot)
        return snapshot

    def mutate(self, kind, tid, value):
        self.calls.append((kind, tid, value))
        if self.before_mutation:
            self.before_mutation(self, kind, tid, value)
        if kind == 'policy':
            self.policy = value
        else:
            self.nice = value

    def set_policy(self, tid, value):
        self.mutate('policy', tid, value)

    def set_nice(self, tid, value):
        self.mutate('nice', tid, value)


class PolicyTests(unittest.TestCase):
    def run_helper(self, system, check=False):
        with redirect_stdout(io.StringIO()):
            return m.Helper(system).run('ark-proto', check=check)

    def test_config_defaults_and_explicit_restore(self):
        value = {'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
        self.assertEqual(m.Config.parse(value), CONFIG)
        self.assertEqual(m.Config.parse({**value, 'nice': 0}).nice, 0)
        self.assertEqual(json.loads(Path(__file__).parents[1].joinpath('main-thread-priority.example.json').read_text())['nice'], -20)

    def test_config_requires_exact_image_revision_pairs(self):
        valid = {'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
        for value in ({}, {'approved_images': []}, {**valid, 'nice': -10}, {**valid, 'nice': True},
                      {**valid, 'startup_timeout_seconds': 0}, {**valid, 'project': 'auth'},
                      {'approved_images': [{'revision': 'short', 'image_id': IMAGE}]},
                      {'approved_images': [{'revision': REV, 'image_id': 'mutable-tag'}]}):
            with self.subTest(value=value), self.assertRaises(m.Refused):
                m.Config.parse(value)

    def test_config_file_rejects_symlink_and_writable_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'approved_images': [{'revision': REV, 'image_id': IMAGE}]}))
            os.chmod(path, 0o666)
            with self.assertRaises(m.Refused):
                m.load_config(path)
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                m.load_config(link)

    def test_metadata_accepts_only_game_baseline(self):
        m.validate_info(info(), image(), CONFIG)
        changes = {'name': '/ark-proto-auth', 'service': 'auth', 'project': 'other',
                   'revision': 'd' * 40, 'image_id': 'sha256:' + 'e' * 64, 'source': 'other',
                   'init': False, 'readonly': False, 'privileged': True, 'cap_add': ['SYS_NICE'],
                   'cap_drop': [], 'security_opt': [], 'pids': 256, 'cpu_quota': 100,
                   'nano_cpus': 1, 'cpuset': '0', 'memory': 100,
                   'ports': [{'HostIp': '0.0.0.0', 'HostPort': '3120'}]}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.validate_info({**info(), key: value}, image(), CONFIG)

    def test_image_labels_cannot_be_overridden_by_container(self):
        for value in ({**image(), 'revision': 'e' * 40}, {**image(), 'source': 'other'}, {**image(), 'id': 'other'}):
            with self.subTest(value=value), self.assertRaises(m.Refused):
                m.validate_info(info(), value, CONFIG)

    def test_stopped_restarting_and_missing_pid_are_not_ready(self):
        for key, value in (('running', False), ('restarting', True), ('pid', 0), ('pid', True)):
            with self.subTest(key=key), self.assertRaises(m.NotReady):
                m.validate_info({**info(), key: value}, image(), CONFIG)

    def test_health_is_explicit_six_plus_one_not_merely_ok(self):
        self.assertTrue(m.health_ready(health()))
        for key in ('combat', 'trial'):
            for field, value in (('ready', 0), ('status', 'degraded'), ('workers', 0)):
                changed = health()
                changed[key][field] = value
                self.assertFalse(m.health_ready(changed))
        self.assertFalse(m.health_ready({**health(), 'maxRooms': 1}))
        self.assertFalse(m.health_ready({'ok': True}))
        self.assertFalse(m.health_ready(None))

    def test_proc_stat_parsing_handles_parentheses_in_name(self):
        fields = ['S', '100'] + ['0'] * 14 + ['-20', '8', '0', '123']
        value = m.proc_stat('101 (Main(Thread)) ' + ' '.join(fields))
        self.assertEqual(value['name'], 'Main(Thread)')
        self.assertEqual((value['ppid'], value['nice'], value['start_ticks']), (100, -20, 123))
        with self.assertRaises(m.Refused):
            m.proc_stat('broken')

    def test_only_node_main_not_init_is_mutated_reset_before_nice(self):
        system = FakeSystem()
        result = self.run_helper(system)
        self.assertEqual(system.calls, [('policy', 101, m.RESET_ON_FORK), ('nice', 101, -20)])
        self.assertTrue(result['configured'])
        self.assertTrue(result['reset_on_fork'])
        self.assertTrue(all(thread.nice == 0 for thread in system.helpers))

    def test_existing_manual_minus20_is_not_restored_zero(self):
        system = FakeSystem()
        system.nice = -20
        self.run_helper(system)
        self.assertEqual(system.calls, [('policy', 101, m.RESET_ON_FORK)])
        self.assertEqual(system.nice, -20)

    def test_idempotent_duplicate_start_has_no_syscalls(self):
        system = FakeSystem()
        self.run_helper(system)
        system.calls.clear()
        result = self.run_helper(system)
        self.assertFalse(result['changed'])
        self.assertEqual(system.calls, [])

    def test_check_is_read_only_without_runtime_lock(self):
        system = FakeSystem()
        result = self.run_helper(system, check=True)
        self.assertFalse(result['configured'])
        self.assertEqual(system.calls, [])

    def test_unknown_nice_realtime_or_helper_priority_is_refused(self):
        for nice, policy in ((-10, 0), (0, os.SCHED_FIFO)):
            system = FakeSystem()
            system.nice, system.policy = nice, policy
            with self.assertRaises(m.Refused):
                self.run_helper(system)
            self.assertEqual(system.calls, [])
        system = FakeSystem()
        system.helpers[0] = replace(system.helpers[0], nice=-20)
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual(system.calls, [])

    def test_deadline_and_missing_worker_do_not_mutate(self):
        system = FakeSystem()
        system.helpers.pop(0)
        ticks = [0]
        def sleep(seconds):
            ticks[0] += seconds
        with self.assertRaisesRegex(m.Refused, 'deadline'):
            m.Helper(system, clock=lambda: ticks[0], sleep=sleep).run('ark-proto')
        self.assertEqual(system.calls, [])
        self.assertEqual(ticks[0], 90)

    def test_pid_reuse_before_mutation_is_refused(self):
        system = FakeSystem()
        count = [0]
        def hook(current, ready):
            count[0] += 1
            if count[0] == 2:
                current.generation = replace(current.generation, main_start=99)
        system.before_snapshot = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual(system.calls, [])

    def test_container_restart_before_mutation_is_refused(self):
        for field, value in (('container_id', 'd' * 64), ('init_start', 999), ('restarts', 1)):
            system = FakeSystem()
            count = [0]
            def hook(current, ready):
                count[0] += 1
                if count[0] == 2:
                    current.generation = replace(current.generation, **{field: value})
            system.before_snapshot = hook
            with self.subTest(field=field), self.assertRaises(m.Refused):
                self.run_helper(system)
            self.assertEqual(system.calls, [])

    def test_permission_failure_rolls_back_only_our_flag(self):
        system = FakeSystem()
        def hook(current, kind, tid, value):
            if kind == 'nice' and value == -20:
                raise PermissionError()
        system.before_mutation = hook
        with self.assertRaises(PermissionError):
            self.run_helper(system)
        self.assertEqual((system.nice, system.policy), (0, 0))
        self.assertEqual(system.calls[-1], ('policy', 101, 0))

    def test_reset_readback_must_succeed_before_nice(self):
        system = FakeSystem()
        def hook(current, ready):
            if current.calls:
                current.policy = 0
        system.before_snapshot = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertFalse(any(kind == 'nice' for kind, *_ in system.calls))

    def test_signal_during_transaction_restores_own_values(self):
        system = FakeSystem()
        def hook(current, kind, tid, value):
            if kind == 'nice' and value == -20:
                raise m.Stopped()
        system.before_mutation = hook
        with self.assertRaises(m.Stopped):
            self.run_helper(system)
        self.assertEqual((system.nice, system.policy), (0, 0))

    def test_failure_after_successful_boost_restores_in_reverse_order(self):
        system = FakeSystem()
        failed = [False]
        def hook(current, ready):
            if ready and current.nice == -20 and not failed[0]:
                failed[0] = True
                raise m.Refused('postcheck fixture failure')
        system.before_snapshot = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual(system.calls[-2:], [('nice', 101, 0), ('policy', 101, 0)])

    def test_rollback_preserves_original_manual_minus20(self):
        system = FakeSystem()
        system.nice = -20
        failed = [False]
        def hook(current, ready):
            if ready and current.policy and not failed[0]:
                failed[0] = True
                raise m.Refused('postcheck fixture failure')
        system.before_snapshot = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual((system.nice, system.policy), (-20, 0))
        self.assertFalse(any(kind == 'nice' for kind, *_ in system.calls))

    def test_rollback_does_not_overwrite_external_change(self):
        system = FakeSystem()
        def hook(current, kind, tid, value):
            if kind == 'nice':
                current.nice = -10
                raise m.Refused('external change fixture')
        system.before_mutation = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual((system.nice, system.policy), (-10, m.RESET_ON_FORK))
        self.assertEqual(len(system.calls), 2)

    def test_rollback_does_not_mutate_reused_pid(self):
        system = FakeSystem()
        def hook(current, kind, tid, value):
            if kind == 'nice':
                current.generation = replace(current.generation, main_start=999)
                raise m.Refused('PID reused fixture')
        system.before_mutation = hook
        with self.assertRaises(m.Refused):
            self.run_helper(system)
        self.assertEqual(len(system.calls), 2)

    def test_explicit_restore_zero_clears_flag_after_nice(self):
        system = FakeSystem(replace(CONFIG, nice=0))
        system.nice, system.policy = -20, m.RESET_ON_FORK
        result = self.run_helper(system)
        self.assertEqual(system.calls, [('nice', 101, 0), ('policy', 101, 0)])
        self.assertTrue(result['configured'])

    def test_local_docker_does_not_inherit_context_or_return_secrets(self):
        payload = json.dumps({'id': CID})
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, payload, 'secret')) as run:
            m.System(CONFIG).docker('container', 'inspect', '--format', m.formatter(m.INSPECT_FIELDS), 'ark-proto')
        args, kwargs = run.call_args
        self.assertEqual(args[0][:2], m.DOCKER)
        self.assertNotIn('DOCKER_CONTEXT', kwargs['env'])
        self.assertNotIn('DOCKER_HOST', kwargs['env'])
        self.assertNotIn('.Config.Env', args[0][5])
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'SECRET')), self.assertRaises(m.NotReady) as error:
            m.System(CONFIG).docker('inspect')
        self.assertNotIn('SECRET', str(error.exception))

    def test_init_and_node_are_resolved_with_same_cgroup(self):
        system = m.System(CONFIG)
        def value(pid, name):
            return f'{pid} ({name}) S 1 ' + ' '.join(['0'] * 14 + ['0', '8', '0', str(pid)])
        files = {'/proc/100/cgroup': 'same', '/proc/101/cgroup': 'same',
                 '/proc/100/stat': value(100, 'docker-init'), '/proc/101/stat': value(101, 'MainThread'),
                 '/proc/100/task/100/children': '101', '/proc/101/task/101/children': '',
                 '/proc/101/status': 'Tgid:\t101\n'}
        with patch.object(system, 'read', side_effect=lambda path, *args: files[str(path)]), patch.object(m.os, 'readlink', return_value='/usr/local/bin/node'):
            self.assertEqual(system.node(100), (101, 101))
            files['/proc/101/cgroup'] = 'other'
            with self.assertRaises(m.Refused):
                system.node(100)

    def test_multiple_node_processes_are_refused(self):
        system = m.System(CONFIG)
        def read(path, *args):
            path = str(path)
            pid = int(path.split('/')[2])
            if path.endswith('/cgroup'):
                return 'same'
            if path.endswith('/children'):
                return '101 102' if pid == 100 else ''
            if path.endswith('/status'):
                return f'Tgid:\t{pid}\n'
            return f'{pid} ({"docker-init" if pid == 100 else "MainThread"}) S 1 ' + ' '.join(['0'] * 14 + ['0', '8', '0', str(pid)])
        with patch.object(system, 'read', side_effect=read), patch.object(m.os, 'readlink', return_value='/usr/local/bin/node'), self.assertRaises(m.Refused):
            system.node(100)

    def test_event_cursor_filters_and_fixed_socket(self):
        command = m.events_command(CONFIG, 'start-time')
        self.assertEqual(command[:2], m.DOCKER)
        self.assertIn('start-time', command)
        self.assertIn('event=start', command)
        self.assertIn('label=com.docker.compose.service=ark-proto', command)
        self.assertEqual(command[-1], '{{.Actor.ID}}')

    def test_watcher_scans_before_consuming_duplicate_start_events(self):
        stream = unittest.mock.Mock()
        stream.stdout = io.StringIO(CID + '\nmalformed\n' + CID + '\n')
        stream.poll.return_value = 0
        targets = []
        watcher = m.Watcher(lambda: CONFIG, popen=lambda *args, **kwargs: stream)
        watcher.handle = targets.append
        with self.assertRaises(m.NotReady):
            watcher.cycle()
        self.assertEqual(targets, ['ark-proto', CID, CID])
        self.assertTrue(stream.stdout.closed)

    def test_watcher_reload_config_for_each_generation(self):
        system = FakeSystem()
        loads = []
        watcher = m.Watcher(lambda: loads.append(1) or CONFIG, system_factory=lambda config: system)
        with redirect_stdout(io.StringIO()):
            watcher.handle(CID)
            system.generation = replace(system.generation, container_id='d' * 64, main_start=999)
            system.nice, system.policy = 0, 0
            watcher.handle('d' * 64)
        self.assertEqual(len(loads), 2)
        self.assertEqual(sum(kind == 'nice' for kind, *_ in system.calls), 2)

    def test_watcher_retries_transient_guard_after_confirmed_rollback(self):
        system = FakeSystem()
        transient = [True]
        def hook(current, ready):
            if ready and current.policy == m.RESET_ON_FORK and transient[0]:
                transient[0] = False
                raise m.NotReady('transient post-readiness check')
        system.before_snapshot = hook
        delays = []
        watcher = m.Watcher(lambda: CONFIG, system_factory=lambda config: system, sleep=delays.append)
        with redirect_stdout(io.StringIO()):
            watcher.handle(CID)
        self.assertEqual(delays, [0.25])
        self.assertEqual((system.nice, system.policy), (-20, m.RESET_ON_FORK))
        self.assertEqual(system.calls[:2], [('policy', 101, m.RESET_ON_FORK), ('policy', 101, 0)])

    def test_watcher_retries_transient_before_mutation(self):
        system = FakeSystem()
        count = [0]
        def hook(current, ready):
            count[0] += 1
            if count[0] == 2:
                raise m.NotReady('transient proc disappearance')
        system.before_snapshot = hook
        delays = []
        watcher = m.Watcher(lambda: CONFIG, system_factory=lambda config: system, sleep=delays.append)
        with redirect_stdout(io.StringIO()):
            watcher.handle(CID)
        self.assertEqual(delays, [0.25])
        self.assertEqual(len(system.calls), 2)
        self.assertEqual(system.nice, -20)

    def test_watcher_transient_retry_budget_is_bounded(self):
        system = FakeSystem()
        def hook(current, ready):
            if ready and current.policy == m.RESET_ON_FORK:
                raise m.NotReady('still transient')
        system.before_snapshot = hook
        delays = []
        watcher = m.Watcher(lambda: CONFIG, system_factory=lambda config: system, sleep=delays.append)
        with redirect_stdout(io.StringIO()) as output:
            watcher.handle(CID)
        self.assertEqual(delays, [0.25, 0.5])
        self.assertEqual(system.calls.count(('policy', 101, m.RESET_ON_FORK)), 3)
        self.assertEqual((system.nice, system.policy), (0, 0))
        self.assertIn('retry budget exhausted', output.getvalue())

    def test_watcher_unconfirmed_rollback_is_not_retried(self):
        system = FakeSystem()
        def hook(current, ready):
            if ready and current.policy == m.RESET_ON_FORK:
                current.generation = replace(current.generation, main_start=999)
                raise m.NotReady('process replaced during check')
        system.before_snapshot = hook
        delays = []
        watcher = m.Watcher(lambda: CONFIG, system_factory=lambda config: system, sleep=delays.append)
        with redirect_stdout(io.StringIO()) as output:
            watcher.handle(CID)
        self.assertEqual(delays, [])
        self.assertEqual(len(system.calls), 1)
        self.assertIn('unconfirmed rollback', output.getvalue())

    def test_watcher_permanent_refusal_is_not_retried(self):
        system = FakeSystem()
        system.nice = -10
        delays = []
        watcher = m.Watcher(lambda: CONFIG, system_factory=lambda config: system, sleep=delays.append)
        with redirect_stdout(io.StringIO()):
            watcher.handle(CID)
        self.assertEqual(delays, [])
        self.assertEqual(system.calls, [])

    def test_docker_reply_structure_is_bounded_and_safe(self):
        for raw in ('null', '[]', '"SECRET"', 'invalid'):
            with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, raw, '')), self.assertRaises(m.Refused) as error:
                m.System(CONFIG).docker('inspect')
            self.assertNotIn('SECRET', str(error.exception))

    def test_watcher_reconnect_backoff_is_bounded_and_stop_propagates(self):
        delays = []
        def sleep(delay):
            delays.append(delay)
            if len(delays) == 8:
                raise m.Stopped()
        watcher = m.Watcher(lambda: CONFIG, sleep=sleep)
        watcher.cycle = lambda: (_ for _ in ()).throw(m.NotReady('disconnected'))
        with redirect_stdout(io.StringIO()), self.assertRaises(m.Stopped):
            watcher.run()
        self.assertEqual(delays, [1, 2, 4, 8, 16, 30, 30, 30])

    def test_watcher_stop_cleans_only_own_event_process(self):
        stream = unittest.mock.Mock()
        stream.stdout = io.StringIO('')
        stream.poll.return_value = None
        watcher = m.Watcher(lambda: CONFIG, popen=lambda *args, **kwargs: stream)
        watcher.handle = lambda target: (_ for _ in ()).throw(m.Stopped())
        with self.assertRaises(m.Stopped):
            watcher.cycle()
        stream.terminate.assert_called_once()
        stream.wait.assert_called_once_with(timeout=3)

    def test_runtime_lock_serializes_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lock'
            with m.runtime_lock(path), self.assertRaises(m.Refused):
                with m.runtime_lock(path):
                    pass
            with m.runtime_lock(path):
                pass

    def test_systemd_is_host_nice_zero_and_no_container_permission_changes(self):
        root = Path(__file__).parents[1]
        service = (root / 'systemd/ark-main-thread-priority.service').read_text()
        self.assertIn('Nice=0', service)
        self.assertIn('--watch', service)
        self.assertNotIn('Nice=-20', service)
        self.assertNotIn('CAP_SYS_NICE', (root / 'compose.yaml').read_text())
        self.assertNotIn('nice ', (root / 'Dockerfile.offline').read_text())


if __name__ == '__main__':
    unittest.main()
