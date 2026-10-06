"""Injected lifecycle/CLI tests; no Docker, nft, SSH, WG files, or scheduler calls."""
from contextlib import contextmanager, redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('game_backend_manager_tested', Path(__file__).with_name('game-backend-manager.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
p = m.priority
REV, IMAGE, CID = 'a' * 40, 'sha256:' + 'b' * 64, 'c' * 64


def config(profile='beta'):
    return p.Config.parse({'profile': profile, 'approved_images': [{'revision': REV, 'image_id': IMAGE}]})


def metadata(c):
    return {'id': CID, 'name': '/' + c.container_name, 'project': c.project, 'service': c.service,
            'pid': 100, 'running': True, 'restarting': False, 'started_at': 'fixed-start', 'restarts': 0,
            'image_id': IMAGE, 'revision': REV, 'source': p.SOURCE, 'init': True, 'readonly': True,
            'privileged': False, 'cap_drop': ['ALL'], 'cap_add': None, 'security_opt': ['no-new-privileges:true'],
            'pids': 128, 'cpu_quota': 0, 'nano_cpus': 0, 'cpuset': '', 'memory': 0,
            'ports': [{'HostIp': ip, 'HostPort': str(c.health_port)} for ip in c.publish_ips]}


class FakeSystem(p.System):
    def __init__(self, c, harness):
        # Do not initialize any real host/network adapters.
        self.config, self.harness = c, harness

    def docker(self, *args):
        self.harness.events.append(('docker-query', args[0], args[-1]))
        if args[:2] == ('image', 'inspect'):
            return copy.deepcopy(self.harness.image)
        return copy.deepcopy(self.harness.info)

    def set_policy(self, *_args):
        raise AssertionError('scheduler mutation forbidden')

    def set_nice(self, *_args):
        raise AssertionError('scheduler mutation forbidden')


class FakeNft:
    def snapshot(self, *_args):
        raise AssertionError('fake lifecycle gate must not query nft')

    def apply(self, *_args):
        raise AssertionError('fake lifecycle gate must not execute nft')


class FakeStore:
    def load(self):
        raise AssertionError('real WG manifest access forbidden')

    def save(self, *_args):
        raise AssertionError('real WG manifest access forbidden')


class Harness:
    def __init__(self, c):
        self.config, self.info = c, metadata(c)
        self.image = {'id': IMAGE, 'revision': REV, 'source': p.SOURCE}
        self.events, self.commands, self.active_locks, self.lock_timeouts = [], [], [], []
        self.inspected_name_exists, self.fail_check, self.fail_close = False, False, False
        self.lease_open = False
        self.nice, self.reset_on_fork = 0, False

    @contextmanager
    def lock(self, path, *, timeout=0):
        self.events.append(('lock', path))
        self.lock_timeouts.append((path, timeout))
        if path in self.active_locks:
            raise p.Refused('fixture lock already held')
        self.active_locks.append(path)
        try:
            yield
        finally:
            self.active_locks.remove(path)
            self.events.append(('unlock', path))

    def gate_helper(self, system, nft, store):
        harness = self
        assert isinstance(nft, FakeNft) and isinstance(store, FakeStore)
        class Gate:
            def run(self, action):
                assert m.access.LOCK in harness.active_locks
                harness.events.append(('gate', action))
                if action in ('guard', 'close'):
                    if action == 'close' and harness.fail_close:
                        raise p.Refused('fixture close failed')
                    harness.lease_open = False
                elif action == 'open':
                    assert harness.nice == -20 and harness.reset_on_fork
                    harness.lease_open = True
                elif action == 'check' and harness.fail_check:
                    raise p.Refused('fixture lease generation changed')
                return {'profile': system.config.profile, 'state': 'open' if harness.lease_open else 'closed'}
        return Gate()

    def priority_helper(self, system):
        harness = self
        class Policy:
            def run(self, target):
                assert system.config.lock_path in harness.active_locks
                assert target == system.config.container_name
                harness.events.append(('priority', target))
                harness.nice, harness.reset_on_fork = -20, True
                return {'configured': True}
        return Policy()

    def compose(self, c, action):
        assert c == self.config
        self.events.append(('compose', action))

    def lease(self, system):
        assert system.config == self.config and self.lease_open
        self.events.append(('lease', CID))
        return {'container_id': CID, 'main_pid': 101, 'main_start': 10}

    def subprocess(self, args, **kwargs):
        assert args[:len(p.DOCKER)] == p.DOCKER
        assert kwargs.get('env') == p.DOCKER_ENV
        self.commands.append(args)
        operation = args[len(p.DOCKER):]
        if operation[:2] == ['container', 'inspect']:
            assert operation[-1] == self.config.container_name
            self.events.append(('name-inspect', operation[-1]))
            return type('Result', (), {'returncode': 0 if self.inspected_name_exists else 1,
                                      'stdout': json.dumps(self.info), 'stderr': 'NEVER-DUMP-THIS'})()
        if operation[0] == 'stop':
            assert not self.lease_open
            self.events.append(('stop-cid', operation[-1]))
        elif operation[0] == 'compose':
            self.events.append(('compose-command', tuple(operation)))
        else:
            raise AssertionError('unexpected subprocess')
        return type('Result', (), {'returncode': 0, 'stdout': b'', 'stderr': b''})()


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.harness = Harness(config())
        h = self.harness
        patches = [patch.object(p, 'System', side_effect=lambda c: FakeSystem(c, h)),
                   patch.object(m.access, 'System', side_effect=lambda c: FakeSystem(c, h)),
                   patch.object(p, 'runtime_lock', side_effect=h.lock),
                   patch.object(p, 'Helper', side_effect=h.priority_helper),
                   patch.object(m.access, 'Helper', side_effect=h.gate_helper),
                   patch.object(m.access, 'Nft', FakeNft), patch.object(m.access, 'Store', FakeStore),
                   patch.object(m.access, 'lease', side_effect=h.lease),
                   patch.object(m, 'compose', side_effect=h.compose),
                   patch.object(m.subprocess, 'run', side_effect=h.subprocess),
                   patch.object(m.signal, 'signal'), patch.object(m.os, 'geteuid', return_value=0),
                   patch.object(m.os, 'setpriority', side_effect=AssertionError('no real scheduler')),
                   patch.object(m.os, 'sched_setscheduler', side_effect=AssertionError('no real scheduler')),
                   patch.object(m.time, 'sleep', side_effect=AssertionError('sleep must be injected'))]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def cli(self, action, profile='beta', loader=None):
        argv = ['manager', '--profile', profile, '--config', '/root/fixed-policy.json', '--action', action]
        with patch.object(sys, 'argv', argv), patch.object(m.access, 'load_config', side_effect=loader or (lambda path, selected: config(selected))) as load:
            output = io.StringIO()
            with redirect_stdout(output):
                result = m.main()
        return result, output.getvalue(), load

    def test_start_cli_guard_compose_priority_open_lease_and_own_locks(self):
        result, output, load = self.cli('start')
        self.assertEqual(result, 0)
        self.assertIn('game-backend-started', output)
        load.assert_called_once_with('/root/fixed-policy.json', 'beta')
        semantic = [event for event in self.harness.events if event[0] not in ('lock', 'unlock', 'name-inspect')]
        self.assertEqual(semantic, [('gate', 'guard'), ('compose', 'start'), ('priority', 'ark-proto-beta'),
                                    ('gate', 'open'), ('lease', CID)])
        self.assertIn(('lock', p.BETA_LOCK), self.harness.events)
        self.assertTrue(all(timeout == (m.access.LOCK_TIMEOUT if path == m.access.LOCK else 0)
                            for path, timeout in self.harness.lock_timeouts))
        self.assertEqual(self.harness.events[0], ('lock', '/run/ark-game-beta-lifecycle.lock'))
        self.assertEqual(self.harness.events[-1], ('unlock', '/run/ark-game-beta-lifecycle.lock'))
        self.assertTrue(self.harness.lease_open)

    def test_fixed_profiles_paths_config_and_root_required(self):
        self.assertEqual(tuple(map(str, m.paths('beta'))),
                         ('/opt/ark-proto-beta', '/opt/ark-proto-beta/compose.beta-game.yaml', '/opt/ark-proto-beta/runtime.env'))
        self.assertEqual(tuple(map(str, m.paths('core'))),
                         ('/opt/ark-proto', '/opt/ark-proto/compose.core-game.yaml', '/opt/ark-proto/runtime.env'))
        self.assertEqual(self.cli('check', 'core')[0], 0)
        self.assertNotIn(('lock', '/run/ark-game-core-lifecycle.lock'), self.harness.events)
        self.assertIn((m.access.LOCK, m.access.LOCK_TIMEOUT), self.harness.lock_timeouts)
        with patch.object(m.os, 'geteuid', return_value=1000):
            result, _output, load = self.cli('start')
            self.assertEqual(result, 1)
            load.assert_not_called()
        def mismatch(_path, _profile):
            raise p.Refused('fixture config profile mismatch')
        before = len(self.harness.events)
        self.assertEqual(self.cli('start', loader=mismatch)[0], 1)
        self.assertEqual(len(self.harness.events), before)
        for profile in ('prod', 'arbitrary'):
            with redirect_stdout(io.StringIO()), patch.object(sys, 'argv', ['manager', '--profile', profile, '--config', 'ignored', '--action', 'start']), \
                 patch('sys.stderr', new=io.StringIO()), self.assertRaises(SystemExit) as error:
                m.main()
            self.assertEqual(error.exception.code, 2)

    def test_check_with_active_lifecycle_owner_only_takes_shared_wg_lock(self):
        self.harness.lease_open = True
        path = '/run/ark-game-beta-lifecycle.lock'
        with self.harness.lock(path):
            before = len(self.harness.events)
            self.assertEqual(self.cli('check')[0], 0)
            events = self.harness.events[before:]
            self.assertNotIn(('lock', path), events)
            self.assertEqual([event for event in events if event[0] == 'gate'], [('gate', 'check')])
            self.assertIn(path, self.harness.active_locks)
            self.assertTrue(self.harness.lease_open)
        self.assertEqual(self.harness.lock_timeouts[-1], (m.access.LOCK, m.access.LOCK_TIMEOUT))

    def test_lifecycle_collision_never_closes_existing_managers_lease(self):
        path = '/run/ark-game-beta-lifecycle.lock'
        for action in ('start', 'stop', 'serve'):
            self.harness.lease_open = True
            self.harness.nice, self.harness.reset_on_fork = -20, True
            with self.subTest(action=action), self.harness.lock(path):
                before = len(self.harness.events)
                result, output, _loader = self.cli(action)
                self.assertEqual(result, 1)
                self.assertIn('refused', output)
                self.assertTrue(self.harness.lease_open)
                self.assertEqual((self.harness.nice, self.harness.reset_on_fork), (-20, True))
                self.assertFalse(any(event[0] in ('gate', 'compose', 'priority', 'stop-cid')
                                     for event in self.harness.events[before:]))

    def test_stop_signal_before_lifecycle_ownership_preserves_live_lease(self):
        self.harness.lease_open = True
        @contextmanager
        def interrupted_lock(_path, **_kwargs):
            raise p.Stopped()
            yield
        with patch.object(p, 'runtime_lock', interrupted_lock):
            self.assertEqual(self.cli('serve')[0], 0)
        self.assertTrue(self.harness.lease_open)
        self.assertEqual(self.harness.events, [])

    def test_shared_lock_timeout_keeps_failed_check_fail_closed(self):
        self.harness.lease_open = True
        attempts = []
        @contextmanager
        def timed_out_once(path, *, timeout=0):
            attempts.append((path, timeout))
            if len(attempts) == 1:
                raise p.Refused('fixture bounded shared-lock timeout')
            with self.harness.lock(path, timeout=timeout):
                yield
        with patch.object(p, 'runtime_lock', timed_out_once):
            self.assertEqual(self.cli('check')[0], 1)
        self.assertEqual(attempts, [(m.access.LOCK, m.access.LOCK_TIMEOUT)] * 2)
        self.assertFalse(self.harness.lease_open)
        self.assertEqual([event for event in self.harness.events if event[0] == 'gate'], [('gate', 'close')])

    def test_start_refuses_foreign_fixed_name_before_compose_or_policy(self):
        self.harness.inspected_name_exists = True
        for key, value in (('name', '/foreign'), ('project', 'foreign'), ('service', 'auth'),
                           ('image_id', 'sha256:' + 'f' * 64), ('revision', 'f' * 40)):
            self.harness.info = {**metadata(self.harness.config), key: value}
            self.harness.events.clear()
            with self.subTest(key=key):
                result, output, _load = self.cli('start')
                self.assertEqual(result, 1)
                self.assertFalse(self.harness.lease_open)
                self.assertNotIn(('compose', 'start'), self.harness.events)
                self.assertFalse(any(event[0] == 'priority' for event in self.harness.events))
                self.assertNotIn('NEVER-DUMP-THIS', output)
                self.assertEqual([event for event in self.harness.events if event[0] == 'gate'], [('gate', 'guard'), ('gate', 'close')])

    def test_stop_closes_before_inspect_and_uses_verified_cid_not_name(self):
        self.harness.lease_open = True
        result, _output, _load = self.cli('stop')
        self.assertEqual(result, 0)
        events = self.harness.events
        close = events.index(('gate', 'close'))
        inspect = events.index(('docker-query', 'container', 'ark-proto-beta'))
        stop = events.index(('stop-cid', CID))
        self.assertLess(close, inspect)
        self.assertLess(inspect, stop)
        self.assertEqual(self.harness.commands[-1], p.DOCKER + ['stop', '--time', '10', CID])
        self.assertFalse(self.harness.lease_open)

    def test_stop_refuses_unknown_image_project_name_and_reused_cid(self):
        for key, value in (('name', '/foreign'), ('project', 'foreign'), ('service', 'auth'),
                           ('image_id', 'sha256:' + 'f' * 64), ('revision', 'f' * 40)):
            self.harness.info = {**metadata(self.harness.config), key: value}
            self.harness.commands.clear()
            self.harness.lease_open = True
            with self.subTest(key=key):
                self.assertEqual(self.cli('stop')[0], 1)
                self.assertFalse(self.harness.lease_open)
                self.assertEqual(self.harness.commands, [])
        self.harness.info = {**metadata(self.harness.config), 'id': 'd' * 64}
        with self.assertRaises(p.Refused):
            m.stop(self.harness.config, expected={'container_id': CID})
        self.assertEqual(self.harness.commands, [])

    def test_signal_after_start_closes_lease_without_restoring_nice(self):
        handlers = {}
        def install(number, handler):
            handlers[number] = handler
        def interrupted_sleep(_seconds):
            handlers[m.signal.SIGTERM](m.signal.SIGTERM, None)
        with patch.object(m.signal, 'signal', side_effect=install), patch.object(m.time, 'sleep', side_effect=interrupted_sleep):
            result, _output, _load = self.cli('serve')
        self.assertEqual(result, 0)
        self.assertFalse(self.harness.lease_open)
        self.assertEqual((self.harness.nice, self.harness.reset_on_fork), (-20, True))
        self.assertEqual(sum(event[0] == 'priority' for event in self.harness.events), 1)
        self.assertFalse(any(event[0] == 'stop-cid' for event in self.harness.events))
        self.assertEqual([event for event in self.harness.events if event[0] == 'gate'], [('gate', 'guard'), ('gate', 'open'), ('gate', 'close')])

    def test_failed_check_best_effort_closes_without_reusing_or_reopening(self):
        self.harness.lease_open, self.harness.fail_check = True, True
        result, _output, _load = self.cli('check')
        self.assertEqual(result, 1)
        self.assertFalse(self.harness.lease_open)
        self.assertEqual([event for event in self.harness.events if event[0] == 'gate'], [('gate', 'check'), ('gate', 'close')])
        self.assertFalse(any(event[0] in ('compose', 'priority', 'lease', 'stop-cid') for event in self.harness.events))
        self.harness.fail_close = True
        self.assertEqual(self.cli('check')[0], 1)

    def test_serve_check_failure_closes_without_second_start(self):
        self.harness.fail_check = True
        with patch.object(m.time, 'sleep', return_value=None) as sleep:
            result, _output, _load = self.cli('serve')
        self.assertEqual(result, 1)
        sleep.assert_called_once_with(5)
        self.assertFalse(self.harness.lease_open)
        self.assertEqual(sum(event == ('compose', 'start') for event in self.harness.events), 1)
        self.assertEqual(sum(event == ('gate', 'open') for event in self.harness.events), 1)
        self.assertEqual((self.harness.nice, self.harness.reset_on_fork), (-20, True))

    def test_compose_rejects_fifo_before_read_or_command(self):
        regular = type('Stat', (), {'st_uid': 0, 'st_mode': stat.S_IFREG | 0o600, 'st_size': 128})()
        fifo = type('Stat', (), {'st_uid': 0, 'st_mode': stat.S_IFIFO | 0o600, 'st_size': 0})()
        for invalid_name in ('compose.beta-game.yaml', 'runtime.env'):
            def checked_file(path):
                metadata = fifo if Path(path).name == invalid_name else regular
                return type('File', (), {'stat': lambda self: metadata})()
            with self.subTest(file=invalid_name), patch.object(m.access, 'no_symlink', side_effect=checked_file), \
                 patch.object(m.Path, 'read_text', side_effect=AssertionError('FIFO must not be read')) as read:
                with self.assertRaises(p.Refused):
                    ORIGINAL_COMPOSE(self.harness.config, 'start')
                read.assert_not_called()
                self.assertEqual(self.harness.commands, [])
                self.assertFalse(any(event[0] == 'docker-query' for event in self.harness.events))

    def test_real_compose_function_uses_fixed_files_and_approved_image(self):
        # Exercise the original compose function, with every file/command replaced by safe data.
        real_compose = ORIGINAL_COMPOSE
        fake_stat = type('Stat', (), {'st_uid': 0, 'st_mode': stat.S_IFREG | 0o600, 'st_size': 128})()
        fake_file = type('File', (), {'stat': lambda self: fake_stat})()
        with patch.object(m.access, 'no_symlink', return_value=fake_file) as no_symlink, \
             patch.object(m.Path, 'read_text', return_value='ARK_GAME_IMAGE=' + IMAGE + '\n'):
            real_compose(self.harness.config, 'start')
            self.assertEqual([str(call.args[0]) for call in no_symlink.call_args_list],
                             ['/opt/ark-proto-beta/compose.beta-game.yaml', '/opt/ark-proto-beta/runtime.env'])
            self.assertEqual(self.harness.commands[-1], p.DOCKER + ['compose', '--project-name', 'ark-proto-beta',
                             '--env-file', '/opt/ark-proto-beta/runtime.env', '-f', '/opt/ark-proto-beta/compose.beta-game.yaml',
                             'up', '-d', '--no-deps', 'ark-proto'])
            self.harness.commands.clear()
            self.harness.image['id'] = 'sha256:' + 'f' * 64
            with self.assertRaises(p.Refused):
                real_compose(self.harness.config, 'start')
            self.assertEqual(self.harness.commands, [])
            fake_stat.st_mode = stat.S_IFREG | 0o666
            with self.assertRaises(p.Refused):
                real_compose(self.harness.config, 'start')
            self.assertEqual(self.harness.commands, [])


ORIGINAL_COMPOSE = m.compose

if __name__ == '__main__':
    unittest.main()
