#!/usr/bin/env python3
"""Fixed Beta/core lifecycle: close the WG lease before starting or stopping a game."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('game_backend_access', BASE / 'wg-backend-access.py')
access = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = access
spec.loader.exec_module(access)
priority = access.priority
Refused = priority.Refused
ENV = priority.DOCKER_ENV


def paths(profile):
    root = Path('/opt/ark-proto-beta' if profile == 'beta' else '/opt/ark-proto')
    return root, root / ('compose.beta-game.yaml' if profile == 'beta' else 'compose.core-game.yaml'), root / 'runtime.env'


def compose(config, action):
    root, definition, environment = paths(config.profile)
    # Configuration is public image metadata only; secrets never belong in this env file.
    for path in (definition, environment):
        path = access.no_symlink(path)
        info = path.stat()
        access.require(access.stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                       and info.st_size <= 65536, 'unsafe fixed deployment file')
    image_rows = [line.partition('=')[2].strip() for line in environment.read_text().splitlines() if line.startswith('ARK_GAME_IMAGE=')]
    access.require(len(image_rows) == 1 and image_rows[0], 'fixed game image required')
    system = priority.System(config)
    image = system.docker('image', 'inspect', '--format', priority.formatter(priority.IMAGE_FIELDS), image_rows[0])
    access.require((image.get('revision'), image.get('id')) in config.approved_images and image.get('source') == priority.SOURCE,
                   'deployment image not approved')
    args = priority.DOCKER + ['compose', '--project-name', config.project, '--env-file', str(environment), '-f', str(definition)]
    args += ['up', '-d', '--no-deps', 'ark-proto'] if action == 'start' else ['stop', '--timeout', '10', 'ark-proto']
    value = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, timeout=60)
    access.require(value.returncode == 0, 'fixed game lifecycle failed')


def gate(config, action):
    with priority.runtime_lock(access.LOCK):
        return access.Helper(access.System(config), access.Nft(), access.Store()).run(action)


def start(config):
    gate(config, 'guard')
    # If the fixed name is already in use, never recreate an unapproved or foreign container.
    system = priority.System(config)
    running = subprocess.run(priority.DOCKER + ['container', 'inspect', '--format', priority.formatter(priority.INSPECT_FIELDS),
                                               config.container_name], capture_output=True, text=True, timeout=5, env=ENV)
    if running.returncode == 0:
        info = json.loads(running.stdout)
        access.require(info.get('name') == '/' + config.container_name and info.get('project') == config.project
                       and info.get('service') == config.service and (info.get('revision'), info.get('image_id')) in config.approved_images,
                       'fixed game name already owned elsewhere')
    compose(config, 'start')
    with priority.runtime_lock(config.lock_path):
        priority.Helper(system).run(config.container_name)
    gate(config, 'open')
    return access.lease(access.System(config))


def stop(config, expected=None):
    gate(config, 'close')
    info = priority.System(config).inspect(config.container_name)
    access.require(info.get('name') == '/' + config.container_name and info.get('project') == config.project
                   and info.get('service') == config.service and (info.get('revision'), info.get('image_id')) in config.approved_images,
                   'stop target not approved')
    if expected is not None:
        access.require(info['id'] == expected['container_id'], 'stop generation changed')
    # Stop the verified immutable CID, never a name that could be reused between inspection and the operation.
    result = subprocess.run(priority.DOCKER + ['stop', '--time', '10', info['id']], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=ENV, timeout=20)
    access.require(result.returncode == 0, 'owned game stop failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, choices=('beta', 'core'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--action', required=True, choices=('start', 'stop', 'serve', 'check'))
    args = parser.parse_args()
    def interrupted(_number, _frame):
        raise priority.Stopped()
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    config = None
    try:
        access.require(os.geteuid() == 0, 'host root required')
        config = access.load_config(args.config, args.profile)
        # A lifecycle lock prevents two root managers from changing one backend at once.
        with priority.runtime_lock('/run/ark-game-' + args.profile + '-lifecycle.lock'):
            if args.action == 'check':
                gate(config, 'check')
            elif args.action == 'stop':
                stop(config)
            else:
                started = start(config)
                priority.emit('game-backend-started', profile=config.profile, container_id=started['container_id'])
                if args.action == 'serve':
                    while True:
                        time.sleep(5)
                        gate(config, 'check')
        return 0
    except priority.Stopped:
        # Completed priority policy stays; only the owned WG lease is closed when this manager exits.
        if config is not None:
            try: gate(config, 'close')
            except (Refused, OSError, ValueError): pass
        return 0
    except (Refused, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        if config is not None:
            try: gate(config, 'close')
            except (Refused, OSError, ValueError): pass
        priority.emit('refused', reason='fixed backend lifecycle refused; no command output disclosed')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
