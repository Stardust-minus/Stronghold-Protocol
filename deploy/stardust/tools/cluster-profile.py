#!/usr/bin/env python3
"""Exact, immutable cluster namespaces. No caller-supplied network overrides."""
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType


@dataclass(frozen=True)
class Profile:
    name: str
    origin: str
    wg_interface: str
    wg_core: str
    wg_peers: tuple
    wg_port: int
    core_subnet: str
    edge_subnet: str
    coordinator_port: int
    end_port: int
    game_first_port: int
    ingress_port: int
    wg_owner: str
    security_map: str
    code_prefix: str

    @property
    def root(self):
        return Path('/opt/ark-cluster-' + self.name)

    @property
    def policy_file(self):
        return Path('/etc/ark-cluster-' + self.name + '/host-policy.json')

    @property
    def wg_directory(self):
        return Path('/etc/ark-cluster-' + self.name + '-wg')

    @property
    def site(self):
        return self.origin.removeprefix('https://')

    @property
    def core_project(self):
        return 'ark-cluster-' + self.name + '-core'

    def edge_project(self, entry):
        return 'ark-cluster-' + self.name + '-edge-' + format(entry, '02d')

    def table(self, role):
        if role not in ('boot', 'core', 'edge'):
            raise ValueError('invalid fixed cluster guard role')
        return 'ak_cluster_' + self.name + '_' + role

    def core_ip(self, suffix):
        return self.core_subnet.split('/')[0].rsplit('.', 1)[0] + '.' + str(suffix)

    @property
    def edge_ip(self):
        return self.ingress_ip(1)

    def ingress_ip(self, instance=1):
        if type(instance) is not int or instance not in (1, 2):
            raise ValueError('only one or two fixed ingress instances supported')
        return self.edge_subnet.split('/')[0].rsplit('.', 1)[0] + '.' + str(instance + 1)

    def ingress_host_port(self, instance=1):
        self.ingress_ip(instance)  # Validate before deriving a fixed mapping.
        return self.ingress_port + instance - 1

    @property
    def endpoints(self):
        return MappingProxyType(dict(zip(self.wg_peers, (
            host + ':' + str(self.wg_port)
            for host in ('115.231.235.78', '115.231.235.219' if self.name == 'formal' else '115.231.235.75',
                         '115.231.235.73', '115.231.235.92')))))

    @property
    def protected_roots(self):
        projects = (self.core_project, *(self.edge_project(i) for i in range(1, 5)))
        return (self.root, self.policy_file.parent, self.wg_directory,
                Path('/www/sites') / self.site, Path('/opt/ark-proto-' + self.name),
                Path('/etc/ark-proto-' + self.name),
                Path('/run/ark-cluster-' + self.name + '-wg.lock'),
                *(Path('/run/' + project + suffix) for project in projects for suffix in ('.guard.json', '.lock', '.control')))


PROFILES = MappingProxyType({
    'beta': Profile('beta', 'https://ark-proto-beta.stardust.matce.cn',
                    'ark-wg-cluster', '10.253.78.2', tuple('10.253.78.' + str(i) for i in range(11, 15)),
                    51838, '172.30.242.0/24', '172.30.243.0/24', 35300, 35310, 35311, 35301,
                    'ark-cluster-beta-wg-20261007-7DkMrv', 'ark_beta', 'cluster-'),
    'formal': Profile('formal', 'https://ark-proto.stardust.matce.cn',
                      'ark-wg-formal', '10.253.79.2', tuple('10.253.79.' + str(i) for i in range(11, 15)),
                      51839, '172.30.245.0/24', '172.30.246.0/24', 35400, 35410, 35411, 35401,
                      'ark-cluster-formal-wg-20261007', 'ark_proto', 'cluster-formal-'),
})


def get_profile(name='beta'):
    if not isinstance(name, str) or name not in PROFILES:
        raise ValueError('unknown fixed cluster profile')
    return PROFILES[name]


def path_allowed(path, profile='beta'):
    """A profile may never consume or write the other namespace's owned paths."""
    selected = get_profile(profile)
    path = Path(path)
    return path.is_absolute() and all(
        path != root and root not in path.parents
        for other in PROFILES.values() if other.name != selected.name
        for root in other.protected_roots)
