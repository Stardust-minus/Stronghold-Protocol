import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('generated_assets', Path(__file__).with_name('cluster-generated-assets.py'))
assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assets)


class GeneratedAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.value = {'version': 1, 'count': 2, 'source': 'fixture', 'groups': {
            'map/autochess': {'TX_autochessi_D': {'path': '/assets/local/map/autochess/TX_autochessi_D.png', 'kind': 'Texture2D'}},
            'mesh/map_autochess_bkg': {'floor': {'path': '/assets/local/mesh/map_autochess_bkg/floor.obj', 'kind': 'Mesh'}}}}
        for path in ['public/assets/local/map/autochess/TX_autochessi_D.png', 'public/assets/local/mesh/map_autochess_bkg/floor.obj']:
            destination = self.root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b'fixture-resource')
        (self.root / 'data').mkdir()
        self.save()

    def save(self):
        (self.root / assets.INDEX).write_text(json.dumps(self.value))

    def test_generated_index_is_part_of_release_resources_not_git_source(self):
        result = assets.generated_renderer_data(self.root)
        self.assertEqual(result['path'], assets.INDEX)
        self.assertEqual(result['kind'], 'generated-renderer-data')
        self.assertEqual(result['resourceReferences'], 2)
        self.assertEqual(result['bytes'], (self.root / assets.INDEX).read_bytes())
        self.assertEqual(len(result['sha256']), 64)

    def test_missing_ignored_index_refuses_export_even_when_art_exists(self):
        (self.root / assets.INDEX).unlink()
        with self.assertRaises(assets.Refused):
            assets.generated_renderer_data(self.root)

    def test_empty_fallback_manifest_is_not_a_release(self):
        self.value = {'version': 1, 'source': 'none', 'count': 0, 'groups': {}}
        self.save()
        with self.assertRaises(assets.Refused):
            assets.generated_renderer_data(self.root)

    def test_missing_atlas_or_mesh_refuses_export(self):
        for group in ['map/autochess', 'mesh/map_autochess_bkg']:
            records = self.value['groups'].pop(group)
            self.save()
            with self.assertRaises(assets.Refused):
                assets.generated_renderer_data(self.root)
            self.value['groups'][group] = records

    def test_missing_or_empty_referenced_art_refuses_export(self):
        path = self.root / 'public/assets/local/mesh/map_autochess_bkg/floor.obj'
        path.write_bytes(b'')
        with self.assertRaises(assets.Refused):
            assets.generated_renderer_data(self.root)
        path.unlink()
        with self.assertRaises(assets.Refused):
            assets.generated_renderer_data(self.root)

    def test_unexpected_reference_paths_are_refused(self):
        record = self.value['groups']['mesh/map_autochess_bkg']['floor']
        for path in ['/assets/local/../gate.json', '/js/main.js', 'https://example.com/map.obj', '/assets/local/a//b.obj']:
            record['path'] = path
            self.save()
            with self.assertRaises(assets.Refused):
                assets.generated_renderer_data(self.root)

    def test_index_and_resource_symlinks_are_refused(self):
        for relative in [assets.INDEX, 'public/assets/local/mesh/map_autochess_bkg/floor.obj']:
            path = self.root / relative
            raw = path.read_bytes()
            path.unlink()
            external = self.root / 'external'
            external.write_bytes(raw)
            path.symlink_to(external)
            with self.assertRaises(assets.Refused):
                assets.generated_renderer_data(self.root)
            path.unlink()
            path.write_bytes(raw)

    def test_declared_count_and_integer_schema_are_strict(self):
        for key, value in [('count', 3), ('count', True), ('version', True)]:
            before = self.value[key]
            self.value[key] = value
            self.save()
            with self.assertRaises(assets.Refused):
                assets.generated_renderer_data(self.root)
            self.value[key] = before


if __name__ == '__main__':
    unittest.main()
