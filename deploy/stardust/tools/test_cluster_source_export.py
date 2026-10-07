import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('cluster_export', Path(__file__).with_name('cluster-source-export.py'))
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class ClusterSourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'export'
        files = {'package.json': '{"version":"0.1.4"}', 'package-lock.json': '{}',
            'server/cluster/start.mjs': '// fixture\n', 'shared/experimental.js': '// fixture\n',
            'shared/cluster-load.js': '// fixture\n', 'data/assets.json': '{}',
            'public/js/main.js': '// fixture\n', 'public/css/main.css': 'body{}',
            'deploy/stardust/cluster/Dockerfile.cluster': '# fixture Dockerfile\n',
            '.gitignore': 'data/local-assets.json\npublic/assets/\nnode_modules/\n'}
        files.update({'deploy/stardust/auth/' + name: 'fixture\n' for name in exporter.AUTH_FILES})
        for relative, content in files.items():
            self.put(relative, content)
        subprocess.run(['git', 'init', '-q', '--initial-branch=fixture', str(self.root)], check=True)
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture source')
        self.revision = self.git('rev-parse', 'HEAD').decode().strip()
        index = {'version': 1, 'count': 2, 'groups': {
            'map/autochess': {'TX_autochessi_D': {'path': '/assets/local/map/autochess/TX_autochessi_D.png', 'kind': 'Texture2D'}},
            'mesh/map_autochess_bkg': {'floor': {'path': '/assets/local/mesh/map_autochess_bkg/floor.obj', 'kind': 'Mesh'}}}}
        self.put('data/local-assets.json', json.dumps(index))
        self.put('public/assets/local/map/autochess/TX_autochessi_D.png', 'fixture atlas')
        self.put('public/assets/local/mesh/map_autochess_bkg/floor.obj', 'fixture mesh')
        self.put('public/fonts/font.woff2', 'fixture font')
        self.put('public/vendor/preact.js', 'fixture vendor')
        self.put('node_modules/dependency/package.json', '{}')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL)

    def put(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def test_ignored_renderer_index_is_exported_and_bound_as_resource(self):
        self.assertEqual(self.git('ls-files', 'data/local-assets.json'), b'')
        identity = exporter.export(self.root, self.output, self.revision)
        self.assertEqual(identity['sourceKind'], 'commit')
        self.assertEqual(identity['build'], self.revision)
        self.assertEqual(identity['generatedRendererIndex']['resourceReferences'], 2)
        source = json.loads((self.output / 'source-manifest.json').read_text())
        self.assertNotIn('data/local-assets.json', [row['path'] for row in source['files']])
        resource = json.loads((self.output / 'resource-manifest.json').read_text())
        row = next(row for row in resource['files'] if row['path'] == 'data/local-assets.json')
        self.assertEqual(row['kind'], 'generated-renderer-data')
        self.assertEqual(row['sha256'], identity['generatedRendererIndex']['sha256'])
        self.assertEqual((self.output / 'app/data/local-assets.json').read_bytes(), (self.root / 'data/local-assets.json').read_bytes())

    def test_missing_generated_index_fails_before_creating_export(self):
        (self.root / 'data/local-assets.json').unlink()
        with self.assertRaises(exporter.assets.Refused):
            exporter.export(self.root, self.output, self.revision)
        self.assertFalse(self.output.exists())

    def test_uncommitted_runtime_or_dockerfile_is_refused(self):
        for relative in ['public/js/main.js', 'deploy/stardust/cluster/Dockerfile.cluster']:
            path = self.root / relative
            before = path.read_bytes()
            path.write_bytes(before + b'changed')
            with self.assertRaises(exporter.Refused):
                exporter.export(self.root, self.output, self.revision)
            self.assertFalse(self.output.exists())
            path.write_bytes(before)

    def test_noncommit_revision_and_existing_output_are_refused(self):
        for revision in ['master', 'HEAD', '0' * 40]:
            with self.assertRaises((exporter.Refused, subprocess.CalledProcessError)):
                exporter.export(self.root, self.output, revision)
        self.output.mkdir()
        with self.assertRaises(exporter.Refused):
            exporter.export(self.root, self.output, self.revision)

    def test_resource_symlink_is_refused(self):
        target = self.root / 'public/assets/local/mesh/map_autochess_bkg/floor.obj'
        target.unlink()
        target.symlink_to(self.root / 'package.json')
        with self.assertRaises(exporter.assets.Refused):
            exporter.export(self.root, self.output, self.revision)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
