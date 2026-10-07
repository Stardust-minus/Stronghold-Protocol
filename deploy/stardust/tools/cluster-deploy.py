#!/usr/bin/env python3
"""Generate a NEW protected fixed-profile cluster bundle; no SSH, Docker or activation."""
import argparse
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import re
import secrets
import stat
import sys

SOURCE = 'https://github.com/Stardust-minus/Stronghold-Protocol'
_PROFILE_SPEC = importlib.util.spec_from_file_location('cluster_profiles', Path(__file__).resolve().with_name('cluster-profile.py'))
profiles = importlib.util.module_from_spec(_PROFILE_SPEC)
sys.modules[_PROFILE_SPEC.name] = profiles
_PROFILE_SPEC.loader.exec_module(profiles)
# Stable legacy Beta aliases are read-only compatibility, never switched per call.
_BETA = profiles.get_profile()
CORE_PROJECT = _BETA.core_project
WG_IFACE, WG_CORE, WG_PEERS = _BETA.wg_interface, _BETA.wg_core, _BETA.wg_peers
CORE_SUBNET, EDGE_SUBNET = _BETA.core_subnet, _BETA.edge_subnet
COORDINATOR_PORT, END_PORT = _BETA.coordinator_port, _BETA.end_port
GAME_FIRST_PORT, INGRESS_PORT, ORIGIN = _BETA.game_first_port, _BETA.ingress_port, _BETA.origin
HEX40, HEX64 = re.compile(r'[a-f0-9]{40}'), re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
KNOWN_REPO = Path('/root/projects/Stronghold-Protocol')
_TOOL = Path(__file__).resolve()
_CANDIDATE_REPO = _TOOL.parents[3] if len(_TOOL.parents) > 3 else None
# Installed /opt/.../tools paths have '/' at this depth; it is NEVER a repository.
# A second checkout is recognized only by a Git marker and the exact source-tool anchor.
REPO = _CANDIDATE_REPO if (_CANDIDATE_REPO is not None and _CANDIDATE_REPO != Path('/')
                              and (_CANDIDATE_REPO / '.git').exists()
                              and (_CANDIDATE_REPO / 'deploy/stardust/tools/cluster-deploy.py').resolve() == _TOOL) else KNOWN_REPO
FORBIDDEN_REPOS = tuple(dict.fromkeys((KNOWN_REPO, REPO)))


class Refused(Exception):
    """Only fixed diagnostics; no secret or external command output."""


def require(ok, diagnostic):
    if not ok:
        raise Refused(diagnostic)


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def no_symlink(path, *, missing=False):
    path = Path(os.path.abspath(path))
    require(str(path) == str(Path(path)), 'non-normalized path')
    for parent in (*reversed(path.parents), path):
        try:
            info = os.lstat(parent)
        except FileNotFoundError:
            if missing and parent == path:
                continue
            raise Refused('deployment path unavailable') from None
        require(not stat.S_ISLNK(info.st_mode), 'symlink deployment path refused')
    return path


def write_new(path, data, *, mode=0o440, gid=1000):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
    finally:
        os.close(fd)


def mkdir_new(path, *, gid=1000):
    os.mkdir(path, 0o750)
    if os.geteuid() == 0:
        os.chown(path, 0, gid)
    os.chmod(path, 0o750)


def service(role, name, config_dir, *, image, build, kind, manifest, ip, ports, secrets_mounts=(), profile='beta'):
    return {
        'image': image, 'pull_policy': 'never', 'container_name': name,
        'init': True, 'restart': 'no', 'user': '1000:1000',
        'command': ['node', 'server/cluster/start.mjs', '--config', '/run/config/runtime.json'],
        'environment': {'NODE_ENV': 'production', 'SP_COMBAT': 'server', 'SP_VERIFY': 'off',
                        'SP_SNAPSHOT_HZ': '10', 'SP_COMBAT_WORKERS': '8' if role == 'game' else '0',
                        'SP_TRIAL_WORKERS': '2' if role == 'game' else '0', 'SP_WS_COMPRESSION': 'on'},
        'labels': {'org.opencontainers.image.source': SOURCE, 'org.opencontainers.image.revision': build,
                   'cn.stardust.cluster.source-kind': kind, 'cn.stardust.cluster.manifest-sha256': manifest,
                   'cn.stardust.cluster.role': role, 'cn.stardust.cluster.namespace': profiles.get_profile(profile).name},
        'ports': ports,
        # A directory mount preserves root-controlled atomic config replacement for SIGHUP.
        'volumes': [str(config_dir) + ':/run/config:ro', *secrets_mounts],
        'read_only': True, 'tmpfs': ['/tmp:rw,noexec,nosuid,size=16m'],
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'pids_limit': 128,
        'healthcheck': {'disable': True},
        'networks': {'default': {'ipv4_address': ip}},
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }


def network(subnet):
    return {'default': {'driver': 'bridge', 'ipam': {'config': [{'subnet': subnet}]}}}


def target(role, project, service_name, name, ip, mappings, config_file, config_sha, *, node_id=None, key_file=None, public_slot=None):
    value = {'role': role, 'project': project, 'service': service_name, 'container_name': name,
             'container_ip': ip, 'mappings': mappings, 'runtime_file': str(config_file),
             'runtime_sha256': config_sha, 'combat_workers': 8 if role == 'game' else 0,
             'trial_workers': 2 if role == 'game' else 0}
    if node_id is not None:
        value.update(node_id=node_id, key_file=str(key_file), public_slot=public_slot)
    return value


def generate(out, *, image, build, manifest_sha256, source_kind, role, entry=1, profile='beta'):
    p = profiles.get_profile(profile)
    require(source_kind in ('commit', 'tree'), 'invalid source identity kind')
    require(isinstance(build, str) and HEX40.fullmatch(build), 'fixed 40-hex build required')
    require(isinstance(manifest_sha256, str) and HEX64.fullmatch(manifest_sha256), 'full source manifest digest required')
    require(source_kind != 'tree' or build == manifest_sha256[:40], 'tree build must derive from the source manifest digest')
    require(isinstance(image, str) and IMAGE.fullmatch(image), 'immutable local image ID required')
    require(role in ('core', 'edge') and type(entry) is int and entry in range(1, 5), 'invalid deployment role')
    out = Path(os.path.abspath(out))
    require(all(out != repo and repo not in out.parents for repo in FORBIDDEN_REPOS), 'protected output must be outside repository')
    require(profiles.path_allowed(out, profile), 'cross-profile protected output refused')
    no_symlink(out, missing=True)
    require(not out.exists(), 'output already exists; never overwrite keys or a release')
    parent = out.parent.stat()
    require(parent.st_uid == os.geteuid() and not parent.st_mode & 0o022, 'output parent must be protected and owned')
    mkdir_new(out)
    configs, keys_dir = out / 'runtime', out / 'keys'
    mkdir_new(configs)
    mkdir_new(keys_dir)
    services, targets = {}, []

    def add_runtime(name, value):
        directory = configs / name
        mkdir_new(directory)
        raw = canonical(value)
        write_new(directory / 'runtime.json', raw)
        return directory, directory / 'runtime.json', hashlib.sha256(raw).hexdigest()

    if role == 'core':
        node_entries = []
        for index in range(1, 17):
            node_id = 'game-' + format(index, '02d')
            write_new(keys_dir / (node_id + '.key'), secrets.token_bytes(32))
            ip = p.core_ip(10 + index)
            port = p.game_first_port + index - 1
            config = {'role': 'game', 'nodeId': node_id, 'publicSlot': index, 'build': build,
                      'host': '0.0.0.0', 'port': 3000, 'keyFile': '/run/secrets/game.key',
                      'coordinatorUrl': f'http://{p.core_ip(2)}:3001', 'combatWorkers': 8,
                      'trialWorkers': 2, 'futureSkewMs': 1000}
            directory, file, sha = add_runtime(node_id, config)
            mappings = [{'container_port': 3000, 'host_ip': host, 'host_port': port} for host in ('127.0.0.1', p.wg_core)]
            name = p.core_project + '-' + node_id
            services[node_id] = service('game', name, directory, image=image, build=build, kind=source_kind,
                                        manifest=manifest_sha256, profile=profile, ip=ip,
                                        ports=[f'{row["host_ip"]}:{row["host_port"]}:3000' for row in mappings],
                                        secrets_mounts=[str(keys_dir / (node_id + '.key')) + ':/run/secrets/game.key:ro'])
            targets.append(target('game', p.core_project, node_id, name, ip, mappings, file, sha,
                                  node_id=node_id, key_file=keys_dir / (node_id + '.key'), public_slot=index))
            node_entries.append({'nodeId': node_id, 'publicSlot': index, 'url': f'http://{ip}:3000',
                                 'keyFile': '/run/secrets/' + node_id + '.key', 'capacity': 0})
        config = {'role': 'coordinator', 'build': build, 'host': '0.0.0.0', 'port': 3000,
                  'privateHost': '0.0.0.0', 'privatePort': 3001, 'heartbeatMs': 1000,
                  'snapshotHz': 10, 'nodes': node_entries}
        directory, file, sha = add_runtime('coordinator', config)
        mappings = [{'container_port': 3000, 'host_ip': host, 'host_port': p.coordinator_port} for host in ('127.0.0.1', p.wg_core)]
        mappings.append({'container_port': 3001, 'host_ip': '127.0.0.1', 'host_port': p.end_port})
        services['coordinator'] = service('coordinator', p.core_project + '-coordinator', directory,
                                          image=image, build=build, kind=source_kind, manifest=manifest_sha256, profile=profile,
                                          ip=p.core_ip(2),
                                          ports=[f'{row["host_ip"]}:{row["host_port"]}:{row["container_port"]}' for row in mappings],
                                          secrets_mounts=[str(keys_dir) + ':/run/secrets:ro'])
        targets.append(target('coordinator', p.core_project, 'coordinator', p.core_project + '-coordinator',
                              p.core_ip(2), mappings, file, sha))
        project, subnet, local, peers = p.core_project, p.core_subnet, p.wg_core, list(p.wg_peers)
    else:
        project = p.edge_project(entry)
        config = {'role': 'ingress', 'host': '0.0.0.0', 'port': 3000,
                  'coordinatorUrl': f'http://{p.wg_core}:{p.coordinator_port}',
                  'nodes': [{'nodeId': 'game-' + format(index, '02d'),
                             'url': f'http://{p.wg_core}:{p.game_first_port + index - 1}'} for index in range(1, 17)],
                  'origins': [p.origin], 'wsCompression': 'on', 'trustProxy': 'auto'}
        directory, file, sha = add_runtime('ingress', config)
        mappings = [{'container_port': 3000, 'host_ip': '127.0.0.1', 'host_port': p.ingress_port}]
        services['ingress'] = service('ingress', project + '-ingress', directory, image=image, build=build,
                                     kind=source_kind, manifest=manifest_sha256, profile=profile, ip=p.edge_ip,
                                     ports=[f'127.0.0.1:{p.ingress_port}:3000'])
        targets.append(target('ingress', project, 'ingress', project + '-ingress', p.edge_ip, mappings, file, sha))
        subnet, local, peers = p.edge_subnet, p.wg_peers[entry - 1], [p.wg_core]
    compose = {'name': project, 'services': services, 'networks': network(subnet)}
    compose_bytes = canonical(compose)
    write_new(out / 'compose.json', compose_bytes, mode=0o600, gid=0)
    policy = {'version': 1, 'namespace': p.name, 'host_role': role, 'entry': entry,
              'source_kind': source_kind, 'build': build, 'manifest_sha256': manifest_sha256,
              'image_id': image, 'bundle': str(out), 'compose_file': str(out / 'compose.json'),
              'compose_sha256': hashlib.sha256(compose_bytes).hexdigest(), 'project': project,
              'subnet': subnet, 'wg_interface': p.wg_interface, 'wg_local': local, 'wg_peers': peers,
              'origin': p.origin, 'targets': targets}
    write_new(out / 'host-policy.json', canonical(policy), mode=0o600, gid=0)
    # This summary contains no secret bytes and is safe to inspect. It is not an activation receipt.
    write_new(out / 'bundle-summary.json', canonical({
        'version': 1, **({'profile': p.name} if p.name != 'beta' else {}), 'prepared': True, 'activated': False, 'sourceKind': source_kind, 'build': build,
        'manifestSha256': manifest_sha256, 'imageId': image, 'role': role,
        'entry': entry, 'gameNodes': 16 if role == 'core' else 0,
        'combatWorkersPerGame': 8, 'trialWorkersPerGame': 2, 'ingressRoutes': 16,
        'ingressLogicalGroup': list(range((entry - 1) * 4 + 1, entry * 4 + 1)) if role == 'edge' else None,
        'coordinatorHighAvailability': False,
    }), mode=0o600, gid=0)
    return policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(profiles.PROFILES))
    parser.add_argument('--out', required=True)
    parser.add_argument('--role', required=True, choices=('core', 'edge'))
    parser.add_argument('--entry', type=int, default=1, choices=range(1, 5))
    parser.add_argument('--image-id', required=True)
    parser.add_argument('--build', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--source-kind', required=True, choices=('commit', 'tree'))
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'host root required for protected deployment generation')
        policy = generate(args.out, image=args.image_id, build=args.build, manifest_sha256=args.manifest_sha256,
                          source_kind=args.source_kind, role=args.role, entry=args.entry, profile=args.profile)
        print(json.dumps({'event': 'cluster-bundle-prepared', 'role': policy['host_role'],
                          'source_kind': policy['source_kind'], 'build': policy['build'],
                          'targets': len(policy['targets']), 'activated': False}))
        return 0
    except (Refused, OSError, ValueError):
        print('{"event":"refused","reason":"protected cluster bundle preparation refused"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
