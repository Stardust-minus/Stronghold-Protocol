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
            'public/sw.js': '// fixture worker\n', 'tools/assets/skel.mjs': '// fixture parser\n', 'tools/other.mjs': '// not runtime\n',
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
        self.put('public/build/index.html', 'fixture bundle page')
        self.put('public/build/assets/index-AbCdEfGh.js', 'fixture bundle')
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

    def test_ignored_effects_list_is_exported_as_resource_only_when_present(self):
        plain = exporter.export(self.root, self.output, self.revision)
        self.assertNotIn('generatedFxIndex', plain)
        self.assertFalse((self.output / 'app/data/local-fx.json').exists())
        fx = {'version': 1, 'format': 'fx-manifest', 'source': 'local-client', 'count': 2, 'groups': {
            'fx': {'index': {'path': '/assets/local/fx/index.json', 'kind': 'FxIndex'}},
            'fx/prefabs': {'hit': {'path': '/assets/local/fx/prefabs/hit.json', 'kind': 'FxPrefab'}}}}
        self.put('data/local-fx.json', json.dumps(fx))  # its effect files are material-source art, not in the checkout
        identity = exporter.export(self.root, Path(self.temp.name) / 'export-fx', self.revision)
        self.assertEqual(identity['generatedFxIndex']['entries'], 2)
        self.assertEqual(identity['publicResourceFiles'], plain['publicResourceFiles'])
        self.assertEqual(identity['resourceFiles'], plain['resourceFiles'] + 1)
        out = Path(self.temp.name) / 'export-fx'
        self.assertEqual((out / 'app/data/local-fx.json').read_text(), json.dumps(fx))
        rows = {row['path']: row for row in json.loads((out / 'resource-manifest.json').read_text())['files']}
        self.assertEqual(rows['data/local-fx.json']['kind'], 'generated-fx-data')
        source = json.loads((out / 'source-manifest.json').read_text())
        self.assertNotIn('data/local-fx.json', [row['path'] for row in source['files']])
        for bad in ({**fx, 'count': 3}, {**fx, 'format': 'other'}, {**fx, 'groups': {'fx': fx['groups']['fx']}, 'count': 1},
                    {**fx, 'groups': {**fx['groups'], 'fx/prefabs': {'x': {'path': '/assets/local/char/x.png'}}}},
                    {**fx, 'groups': {**fx['groups'], 'fx/prefabs': {'x': {'path': '/assets/local/fx/../x.json'}}}}):
            with self.subTest(bad=bad):
                self.put('data/local-fx.json', json.dumps(bad))
                target = Path(tempfile.mkdtemp(dir=self.temp.name)) / 'export'
                with self.assertRaises(exporter.assets.Refused):
                    exporter.export(self.root, target, self.revision)
                self.assertFalse(target.exists())

    def test_service_worker_and_server_imported_tools_are_code(self):
        exporter.export(self.root, self.output, self.revision)
        paths = [row['path'] for row in json.loads((self.output / 'source-manifest.json').read_text())['files']]
        self.assertIn('public/sw.js', paths)
        self.assertIn('tools/assets/skel.mjs', paths)
        self.assertNotIn('tools/other.mjs', paths)
        self.assertTrue((self.output / 'app/tools/assets/skel.mjs').is_file())

    def test_committed_language_packs_are_code_not_public_art(self):
        self.put('public/i18n/en.json', '{"_meta":{"lang":"en"},"开始":"Start"}\n')
        self.put('public/i18n/zh-TW.json', '{"_meta":{"lang":"zh-TW"},"开始":"開始"}\n')
        self.put('data/i18n/en.json', '{"files":{}}\n')
        self.git('add', 'public/i18n/en.json', 'public/i18n/zh-TW.json', 'data/i18n/en.json')
        self.git('commit', '-qm', 'fixture language packs')
        self.revision = self.git('rev-parse', 'HEAD').decode().strip()
        exporter.export(self.root, self.output, self.revision)
        source = json.loads((self.output / 'source-manifest.json').read_text())
        resources = json.loads((self.output / 'resource-manifest.json').read_text())
        for relative in ['public/i18n/en.json', 'public/i18n/zh-TW.json', 'data/i18n/en.json']:
            self.assertIn(relative, [row['path'] for row in source['files']])
            self.assertNotIn(relative, [row['path'] for row in resources['files']])
            self.assertEqual((self.output / 'app' / relative).read_bytes(), (self.root / relative).read_bytes())

    def test_language_pack_export_rejects_uncommitted_change(self):
        self.put('public/i18n/en.json', '{}\n')
        self.git('add', 'public/i18n/en.json')
        self.git('commit', '-qm', 'fixture language pack')
        self.revision = self.git('rev-parse', 'HEAD').decode().strip()
        self.put('public/i18n/en.json', '{"changed":true}\n')
        with self.assertRaises(exporter.Refused):
            exporter.export(self.root, self.output, self.revision)
        self.assertFalse(self.output.exists())

    def test_language_pack_selection_does_not_broaden_to_other_public_data(self):
        self.assertTrue(exporter.code_path('public/i18n/en.json'))
        self.assertTrue(exporter.code_path('public/i18n/zh-TW.json'))
        for path in ['public/i18n/.secret.json', 'public/i18n/../secret.json',
                     'public/i18n/en.js', 'public/i18n/en.json/private.json',
                     'public/packs/random.json', 'public/assets/data.json']:
            self.assertFalse(exporter.code_path(path), path)

    def test_server_runtime_imports_outside_server_are_exported(self):
        # 0.3.1: the game role fails to start without these (ERR_MODULE_NOT_FOUND at boot)
        for path in ['public/studio/js/gameplayModel.js', 'public/studio/js/presentation.js',
                     'tools/assets/official-tables.mjs', 'tools/assets/cache.mjs', 'tools/assets/sources.mjs',
                     'tools/assets/network.mjs', 'tools/assets/env-proxy.mjs']:
            self.assertTrue(exporter.code_path(path), path)
        for path in ['public/studio/index.html', 'public/studio/js/app.js', 'tools/assets/extract.mjs']:
            self.assertFalse(exporter.code_path(path), path)

    def test_verified_webp_renderer_atlas_is_bound_as_generated_resource(self):
        index = json.loads((self.root / 'data/local-assets.json').read_text())
        record = index['groups']['map/autochess']['TX_autochessi_D']
        record['path'] = '/assets/local/map/autochess/TX_autochessi_D.webp'
        self.put('data/local-assets.json', json.dumps(index))
        self.put('public/assets/local/map/autochess/TX_autochessi_D.webp', 'fixture WebP atlas')
        identity = exporter.export(self.root, self.output, self.revision)
        self.assertEqual(identity['generatedRendererIndex']['resourceReferences'], 2)
        self.assertEqual((self.output / 'app/public/assets/local/map/autochess/TX_autochessi_D.webp').read_text(), 'fixture WebP atlas')

    def test_unknown_or_relocated_renderer_atlas_is_rejected_before_export(self):
        index = json.loads((self.root / 'data/local-assets.json').read_text())
        for target in ['/assets/local/map/autochess/TX_autochessi_D.jpg',
                       '/assets/local/map/autochess/other.webp',
                       '/assets/local/map/other/TX_autochessi_D.webp']:
            index['groups']['map/autochess']['TX_autochessi_D']['path'] = target
            self.put('data/local-assets.json', json.dumps(index))
            with self.assertRaises(exporter.assets.Refused):
                exporter.export(self.root, self.output, self.revision)
            self.assertFalse(self.output.exists())

    def test_empty_locked_dependency_files_are_preserved(self):
        for relative in ['node_modules/dependency/types.d.ts', 'node_modules/dependency/legacy.js']:
            self.put(relative, '')
        identity = exporter.export(self.root, self.output, self.revision)
        self.assertEqual(identity['resourceFiles'], 7)  # + the two bundle files (public/build)
        for relative in ['node_modules/dependency/types.d.ts', 'node_modules/dependency/legacy.js']:
            self.assertTrue((self.output / 'app' / relative).is_file())
            self.assertEqual((self.output / 'app' / relative).read_bytes(), b'')

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
