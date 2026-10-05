"""Opt-in host-root Linux/Node24 proof; creates only purpose-labelled local containers."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from dataclasses import replace

SPEC = importlib.util.spec_from_file_location('main_thread_priority', Path(__file__).with_name('main-thread-priority.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
ROOT = Path(__file__).resolve().parents[3]
IMAGE_TAG = 'ark-proto:v013-ui-20261005'


@unittest.skipUnless(os.environ.get('SP_PRIORITY_INHERITANCE') == '1', 'explicit local host-root opt-in required')
class InheritanceTests(unittest.TestCase):
    def run_fixture(self, kind):
        self.assertEqual(os.geteuid(), 0)
        name = f'ark-localtest-priority-{kind}-{os.getpid()}'
        purpose = 'ark-main-priority-inheritance'
        # This image is the Node24/dependency provider, not a claim about mounted source revision.
        raw = subprocess.check_output(m.DOCKER + ['image', 'inspect', '--format', m.formatter(m.IMAGE_FIELDS), IMAGE_TAG], env=m.DOCKER_ENV, text=True)
        image = json.loads(raw)
        fixture = f'deploy/stardust/tools/fixtures/main-thread-{kind}.{"mjs" if kind == "game" else "cjs"}'
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
        config = m.Config(((image['revision'], image['id']),), container_name=name,
                          project=name, health_port=port, startup_timeout_seconds=30)
        cmd = m.DOCKER + ['create', '--pull=never', '--name', name, '--init', '--read-only',
                         '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
                         '--label', 'purpose=' + purpose, '--label', 'com.docker.compose.project=' + name,
                         '--label', 'com.docker.compose.service=ark-proto', '--tmpfs', '/tmp:rw,nosuid,size=16m',
                         '--mount', f'type=bind,src={ROOT},dst=/app,readonly', '--workdir', '/app',
                         '-p', f'127.0.0.1:{port}:3000', '-e', 'SP_COMBAT=server', '-e', 'SP_VERIFY=off',
                         '-e', 'SP_COMBAT_WORKERS=6', '-e', 'SP_TRIAL_WORKERS=1',
                         '--entrypoint', 'node', IMAGE_TAG, fixture]
        cid = None
        with tempfile.NamedTemporaryFile(mode='w', dir=ROOT / '.cache/stardust', prefix=f'main-priority-{kind}-', suffix='.json', delete=False) as evidence:
            result = {'fixture': kind, 'provider_revision': image['revision'], 'mounted_working_tree': True,
                      'evidence': evidence.name, 'removed': False}
            try:
                cid = subprocess.check_output(cmd, env=m.DOCKER_ENV, text=True).strip()
                subprocess.run(m.DOCKER + ['start', cid], env=m.DOCKER_ENV, check=True, stdout=subprocess.DEVNULL)
                raw = subprocess.check_output(m.DOCKER + ['port', cid, '3000/tcp'], env=m.DOCKER_ENV, text=True).strip()
                self.assertEqual(raw, f'127.0.0.1:{port}')
                system = m.System(config)
                helper = m.Helper(system)
                before = helper.wait_ready(cid)
                result['before'] = {'init_pid': before.generation.init_pid, 'main_pid': before.generation.main_pid}
                self.assertNotEqual(before.generation.init_pid, before.generation.main_pid)
                ready = self.marker(cid, 'ready')
                self.assertEqual(ready['node'], 'v24.14.0')
                if kind == 'lazy':
                    self.assertEqual(ready['libuvBefore'], 0, 'fixture must prove threadpool was absent before boosting')
                result['applied'] = helper.run(cid)
                self.assertTrue(result['applied']['configured'])
                self.assertEqual(os.getpriority(os.PRIO_PROCESS, before.generation.init_pid), 0)
                os.kill(before.generation.main_pid, signal.SIGUSR2)
                event = self.marker(cid, 'replaced' if kind == 'game' else 'created')
                result['birth'] = event
                if kind == 'game':
                    self.assertEqual(event['newWorkerNice'], 0)
                    self.assertEqual(event['combatReplacements'], 1)
                    self.assertEqual(event['trialReplacements'], 1)
                else:
                    self.assertGreater(event['libuvAfter'], 0)
                after = system.snapshot(cid)
                self.assertEqual(after.main.nice, -20)
                self.assertEqual(after.main.policy, m.RESET_ON_FORK)
                self.assertTrue(all(thread.nice == 0 and thread.policy == 0 for thread in after.threads if thread.tid != after.main.tid))
                result['roles_after'] = {name: sorted({thread.nice for thread in after.threads if thread.name == name})
                                         for name in sorted({thread.name for thread in after.threads})}
                result['idempotent'] = helper.run(cid)
                self.assertFalse(result['idempotent']['changed'])
                restored = m.Helper(m.System(replace(config, nice=0))).run(cid)
                self.assertTrue(restored['configured'])
                result['restored'] = restored
                # Exercise an actual same-CID Docker restart and fresh PID discovery.
                subprocess.run(m.DOCKER + ['restart', '--time', '5', cid], check=True, stdout=subprocess.DEVNULL, env=m.DOCKER_ENV)
                new = helper.wait_ready(cid)
                self.assertNotEqual(new.generation.main_start, before.generation.main_start)
                self.assertEqual(new.main.nice, 0)
                result['restarted_applied'] = helper.run(cid)
                self.assertTrue(result['restarted_applied']['configured'])
                if kind == 'game':
                    m.Helper(m.System(replace(config, nice=0))).run(cid)
                    code = '''import importlib.util, sys, signal
from dataclasses import replace
spec = importlib.util.spec_from_file_location('policy', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
config = m.Config(((sys.argv[2], sys.argv[3]),), container_name=sys.argv[4], project=sys.argv[4], health_port=int(sys.argv[5]), startup_timeout_seconds=15)
def stop(*args): raise m.Stopped()
signal.signal(signal.SIGTERM, stop)
try:
    with m.runtime_lock(sys.argv[6]): m.Watcher(lambda: config).run()
except m.Stopped: pass
'''
                    with tempfile.NamedTemporaryFile(mode='w+', dir=ROOT / '.cache/stardust', prefix='main-priority-watch-', suffix='.log', delete=False) as log, tempfile.TemporaryDirectory() as locks:
                        watch = subprocess.Popen([sys.executable, '-B', '-c', code, str(Path(__file__).with_name('main-thread-priority.py')),
                            image['revision'], image['id'], name, str(port), str(Path(locks) / 'lock')],
                            stdout=log, stderr=log, start_new_session=True)
                        try:
                            result['watch_log'] = log.name
                            watch.policy_log = Path(log.name)
                            self.wait_applied(system, cid, watch)
                            subprocess.run(m.DOCKER + ['restart', '--time', '5', cid], check=True, stdout=subprocess.DEVNULL, env=m.DOCKER_ENV)
                            result['watch_restart'] = self.wait_applied(system, cid, watch)
                            self.assert_owned(cid, name, purpose)
                            subprocess.run(m.DOCKER + ['rm', '-f', cid], check=True, stdout=subprocess.DEVNULL, env=m.DOCKER_ENV)
                            cid = None
                            cid = subprocess.check_output(cmd, env=m.DOCKER_ENV, text=True).strip()
                            subprocess.run(m.DOCKER + ['start', cid], check=True, stdout=subprocess.DEVNULL, env=m.DOCKER_ENV)
                            result['watch_recreate'] = self.wait_applied(system, cid, watch)
                        finally:
                            watch.terminate()
                            try:
                                watch.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                watch.kill()
                                watch.wait(timeout=5)
                        self.assertEqual(watch.returncode, 0)
                        self.assertNotIn('event-reconnect', Path(log.name).read_text(), 'healthy event subscription must stay open')
                        self.assertEqual(system.snapshot(cid).main.nice, -20, 'watcher exit retains completed policy')
            except BaseException as error:
                result['error_type'] = type(error).__name__
                raise
            finally:
                if cid:
                    raw = subprocess.check_output(m.DOCKER + ['container', 'inspect', '--format',
                        '{{.Id}} {{.Name}} {{index .Config.Labels "purpose"}}', cid], env=m.DOCKER_ENV, text=True).strip()
                    self.assertEqual(raw, f'{cid} /{name} {purpose}')
                    subprocess.run(m.DOCKER + ['rm', '-f', cid], check=True, stdout=subprocess.DEVNULL, env=m.DOCKER_ENV)
                    result['removed'] = True
                json.dump(result, evidence, indent=2)
                print(json.dumps({'fixture': kind, 'evidence': evidence.name, 'removed': result['removed']}), flush=True)

    def assert_owned(self, cid, name, purpose):
        raw = subprocess.check_output(m.DOCKER + ['container', 'inspect', '--format',
            '{{.Id}} {{.Name}} {{index .Config.Labels "purpose"}}', cid], env=m.DOCKER_ENV, text=True).strip()
        self.assertEqual(raw, f'{cid} /{name} {purpose}')

    def wait_applied(self, system, cid, watch):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self.assertIsNone(watch.poll(), 'watcher must remain running')
            try:
                snapshot = system.snapshot(cid)
                records = [json.loads(line) for line in watch.policy_log.read_text().splitlines(keepends=True)
                           if line.startswith('{') and line.endswith('\n')]
                completed = any(record.get('event') == 'policy-applied' and record.get('configured')
                    and record.get('container_id') == cid and record.get('main_pid') == snapshot.main.tid
                    and record.get('main_start_ticks') == snapshot.generation.main_start for record in records)
                if completed and snapshot.main.nice == -20 and snapshot.main.policy == m.RESET_ON_FORK:
                    return {'container_id': cid, 'main_pid': snapshot.main.tid, 'main_nice': -20,
                            'reset_on_fork': True, 'other_threads_zero': True}
            except m.NotReady:
                pass
            time.sleep(0.1)
        self.fail('watcher apply deadline')

    def marker(self, cid, expected):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # These are exclusively our labelled fixture logs, never production logs.
            raw = subprocess.check_output(m.DOCKER + ['logs', '--tail', '100', cid], env=m.DOCKER_ENV, text=True, stderr=subprocess.DEVNULL)
            for line in raw.splitlines():
                if not line.startswith('{'):
                    continue
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if value.get('stage') == 'failed':
                    self.fail('fixture reported failure')
                if value.get('stage') == expected:
                    return value
            time.sleep(0.1)
        self.fail('fixture event deadline')

    def test_actual_six_plus_one_worker_birth_replacement_and_restart(self):
        self.run_fixture('game')

    def test_late_libuv_birth_and_restart(self):
        self.run_fixture('lazy')


if __name__ == '__main__':
    unittest.main()
