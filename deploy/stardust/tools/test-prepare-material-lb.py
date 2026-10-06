#!/usr/bin/env python3
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('prepare_material_lb', Path(__file__).with_name('prepare-material-lb.py'))
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
CONTAINER = TOOL.CONTAINER_PREFIX + 'fixture-20261006'


def fixture():
    image = {'requestPath': '/assets/test/pixel.png', 'fileName': 'releases/' + TOOL.RELEASE + '/assets/test/pixel.png',
             'bytes': 70, 'sha256': 'a' * 64, 'mime': 'image/png'}
    voice = {'requestPath': '/media/voice/test', 'fileName': 'releases/' + TOOL.RELEASE + '/media/voice/test',
             'bytes': 100, 'sha256': 'b' * 64, 'mime': 'audio/mpeg'}
    alias = {**voice, 'requestPath': '/assets/audio/voice/test.mp3'}
    rows = [image, voice, alias]
    openi = {'schemaVersion': 1, 'release': TOOL.RELEASE, 'fallbackBase': TOOL.FALLBACK,
             'dataset': 'Stardust_minus/arknight_assets', 'apiOrigin': 'https://openi.pcl.ac.cn',
             'ossOrigin': TOOL.OSS_ORIGIN, 'ossPathPrefix': '/bucket-prefix/object-prefix/', 'entries': rows}
    models = {'schemaVersion': 1, 'release': TOOL.RELEASE, 'fallbackBase': TOOL.FALLBACK,
              'repo': TOOL.MODEL_REPO, 'revision': TOOL.MODEL_REVISION, 'prefix': TOOL.MODEL_PREFIX,
              'apiOrigin': 'https://modelscope.cn', 'deliveryStrategy': '302-to-stable-public-api', 'uploadVerified': True,
              'entries': [{**row, 'fileName': TOOL.MODEL_PREFIX + '/' + row['fileName'].split('/', 2)[2]} for row in rows]}
    return openi, models


class PrepareTests(unittest.TestCase):
    def test_valid_profile(self):
        openi, models = fixture()
        files = TOOL.render(openi, models, CONTAINER)
        data = json.loads(files['routes.json'])
        self.assertEqual((data['modelscopeWeight'], data['openiWeight'], data['ningxiaWeight']), (60, 40, 0))
        self.assertEqual(data['paths']['/media/voice/test'], data['paths']['/assets/audio/voice/test.mp3'])
        self.assertIn(TOOL.MODEL_REVISION, data['paths']['/assets/test/pixel.png'])
        self.assertNotIn(b'__MATERIAL_LB_', files['access.lua'] + files['header.lua'])
        self.assertIn((CONTAINER + '/routes.json').encode(), files['access.lua'])
        self.assertIn(b'sp_request = true', files['header.lua'])
        self.assertIn(b'2576980378', files['access.lua'])
        self.assertIn(b'if method == "OPTIONS" then return end', files['access.lua'])

    def test_explicit_new_profile_preserves_default_profile(self):
        openi, models = fixture()
        release, revision, prefix = 'v014-fixture-20261006', 'c' * 40, 'releases/v014-fixture-20261006'
        for manifest in (openi, models):
            manifest['release'] = release
            manifest['fallbackBase'] = TOOL.FALLBACK_ORIGIN + '/releases/' + release
        for row in openi['entries']:
            row['fileName'] = row['fileName'].replace(TOOL.RELEASE, release)
        models.update(revision=revision, prefix=prefix)
        for row in models['entries']:
            row['fileName'] = row['fileName'].replace(TOOL.MODEL_PREFIX, prefix)
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)
        files = TOOL.render(openi, models, CONTAINER, release=release, model_revision=revision, model_prefix=prefix)
        data = json.loads(files['routes.json'])
        self.assertEqual(data['release'], release)
        self.assertIn(release.encode(), files['access.lua'])
        self.assertIn(revision.encode(), files['access.lua'])
        self.assertNotIn(TOOL.MODEL_REVISION.encode(), files['access.lua'])
        self.assertIn(revision, data['paths']['/media/voice/test'])
        self.assertEqual((data['modelscopeWeight'], data['openiWeight']), (60, 40))
        baseline = fixture()
        self.assertIn(TOOL.MODEL_REVISION, json.loads(TOOL.render(*baseline, CONTAINER)['routes.json'])['paths']['/media/voice/test'])
        for key, value in [('release', '../escape'), ('model_revision', 'master'), ('model_prefix', 'releases/a/../b')]:
            pins = dict(release=release, model_revision=revision, model_prefix=prefix)
            pins[key] = value
            with self.subTest(key=key):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **pins)

    def test_mirror_quantity_limit_is_not_relaxed(self):
        openi, models = fixture()
        openi['mirrorReleases'] = [TOOL.RELEASE, 'old-mirror', 'third-mirror']
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_manifest_root_and_schema_types(self):
        openi, models = fixture()
        for value in ([], None, 'invalid'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError): TOOL.render(value, models, CONTAINER)
                with self.assertRaises(ValueError): TOOL.render(openi, value, CONTAINER)
        openi['schemaVersion'] = True
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_revision_and_origin_pins(self):
        for key, value in [('revision', 'master'), ('repo', 'someone/else'), ('apiOrigin', 'http://modelscope.cn'),
                           ('prefix', 'releases/unapproved'), ('uploadVerified', False)]:
            with self.subTest(key=key):
                openi, models = fixture()
                models[key] = value
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_openi_pins_and_prefix(self):
        for key, value in [('ossOrigin', 'https://other.invalid'), ('dataset', 'other/repo'),
                           ('fallbackBase', 'https://other.invalid'), ('release', 'old-release'),
                           ('ossPathPrefix', '/bucket/../')]:
            with self.subTest(key=key):
                openi, models = fixture()
                openi[key] = value
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_alias_content_mismatch(self):
        for key, value in [('bytes', 71), ('sha256', 'c' * 64), ('mime', 'text/plain')]:
            with self.subTest(key=key):
                openi, models = fixture()
                models['entries'][0][key] = value
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_inventory_mismatch_and_duplicates(self):
        openi, models = fixture()
        models['entries'].pop()
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)
        openi, models = fixture()
        models['entries'].append(copy.deepcopy(models['entries'][0]))
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_no_private_paths_or_traversal(self):
        for value in ('/js/main.js', '/assets/../data.json', '/assets/a%2fb.png', '/media/.secret', '/assets/pixel.js'):
            with self.subTest(value=value):
                openi, models = fixture()
                openi['entries'][0]['requestPath'] = models['entries'][0]['requestPath'] = value
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_no_secret_or_unknown_entry_fields(self):
        openi, models = fixture()
        models['entries'][0]['accountToken'] = 'synthetic-not-a-credential'
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_metadata_types(self):
        for key, value in [('bytes', True), ('bytes', -1), ('sha256', 'invalid'), ('mime', 'audio/mpeg\r\nX-Test: bad')]:
            with self.subTest(key=key):
                openi, models = fixture()
                openi['entries'][0][key] = models['entries'][0][key] = value
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_container_directory(self):
        for value in ('/tmp/anything', TOOL.CONTAINER_PREFIX + '../other', TOOL.CONTAINER_PREFIX + 'bad;path', TOOL.CONTAINER_PREFIX):
            with self.subTest(value=value):
                openi, models = fixture()
                with self.assertRaises(ValueError): TOOL.render(openi, models, value)

    def test_output_exclusive_and_not_tracked(self):
        openi, models = fixture()
        files = TOOL.render(openi, models, CONTAINER)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'fresh'
            hashes = TOOL.write_output(files, out)
            self.assertEqual(set(hashes), set(files))
            self.assertEqual((out / 'routes.json').read_bytes(), files['routes.json'])
            with self.assertRaises(ValueError): TOOL.write_output(files, out)
            link = Path(directory) / 'symlink'
            link.symlink_to(out, target_is_directory=True)
            with self.assertRaises(ValueError): TOOL.write_output(files, link)
        repo = Path(__file__).resolve().parents[3]
        with self.assertRaises(ValueError): TOOL.write_output(files, repo / 'public' / 'never-create-material-lb-output')


if __name__ == '__main__':
    unittest.main()
