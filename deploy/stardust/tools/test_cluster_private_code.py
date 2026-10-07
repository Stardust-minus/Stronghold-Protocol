"""Pinned TREE private-code tests; no Git writes, SSH, actual secrets or activation."""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_private_code_tested', BASE / 'cluster-private-code.py')
code = importlib.util.module_from_spec(spec)
spec.loader.exec_module(code)


class PrivateCodeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ark-cluster-private-code-'))
        self.addCleanup(shutil.rmtree, self.root)
        self.source, self.output = self.root / 'app', self.root / 'stage'
        self.rows = []
        for path, body in [('public/js/main.js', b'export const fixture = "private";\n'),
                           ('public/js/ui/panel.js', b'export const panel = 1;\n'),
                           ('public/css/theme.css', b'body { color: #123456; }\n'),
                           ('public/css/screens/game.css', b'.game { display: grid; }\n')]:
            file = self.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
            file.chmod(0o644)
            self.rows.append({'path': path, 'bytes': len(body), 'sha256': code.sha(body), 'mode': '0o644'})
        # Out-of-scope app files are neither executed, published nor silently copied.
        for path in ('data/private.json', 'server/index.js', 'public/index.html', 'public/assets/test.png', 'public/vendor/test.js'):
            file = self.source / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'explicit excluded fixture')
        self.manifest = self.root / 'source-manifest.json'
        self.value = {'version': 1, 'kind': 'tree', 'baseRevision': 'a' * 40,
                      'files': sorted(self.rows, key=lambda row: row['path'])}
        self.refresh()

    def refresh(self):
        raw = code.canonical(self.value)
        self.manifest.write_bytes(raw)
        self.digest, self.build = code.sha(raw), code.sha(raw)[:40]

    def prepare(self):
        return code.prepare(self.source, self.manifest, self.digest, self.build, self.output)

    def verify(self):
        return code.verify(self.output, self.manifest, self.digest, self.build)

    def test_reproducible_tree_snapshot_inventory_bytes_mode_and_provenance(self):
        value = self.prepare()
        self.assertEqual(value, self.verify())
        self.assertEqual((value['namespace'], value['sourceKind'], value['build']), ('beta', 'tree', self.build))
        self.assertFalse(value['activated'])
        self.assertEqual(len(value['files']), 4)
        self.assertEqual(value['preparer']['sha256'], code.sha((BASE / 'cluster-private-code.py').read_bytes()))
        for row in value['files']:
            file = self.output / ('localcode/cluster-' + self.build) / row['path']
            self.assertEqual(file.read_bytes(), (self.source / row['sourcePath']).read_bytes())
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)
            self.assertEqual(file.stat().st_nlink, 1)
        other = self.root / 'stage2'
        self.assertEqual(code.prepare(self.source, self.manifest, self.digest, self.build, other), value)
        self.assertEqual((other / 'SHA256SUMS').read_bytes(), (self.output / 'SHA256SUMS').read_bytes())
        self.assertFalse((self.output / 'data').exists())
        self.assertFalse((self.output / 'public').exists())

    def test_exact_aliases_gate_after_access_fallback_and_every_stock_security_header(self):
        value = self.prepare()
        include = (self.output / value['nginx'][0]['path']).read_text()
        self.assertEqual(include.count('location = /'), 4)
        self.assertEqual(include.count('auth_request /_gate/check;'), 7)
        stock = (BASE.parent / 'nginx' / 'ark-proto-beta.conf').read_text().split('proxy_hide_header')[0]
        headers = [line.strip() for line in stock.splitlines() if line.strip().startswith('add_header ')
                   and not line.strip().startswith('add_header Access-Control-Allow-Origin')]
        for directive in headers:
            with self.subTest(header=directive):
                self.assertEqual(include.count(directive), 7)
        self.assertNotIn('add_header Access-Control-Allow-Origin', include)
        self.assertNotIn('auth_request off', include)
        self.assertNotIn('try_files', include)
        self.assertNotIn('rewrite', include)
        self.assertNotIn('http://10.253.77.', include)
        self.assertNotIn('/opt/ark-proto/', include)
        self.assertNotIn('ark-proto.stardust.matce.cn', include)
        self.assertEqual(include.count('error_page 404 = @ark_beta_cluster_code;'), 4)
        self.assertEqual(include.count('proxy_pass http://10.253.78.2:35300;'), 3)
        self.assertIn('location @ark_beta_cluster_code {', include)
        self.assertIn('location ^~ /js/ {', include)
        self.assertIn('location ^~ /css/ {', include)
        self.assertIn('default_type application/javascript;', include)
        self.assertIn('default_type text/css;', include)
        self.assertIn('disable_symlinks on;', include)
        self.assertIn('an empty $ark_beta_csp emits no CSP header', include)
        self.assertNotIn('gitBlob', json.dumps(value))
        self.assertNotIn('fullref', json.dumps(value))

    def test_bytes_source_mode_extra_js_css_noncodes_missing_and_empty_dirs_refused(self):
        cases = ('bytes', 'mode', 'extra-js', 'extra-css', 'extra-map', 'extra-txt', 'missing', 'empty-dir')
        for case in cases:
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    file = fixture.source / 'public/js/main.js'
                    if case == 'bytes': file.write_bytes(b'forged bytes')
                    if case == 'mode': file.chmod(0o755)
                    if case == 'missing': file.unlink()
                    if case == 'empty-dir': (fixture.source / 'public/js/unknown').mkdir()
                    paths = {'extra-js': 'public/js/unknown.js', 'extra-css': 'public/css/unknown.css',
                             'extra-map': 'public/js/main.js.map', 'extra-txt': 'public/css/notes.txt'}
                    if case in paths: (fixture.source / paths[case]).write_bytes(b'unknown')
                    with self.assertRaises((code.Refused, OSError)): fixture.prepare()
                    self.assertFalse(fixture.output.exists())
                finally:
                    fixture.doCleanups()

    def test_links_hardlinks_fifo_ancestor_link_and_manifest_link_refused(self):
        for case in ('symlink', 'hardlink', 'fifo', 'directory-link', 'source-link', 'manifest-link'):
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    file = fixture.source / 'public/js/main.js'
                    target = fixture.root / 'target.js'
                    target.write_bytes(file.read_bytes())
                    if case in ('symlink', 'hardlink', 'fifo'):
                        file.unlink()
                        if case == 'symlink': file.symlink_to(target)
                        if case == 'hardlink': os.link(target, file)
                        if case == 'fifo': os.mkfifo(file)
                    if case == 'directory-link':
                        directory = fixture.source / 'public/js/ui'
                        directory.rename(fixture.root / 'ui')
                        directory.symlink_to(fixture.root / 'ui')
                    if case == 'source-link':
                        fixture.source.rename(fixture.root / 'real-app')
                        fixture.source.symlink_to(fixture.root / 'real-app')
                    if case == 'manifest-link':
                        fixture.manifest.rename(fixture.root / 'real-manifest.json')
                        fixture.manifest.symlink_to(fixture.root / 'real-manifest.json')
                    with self.assertRaises((code.Refused, OSError)): fixture.prepare()
                    self.assertFalse(fixture.output.exists())
                finally:
                    fixture.doCleanups()

    def test_unsafe_manifest_paths_schema_kind_and_duplicate_entries_refused(self):
        for bad in ('../private.js', 'public/js/.secret.js', 'public/js/hello world.js',
                    'public/js/bad;name.js', 'public/js/$host.js', 'public/js/%2e.js',
                    'public/js/quoted"name.js', 'public/js/back\\slash.js', 'public/js/final.js\n'):
            original = deepcopy(self.value)
            self.value['files'][0]['path'] = bad
            self.value['files'].sort(key=lambda row: row['path'])
            self.refresh()
            with self.assertRaises(code.Refused): self.prepare()
            self.value = original
        for key, bad in (('kind', 'commit'), ('version', True), ('baseRevision', 'HEAD')):
            original = deepcopy(self.value)
            self.value[key] = bad
            self.refresh()
            with self.assertRaises(code.Refused): self.prepare()
            self.value = original
        self.value['files'].append(deepcopy(self.value['files'][0]))
        self.value['files'].sort(key=lambda row: row['path'])
        self.refresh()
        with self.assertRaises(code.Refused): self.prepare()

    def test_pinned_digest_build_canonical_json_and_duplicate_keys_are_required(self):
        original = self.manifest.read_bytes()
        self.manifest.write_bytes(original + b' ')
        with self.assertRaises(code.Refused): self.prepare()
        self.manifest.write_bytes(original)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, self.digest, 'f' * 40, self.output)
        noncanonical = json.dumps(self.value, indent=2).encode()
        self.manifest.write_bytes(noncanonical)
        digest = code.sha(noncanonical)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, digest, digest[:40], self.output)
        duplicate = original.replace(b'"kind":"tree"', b'"kind":"tree","kind":"tree"')
        self.manifest.write_bytes(duplicate)
        digest = code.sha(duplicate)
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, digest, digest[:40], self.output)

    def test_new_directory_and_protected_source_boundary(self):
        self.output.mkdir()
        with self.assertRaises(code.Refused): self.prepare()
        self.output.rmdir()
        self.output.symlink_to(self.source)
        with self.assertRaises(code.Refused): self.prepare()
        self.output.unlink()
        with self.assertRaises(code.Refused):
            code.prepare(self.source, self.manifest, self.digest, self.build, self.source / 'stage')
        with self.assertRaises(code.Refused):
            code.prepare(str(self.source) + '/../app', self.manifest, self.digest, self.build, self.output)

    def test_verify_refuses_altered_metadata_include_sums_extra_dirs_bytes_and_mode(self):
        for case in ('metadata', 'include', 'sums', 'extra-file', 'extra-dir', 'bytes', 'mode', 'hardlink'):
            with self.subTest(case=case):
                fixture = PrivateCodeTests()
                fixture.setUp()
                try:
                    value = fixture.prepare()
                    file = fixture.output / ('localcode/cluster-' + fixture.build) / value['files'][0]['path']
                    if case == 'metadata': (fixture.output / 'release-manifest.json').write_bytes(b'forged metadata')
                    if case == 'include': (fixture.output / value['nginx'][0]['path']).write_bytes(b'auth_request off;')
                    if case == 'sums': (fixture.output / 'SHA256SUMS').write_bytes(b'forged sums')
                    if case == 'extra-file': (fixture.output / 'unknown').write_bytes(b'unknown')
                    if case == 'extra-dir': (fixture.output / 'unknown').mkdir()
                    if case == 'bytes': file.write_bytes(b'forged source')
                    if case == 'mode': file.chmod(0o666)
                    if case == 'hardlink': os.link(file, fixture.root / 'extra-link')
                    with self.assertRaises((code.Refused, OSError)): fixture.verify()
                finally:
                    fixture.doCleanups()


if __name__ == '__main__':
    unittest.main()
