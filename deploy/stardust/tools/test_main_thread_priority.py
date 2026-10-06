import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
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
BETA_CONFIG = m.Config.parse({'profile': 'beta', 'approved_images': [{'revision': REV, 'image_id': IMAGE}]})
CORE_CONFIG = m.Config.parse({'profile': 'core', 'approved_images': [{'revision': REV, 'image_id': IMAGE}]})
PROFILES = (CONFIG, BETA_CONFIG, CORE_CONFIG)


def image():
    return {'id': IMAGE, 'revision': REV, 'source': m.SOURCE}


def info(config=CONFIG):
    return {'id': CID, 'name': '/' + config.container_name, 'project': config.project, 'service': config.service,
            'pid': 100, 'running': True, 'restarting': False, 'started_at': 'test-start', 'restarts': 0,
            'image_id': IMAGE, 'revision': REV, 'source': m.SOURCE, 'init': True, 'readonly': True,
            'privileged': False, 'cap_drop': ['ALL'], 'cap_add': None,
            'security_opt': ['no-new-privileges:true'], 'pids': 128,
            'cpu_quota': 0, 'nano_cpus': 0, 'cpuset': '', 'memory': 0,
            'ports': [{'HostIp': ip, 'HostPort': str(config.health_port)} for ip in config.publish_ips]}


def health(config=CONFIG):
    return {'ok': True, 'maxRooms': 4096,
            'combat': {'status': 'ready', 'workers': config.combat_workers, 'ready': config.combat_workers},
            'trial': {'status': 'ready', 'workers': config.trial_workers, 'ready': config.trial_workers}}


def unit_argv(profile):
    name = 'ark-main-thread-priority.service' if profile == 'prod' else f'ark-{profile}-main-thread-priority.service'
    service = (Path(__file__).parents[1] / 'systemd' / name).read_text()
    starts = [line.removeprefix('ExecStart=') for line in service.splitlines() if line.startswith('ExecStart=')]
    if len(starts) != 1:
        raise AssertionError('exactly one scheduling unit command required')
    return shlex.split(starts[0])


class FakeSystem:
    def __init__(self, config=CONFIG):
        self.config = config
        self.generation = m.Generation(CID, IMAGE, REV, 'test-start', 0, 100, 10, 101, 11)
        self.nice, self.policy = 0, os.SCHED_OTHER
        self.helpers = [m.Thread(102 + i, 'WorkerThread', 0, os.SCHED_OTHER, 20 + i) for i in range(config.worker_count)]
        self.helpers.append(m.Thread(102 + config.worker_count, 'libuv-worker', 0, os.SCHED_OTHER, 40))
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
            m.validate_threads(snapshot, self.config)
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

    def test_unlimited_room_default_keeps_strict_profile_health_counts(self):
        for config in PROFILES:
            self.assertTrue(m.health_ready({**health(config), 'maxRooms': 0}, config))
            for rooms in (None, False, True, -1, 0.0, '0', 4095):
                self.assertFalse(m.health_ready({**health(config), 'maxRooms': rooms}, config))
            for role in ('combat', 'trial'):
                changed = {**health(config), 'maxRooms': 0}
                changed[role]['ready'] = 0
                self.assertFalse(m.health_ready(changed, config))

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

    def test_waiting_lock_serializes_independent_beta_core_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'shared-wg.lock'
            entered, attempting, release = threading.Event(), threading.Event(), threading.Event()
            events, failures = [], []
            original_flock = m.fcntl.flock
            def flock(fd, operation):
                try:
                    return original_flock(fd, operation)
                except BlockingIOError:
                    attempting.set()
                    raise
            def writer(profile):
                try:
                    with m.runtime_lock(path, timeout=2):
                        events.append(('enter', profile))
                        if profile == 'beta':
                            entered.set()
                            if not release.wait(2):
                                raise AssertionError('fixture release timed out')
                        events.append(('leave', profile))
                except BaseException as error:
                    failures.append(error)
            beta = threading.Thread(target=writer, args=('beta',))
            core = threading.Thread(target=writer, args=('core',))
            patcher = patch.object(m.fcntl, 'flock', side_effect=flock)
            patcher.start()
            beta.start()
            try:
                self.assertTrue(entered.wait(2))
                core.start()
                self.assertTrue(attempting.wait(2))
                self.assertEqual(events, [('enter', 'beta')])
            finally:
                release.set()
                beta.join(3)
                if core.ident is not None:
                    core.join(3)
                patcher.stop()
            self.assertFalse(beta.is_alive() or core.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(events, [('enter', 'beta'), ('leave', 'beta'), ('enter', 'core'), ('leave', 'core')])

    def test_waiting_lock_timeout_is_bounded_without_busy_loop(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lock'
            now = [0]
            def advance(seconds):
                now[0] += seconds
            with m.runtime_lock(path), patch.object(m.time, 'monotonic', side_effect=lambda: now[0]), \
                 patch.object(m.time, 'sleep', side_effect=advance) as sleep, self.assertRaises(m.Refused):
                with m.runtime_lock(path, timeout=.2):
                    self.fail('contending writer must not acquire the lock')
            self.assertEqual(sleep.call_count, 4)
            self.assertTrue(all(0 < call.args[0] <= .05 for call in sleep.call_args_list))
            self.assertAlmostEqual(sum(call.args[0] for call in sleep.call_args_list), .2)
            with m.runtime_lock(path):
                pass

    def test_waiting_lock_stop_propagates_and_closes_only_waiter_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lock'
            with m.runtime_lock(path), patch.object(m.time, 'sleep', side_effect=m.Stopped()), \
                 patch.object(m.os, 'close', wraps=os.close) as close, self.assertRaises(m.Stopped):
                with m.runtime_lock(path, timeout=1):
                    self.fail('interrupted writer must not acquire the lock')
            close.assert_called_once()
            with m.runtime_lock(path):
                pass

    def test_runtime_lock_rejects_invalid_wait_before_open(self):
        for timeout in (-1, 31, 10 ** 1000, float('nan'), float('inf'), True, None, '1'):
            with self.subTest(timeout=timeout), patch.object(m.os, 'open') as opened, self.assertRaises(m.Refused):
                with m.runtime_lock(timeout=timeout):
                    pass
            opened.assert_not_called()

    def test_waiting_lock_retains_regular_root_owned_nonwritable_no_symlink_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lock'
            path.write_bytes(b'')
            path.chmod(0o666)
            with self.assertRaises(m.Refused):
                with m.runtime_lock(path, timeout=1):
                    pass
            path.chmod(0o600)
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                with m.runtime_lock(link, timeout=1):
                    pass
            fifo = Path(directory) / 'fifo'
            os.mkfifo(fifo)
            with self.assertRaises(m.Refused):
                with m.runtime_lock(fifo, timeout=1):
                    pass
            with patch.object(m.os, 'fstat', return_value=type('Stat', (), {'st_uid': 1000, 'st_mode': 0o100600})()), \
                 self.assertRaises(m.Refused):
                with m.runtime_lock(path, timeout=1):
                    pass

    def test_systemd_is_host_nice_zero_and_no_container_permission_changes(self):
        root = Path(__file__).parents[1]
        service = (root / 'systemd/ark-main-thread-priority.service').read_text()
        self.assertIn('Nice=0', service)
        self.assertIn('--watch', service)
        self.assertNotIn('Nice=-20', service)
        self.assertNotIn('CAP_SYS_NICE', (root / 'compose.yaml').read_text())
        self.assertNotIn('nice ', (root / 'Dockerfile.offline').read_text())


class ProfileTests(unittest.TestCase):
    def test_profiles_have_only_the_fixed_targets_counts_bindings_and_locks(self):
        value = {'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
        self.assertEqual(m.Config.parse({**value, 'profile': 'prod'}), CONFIG)
        self.assertEqual((CONFIG.project, CONFIG.service, CONFIG.container_name, CONFIG.health_port,
                          CONFIG.combat_workers, CONFIG.trial_workers, CONFIG.worker_count,
                          CONFIG.publish_ips, CONFIG.lock_path),
                         ('ark-proto', 'ark-proto', 'ark-proto', 3120, 6, 1, 7, ('127.0.0.1',), m.LOCK))
        self.assertEqual((BETA_CONFIG.project, BETA_CONFIG.service, BETA_CONFIG.container_name,
                          BETA_CONFIG.health_port, BETA_CONFIG.combat_workers, BETA_CONFIG.trial_workers,
                          BETA_CONFIG.worker_count, BETA_CONFIG.publish_ips, BETA_CONFIG.lock_path),
                         ('ark-proto-beta', 'ark-proto', 'ark-proto-beta', 3220, 12, 2, 14,
                          ('127.0.0.1', '10.253.77.2'), m.BETA_LOCK))
        self.assertEqual(m.LOCK, '/run/ark-main-thread-priority.lock')
        self.assertEqual(m.BETA_LOCK, '/run/ark-beta-main-thread-priority.lock')
        self.assertNotEqual(CONFIG.lock_path, BETA_CONFIG.lock_path)

    def test_profile_rejects_arbitrary_values_and_selector_overrides(self):
        value = {'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
        for profile in ('local', 'Beta', '', None, True, 1, [], {}):
            with self.subTest(profile=profile), self.assertRaises(m.Refused):
                m.Config.parse({**value, 'profile': profile})
        for profile in ('prod', 'beta', 'core'):
            for key in ('project', 'service', 'container_name', 'health_port', 'combat_workers',
                        'trial_workers', 'worker_count', 'publish_ips', 'ports', 'lock_path'):
                with self.subTest(profile=profile, key=key), self.assertRaises(m.Refused):
                    m.Config.parse({**value, 'profile': profile, key: 'override'})

    def test_beta_config_retains_full_paired_allowlist_and_restore_constraints(self):
        value = {'profile': 'beta', 'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
        self.assertEqual(m.Config.parse({**value, 'nice': 0}).nice, 0)
        for change in ({'nice': -10}, {'nice': False}, {'startup_timeout_seconds': True},
                       {'startup_timeout_seconds': 121}, {'approved_images': []},
                       {'approved_images': [{'revision': REV[:7], 'image_id': IMAGE}]},
                       {'approved_images': [{'revision': REV, 'image_id': 'tag'}]},
                       {'approved_images': [{'revision': REV, 'image_id': IMAGE}] * 9}):
            with self.subTest(change=change), self.assertRaises(m.Refused):
                m.Config.parse({**value, **change})
        second_revision, second_image = 'd' * 40, 'sha256:' + 'e' * 64
        config = m.Config.parse({**value, 'approved_images': value['approved_images'] + [
            {'revision': second_revision, 'image_id': second_image}]})
        with self.assertRaises(m.Refused):
            m.validate_info({**info(config), 'image_id': second_image},
                            {**image(), 'id': second_image}, config)

    def test_beta_example_is_explicit_and_deliberately_fail_closed(self):
        root = Path(__file__).parents[1]
        example = json.loads((root / 'main-thread-priority.beta.example.json').read_text())
        self.assertEqual(example, {'profile': 'beta', 'nice': -20, 'startup_timeout_seconds': 90,
                                   'approved_images': []})
        with self.assertRaisesRegex(m.Refused, 'allowlist'):
            m.Config.parse(example)

    def test_both_profiles_reject_non_root_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            for profile in ('prod', 'beta', 'core'):
                path.write_text(json.dumps({'profile': profile, 'approved_images': [
                    {'revision': REV, 'image_id': IMAGE}]}))
                os.chmod(path, 0o600)
                metadata = os.stat(path)
                with patch.object(m.os, 'fstat', return_value=unittest.mock.Mock(
                        st_mode=metadata.st_mode, st_uid=1000, st_size=metadata.st_size)), self.assertRaises(m.Refused):
                    m.load_config(path)

    def test_profiles_mutually_reject_other_container_metadata(self):
        for config, other in ((CONFIG, BETA_CONFIG), (BETA_CONFIG, CONFIG)):
            m.validate_info(info(config), image(), config)
            with self.subTest(profile=config.profile), self.assertRaises(m.Refused):
                m.validate_info(info(other), image(), config)
            for key in ('name', 'project', 'ports'):
                with self.subTest(profile=config.profile, key=key), self.assertRaises(m.Refused):
                    m.validate_info({**info(config), key: info(other)[key]}, image(), config)

    def test_beta_exact_dual_binding_is_an_unordered_set(self):
        value = info(BETA_CONFIG)
        m.validate_info(value, image(), BETA_CONFIG)
        m.validate_info({**value, 'ports': list(reversed(value['ports']))}, image(), BETA_CONFIG)

    def test_beta_rejects_missing_duplicate_extra_wildcard_and_wrong_binding(self):
        ports = info(BETA_CONFIG)['ports']
        invalid = [None, {}, [], ports[:1], ports[1:], ports + ports[:1], [ports[0], ports[0]],
                   ports + [{'HostIp': '127.0.0.2', 'HostPort': '3220'}]]
        for index in range(2):
            for key, value in (('HostIp', '0.0.0.0'), ('HostIp', '::'), ('HostIp', ''),
                               ('HostIp', '::1'), ('HostIp', '127.0.0.2'), ('HostIp', '10.253.77.3'),
                               ('HostPort', '3120'), ('HostPort', '3000'), ('HostPort', '03220'),
                               ('HostPort', 3220), ('HostIp', [])):
                changed = [dict(port) for port in ports]
                changed[index][key] = value
                invalid.append(changed)
        invalid += [[ports[0], {**ports[1], 'extra': True}], [ports[0], {'HostIp': '10.253.77.2'}],
                    [ports[0], None], [ports[0], []]]
        for bindings in invalid:
            with self.subTest(bindings=bindings), self.assertRaises(m.Refused):
                m.validate_info({**info(BETA_CONFIG), 'ports': bindings}, image(), BETA_CONFIG)

    def test_prod_still_requires_single_exact_loopback_binding(self):
        for ports in (info(BETA_CONFIG)['ports'], info(CONFIG)['ports'] * 2,
                      [{'HostIp': '127.0.0.1', 'HostPort': '3220'}],
                      [{'HostIp': '10.253.77.2', 'HostPort': '3120'}],
                      [{'HostIp': '127.0.0.1', 'HostPort': '3120', 'extra': True}]):
            with self.subTest(ports=ports), self.assertRaises(m.Refused):
                m.validate_info({**info(), 'ports': ports}, image(), CONFIG)

    def test_beta_retains_image_oci_security_and_resource_baselines(self):
        changes = {'service': 'ark-proto-beta', 'source': 'other', 'revision': 'd' * 40,
                   'image_id': 'sha256:' + 'e' * 64, 'init': False, 'readonly': False,
                   'privileged': True, 'cap_add': ['SYS_NICE'], 'cap_drop': [], 'security_opt': [],
                   'pids': 256, 'cpu_quota': 100, 'nano_cpus': 1, 'cpuset': '0', 'memory': 100}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.validate_info({**info(BETA_CONFIG), key: value}, image(), BETA_CONFIG)
        for other_image in ({**image(), 'revision': 'd' * 40}, {**image(), 'source': 'other'},
                            {**image(), 'id': 'sha256:' + 'e' * 64}):
            with self.subTest(image=other_image), self.assertRaises(m.Refused):
                m.validate_info(info(BETA_CONFIG), other_image, BETA_CONFIG)

    def test_health_requires_profile_specific_ready_counts(self):
        for config, other in ((CONFIG, BETA_CONFIG), (BETA_CONFIG, CONFIG)):
            self.assertTrue(m.health_ready(health(config), config))
            self.assertFalse(m.health_ready(health(other), config))
            for role in ('combat', 'trial'):
                for field, value in (('ready', 0), ('workers', 0), ('status', 'starting'),
                                     ('ready', other.combat_workers if role == 'combat' else other.trial_workers),
                                     ('workers', other.combat_workers if role == 'combat' else other.trial_workers)):
                    changed = health(config)
                    changed[role][field] = value
                    self.assertFalse(m.health_ready(changed, config))
            self.assertFalse(m.health_ready({**health(config), 'maxRooms': 4095}, config))
            self.assertFalse(m.health_ready({**health(config), 'ok': False}, config))
        self.assertFalse(m.health_ready(health(BETA_CONFIG)))

    def test_system_health_uses_fixed_loopback_port_and_profile_counts(self):
        for config, other in ((CONFIG, BETA_CONFIG), (BETA_CONFIG, CONFIG)):
            system = m.System(config)
            response = unittest.mock.Mock(status=200)
            response.read.return_value = json.dumps(health(config)).encode()
            with patch.object(system.health_opener, 'open') as open_health:
                open_health.return_value.__enter__.return_value = response
                system.health()
                open_health.assert_called_once_with(f'http://127.0.0.1:{config.health_port}/healthz', timeout=1)
                response.read.return_value = json.dumps(health(other)).encode()
                with self.assertRaises(m.NotReady):
                    system.health()

    def test_system_snapshot_passes_beta_profile_to_thread_validation(self):
        system = m.System(BETA_CONFIG)
        tasks = [Path(f'/proc/101/task/{tid}') for tid in range(101, 116)]
        def read(path, *args):
            tid = int(Path(path).parent.name)
            name = 'docker-init' if tid == 100 else 'MainThread' if tid == 101 else 'WorkerThread'
            start = 10 if tid == 100 else 11 if tid == 101 else tid
            return f'{tid} ({name}) S 100 ' + ' '.join(['0'] * 14 + ['0', '8', '0', str(start)])
        with patch.object(system, 'inspect', return_value=info(BETA_CONFIG)), \
                patch.object(system, 'node', return_value=(101, 11)), patch.object(system, 'read', side_effect=read), \
                patch.object(system, 'health') as ready, patch.object(m.Path, 'iterdir', return_value=iter(tasks)), \
                patch.object(m.os, 'getpriority', return_value=0), patch.object(m.os, 'sched_getscheduler', return_value=0), \
                patch.object(m, 'validate_threads', wraps=m.validate_threads) as validate:
            snapshot = system.snapshot(BETA_CONFIG.container_name)
        ready.assert_called_once()
        validate.assert_called_once_with(snapshot, BETA_CONFIG)
        self.assertEqual(sum(thread.name == 'WorkerThread' for thread in snapshot.threads), 14)

    def test_worker_counts_are_exact_and_profile_specific(self):
        for config, other in ((CONFIG, BETA_CONFIG), (BETA_CONFIG, CONFIG)):
            snapshot = FakeSystem(config).snapshot(config.container_name)
            m.validate_threads(snapshot, config)
            with self.subTest(profile=config.profile), self.assertRaises(m.NotReady):
                m.validate_threads(snapshot, other)
            for workers in (snapshot.threads[1:-2], snapshot.threads[1:] + (
                    m.Thread(500, 'WorkerThread', 0, os.SCHED_OTHER, 500),)):
                with self.assertRaises(m.NotReady):
                    m.validate_threads(replace(snapshot, threads=(snapshot.main, *workers)), config)

    def test_beta_reset_before_nice_reports_twelve_plus_two_and_is_idempotent(self):
        system = FakeSystem(BETA_CONFIG)
        result = m.Helper(system).run(BETA_CONFIG.container_name)
        self.assertEqual(system.calls, [('policy', 101, m.RESET_ON_FORK), ('nice', 101, -20)])
        self.assertEqual((result['combat_ready'], result['trial_ready'], result['other_threads']), (12, 2, 15))
        self.assertTrue(result['configured'])
        self.assertTrue(result['reset_on_fork'])
        system.calls.clear()
        self.assertFalse(m.Helper(system).run(BETA_CONFIG.container_name)['changed'])
        self.assertEqual(system.calls, [])
        self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER for thread in system.helpers))

    def test_beta_helper_rejects_nonzero_or_nonordinary_helper_threads(self):
        for change in ({'nice': -20}, {'policy': os.SCHED_FIFO}, {'policy': m.RESET_ON_FORK}):
            system = FakeSystem(BETA_CONFIG)
            system.helpers[0] = replace(system.helpers[0], **change)
            with self.subTest(change=change), self.assertRaises(m.Refused):
                m.Helper(system).run(BETA_CONFIG.container_name)
            self.assertEqual(system.calls, [])

    def test_beta_rollback_still_protects_third_party_changes_and_reused_pid(self):
        for change in ('external', 'generation'):
            system = FakeSystem(BETA_CONFIG)
            def hook(current, kind, tid, value):
                if kind == 'nice':
                    if change == 'external':
                        current.nice = -10
                    else:
                        current.generation = replace(current.generation, main_start=999)
                    raise m.Refused('fixture mutation race')
            system.before_mutation = hook
            with redirect_stdout(io.StringIO()), self.subTest(change=change), self.assertRaises(m.Refused):
                m.Helper(system).run(BETA_CONFIG.container_name)
            self.assertEqual(len(system.calls), 2)
            self.assertEqual(system.policy, m.RESET_ON_FORK)

    def test_beta_restore_keeps_nice_before_policy_order(self):
        system = FakeSystem(replace(BETA_CONFIG, nice=0))
        system.nice, system.policy = -20, m.RESET_ON_FORK
        result = m.Helper(system).run(BETA_CONFIG.container_name)
        self.assertEqual(system.calls, [('nice', 101, 0), ('policy', 101, 0)])
        self.assertEqual((result['combat_ready'], result['trial_ready']), (12, 2))
        self.assertTrue(result['configured'])

    def test_beta_event_filters_are_fixed_project_and_service_with_actor_id(self):
        command = m.events_command(BETA_CONFIG, 'start-time')
        self.assertEqual(command[:2], m.DOCKER)
        self.assertIn('type=container', command)
        self.assertIn('event=start', command)
        self.assertIn('label=com.docker.compose.project=ark-proto-beta', command)
        self.assertIn('label=com.docker.compose.service=ark-proto', command)
        self.assertEqual(command[-1], '{{.Actor.ID}}')
        self.assertNotIn('label=com.docker.compose.project=ark-proto', command)

    def test_beta_watcher_initial_scan_and_event_subscription_are_isolated(self):
        stream = unittest.mock.Mock()
        stream.stdout = io.StringIO(CID + '\n')
        stream.poll.return_value = 0
        popen = unittest.mock.Mock(return_value=stream)
        targets = []
        watcher = m.Watcher(lambda: BETA_CONFIG, popen=popen)
        watcher.handle = targets.append
        with self.assertRaises(m.NotReady):
            watcher.cycle()
        self.assertEqual(targets, ['ark-proto-beta', CID])
        self.assertEqual(watcher.profile, 'beta')
        self.assertIn('label=com.docker.compose.project=ark-proto-beta', popen.call_args.args[0])
        self.assertEqual(popen.call_args.kwargs['env'], m.DOCKER_ENV)

    def test_watcher_rejects_profile_switch_without_cross_target_mutation(self):
        for config, other in ((config, other) for config in PROFILES for other in PROFILES if config != other):
            loader = unittest.mock.Mock(side_effect=[config, other])
            factory = unittest.mock.Mock(side_effect=FakeSystem)
            watcher = m.Watcher(loader, system_factory=factory)
            with redirect_stdout(io.StringIO()) as output:
                watcher.handle(config.container_name)
                watcher.handle(other.container_name)
            factory.assert_called_once()
            self.assertIn('config profile changed', output.getvalue())
            self.assertEqual(watcher.profile, config.profile)
            pinned = m.Watcher(lambda: other, system_factory=factory, profile=config.profile)
            with redirect_stdout(io.StringIO()):
                pinned.handle(other.container_name)
            factory.assert_called_once()

    def test_main_takes_only_its_profile_lock_and_check_is_unlocked(self):
        for config in PROFILES:
            for check in (False, True):
                system = FakeSystem(config)
                argv = ['main-thread-priority.py', '--config', '/isolated/config.json'] + (['--check'] if check else [])
                with patch.object(sys, 'argv', argv), patch.object(m.os, 'geteuid', return_value=0), \
                        patch.object(m.signal, 'signal'), patch.object(m, 'load_config', return_value=config), \
                        patch.object(m, 'System', return_value=system), patch.object(m, 'runtime_lock') as lock, \
                        redirect_stdout(io.StringIO()):
                    self.assertEqual(m.main(), 2 if check else 0)
                if check:
                    lock.assert_not_called()
                    self.assertEqual(system.calls, [])
                else:
                    lock.assert_called_once_with(config.lock_path)

    def test_main_watcher_is_pinned_and_stop_retains_completed_policy(self):
        system = FakeSystem(BETA_CONFIG)
        m.Helper(system).run(BETA_CONFIG.container_name)
        calls = list(system.calls)
        with patch.object(sys, 'argv', ['main-thread-priority.py', '--config', '/isolated/config.json', '--watch']), \
                patch.object(m.os, 'geteuid', return_value=0), patch.object(m.signal, 'signal'), \
                patch.object(m, 'load_config', return_value=BETA_CONFIG), patch.object(m, 'runtime_lock') as lock, \
                patch.object(m, 'Watcher') as watcher, redirect_stdout(io.StringIO()) as output:
            watcher.return_value.run.side_effect = m.Stopped()
            self.assertEqual(m.main(), 0)
        lock.assert_called_once_with(m.BETA_LOCK)
        self.assertEqual(watcher.call_args.kwargs['profile'], 'beta')
        self.assertEqual(system.calls, calls)
        self.assertEqual((system.nice, system.policy), (-20, m.RESET_ON_FORK))
        self.assertIn('"policy_retained":true', output.getvalue())

    def test_cli_does_not_expose_arbitrary_selectors_ports_counts_or_locks(self):
        for option in ('--project', '--service', '--container-name', '--health-port', '--publish-ip',
                       '--combat-workers', '--trial-workers', '--lock'):
            with patch.object(sys, 'argv', ['main-thread-priority.py', '--config', '/isolated/config.json', option, 'x']), \
                    redirect_stdout(io.StringIO()), patch.object(sys, 'stderr', io.StringIO()), \
                    patch.object(m, 'load_config') as load, self.assertRaises(SystemExit) as error:
                m.main()
            self.assertEqual(error.exception.code, 2)
            load.assert_not_called()

    def test_inheritance_runner_injects_only_isolated_test_binding_and_keeps_profile_counts(self):
        path = Path(__file__).with_name('test_main_thread_inheritance.py')
        spec = importlib.util.spec_from_file_location('inheritance_profile_config_test', path)
        fixtures = importlib.util.module_from_spec(spec)
        with patch.object(m.subprocess, 'check_output', side_effect=AssertionError('no Docker fixture run')), \
                patch.object(m.os, 'sched_setscheduler', side_effect=AssertionError('no scheduling fixture run')), \
                patch.object(m.os, 'setpriority', side_effect=AssertionError('no scheduling fixture run')):
            spec.loader.exec_module(fixtures)
            for profile, combat, trial, ips in (('prod', 6, 1, ('127.0.0.1',)),
                                                ('beta', 12, 2, ('127.0.0.1', '127.0.0.2'))):
                config = fixtures.fixture_config(image(), profile, 'ark-localtest-priority-unit', 49151)
                self.assertEqual((config.profile, config.combat_workers, config.trial_workers,
                                  config.worker_count, config.publish_ips, config.health_port),
                                 (profile, combat, trial, combat + trial, ips, 49151))
                self.assertEqual((config.project, config.service, config.container_name),
                                 ('ark-localtest-priority-unit', 'ark-proto', 'ark-localtest-priority-unit'))
                fixtures.m.validate_info(info(config), image(), config)
            with self.assertRaises(fixtures.m.Refused):
                fixtures.fixture_config(image(), 'arbitrary', 'ark-localtest-priority-unit', 49151)

    def test_beta_unit_is_independent_root_nice_zero_and_fixed_beta_paths(self):
        root = Path(__file__).parents[1]
        service = (root / 'systemd/ark-beta-main-thread-priority.service').read_text()
        self.assertIn('User=root', service)
        self.assertIn('Nice=0', service)
        self.assertIn('UMask=0077', service)
        self.assertIn('/opt/ark-proto-beta/main-priority/current/main-thread-priority.py', service)
        self.assertIn('--config /opt/ark-proto-beta/main-priority/config.json --profile beta --watch', service)
        self.assertNotIn('/opt/ark-proto/main-priority/', service)
        self.assertNotIn('Nice=-20', service)
        self.assertNotIn('CAP_SYS_NICE', service)


class CoreProfileTests(unittest.TestCase):
    def test_core_is_fixed_formal_target_twelve_plus_two_and_independent_lock(self):
        config = CORE_CONFIG
        self.assertEqual((config.profile, config.project, config.service, config.container_name,
                          config.health_port, config.combat_workers, config.trial_workers,
                          config.worker_count, config.publish_ips, config.lock_path),
                         ('core', 'ark-proto', 'ark-proto', 'ark-proto', 3120, 12, 2, 14,
                          ('127.0.0.1', '10.253.77.2'), '/run/ark-core-main-thread-priority.lock'))
        self.assertEqual(len({config.lock_path for config in PROFILES}), 3)
        default = m.Config.parse({'approved_images': [{'revision': REV, 'image_id': IMAGE}]})
        self.assertEqual(default, CONFIG)
        self.assertEqual((default.worker_count, default.publish_ips), (7, ('127.0.0.1',)))

    def test_core_bindings_are_exact_unordered_and_not_prod_or_beta(self):
        value = info(CORE_CONFIG)
        ports = value['ports']
        m.validate_info(value, image(), CORE_CONFIG)
        m.validate_info({**value, 'ports': list(reversed(ports))}, image(), CORE_CONFIG)
        invalid = [info(CONFIG)['ports'], info(BETA_CONFIG)['ports'], None, [], ports[:1],
                   [ports[0], ports[0]], ports + ports[:1],
                   ports + [{'HostIp': '127.0.0.2', 'HostPort': '3120'}]]
        for index in range(2):
            for key, change in (('HostIp', '0.0.0.0'), ('HostIp', '::'), ('HostIp', ''),
                                ('HostIp', '127.0.0.2'), ('HostIp', '10.253.77.3'),
                                ('HostPort', '3220'), ('HostPort', '3000'), ('HostPort', 3120)):
                changed = [dict(port) for port in ports]
                changed[index][key] = change
                invalid.append(changed)
        for bindings in invalid:
            with self.subTest(bindings=bindings), self.assertRaises(m.Refused):
                m.validate_info({**value, 'ports': bindings}, image(), CORE_CONFIG)

    def test_all_profile_container_metadata_is_mutually_exclusive(self):
        for config in PROFILES:
            m.validate_info(info(config), image(), config)
            for other in PROFILES:
                if config != other:
                    with self.subTest(profile=config.profile, other=other.profile), self.assertRaises(m.Refused):
                        m.validate_info(info(other), image(), config)
        for key, value in (('project', 'ark-proto-beta'), ('name', '/ark-proto-beta'),
                           ('service', 'ark-proto-beta'), ('project', 'custom')):
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.validate_info({**info(CORE_CONFIG), key: value}, image(), CORE_CONFIG)

    def test_core_health_thread_counts_and_returned_counts_are_twelve_plus_two(self):
        self.assertTrue(m.health_ready(health(CORE_CONFIG), CORE_CONFIG))
        self.assertFalse(m.health_ready(health(CONFIG), CORE_CONFIG))
        self.assertFalse(m.health_ready(health(CORE_CONFIG), CONFIG))
        for role in ('combat', 'trial'):
            for field in ('workers', 'ready'):
                changed = health(CORE_CONFIG)
                changed[role][field] -= 1
                self.assertFalse(m.health_ready(changed, CORE_CONFIG))
        system = FakeSystem(CORE_CONFIG)
        initial = system.snapshot('ark-proto')
        with self.assertRaises(m.NotReady):
            m.validate_threads(initial, CONFIG)
        with self.assertRaises(m.NotReady):
            m.validate_threads(FakeSystem(CONFIG).snapshot('ark-proto'), CORE_CONFIG)
        result = m.Helper(system).run('ark-proto')
        self.assertEqual((result['combat_ready'], result['trial_ready'], result['other_threads']), (12, 2, 15))
        self.assertEqual(system.calls, [('policy', 101, m.RESET_ON_FORK), ('nice', 101, -20)])
        self.assertTrue(result['configured'])
        self.assertTrue(all(thread.nice == 0 and thread.policy == os.SCHED_OTHER for thread in system.helpers))

    def test_core_system_health_uses_3120_and_twelve_plus_two(self):
        system = m.System(CORE_CONFIG)
        response = unittest.mock.Mock(status=200)
        response.read.return_value = json.dumps(health(CORE_CONFIG)).encode()
        with patch.object(system.health_opener, 'open') as open_health:
            open_health.return_value.__enter__.return_value = response
            system.health()
            open_health.assert_called_once_with('http://127.0.0.1:3120/healthz', timeout=1)
            response.read.return_value = json.dumps(health(CONFIG)).encode()
            with self.assertRaises(m.NotReady):
                system.health()

    def test_core_keeps_oci_immutable_allowlist_security_and_resource_baselines(self):
        changes = {'source': 'other', 'revision': 'd' * 40, 'image_id': 'sha256:' + 'e' * 64,
                   'init': False, 'readonly': False, 'privileged': True, 'cap_add': ['SYS_NICE'],
                   'cap_drop': [], 'security_opt': [], 'pids': 256, 'cpu_quota': 100,
                   'nano_cpus': 1, 'cpuset': '0', 'memory': 100}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.validate_info({**info(CORE_CONFIG), key: value}, image(), CORE_CONFIG)
        for changed in ({**image(), 'source': 'other'}, {**image(), 'revision': 'd' * 40},
                        {**image(), 'id': 'sha256:' + 'e' * 64}):
            with self.assertRaises(m.Refused):
                m.validate_info(info(CORE_CONFIG), changed, CORE_CONFIG)

    def test_core_event_filters_use_formal_project_service_and_actor_id(self):
        command = m.events_command(CORE_CONFIG, 'start-time')
        self.assertEqual(command, m.events_command(CONFIG, 'start-time'))
        self.assertIn('label=com.docker.compose.project=ark-proto', command)
        self.assertIn('label=com.docker.compose.service=ark-proto', command)
        self.assertEqual(command[-1], '{{.Actor.ID}}')

    def test_cli_profile_is_only_fixed_enum_and_requires_matching_config(self):
        for config in PROFILES:
            system = FakeSystem(config)
            argv = ['main-thread-priority.py', '--config', '/isolated/config.json', '--profile', config.profile]
            with patch.object(sys, 'argv', argv), patch.object(m.os, 'geteuid', return_value=0), \
                    patch.object(m.signal, 'signal'), patch.object(m, 'load_config', return_value=config), \
                    patch.object(m, 'System', return_value=system), patch.object(m, 'runtime_lock') as lock, \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 0)
            lock.assert_called_once_with(config.lock_path)
            for other in PROFILES:
                if config != other:
                    with patch.object(sys, 'argv', argv), patch.object(m.os, 'geteuid', return_value=0), \
                            patch.object(m.signal, 'signal'), patch.object(m, 'load_config', return_value=other), \
                            patch.object(m, 'System') as create_system, patch.object(m, 'Watcher') as watcher, \
                            patch.object(m, 'runtime_lock') as lock, redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(m.main(), 1)
                    self.assertIn('config profile does not match', output.getvalue())
                    lock.assert_not_called()
                    create_system.assert_not_called()
                    watcher.assert_not_called()
        for value in ('custom', 'Core', '12', 'ark-proto'):
            with patch.object(sys, 'argv', ['main-thread-priority.py', '--config', '/isolated/config.json', '--profile', value]), \
                    patch.object(sys, 'stderr', io.StringIO()), patch.object(m, 'load_config') as load, \
                    self.assertRaises(SystemExit) as error:
                m.main()
            self.assertEqual(error.exception.code, 2)
            load.assert_not_called()

    def test_all_unit_argv_pin_exact_profile_and_fixed_paths(self):
        for config in PROFILES:
            target = 'ark-proto-beta' if config.profile == 'beta' else 'ark-proto'
            base = f'/opt/{target}/main-priority'
            self.assertEqual(unit_argv(config.profile), ['/usr/bin/python3', '-B',
                f'{base}/current/main-thread-priority.py', '--config', f'{base}/config.json',
                '--profile', config.profile, '--watch'])

    def test_unit_initial_config_mismatch_refuses_before_lock_target_or_write(self):
        for config in PROFILES:
            for other in PROFILES:
                if config == other:
                    continue
                # The prod payload deliberately omits profile: a miscopied legacy config.
                payload = {'approved_images': [{'revision': REV, 'image_id': IMAGE}]}
                if other.profile != 'prod':
                    payload['profile'] = other.profile
                loaded = m.Config.parse(payload)
                system = FakeSystem(loaded)
                with self.subTest(unit_profile=config.profile, config_profile=other.profile), \
                        patch.object(sys, 'argv', unit_argv(config.profile)[2:]), \
                        patch.object(m.os, 'geteuid', return_value=0), patch.object(m.signal, 'signal'), \
                        patch.object(m, 'load_config', return_value=loaded), \
                        patch.object(m, 'System', return_value=system) as create_system, \
                        patch.object(m, 'Watcher') as watcher, patch.object(m, 'runtime_lock') as lock, \
                        patch.object(m.os, 'sched_setscheduler') as set_policy, \
                        patch.object(m.os, 'setpriority') as set_nice, redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(m.main(), 1)
                self.assertIn('config profile does not match', output.getvalue())
                lock.assert_not_called()
                create_system.assert_not_called()
                watcher.assert_not_called()
                set_policy.assert_not_called()
                set_nice.assert_not_called()
                self.assertEqual(system.calls, [])

    def test_core_candidate_example_is_explicit_and_fail_closed(self):
        root = Path(__file__).parents[1]
        value = json.loads((root / 'main-thread-priority.core.example.json').read_text())
        self.assertEqual(value, {'profile': 'core', 'nice': -20, 'startup_timeout_seconds': 90,
                                 'approved_images': []})
        with self.assertRaisesRegex(m.Refused, 'allowlist'):
            m.Config.parse(value)
        value['approved_images'] = [{'revision': REV, 'image_id': IMAGE}]
        self.assertEqual(m.Config.parse(value), CORE_CONFIG)
        self.assertEqual(m.Config.parse({**value, 'nice': 0}).nice, 0)

    def test_core_candidate_unit_is_root_nice_zero_fixed_formal_paths_and_profile(self):
        root = Path(__file__).parents[1]
        service = (root / 'systemd/ark-core-main-thread-priority.service').read_text()
        self.assertIn('User=root', service)
        self.assertIn('Nice=0', service)
        self.assertIn('UMask=0077', service)
        self.assertIn('/opt/ark-proto/main-priority/current/main-thread-priority.py', service)
        self.assertIn('--config /opt/ark-proto/main-priority/config.json --profile core --watch', service)
        self.assertNotIn('/opt/ark-proto-beta/', service)
        self.assertNotIn('Nice=-20', service)
        self.assertNotIn('CAP_SYS_NICE', service)


if __name__ == '__main__':
    unittest.main()
