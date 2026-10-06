#!/usr/bin/env python3
"""Host-only game main-TID policy. No container, server or Docker mutations."""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time
import urllib.request

DEFAULT_NICE = -20
RESET_ON_FORK = os.SCHED_RESET_ON_FORK
SOURCE = 'https://github.com/Stardust-minus/Stronghold-Protocol'
CID = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
DOCKER = ['/usr/bin/docker', '--host=unix:///var/run/docker.sock']
DOCKER_ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LC_ALL': 'C'}
LOCK = '/run/ark-main-thread-priority.lock'
BETA_LOCK = '/run/ark-beta-main-thread-priority.lock'
CORE_LOCK = '/run/ark-core-main-thread-priority.lock'


class Refused(Exception):
    """Fixed diagnostic strings only; never include command output or payloads."""


class NotReady(Refused):
    pass


class Stopped(BaseException):
    pass


@dataclass(frozen=True)
class Config:
    approved_images: tuple
    nice: int = DEFAULT_NICE
    startup_timeout_seconds: int = 90
    # Tests inject isolated targets; parsed config exposes only the three fixed profiles.
    project: str = 'ark-proto'
    service: str = 'ark-proto'
    container_name: str = 'ark-proto'
    health_port: int = 3120
    profile: str = 'prod'
    combat_workers: int = 6
    trial_workers: int = 1
    publish_ips: tuple = ('127.0.0.1',)

    @property
    def worker_count(self):
        return self.combat_workers + self.trial_workers

    @property
    def lock_path(self):
        return {'prod': LOCK, 'beta': BETA_LOCK, 'core': CORE_LOCK}[self.profile]

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or set(value) - {'profile', 'nice', 'startup_timeout_seconds', 'approved_images'}:
            raise Refused('invalid config keys')
        profile = value.get('profile', 'prod')
        if not isinstance(profile, str) or profile not in ('prod', 'beta', 'core'):
            raise Refused('profile must be prod, beta or core')
        nice = value.get('nice', DEFAULT_NICE)
        timeout = value.get('startup_timeout_seconds', 90)
        if type(nice) is not int or nice not in (0, DEFAULT_NICE):
            raise Refused('nice must be -20 or explicit restore value 0')
        if type(timeout) is not int or not 1 <= timeout <= 120:
            raise Refused('invalid startup timeout')
        images = value.get('approved_images')
        if not isinstance(images, list) or not 1 <= len(images) <= 8:
            raise Refused('approved image allowlist required')
        pairs = []
        for entry in images:
            if not isinstance(entry, dict) or set(entry) != {'revision', 'image_id'}:
                raise Refused('invalid approved image entry')
            revision, image_id = entry['revision'], entry['image_id']
            if not isinstance(revision, str) or not REVISION.fullmatch(revision):
                raise Refused('full source revision required')
            if not isinstance(image_id, str) or not IMAGE.fullmatch(image_id):
                raise Refused('immutable image ID required')
            pairs.append((revision, image_id))
        if profile == 'beta':
            return cls(tuple(pairs), nice, timeout, project='ark-proto-beta', service='ark-proto',
                       container_name='ark-proto-beta', health_port=3220, profile='beta',
                       combat_workers=12, trial_workers=2, publish_ips=('127.0.0.1', '10.253.77.2'))
        if profile == 'core':
            return cls(tuple(pairs), nice, timeout, profile='core', combat_workers=12, trial_workers=2,
                       publish_ips=('127.0.0.1', '10.253.77.2'))
        return cls(tuple(pairs), nice, timeout)


def load_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 65536:
            raise Refused('config must be a bounded root-owned non-writable regular file')
        with os.fdopen(fd, 'r', closefd=False) as source:
            try:
                return Config.parse(json.load(source))
            except (ValueError, UnicodeError):
                raise Refused('invalid config JSON') from None
    finally:
        os.close(fd)


def emit(event, **fields):
    print(json.dumps({'event': event, **fields}, separators=(',', ':')), flush=True)


def proc_stat(value):
    left, sep, right = value.rpartition(') ')
    if not sep or '(' not in left:
        raise Refused('invalid proc stat')
    fields = right.split()
    try:
        return {'name': left.split('(', 1)[1], 'state': fields[0], 'ppid': int(fields[1]),
                'nice': int(fields[16]), 'start_ticks': int(fields[19])}
    except (ValueError, IndexError):
        raise Refused('invalid proc stat fields') from None


# Limit the Docker reply at the source: no env, cmdline, whole inspect, or logs.
INSPECT_FIELDS = {
    'id': '.Id', 'name': '.Name', 'pid': '.State.Pid', 'running': '.State.Running',
    'restarting': '.State.Restarting', 'started_at': '.State.StartedAt', 'restarts': '.RestartCount',
    'image_id': '.Image', 'init': '.HostConfig.Init', 'readonly': '.HostConfig.ReadonlyRootfs',
    'privileged': '.HostConfig.Privileged', 'cap_drop': '.HostConfig.CapDrop', 'cap_add': '.HostConfig.CapAdd',
    'security_opt': '.HostConfig.SecurityOpt', 'pids': '.HostConfig.PidsLimit',
    'cpu_quota': '.HostConfig.CpuQuota', 'nano_cpus': '.HostConfig.NanoCpus',
    'cpuset': '.HostConfig.CpusetCpus', 'memory': '.HostConfig.Memory',
    'ports': '(index .NetworkSettings.Ports "3000/tcp")',
    'project': '(index .Config.Labels "com.docker.compose.project")',
    'service': '(index .Config.Labels "com.docker.compose.service")',
    'revision': '(index .Config.Labels "org.opencontainers.image.revision")',
    'source': '(index .Config.Labels "org.opencontainers.image.source")',
}
IMAGE_FIELDS = {
    'id': '.Id',
    'revision': '(index .Config.Labels "org.opencontainers.image.revision")',
    'source': '(index .Config.Labels "org.opencontainers.image.source")',
}


def formatter(fields):
    return '{' + ','.join(json.dumps(key) + ':{{json ' + value + '}}' for key, value in fields.items()) + '}'


def validate_info(info, image, config):
    if (info.get('name') != '/' + config.container_name or info.get('project') != config.project
            or info.get('service') != config.service):
        raise Refused('container selector mismatch')
    if not CID.fullmatch(str(info.get('id', ''))):
        raise Refused('invalid container ID')
    if (info.get('source') != SOURCE or image.get('source') != SOURCE
            or (info.get('revision'), info.get('image_id')) not in config.approved_images
            or image.get('id') != info.get('image_id') or image.get('revision') != info.get('revision')):
        raise Refused('image and source not approved')
    if info.get('running') is not True or info.get('restarting') is not False or type(info.get('pid')) is not int or info['pid'] <= 0:
        raise NotReady('container not running')
    if (info.get('init') is not True or info.get('readonly') is not True or info.get('privileged') is not False
            or set(info.get('cap_drop') or []) != {'ALL'} or info.get('cap_add')
            or not set(info.get('security_opt') or []) & {'no-new-privileges', 'no-new-privileges:true'}
            or info.get('pids') != 128):
        raise Refused('container security baseline mismatch')
    if any(info.get(key) != 0 for key in ('cpu_quota', 'nano_cpus', 'memory')) or info.get('cpuset') != '':
        raise Refused('container resource baseline mismatch')
    ports = info.get('ports')
    expected = {(ip, str(config.health_port)) for ip in config.publish_ips}
    if (not isinstance(ports, list) or len(ports) != len(expected)
            or any(not isinstance(port, dict) or set(port) != {'HostIp', 'HostPort'}
                   or not isinstance(port['HostIp'], str) or not isinstance(port['HostPort'], str) for port in ports)
            or {(port['HostIp'], port['HostPort']) for port in ports} != expected):
        raise Refused('fixed health mapping mismatch')


def health_ready(value, config=None):
    if not isinstance(value, dict):
        return False
    combat_workers = config.combat_workers if config is not None else 6
    trial_workers = config.trial_workers if config is not None else 1
    combat, trial = value.get('combat'), value.get('trial')
    # Both shipped defaults are healthy: legacy4096 and explicit0=unlimited admission.
    rooms = value.get('maxRooms')
    return (value.get('ok') is True and type(rooms) is int and rooms in (0, 4096)
            and isinstance(combat, dict) and combat.get('status') == 'ready' and combat.get('ready') == combat_workers
            and combat.get('workers') == combat_workers and isinstance(trial, dict) and trial.get('status') == 'ready'
            and trial.get('ready') == trial_workers and trial.get('workers') == trial_workers)


@dataclass(frozen=True)
class Generation:
    container_id: str
    image_id: str
    revision: str
    started_at: str
    restarts: int
    init_pid: int
    init_start: int
    main_pid: int
    main_start: int


@dataclass(frozen=True)
class Thread:
    tid: int
    name: str
    nice: int
    policy: int
    start_ticks: int


@dataclass(frozen=True)
class Snapshot:
    generation: Generation
    threads: tuple

    @property
    def main(self):
        return next(thread for thread in self.threads if thread.tid == self.generation.main_pid)


def validate_threads(snapshot, config=None):
    main = snapshot.main
    if main.name != 'MainThread' or main.nice not in (0, DEFAULT_NICE) or main.policy not in (os.SCHED_OTHER, os.SCHED_OTHER | RESET_ON_FORK):
        raise Refused('unexpected main-thread policy')
    worker_count = config.worker_count if config is not None else 7
    if sum(thread.name == 'WorkerThread' for thread in snapshot.threads) != worker_count:
        raise NotReady(f'exactly {worker_count} workers required')
    if any(thread.nice != 0 or thread.policy != os.SCHED_OTHER for thread in snapshot.threads if thread.tid != main.tid):
        raise Refused('unexpected helper-thread policy')


class System:
    def __init__(self, config):
        self.config = config
        self.health_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def docker(self, *args):
        try:
            result = subprocess.run(DOCKER + list(args), capture_output=True, text=True, timeout=5, env=DOCKER_ENV)
        except (OSError, subprocess.TimeoutExpired):
            raise NotReady('local Docker unavailable') from None
        if result.returncode or len(result.stdout) > 65536:
            raise NotReady('local Docker query failed')
        try:
            value = json.loads(result.stdout)
        except ValueError:
            raise Refused('invalid Docker reply') from None
        if not isinstance(value, dict):
            raise Refused('invalid Docker reply structure')
        return value

    def inspect(self, target):
        info = self.docker('container', 'inspect', '--format', formatter(INSPECT_FIELDS), target)
        if not IMAGE.fullmatch(str(info.get('image_id', ''))):
            raise Refused('invalid container image ID')
        if CID.fullmatch(target) and info.get('id') != target:
            raise Refused('requested container ID mismatch')
        image = self.docker('image', 'inspect', '--format', formatter(IMAGE_FIELDS), info['image_id'])
        validate_info(info, image, self.config)
        return info

    def read(self, path, limit=16384):
        with open(path, 'r') as source:
            value = source.read(limit + 1)
        if len(value) > limit:
            raise Refused('proc reply too large')
        return value

    def node(self, init_pid):
        cgroup = self.read(f'/proc/{init_pid}/cgroup')
        pending, seen, candidates = [init_pid], set(), []
        while pending:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            if len(seen) > 32:
                raise Refused('container process tree exceeds bound')
            value = proc_stat(self.read(f'/proc/{pid}/stat'))
            if value['state'] == 'Z':
                continue
            if self.read(f'/proc/{pid}/cgroup') != cgroup:
                raise Refused('process left container cgroup')
            if value['name'] == 'MainThread':
                status = self.read(f'/proc/{pid}/status')
                if f'Tgid:\t{pid}\n' not in status or Path(os.readlink(f'/proc/{pid}/exe')).name != 'node':
                    raise Refused('main process identity mismatch')
                candidates.append((pid, value['start_ticks']))
            children = self.read(f'/proc/{pid}/task/{pid}/children', 4096).split()
            if any(not child.isdecimal() for child in children):
                raise Refused('invalid child PID')
            pending.extend(int(child) for child in children)
        if len(candidates) > 1:
            raise Refused('multiple Node main processes')
        if not candidates:
            raise NotReady('Node main process not ready')
        return candidates[0]

    def health(self):
        url = f'http://127.0.0.1:{self.config.health_port}/healthz'
        try:
            with self.health_opener.open(url, timeout=1) as response:
                raw = response.read(65537)
                if response.status != 200 or len(raw) > 65536:
                    raise NotReady('health response unavailable')
                value = json.loads(raw)
        except (OSError, ValueError):
            raise NotReady('health response unavailable') from None
        if not health_ready(value, self.config):
            raise NotReady(f'combat{self.config.combat_workers} and trial{self.config.trial_workers} not ready')

    def snapshot(self, target, ready=True):
        try:
            info = self.inspect(target)
            init_pid = info['pid']
            init_start = proc_stat(self.read(f'/proc/{init_pid}/stat'))['start_ticks']
            pid, start = self.node(init_pid)
            threads = []
            for entry in Path(f'/proc/{pid}/task').iterdir():
                tid = int(entry.name)
                value = proc_stat(self.read(entry / 'stat'))
                threads.append(Thread(tid, value['name'], os.getpriority(os.PRIO_PROCESS, tid),
                                      os.sched_getscheduler(tid), value['start_ticks']))
            generation = Generation(info['id'], info['image_id'], info['revision'], info['started_at'],
                                    info['restarts'], init_pid, init_start, pid, start)
            snapshot = Snapshot(generation, tuple(threads))
            if ready:
                self.health()
                validate_threads(snapshot, self.config)
            # Detect restart/recreation while collecting proc and health replies.
            if self.inspect(target) != info or proc_stat(self.read(f'/proc/{pid}/stat'))['start_ticks'] != start:
                raise Refused('container generation changed')
            return snapshot
        except (FileNotFoundError, ProcessLookupError):
            raise NotReady('process exited during check') from None

    def set_policy(self, tid, value):
        os.sched_setscheduler(tid, value, os.sched_param(0))

    def set_nice(self, tid, value):
        os.setpriority(os.PRIO_PROCESS, tid, value)


def thread_state(snapshot):
    return snapshot.main.nice, snapshot.main.policy


class Helper:
    def __init__(self, system, clock=time.monotonic, sleep=time.sleep):
        self.system, self.clock, self.sleep = system, clock, sleep
        self.config = system.config

    def wait_ready(self, target):
        deadline = self.clock() + self.config.startup_timeout_seconds
        while True:
            try:
                return self.system.snapshot(target)
            except NotReady:
                if self.clock() >= deadline:
                    raise Refused('startup readiness deadline exceeded') from None
                self.sleep(min(1, max(0, deadline - self.clock())))

    def guard(self, target, generation, expected):
        snapshot = self.system.snapshot(target)
        if snapshot.generation != generation:
            raise Refused('game process generation changed')
        if thread_state(snapshot) != expected:
            raise Refused('main-thread state changed externally')
        return snapshot

    def rollback(self, target, generation, operations):
        # Reverse only our own expected state, not a third-party policy or reused PID.
        try:
            for kind, before, after in reversed(operations):
                snapshot = self.system.snapshot(target, ready=False)
                if snapshot.generation != generation:
                    return False
                current = thread_state(snapshot)
                if current == before:
                    continue
                if current != after:
                    return False
                if kind == 'nice':
                    self.system.set_nice(generation.main_pid, before[0])
                else:
                    self.system.set_policy(generation.main_pid, before[1])
            snapshot = self.system.snapshot(target, ready=False)
            return snapshot.generation == generation
        except (Refused, OSError, Stopped):
            return False

    def run(self, target, check=False):
        initial = self.wait_ready(target)
        generation, expected, operations = initial.generation, thread_state(initial), []
        desired = (self.config.nice, os.SCHED_OTHER | RESET_ON_FORK if self.config.nice < 0 else os.SCHED_OTHER)
        try:
            # Boost: protect thread births first. Restore: nice0 first, then clear guard.
            order = ('policy', 'nice') if self.config.nice < 0 else ('nice', 'policy')
            if not check:
                for kind in order:
                    index = 0 if kind == 'nice' else 1
                    if expected[index] == desired[index]:
                        continue
                    self.guard(target, generation, expected)
                    updated = list(expected)
                    updated[index] = desired[index]
                    updated = tuple(updated)
                    operations.append((kind, expected, updated))
                    expected = updated
                    if kind == 'nice':
                        self.system.set_nice(generation.main_pid, desired[0])
                    else:
                        self.system.set_policy(generation.main_pid, desired[1])
                    self.guard(target, generation, expected)
            final = self.guard(target, generation, expected)
        except BaseException as error:
            if operations:
                restored = self.rollback(target, generation, operations)
                emit('transaction-rollback', container_id=generation.container_id, restored=restored)
                if not restored and isinstance(error, NotReady):
                    raise Refused('transient failure with unconfirmed rollback') from None
            raise
        return {'container_id': generation.container_id, 'image_id': generation.image_id,
                'revision': generation.revision, 'main_pid': generation.main_pid,
                'main_start_ticks': generation.main_start, 'container_started_at': generation.started_at,
                'main_nice': final.main.nice, 'scheduler': 'SCHED_OTHER',
                'reset_on_fork': bool(final.main.policy & RESET_ON_FORK),
                'other_threads': len(final.threads) - 1,
                'combat_ready': self.config.combat_workers, 'trial_ready': self.config.trial_workers,
                'configured': thread_state(final) == desired, 'changed': bool(operations)}


@contextmanager
def runtime_lock(path=LOCK, *, timeout=0):
    if type(timeout) not in (int, float) or not 0 <= timeout <= 30 or not math.isfinite(timeout):
        raise Refused('invalid runtime lock timeout')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
            raise Refused('unsafe runtime lock')
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if timeout == 0 or remaining <= 0:
                    raise Refused('another policy writer is active') from None
                time.sleep(min(0.05, remaining))
                if time.monotonic() >= deadline:
                    raise Refused('another policy writer is active') from None
        yield
    finally:
        os.close(fd)


def events_command(config, since):
    return DOCKER + ['events', '--since', since, '--filter', 'type=container', '--filter', 'event=start',
                     '--filter', 'label=com.docker.compose.project=' + config.project,
                     '--filter', 'label=com.docker.compose.service=' + config.service, '--format', '{{.Actor.ID}}']


def stop_stream(stream):
    if stream.stdout:
        stream.stdout.close()
    if stream.poll() is None:
        stream.terminate()
        try:
            stream.wait(timeout=3)
        except subprocess.TimeoutExpired:
            stream.kill()
            stream.wait(timeout=3)


class Watcher:
    def __init__(self, config_loader, system_factory=System, popen=subprocess.Popen, sleep=time.sleep,
                 clock=time.monotonic, profile=None):
        self.config_loader, self.system_factory, self.popen, self.sleep = config_loader, system_factory, popen, sleep
        self.clock, self.profile = clock, profile

    def load_config(self):
        config = self.config_loader()
        if self.profile is None:
            self.profile = config.profile
        if config.profile != self.profile:
            raise Refused('config profile changed; restart the matching policy unit')
        return config

    def handle(self, target):
        try:
            config = self.load_config()
            deadline = self.clock() + config.startup_timeout_seconds
            for attempt in range(3):
                if attempt:
                    config = self.load_config()
                remaining = math.ceil(deadline - self.clock())
                if remaining <= 0:
                    raise Refused('policy application deadline exceeded')
                config = replace(config, startup_timeout_seconds=min(config.startup_timeout_seconds, remaining))
                try:
                    result = Helper(self.system_factory(config), clock=self.clock, sleep=self.sleep).run(target)
                    emit('policy-applied', **result)
                    return
                except NotReady as error:
                    # Only transient failures with no mutations or confirmed rollback reach here.
                    if attempt == 2 or self.clock() >= deadline:
                        raise Refused('transient check retry budget exhausted') from None
                    emit('policy-retry', attempt=attempt + 1, reason=str(error))
                    self.sleep(min(0.25 * 2 ** attempt, max(0, deadline - self.clock())))
        except Refused as error:
            emit('policy-skipped', reason=str(error))
        except OSError:
            emit('policy-skipped', reason='host scheduling or proc access failed')

    def cycle(self):
        config = self.load_config()
        since = datetime.now(timezone.utc).isoformat()
        stream = self.popen(events_command(config, since), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, env=DOCKER_ENV, start_new_session=True)
        try:
            # The event cursor predates the scan, so a start during readiness isn't lost.
            self.handle(config.container_name)
            for line in stream.stdout:
                target = line.strip()
                if CID.fullmatch(target):
                    self.handle(target)
            raise NotReady('Docker event stream ended')
        finally:
            stop_stream(stream)

    def run(self):
        delay = 1
        while True:
            try:
                self.cycle()
            except (NotReady, OSError):
                emit('event-reconnect', delay_seconds=delay)
                self.sleep(delay)
                delay = min(30, delay * 2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--profile', choices=('prod', 'beta', 'core'),
                        help='require a matching fixed config profile; never override config selectors')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='read-only check; exit2 if policy is not applied')
    mode.add_argument('--watch', action='store_true', help='watch local Docker starts and apply policy')
    args = parser.parse_args()
    if os.geteuid() != 0:
        emit('refused', reason='host root required; no container capabilities are granted')
        return 1

    def stop(_signal, _frame):
        raise Stopped()

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, stop)
    try:
        config = load_config(args.config)
        if args.profile is not None and config.profile != args.profile:
            raise Refused('config profile does not match requested fixed profile')
        if args.check:
            result = Helper(System(config)).run(config.container_name, check=True)
            emit('policy-checked', **result)
            return 0 if result['configured'] else 2
        with runtime_lock(config.lock_path):
            if args.watch:
                Watcher(lambda: load_config(args.config), profile=config.profile).run()
            else:
                emit('policy-applied', **Helper(System(config)).run(config.container_name))
        return 0
    except Stopped:
        emit('stopped', policy_retained=True)
        return 0
    except Refused as error:
        emit('refused', reason=str(error))
        return 1
    except OSError:
        emit('refused', reason='host config, scheduling or proc access failed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
