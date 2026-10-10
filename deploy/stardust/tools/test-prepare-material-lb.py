#!/usr/bin/env python3
import copy
import importlib.util
import json
import http.client
import os
import shutil
import socket
import time
import subprocess
import sys
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


def full_fixture(count=40000):
    openi, models = fixture()
    rows = []
    for index in range(count):
        group, kind = divmod(index, 3)
        suffix = 'lb-fixture/item[' + str(group) + ']'
        object_path = ('assets/' + suffix + '.png') if kind == 0 else ('media/' + suffix)
        alias = '/' + object_path if kind != 2 else '/assets/audio/' + suffix + '.mp3'
        rows.append({'requestPath': alias, 'fileName': 'releases/' + TOOL.RELEASE + '/' + object_path,
                     'bytes': group + 1, 'sha256': format(group + 1, '064x'),
                     'mime': 'image/png' if kind == 0 else 'audio/mpeg'})
    openi['entries'] = rows
    models['entries'] = [{**row, 'fileName': TOOL.MODEL_PREFIX + '/' + row['fileName'].split('/', 2)[2]} for row in rows]
    return openi, models


def exception_fixture(full=False, multiple_prefixes=False, count=40000):
    openi, models = full_fixture(count) if full else fixture()
    alias = next(iter(TOOL.OPENI_ONLY_ALLOWLIST))
    openi['entries'].append({'requestPath': alias, 'fileName': 'releases/' + TOOL.RELEASE + alias,
                             'bytes': 123, 'sha256': 'd' * 64, 'mime': 'image/png'})
    models['openiOnlyPaths'] = [alias]
    options = {'openi_only_paths': [alias]}
    if multiple_prefixes:
        primary = 'releases/v014-skin-fixture-20261008'
        prefixes = [primary, TOOL.MODEL_PREFIX]
        models.update(prefix=primary, prefixes=prefixes, revision='c' * 40)
        for index, row in enumerate(models['entries']):
            if index % 2 == 0:
                row['fileName'] = row['fileName'].replace(TOOL.MODEL_PREFIX, primary)
        options.update(model_revision='c' * 40, model_prefix=primary, model_prefixes=prefixes)
    return openi, models, options


class PrepareTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('MATERIAL_OPENRESTY_RUNTIME'), 'opt-in local OpenResty runtime not supplied')
    def test_force_openi_actual_http(self):
        runtime = Path(os.environ['MATERIAL_OPENRESTY_RUNTIME'])
        binary = runtime / 'openresty/nginx/sbin/nginx'
        loader = runtime / 'ld-linux-x86-64.so.2'
        libraries = ':'.join(str(runtime / p) for p in ('openresty/openssl3/lib', 'openresty/pcre2/lib', 'openresty/luajit/lib')) + ':' + str(runtime)
        with tempfile.TemporaryDirectory(prefix='material-force-openi-') as directory:
            work = Path(directory)
            (work / 'logs').mkdir()
            (work / 'lualib').mkdir()
            shutil.copyfile(runtime / 'openresty/lualib/cjson.so', work / 'lualib/cjson.so')
            files = TOOL.render(*fixture(), CONTAINER)
            for name, body in files.items():
                text = body.decode()
                if name.endswith('.lua'):
                    text = text.replace(CONTAINER + '/', str(work) + '/')
                    if name == 'access.lua':
                        text = text.replace('ngx.var.request_id', 'ngx.var.fixture_request_id')
                (work / name).write_text(text)
            # Synthetic signatures only; the test never follows Location or contacts either provider.
            (work / 'content.lua').write_text('''local cjson = require 'cjson.safe'
local f = assert(io.open('__DATA__', 'rb'))
local db = assert(cjson.decode(f:read('*a'))); f:close()
if ngx.req.get_method() == 'OPTIONS' then return ngx.exit(204) end
local row = db.entries[ngx.ctx.material_lb_path or ngx.var.uri]
if not row then return ngx.exit(404) end
if ngx.req.get_headers()['X-Fixture-Model'] == '1' then ngx.header['Location'] = row.modelscope
else ngx.header['Location'] = 'https://' .. db.oss_authority .. db.oss_path_prefix .. row.fileName
    .. '?AWSAccessKeyId=synthetic-fixture&Expires=' .. math.floor(ngx.now()+90) .. '&Signature=synthetic-fixture'
end
return ngx.exit(302)
'''.replace('__DATA__', str(work / 'header-data.json')))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            public = f'''set $fixture_request_id $http_x_fixture_request_id;
access_by_lua_file {work}/access.lua;
content_by_lua_file {work}/content.lua;
header_filter_by_lua_file {work}/header.lua;'''
            (work / 'nginx.conf').write_text(f'''daemon off;
master_process off;
worker_processes 1;
error_log {work}/error.log notice;
pid {work}/nginx.pid;
events {{ worker_connections 64; }}
http {{
access_log off;
client_body_temp_path {work}/client_temp;
lua_package_path '{runtime}/openresty/lualib/?.lua;{runtime}/openresty/lualib/?/init.lua;;';
lua_package_cpath '{work}/lualib/?.so;;';
server {{
listen 127.0.0.1:{port};
location /assets/ {{ {public} }}
location /media/ {{ {public} }}
location /js/ {{ add_header Cache-Control 'private, no-store' always; return 401; }}
location / {{ return 404; }}
}}
}}
''')
            command = [str(loader), '--library-path', libraries, str(binary), '-p', str(work) + '/', '-c', str(work / 'nginx.conf')]
            checked = subprocess.run(command + ['-t'], capture_output=True, timeout=10)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode())
            with (work / 'stdout').open('wb') as log:
                process = subprocess.Popen(command, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        try:
                            with socket.create_connection(('127.0.0.1', port), timeout=0.1): break
                        except OSError:
                            if process.poll() is not None: self.fail('local OpenResty exited before listen')
                            time.sleep(0.05)
                    def request(path, method='GET', request_id='0' * 32, extra=None):
                        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                        try:
                            connection.request(method, path, headers={'X-Fixture-Request-Id': request_id, **(extra or {})})
                            response = connection.getresponse(); response.read()
                            return response.status, {k.lower(): v for k, v in response.getheaders()}
                        finally: connection.close()
                    for path in ('/assets/test/pixel.png', '/media/voice/test', '/assets/audio/voice/test.mp3'):
                        status, headers = request(path)
                        self.assertEqual(status, 302)
                        self.assertTrue(headers['location'].startswith(TOOL.MODEL_BASE))
                        status, headers = request(path, request_id='f' * 32)
                        self.assertEqual(status, 302)
                        self.assertTrue(headers['location'].startswith(TOOL.OSS_ORIGIN))
                        status, headers = request(path + '?sp_source=openi')
                        self.assertEqual(status, 302)
                        self.assertTrue(headers['location'].startswith(TOOL.OSS_ORIGIN))
                        self.assertEqual(headers['access-control-allow-origin'], '*')
                        self.assertNotIn('access-control-allow-credentials', headers)
                        self.assertTrue(headers['cache-control'].startswith('public, max-age='))
                        self.assertEqual(request(path + '?sp_source=openi', 'OPTIONS')[0], 204)
                        status, headers = request(path + '?sp_source=openi', 'HEAD')
                        self.assertEqual(status, 302)
                        self.assertEqual(headers['location'], TOOL.FALLBACK + path)
                    for query in ('?', '?sp_source=modelscope', '?sp_source=openi&sp_source=openi', '?sp_source=openi&next=x', '?sp_source=OPENI', '?%73p_source=openi'):
                        status, headers = request('/assets/test/pixel.png' + query)
                        self.assertEqual(status, 404, query)
                        self.assertEqual(headers['cache-control'], 'no-store')
                    self.assertEqual(request('/assets/unknown.png?sp_source=openi')[0], 404)
                    self.assertEqual(request('/assets/test/pixel.png?sp_source=openi', 'POST')[0], 405)
                    status, headers = request('/assets/test/pixel.png?sp_source=openi', extra={'X-Fixture-Model': '1'})
                    self.assertEqual(status, 302)
                    self.assertEqual(headers['cache-control'], 'no-store', 'forced requests cannot cache a ModelScope response')
                    status, headers = request('/js/main.js?sp_source=openi')
                    self.assertEqual(status, 401)
                    self.assertEqual(headers['cache-control'], 'private, no-store')
                    self.assertNotIn('access-control-allow-origin', headers)
                finally:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)

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
        header_data = json.loads(files['header-data.json'])
        self.assertEqual(set(files), {'routes.json', 'header-data.json', 'access.lua', 'header.lua'})
        self.assertEqual(set(header_data), {'fallback_base', 'oss_authority', 'oss_path_prefix', 'entries'})
        self.assertEqual(header_data['fallback_base'], TOOL.FALLBACK)
        self.assertEqual(header_data['oss_authority'], TOOL.OSS_ORIGIN.removeprefix('https://'))
        self.assertEqual(header_data['oss_path_prefix'], openi['ossPathPrefix'])
        self.assertEqual(header_data['entries'], {row['requestPath']: {
            'fileName': row['fileName'], 'modelscope': data['paths'][row['requestPath']]} for row in openi['entries']})

    def test_header_is_fixed_json_reader_not_an_executable_inventory(self):
        files = TOOL.render(*fixture(), CONTAINER)
        header = files['header.lua'].decode()
        template = (TOOL.TEMPLATES / 'header.lua').read_text()
        for source in (header, template):
            self.assertNotIn('loadfile', source)
            self.assertNotIn('loadstring', source)
            self.assertNotIn('dofile', source)
            self.assertIn('require "cjson.safe"', source)
            self.assertIn('cjson.decode(raw)', source)
            self.assertIn('package.loaded[key] = data', source)
            self.assertIn('if data == nil then', source)
            self.assertEqual(source.count('io.open('), 1)
            self.assertLess(len(source.encode()), 16384)
        self.assertIn('io.open("' + CONTAINER + '/header-data.json", "rb")', header)
        self.assertNotIn('header-data.lua', header)
        self.assertNotIn('/assets/test/pixel.png', header)
        self.assertNotIn('/media/voice/test', header)
        self.assertNotIn('ngx.var', header[:header.index('local method = ngx.req.get_method()')])

    def test_full_inventory_above_incident_size_has_no_lua_growth(self):
        openi, models = full_fixture()
        self.assertGreater(len(openi['entries']), 36612)
        files = TOOL.render(openi, models, CONTAINER)
        routes = json.loads(files['routes.json'])
        header_data = json.loads(files['header-data.json'])
        self.assertEqual(len(routes['paths']), 40000)
        self.assertEqual(len(header_data['entries']), 40000)
        self.assertEqual(set(header_data['entries']), {row['requestPath'] for row in openi['entries']})
        for row in openi['entries']:
            with self.subTest(alias=row['requestPath']):
                self.assertEqual(header_data['entries'][row['requestPath']], {
                    'fileName': row['fileName'], 'modelscope': routes['paths'][row['requestPath']]})
                expected = TOOL.MODEL_BASE + '/'.join(TOOL.quote(segment, safe='')
                    for segment in row['fileName'].split('/', 2)[2].split('/'))
                self.assertEqual(routes['paths'][row['requestPath']], expected)
        baseline = TOOL.render(*fixture(), CONTAINER)
        self.assertEqual(files['header.lua'], baseline['header.lua'])
        self.assertEqual(files['access.lua'], baseline['access.lua'])
        self.assertNotIn('header-data.lua', files)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'full-inventory'
            TOOL.write_output(files, out)
            self.assertEqual(set(path.name for path in out.iterdir()), set(files))
            self.assertEqual(json.loads((out / 'header-data.json').read_bytes()), header_data)

    def test_explicit_openi_only_alias_is_retained_not_sent_to_modelscope(self):
        openi, models, options = exception_fixture()
        files = TOOL.render(openi, models, CONTAINER, **options)
        routes = json.loads(files['routes.json'])
        header_data = json.loads(files['header-data.json'])
        alias = options['openi_only_paths'][0]
        self.assertIs(routes['paths'][alias], False)
        self.assertEqual(set(routes['paths']), {row['requestPath'] for row in openi['entries']})
        self.assertEqual(header_data['entries'][alias], {'fileName': 'releases/' + TOOL.RELEASE + alias})
        self.assertEqual((routes['modelscopeWeight'], routes['openiWeight'], routes['ningxiaWeight']), (60, 40, 0))
        self.assertNotIn('modelscopeBases', routes)
        self.assertIn(b'if model_target == nil then return ngx.exit(404) end', files['access.lua'])
        self.assertIn(b'if model_target ~= false then return ngx.exit(500) end', files['access.lua'])
        self.assertIn(b'if model_target ~= false and number < 2576980378 then', files['access.lua'])
        self.assertIn(b'if force_openi then', files['access.lua'])
        self.assertIn(b'if entry.modelscope ~= nil then return false end', files['header.lua'])
        self.assertNotIn(b'__MATERIAL_LB_', files['access.lua'] + files['header.lua'])
        normal = TOOL.render(*fixture(), CONTAINER)
        self.assertEqual(routes['paths']['/assets/test/pixel.png'], json.loads(normal['routes.json'])['paths']['/assets/test/pixel.png'])

    def test_openi_only_requires_explicit_matching_declaration(self):
        openi, models, options = exception_fixture()
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)
        del models['openiOnlyPaths']
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)
        for declaration in (None, True, 'invalid', [], ['/assets/test/pixel.png'],
                            [options['openi_only_paths'][0]] * 2):
            openi, models, options = exception_fixture()
            models['openiOnlyPaths'] = declaration
            with self.subTest(declaration=declaration):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_openi_only_is_exactly_one_authorized_alias(self):
        for aliases in (None, True, 'invalid', {'unknown': True}, ['/assets/test/pixel.png'],
                        ['/assets/skins/char_340_shwaz_snow_1/illustration.png/other.png'],
                        [next(iter(TOOL.OPENI_ONLY_ALLOWLIST))] * 2):
            openi, models, options = exception_fixture()
            options['openi_only_paths'] = aliases
            with self.subTest(aliases=aliases):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_openi_only_missing_alias_other_missing_alias_and_model_row_rejected(self):
        for change in ('missing-openi-exception', 'missing-model-ordinary', 'extra-model-exception'):
            openi, models, options = exception_fixture()
            if change == 'missing-openi-exception':
                openi['entries'].pop()
            elif change == 'missing-model-ordinary':
                models['entries'].pop()
            else:
                row = openi['entries'][-1]
                models['entries'].append({**row, 'fileName': TOOL.MODEL_PREFIX + row['requestPath']})
            with self.subTest(change=change):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_openi_only_does_not_relax_metadata_or_unknown_fields(self):
        for key, value in [('bytes', True), ('bytes', -1), ('sha256', 'invalid'), ('mime', 'image/png\r\nX-Test: bad'),
                           ('accountToken', 'synthetic-not-a-credential')]:
            openi, models, options = exception_fixture()
            openi['entries'][-1][key] = value
            with self.subTest(key=key):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)
        for key, value in [('bytes', 71), ('sha256', 'c' * 64), ('mime', 'text/plain')]:
            openi, models, options = exception_fixture(multiple_prefixes=True)
            models['entries'][0][key] = value
            with self.subTest(normal_key=key):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_unknown_manifest_fields_rejected(self):
        for provider in (0, 1):
            openi, models, options = exception_fixture(multiple_prefixes=True)
            (openi, models)[provider]['unknownOrSecret'] = 'synthetic-not-a-credential'
            with self.subTest(provider=provider):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_multiple_immutable_prefixes_share_one_fixed_revision(self):
        openi, models, options = exception_fixture(multiple_prefixes=True)
        files = TOOL.render(openi, models, CONTAINER, **options)
        routes = json.loads(files['routes.json'])
        bases = ['https://modelscope.cn/datasets/' + TOOL.MODEL_REPO + '/resolve/' + 'c' * 40 + '/' + prefix + '/'
                 for prefix in options['model_prefixes']]
        self.assertEqual(routes['modelscopeBase'], bases[0])
        self.assertEqual(routes['modelscopeBases'], bases)
        for row in models['entries']:
            self.assertTrue(any(routes['paths'][row['requestPath']].startswith(base) for base in bases))
        for base in bases:
            self.assertIn(base.encode(), files['access.lua'])
            self.assertIn(base.encode(), files['header.lua'])
        self.assertNotIn(TOOL.MODEL_REVISION.encode(), files['access.lua'] + files['header.lua'])
        self.assertEqual((routes['modelscopeWeight'], routes['openiWeight']), (60, 40))

    def test_multiple_prefixes_require_explicit_complete_matching_whitelist(self):
        openi, models, options = exception_fixture(multiple_prefixes=True)
        for change in ('no-input', 'no-declaration', 'reversed', 'undeclared-object'):
            oi, ms, pins = copy.deepcopy(openi), copy.deepcopy(models), copy.deepcopy(options)
            if change == 'no-input': pins.pop('model_prefixes')
            elif change == 'no-declaration': ms.pop('prefixes')
            elif change == 'reversed': ms['prefixes'].reverse()
            else: ms['entries'][0]['fileName'] = 'releases/not-authorized/assets/pixel.png'
            with self.subTest(change=change):
                with self.assertRaises(ValueError): TOOL.render(oi, ms, CONTAINER, **pins)

    def test_prefix_whitelist_bounds_and_immutable_namespace(self):
        for prefixes in ([], None, True, 'invalid', ['releases/a/../b'], ['https://other.invalid/a'],
                         ['releases/a/'], ['releases/a'], [TOOL.MODEL_PREFIX] * 2,
                         [TOOL.MODEL_PREFIX] + ['releases/p' + str(i) for i in range(8)]):
            openi, models, options = exception_fixture(multiple_prefixes=True)
            options['model_prefixes'] = prefixes
            with self.subTest(prefixes=prefixes):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)
        openi, models, options = exception_fixture(multiple_prefixes=True)
        options['model_revision'] = models['revision'] = TOOL.MODEL_REVISION
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)
        for revision, verified in [('master', True), ('c' * 40, False), ('c' * 40, 1)]:
            openi, models, options = exception_fixture(multiple_prefixes=True)
            models.update(revision=revision, uploadVerified=verified)
            options['model_revision'] = revision
            with self.subTest(revision=revision, verified=verified):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)

    def test_full_mixed_inventory_retains_every_alias_in_json(self):
        openi, models, options = exception_fixture(full=True, multiple_prefixes=True)
        files = TOOL.render(openi, models, CONTAINER, **options)
        routes = json.loads(files['routes.json'])
        data = json.loads(files['header-data.json'])
        self.assertEqual(len(routes['paths']), 40001)
        self.assertEqual(len(data['entries']), 40001)
        self.assertEqual(set(data['entries']), {row['requestPath'] for row in openi['entries']})
        self.assertEqual(sum(target is False for target in routes['paths'].values()), 1)
        self.assertLess(len(files['header.lua']), 16384)
        self.assertLess(len(files['access.lua']), 16384)
        self.assertNotIn('header-data.lua', files)

    def test_cli_explicit_options_and_missing_or_duplicate_options_rejected(self):
        openi, models, options = exception_fixture(multiple_prefixes=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            oi, ms = root / 'openi.json', root / 'models.json'
            oi.write_text(json.dumps(openi))
            ms.write_text(json.dumps(models))
            common = [sys.executable, '-I', str(Path(TOOL.__file__)), '--openi-manifest', str(oi),
                      '--modelscope-manifest', str(ms), '--container-dir', CONTAINER,
                      '--release', TOOL.RELEASE, '--modelscope-revision', options['model_revision'],
                      '--modelscope-prefix', options['model_prefix']]
            prefixes = [item for prefix in options['model_prefixes'] for item in ('--modelscope-allowed-prefix', prefix)]
            exception = ['--openi-only-path', options['openi_only_paths'][0]]
            accepted = subprocess.run(common + prefixes + exception + ['--out', str(root / 'accepted')], capture_output=True, text=True, check=False)
            self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
            self.assertIs(json.loads(accepted.stdout)['activated'], False)
            self.assertIs(json.loads((root / 'accepted' / 'routes.json').read_text())['paths'][options['openi_only_paths'][0]], False)
            for index, flags in enumerate((prefixes, exception, prefixes + exception * 2, prefixes + prefixes + exception)):
                denied = subprocess.run(common + flags + ['--out', str(root / ('rejected-' + str(index)))], capture_output=True, text=True, check=False)
                with self.subTest(index=index):
                    self.assertEqual(denied.returncode, 1, denied.stdout + denied.stderr)
                    self.assertIs(json.loads(denied.stdout)['prepared'], False)
                    self.assertFalse((root / ('rejected-' + str(index))).exists())

    def test_entry_count_remains_bounded_at_next_release_limit(self):
        self.assertEqual(TOOL.MAX_ENTRIES, 100000)
        for count in (0, TOOL.MAX_ENTRIES + 1):
            with self.subTest(count=count):
                openi, models = fixture()
                for manifest in (openi, models):
                    manifest['entries'] = [manifest['entries'][0]] * count
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_inventory_accepts_old_limit_plus_one_and_exact_new_bound(self):
        for count in (50001, TOOL.MAX_ENTRIES):
            with self.subTest(count=count):
                openi, models = full_fixture(count)
                self.assertEqual(len(TOOL.entries(openi, False)), count)
                self.assertEqual(len(TOOL.entries(models, True)), count)

    def test_next_voice_inventory_keeps_three_prefixes_two_mirrors_and_one_exception(self):
        openi, models, options = exception_fixture(full=True, multiple_prefixes=True, count=85000)
        third = 'releases/next-voice-fixture-20261008'
        options['model_prefixes'].append(third)
        models['prefixes'] = list(options['model_prefixes'])
        openi['mirrorReleases'] = [TOOL.RELEASE, 'old-material-fixture']
        for index, row in enumerate(openi['entries']):
            if index % 2 == 0:
                row['fileName'] = row['fileName'].replace(TOOL.RELEASE, 'old-material-fixture')
        for index, row in enumerate(models['entries']):
            if index % 3 == 0:
                row['fileName'] = third + '/' + row['fileName'].split('/', 2)[2]
        files = TOOL.render(openi, models, CONTAINER, **options)
        routes, headers = json.loads(files['routes.json']), json.loads(files['header-data.json'])
        self.assertEqual(len(routes['paths']), 85001)
        self.assertEqual(len(headers['entries']), 85001)
        self.assertEqual(len(routes['modelscopeBases']), 3)
        self.assertEqual(sum(target is False for target in routes['paths'].values()), 1)
        self.assertNotIn('modelscope', headers['entries'][options['openi_only_paths'][0]])
        for name in ('access.lua', 'header.lua'):
            self.assertIn(('if count > ' + str(TOOL.MAX_ENTRIES) + ' then return false end').encode(), files[name])
            self.assertNotIn(b'__MATERIAL_LB_', files[name])
            self.assertNotIn(b'loadfile', files[name])
            self.assertLess(len(files[name]), 16384)
        base_openi, base_models, base_options = exception_fixture(multiple_prefixes=True)
        baseline = TOOL.render(base_openi, base_models, CONTAINER, **base_options)
        self.assertLess(abs(len(files['access.lua']) - len(baseline['access.lua'])), 1024)
        self.assertLess(abs(len(files['header.lua']) - len(baseline['header.lua'])), 1024)

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
        header_data = json.loads(files['header-data.json'])
        self.assertEqual(header_data['fallback_base'], TOOL.FALLBACK_ORIGIN + '/releases/' + release)
        self.assertIn(header_data['fallback_base'].encode(), files['header.lua'])
        self.assertIn(revision.encode(), files['header.lua'])
        self.assertIn(prefix.encode(), files['header.lua'])
        self.assertNotIn(TOOL.MODEL_REVISION.encode(), files['header.lua'])
        self.assertIn(b'["' + release.encode() + b'"] = true', files['header.lua'])
        baseline = fixture()
        self.assertIn(TOOL.MODEL_REVISION, json.loads(TOOL.render(*baseline, CONTAINER)['routes.json'])['paths']['/media/voice/test'])
        for key, value in [('release', '../escape'), ('model_revision', 'master'), ('model_prefix', 'releases/a/../b')]:
            pins = dict(release=release, model_revision=revision, model_prefix=prefix)
            pins[key] = value
            with self.subTest(key=key):
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **pins)

    def test_two_approved_mirrors_and_distinct_same_byte_objects(self):
        openi, models = fixture()
        openi['mirrorReleases'] = [TOOL.RELEASE, 'old-mirror']
        openi['entries'][0]['fileName'] = openi['entries'][0]['fileName'].replace(TOOL.RELEASE, 'old-mirror')
        models['entries'][0]['fileName'] = TOOL.MODEL_PREFIX + '/assets/other/pixel.png'
        files = TOOL.render(openi, models, CONTAINER)
        header_data = json.loads(files['header-data.json'])
        self.assertEqual(header_data['entries']['/assets/test/pixel.png']['fileName'],
                         'releases/old-mirror/assets/test/pixel.png')
        self.assertEqual(header_data['entries']['/assets/test/pixel.png']['modelscope'],
                         TOOL.MODEL_BASE + 'assets/other/pixel.png')
        self.assertIn(b'["old-mirror"] = true', files['header.lua'])

    def test_three_reviewed_mirrors_keep_exact_targets_and_reject_four(self):
        self.assertEqual(TOOL.MAX_OPENI_MIRRORS, 3)
        openi, models = fixture()
        mirrors = [TOOL.RELEASE, 'old-second-fixture', 'v023-delta-fixture']
        openi['mirrorReleases'] = mirrors
        for mirror, row in zip(mirrors, openi['entries']):
            row['fileName'] = 'releases/' + mirror + '/' + row['fileName'].split('/', 2)[2]
        files = TOOL.render(openi, models, CONTAINER)
        headers = json.loads(files['header-data.json'])
        routes = json.loads(files['routes.json'])
        self.assertEqual((routes['modelscopeWeight'], routes['openiWeight'], routes['ningxiaWeight']), (60, 40, 0))
        for mirror, row in zip(mirrors, openi['entries']):
            self.assertEqual(headers['entries'][row['requestPath']]['fileName'], row['fileName'])
            self.assertIn(('[' + json.dumps(mirror) + '] = true').encode(), files['header.lua'])
        self.assertNotIn(b'fourth-fixture', files['header.lua'])
        openi['mirrorReleases'] = mirrors + ['fourth-fixture']
        with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)

    def test_three_mirror_validation_does_not_allow_arbitrary_hosts_roots_or_objects(self):
        for mirrors in ([TOOL.RELEASE, 'old', 'https://evil.test/delta'], [TOOL.RELEASE, 'old', '../delta'],
                        [TOOL.RELEASE, 'old', 'releases/delta'], [TOOL.RELEASE, 'old', 'old'],
                        [TOOL.RELEASE, 'old', []]):
            with self.subTest(mirrors=mirrors):
                openi, models = fixture()
                openi['mirrorReleases'] = mirrors
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)
        for target in ('releases/fourth-fixture/assets/test/pixel.png', 'other/v023-delta-fixture/assets/test/pixel.png',
                       'https://evil.test/releases/v023-delta-fixture/assets/test/pixel.png',
                       'releases/v023-delta-fixture/data/test/pixel.png'):
            with self.subTest(target=target):
                openi, models = fixture()
                openi['mirrorReleases'] = [TOOL.RELEASE, 'old-second-fixture', 'v023-delta-fixture']
                openi['entries'][0]['fileName'] = target
                with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER)
        openi, models = fixture()
        openi['mirrorReleases'] = [TOOL.RELEASE]
        self.assertEqual(TOOL.render(openi, models, CONTAINER), TOOL.render(*fixture(), CONTAINER),
                         'explicit single mirror and legacy default remain byte-identical')

    def test_modelscope_existing_eight_prefix_bound_is_not_expanded(self):
        self.assertEqual(TOOL.MAX_MODEL_PREFIXES, 8)
        for count in (4, 8, 9):
            with self.subTest(count=count):
                openi, models = fixture()
                prefixes = ['releases/model-prefix-fixture-' + str(index) for index in range(count)]
                models.update(prefix=prefixes[0], prefixes=prefixes, revision='c' * 40)
                for index, row in enumerate(models['entries']):
                    row['fileName'] = prefixes[index % count] + '/' + row['fileName'].split('/', 2)[2]
                options = dict(model_revision='c' * 40, model_prefix=prefixes[0], model_prefixes=prefixes)
                if count > TOOL.MAX_MODEL_PREFIXES:
                    with self.assertRaises(ValueError): TOOL.render(openi, models, CONTAINER, **options)
                else:
                    data = json.loads(TOOL.render(openi, models, CONTAINER, **options)['routes.json'])
                    self.assertEqual(len(data['modelscopeBases']), count)

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
