#!/usr/bin/env python3
import contextlib
import copy
import importlib.util
import json
import http.client
import os
import re
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


def keys_and_paths(source):
    """package.loaded keys and inventory files a rendered loader uses (header.lua's per-token Vary key aside)."""
    return re.findall(r'^local key = "([^"]+)"$', source, re.M), re.findall(r'io\.open\("([^"]+)", "rb"\)', source)


# The http-level block of MATERIAL-SOURCES.md and nginx/ark-proto.conf, with the profile list as a placeholder.
VHOST_PRELOAD = '''init_by_lua_block {
    for _, f in ipairs({ __PRELOADS__ }) do
        local ok, err = pcall(dofile, f)
        if not ok then ngx.log(ngx.ERR, "material preload: ", err) end
    end
}'''


@contextlib.contextmanager
def openresty(runtime, work, http_body):
    """A local master with two workers (and an init_worker hook like the vhost's geo one) serving `http_body`."""
    binary = runtime / 'openresty/nginx/sbin/nginx'
    loader = runtime / 'ld-linux-x86-64.so.2'
    libraries = ':'.join(str(runtime / p) for p in ('openresty/openssl3/lib', 'openresty/pcre2/lib', 'openresty/luajit/lib')) + ':' + str(runtime)
    (work / 'logs').mkdir(exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    (work / 'nginx.conf').write_text(f'''daemon off;
master_process on;
worker_processes 2;
user root;
error_log {work}/error.log notice;
pid {work}/nginx.pid;
events {{ worker_connections 64; }}
http {{
access_log off;
client_body_temp_path {work}/client_temp;
lua_package_path '{runtime}/openresty/lualib/?.lua;{runtime}/openresty/lualib/?/init.lua;;';
lua_package_cpath '{work}/lualib/?.so;;';
init_worker_by_lua_block {{ package.loaded.fixture_worker_hook = true }}
{http_body.replace('__PORT__', str(port))}
}}
''')
    command = [str(loader), '--library-path', libraries, str(binary), '-p', str(work) + '/', '-c', str(work / 'nginx.conf')]
    with (work / 'stdout').open('wb') as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        try:
            for _ in range(200):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.1): break
                except OSError:
                    if process.poll() is not None: raise AssertionError('local OpenResty exited before listen')
                    time.sleep(0.05)

            def request(path, method='GET', request_id='0' * 32, body=None, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                try:
                    connection.request(method, path, body=body, headers={'X-Fixture-Request-Id': request_id, **(headers or {})})
                    response = connection.getresponse(); body = response.read()
                    return response.status, {k.lower(): v for k, v in response.getheaders()}, body
                finally: connection.close()
            yield request
        finally:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)


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

    @unittest.skipUnless(os.environ.get('MATERIAL_OPENRESTY_RUNTIME'), 'opt-in local OpenResty runtime not supplied')
    def test_preload_actual_master_inheritance_and_unchanged_lazy_fallback(self):
        runtime = Path(os.environ['MATERIAL_OPENRESTY_RUNTIME'])
        files = TOOL.render(*fixture(), CONTAINER)
        (route_key, header_key), _ = keys_and_paths(files['preload.lua'].decode())
        probes = [(path + query, method, request_id)
                  for path in ('/assets/test/pixel.png', '/media/voice/test', '/assets/audio/voice/test.mp3')
                  for query, method, request_id in (('', 'GET', '0' * 32), ('', 'GET', 'f' * 32), ('?sp_source=openi', 'GET', '0' * 32),
                                                    ('', 'HEAD', '0' * 32), ('?sp_source=openi', 'OPTIONS', '0' * 32))]
        probes += [('/assets/unknown.png', 'GET', '0' * 32), ('/assets/test/pixel.png', 'POST', '0' * 32),
                   ('/assets/test/pixel.png?sp_source=modelscope', 'GET', '0' * 32)]

        def serve(work, init, routes=None):
            (work / 'lualib').mkdir(parents=True)
            shutil.copyfile(runtime / 'openresty/lualib/cjson.so', work / 'lualib/cjson.so')
            for name, body in files.items():
                text = body.decode()
                if name.endswith('.lua'):
                    text = text.replace(CONTAINER + '/', str(work) + '/').replace('ngx.var.request_id', 'ngx.var.fixture_request_id')
                (work / name).write_text(routes if name == 'routes.json' and routes else text)
            public = f'''set $fixture_request_id $http_x_fixture_request_id;
access_by_lua_file {work}/access.lua;
header_filter_by_lua_file {work}/header.lua;
content_by_lua_block {{ ngx.exit(204) }}'''
            loaded = f'ngx.say(type(package.loaded["{route_key}"]), " ", type(package.loaded["{header_key}"]), " ", tostring(package.loaded.fixture_worker_hook), " ", ngx.worker.pid())'
            return openresty(runtime, work, f'''{init}
server {{
listen 127.0.0.1:__PORT__ reuseport;
location /assets/ {{ {public} }}
location /media/ {{ {public} }}
location = /_fixture_loaded {{ content_by_lua_block {{ {loaded} }} }}
}}''')

        def answers(request):
            result = []
            for path, method, request_id in probes:
                status, headers, _ = request(path, method, request_id)
                result.append((path, method, request_id[0], status) + tuple(
                    headers.get(name) for name in ('location', 'cache-control', 'access-control-allow-origin', 'vary')))
            return result

        def states(request):
            return {tuple(request('/_fixture_loaded')[2].decode().split()) for _ in range(40)}

        with tempfile.TemporaryDirectory(prefix='material-preload-') as directory:
            root = Path(directory)
            with serve(root / 'lazy', '') as request:
                self.assertEqual({state[:3] for state in states(request)}, {('nil', 'nil', 'true')})
                lazy = answers(request)
                self.assertEqual({state[:2] for state in states(request)} - {('nil', 'nil'), ('table', 'nil')}, {('table', 'table')})
            preload = VHOST_PRELOAD.replace('__PRELOADS__', '"' + str(root / 'preload' / 'preload.lua') + '"')
            with serve(root / 'preload', preload) as request:
                before = states(request)
                self.assertEqual({state[:3] for state in before}, {('table', 'table', 'true')})
                self.assertEqual(len({state[3] for state in before}), 2, 'both forked workers inherit the master tables')
                self.assertEqual(answers(request), lazy)
            # At the first start init_by_lua logs to stderr (error_log opens later); at a reload to error_log.
            logs = lambda work: (work / 'error.log').read_text() + (work / 'stdout').read_text()
            self.assertNotIn('[error]', logs(root / 'preload'))
            self.assertIn(('/assets/test/pixel.png', 'GET', '0', 302), [row[:4] for row in lazy])
            # An invalid inventory is cached as `false` by the preload exactly as the lazy loader does: 500, no decode retry.
            routes = json.loads(files['routes.json']); routes['ningxiaWeight'] = 1
            for name, init in (('invalid-lazy', ''), ('invalid-preload', VHOST_PRELOAD.replace(
                    '__PRELOADS__', '"' + str(root / 'invalid-preload' / 'preload.lua') + '"'))):
                with serve(root / name, init, json.dumps(routes)) as request:
                    if init:
                        self.assertEqual({state[:2] for state in states(request)}, {('boolean', 'table')})
                    for _ in range(8):
                        self.assertEqual(request('/assets/test/pixel.png')[0], 500)
                        self.assertEqual(request('/assets/test/pixel.png?sp_source=openi')[0], 500)
                    after = {state[0] for state in states(request)}
                    self.assertIn('boolean', after)
                    self.assertNotIn('table', after)
            self.assertIn('material preload: invalid route inventory ' + route_key, logs(root / 'invalid-preload'))
            # A missing or failing preload only logs; the vhost still starts and the lazy loaders serve unchanged.
            with serve(root / 'missing', VHOST_PRELOAD.replace('__PRELOADS__', '"' + str(root / 'missing' / 'absent.lua') + '"')) as request:
                self.assertEqual({state[:2] for state in states(request)}, {('nil', 'nil')})
                self.assertEqual(answers(request), lazy)
            self.assertIn('material preload: cannot open', logs(root / 'missing'))

    @unittest.skipUnless(os.environ.get('MATERIAL_OPENRESTY_RUNTIME'), 'opt-in local OpenResty runtime not supplied')
    def test_batch_signer_actual_http(self):
        runtime = Path(os.environ['MATERIAL_OPENRESTY_RUNTIME'])
        openi, models, options = exception_fixture()
        files = TOOL.render(openi, models, CONTAINER, modelscope_weight=100, signed_ttl=3600, **options)
        known = ['/assets/test/pixel.png', '/media/voice/test', '/assets/audio/voice/test.mp3']
        exception = options['openi_only_paths'][0]
        # Synthetic provider: a signed-looking CDN Location per object, never a real signature or a real request.
        resolve = f'''location = /_ark_ms_resolve {{
    internal;
    content_by_lua_block {{
        local uri = ngx.var.ark_ms_uri
        ngx.shared.fixture:incr("resolve", 1, 0)
        if uri:find("cool", 1, true) then return ngx.exit(503) end
        local hex = ngx.md5(uri)
        ngx.header["Location"] = "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/" .. hex:sub(1, 2) .. "/" .. hex:sub(3, 4)
            .. "/" .. hex .. "?filename=x&namespace=Stardust&repository=arknight-assets&revision={TOOL.MODEL_REVISION}"
            .. "&auth_key=" .. ngx.time() .. "-0-0-" .. hex
        return ngx.exit(302)
    }}
}}
location = /_ark_ms_declare {{ internal; set $ark_ms_uri ""; return 404; }}
location = /_fixture_resolves {{ content_by_lua_block {{ ngx.say(ngx.shared.fixture:get("resolve") or 0) }} }}'''
        with tempfile.TemporaryDirectory(prefix='material-sign-') as directory:
            work = Path(directory)
            (work / 'lualib').mkdir()
            shutil.copyfile(runtime / 'openresty/lualib/cjson.so', work / 'lualib/cjson.so')
            for name, body in files.items():
                (work / name).write_text(body.decode().replace(CONTAINER + '/', str(work) + '/'))
            public = f'''access_by_lua_file {work}/access.lua;
header_filter_by_lua_file {work}/header.lua;
content_by_lua_block {{ ngx.exit(204) }}'''
            with openresty(runtime, work, f'''lua_shared_dict ark_ms_signed 1m;
lua_shared_dict ark_ms_lock 1m;
lua_shared_dict fixture 1m;
server {{
listen 127.0.0.1:__PORT__ reuseport;
{resolve}
include {work}/sign-location.conf;
location /assets/ {{ {public} }}
location /media/ {{ {public} }}
}}''') as request:
                def sign(paths, raw=None):
                    body = raw if raw is not None else json.dumps({'paths': paths})
                    return request('/material-sign', 'POST', body=body, headers={'Content-Type': 'application/json'})
                resolves = lambda: int(request('/_fixture_resolves')[2])
                status, headers, body = sign(known + [exception, '/assets/unknown.png', known[0], '/js/main.js'])
                self.assertEqual(status, 200, body)
                self.assertEqual(headers['content-type'], 'application/json')
                self.assertEqual(headers['cache-control'], 'no-store')
                urls = json.loads(body)['urls']
                self.assertEqual(sorted(urls), sorted(known), 'unknown, OpenI-only and private paths are left out')
                for url, seconds in urls.values():
                    self.assertTrue(url.startswith('https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/'), url)
                    self.assertTrue(3470 <= seconds <= 3480, seconds)  # TTL 3600 - SAFETY 120
                # /media/voice/test and its /assets/audio/ alias are one object
                self.assertEqual(resolves(), 2, 'one provider request per object')
                # the batch shares the redirect cache: the same URL, no new provider request, either way round
                again = json.loads(sign(list(reversed(known)))[2])['urls']
                self.assertEqual({p: v[0] for p, v in again.items()}, {p: v[0] for p, v in urls.items()})
                status, headers, _ = request(known[0])
                self.assertEqual((status, headers['location']), (302, urls[known[0]][0]))
                self.assertEqual(resolves(), 2)
                self.assertEqual(json.loads(sign(['/assets/none.png'])[2]), {'urls': {}}, 'an empty answer is still an object')
                for raw in ('', 'null', '{}', '{"paths":[]}', '{"paths":{"a":"/assets/test/pixel.png"}}', '{"paths":[1]}',
                            json.dumps({'paths': ['/assets/x%d.png' % i for i in range(65)]}), '{"paths":["/assets/test/pixel.png"]',
                            json.dumps({'paths': ['/assets/' + 'x' * 2100]})):
                    self.assertEqual(sign(None, raw)[0], 400, raw[:40])
                self.assertEqual(sign(None, json.dumps({'paths': known, 'pad': 'x' * 17000}))[0], 413)
                self.assertEqual(request('/material-sign')[0], 405)
                self.assertEqual(json.loads(sign(['/assets/x%d.png' % i for i in range(64)])[2]), {'urls': {}}, '64 is allowed')
                errors = [line for line in (work / 'error.log').read_text().splitlines()
                          if '[error]' in line and 'client intended to send too large body' not in line]
                self.assertEqual(errors, [])

    def test_preload_runs_the_lazy_loaders_verbatim(self):
        openi, models, options = exception_fixture(multiple_prefixes=True)
        profiles = {'default': TOOL.render(*fixture(), CONTAINER),
                    'signed-full-share': TOOL.render(openi, models, CONTAINER, modelscope_weight=100, signed_ttl=3600, **options),
                    'other-directory': TOOL.render(*fixture(), TOOL.CONTAINER_PREFIX + 'other_profile-2')}
        for name, files in profiles.items():
            with self.subTest(profile=name):
                access, header, preload = (files[n].decode() for n in ('access.lua', 'header.lua', 'preload.lua'))
                self.assertNotIn('__MATERIAL_LB_', preload)
                # access.lua from its first line through the cached store: definitions, validation, key, path, decode.
                route_loader = access[:access.index('    package.loaded[key] = db\nend\n') + len('    package.loaded[key] = db\nend\n')]
                self.assertTrue(route_loader.startswith('local cjson = require "cjson.safe"\nlocal key = "'))
                self.assertIn('do\n' + route_loader + 'if db == false then', preload)
                # header.lua's definitions and loader, without its response-header code and method/status gate.
                definitions = header[header.index('local function decode(value, plus)\n'):header.index('\nlocal method = ngx.req.get_method()') + 1]
                header_loader = header[header.index('local key = "'):header.index('    package.loaded[key] = data\nend\n') + len('    package.loaded[key] = data\nend\n')]
                self.assertIn('do\nlocal cjson = require "cjson.safe"\n' + definitions.rstrip('\n') + '\n' + header_loader + 'if data == false then', preload)
                for source, block in ((access, route_loader), (header, header_loader)):
                    function = source[source.index('local function valid_data(value)'):]
                    function = function[:function.index('    return count > 0\nend\n')]
                    self.assertEqual(preload.count(function), 1)
                    self.assertIn('if not valid_data(', block)
                self.assertEqual(keys_and_paths(preload), (keys_and_paths(access)[0] + keys_and_paths(header)[0],
                                                           keys_and_paths(access)[1] + keys_and_paths(header)[1]))
                directory = re.search(r'io\.open\("([^"]+)/routes\.json"', access).group(1)
                self.assertEqual(keys_and_paths(preload)[1], [directory + '/routes.json', directory + '/header-data.json'])
                suffix = directory[len(TOOL.CONTAINER_PREFIX):].replace('-', '_')
                self.assertEqual(keys_and_paths(preload)[0], ['ark_material_lb_' + suffix, 'ark_material_lb_header_data_' + suffix])
                # Master context: no request, response or context API; nothing else is loaded or overwritten.
                code = '\n'.join(line for line in preload.splitlines() if not line.lstrip().startswith('--'))
                for api in ('ngx.var', 'ngx.req', 'ngx.header', 'ngx.ctx', 'ngx.exit', 'ngx.redirect', 'ngx.status',
                            'header[', 'dofile', 'loadstring', 'loadfile', 'mssign', 'collectgarbage'):
                    self.assertNotIn(api, code)
                self.assertEqual(preload.count('package.loaded[key] = '), 2)
                self.assertEqual(preload.count('io.open('), 2)
                self.assertLess(len(files['preload.lua']), 32768)
        full = TOOL.render(*full_fixture(), CONTAINER)
        self.assertEqual(full['preload.lua'], profiles['default']['preload.lua'], 'the inventory stays JSON, not Lua')

    def test_lazy_loaders_unchanged_without_preload(self):
        files = TOOL.render(*fixture(), CONTAINER)
        access, header = files['access.lua'].decode(), files['header.lua'].decode()
        self.assertIn('local db = package.loaded[key]\nif db == nil then\n', access)
        self.assertIn('if type(db) ~= "table" then return ngx.exit(500) end\n', access)
        self.assertIn('local data = package.loaded[key]\nif data == nil then\n', header)
        self.assertIn('if type(data) ~= "table" then return end\n', header)
        for source in (access, header):
            self.assertNotIn('preload', source)
        for name in ('access.lua', 'header.lua'):
            template = (TOOL.TEMPLATES / name).read_text()
            self.assertNotIn('preload', template)

    def test_loader_anchors_must_stay_unique_and_ordered(self):
        self.assertEqual(TOOL.loader('a\nb\nc\n', (('b\n', 'c\n'), ('a\n', 'a\n'))), 'b\nc\na\n')
        for source in ('a\nb\na\n', 'b\na\n', 'a\n', ''):
            with self.subTest(source=source):
                with self.assertRaises(ValueError): TOOL.loader(source, (('a\n', 'b\n'),))
        template = TOOL.TEMPLATES / 'header.lua'
        original = TOOL.TEMPLATES
        with tempfile.TemporaryDirectory() as directory:
            for name in ('access.lua', 'header.lua', 'mssign.lua', 'preload.lua'):
                shutil.copyfile(original / name, Path(directory) / name)
            (Path(directory) / 'header.lua').write_text('-- local function decode(value, plus)\n' + template.read_text())
            TOOL.TEMPLATES = Path(directory)
            try:
                with self.assertRaises(ValueError): TOOL.render(*fixture(), CONTAINER)
            finally:
                TOOL.TEMPLATES = original

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
        self.assertEqual(set(files), {'routes.json', 'header-data.json', 'access.lua', 'header.lua', 'preload.lua'})
        self.assertEqual(set(header_data), {'fallback_base', 'oss_authority', 'oss_path_prefix', 'entries'})
        self.assertEqual(header_data['fallback_base'], TOOL.FALLBACK)
        self.assertEqual(header_data['oss_authority'], TOOL.OSS_ORIGIN.removeprefix('https://'))
        self.assertEqual(header_data['oss_path_prefix'], openi['ossPathPrefix'])
        self.assertEqual(header_data['entries'], {row['requestPath']: {
            'fileName': row['fileName'], 'modelscope': data['paths'][row['requestPath']]} for row in openi['entries']})

    def test_scene_geometry_bin_is_an_assets_object(self):
        # 0.2.5 battlefield scenes fetch assets/local/scene/<stage>/scene.bin; the Lua templates list `bin` too.
        openi, models = fixture()
        scene = {'requestPath': '/assets/local/scene/act1autochess_m01/scene.bin',
                 'fileName': 'releases/' + TOOL.RELEASE + '/assets/local/scene/act1autochess_m01/scene.bin',
                 'bytes': 2108116, 'sha256': 'c' * 64, 'mime': 'application/octet-stream'}
        openi['entries'].append(scene)
        models['entries'].append({**scene, 'fileName': TOOL.MODEL_PREFIX + '/' + scene['fileName'].split('/', 2)[2]})
        files = TOOL.render(openi, models, CONTAINER)
        self.assertIn(TOOL.MODEL_REVISION, json.loads(files['routes.json'])['paths'][scene['requestPath']])
        for name in ('access.lua', 'header.lua'):
            self.assertIn(b'json = true, bin = true,', files[name])

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

    def test_default_profile_has_no_signer(self):
        files = TOOL.render(*fixture(), CONTAINER)
        self.assertIn(b'local signer_file = nil\n', files['access.lua'])
        self.assertNotIn('mssign.lua', files)
        self.assertIn(b'"public, max-age=86400"', files['header.lua'])

    def test_full_modelscope_share_and_signed_profile(self):
        openi, models, options = exception_fixture(multiple_prefixes=True)
        files = TOOL.render(openi, models, CONTAINER, modelscope_weight=100, signed_ttl=3600, **options)
        self.assertEqual(set(files), {'routes.json', 'header-data.json', 'access.lua', 'header.lua', 'mssign.lua', 'preload.lua',
                                      'sign.lua', 'sign-location.conf'})
        # the batch signer runs the access.lua loader verbatim and points at this profile's files only
        self.assertIn(TOOL.loader(files['access.lua'].decode(), TOOL.ACCESS_LOADER).encode(), files['sign.lua'])
        self.assertIn(('local signer_file = "' + CONTAINER + '/mssign.lua"').encode(), files['sign.lua'])
        self.assertIn(('content_by_lua_file ' + CONTAINER + '/sign.lua;').encode(), files['sign-location.conf'])
        self.assertIn(b'location = /material-sign {', files['sign-location.conf'])
        routes = json.loads(files['routes.json'])
        self.assertEqual((routes['modelscopeWeight'], routes['openiWeight'], routes['ningxiaWeight']), (100, 0, 0))
        access, signer = files['access.lua'], files['mssign.lua']
        self.assertIn(b'if model_target ~= false and number < 4294967296 then', access)
        self.assertIn(b'value.openiWeight ~= 0\n', access)
        self.assertIn(('local signer_file = "' + CONTAINER + '/mssign.lua"').encode(), access)
        for body in files.values():
            self.assertNotIn(b'__MATERIAL_LB_', body)
        self.assertIn(b'local TTL = 3600 ', signer)
        self.assertIn(('local REVISION = "' + options['model_revision'] + '"').encode(), signer)
        self.assertIn(b'local NAMESPACE, REPOSITORY = "Stardust", "arknight-assets"', signer)
        self.assertIn(b'ngx.HTTP_HEAD', signer)
        self.assertIn(b'material_lb_ms_max_age', files['header.lua'])
        self.assertIn(b'ngx.ctx.material_lb_ms_direct and "public, max-age=60"', files['header.lua'])
        # The 60/40 profile stays byte-identical to the unsigned default except for the signer line.
        sixty = TOOL.render(openi, models, CONTAINER, signed_ttl=720, **options)
        self.assertIn(b'number < 2576980378', sixty['access.lua'])
        self.assertEqual(sixty['access.lua'].replace(('"' + CONTAINER + '/mssign.lua"').encode(), b'nil'),
                         TOOL.render(openi, models, CONTAINER, **options)['access.lua'])

    def test_modelscope_weight_and_signed_ttl_bounds(self):
        for options in ({'modelscope_weight': 0}, {'modelscope_weight': 50}, {'modelscope_weight': 99},
                        {'modelscope_weight': '100'}, {'modelscope_weight': True}, {'modelscope_weight': 100.0},
                        {'signed_ttl': 599}, {'signed_ttl': 3601}, {'signed_ttl': 720.0}, {'signed_ttl': '720'},
                        {'signed_ttl': True}, {'signed_ttl': 0}):
            with self.subTest(options=options):
                with self.assertRaises(ValueError): TOOL.render(*fixture(), CONTAINER, **options)

    def test_cli_modelscope_weight_and_signed_ttl(self):
        openi, models = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            oi, ms = root / 'openi.json', root / 'models.json'
            oi.write_text(json.dumps(openi))
            ms.write_text(json.dumps(models))
            common = [sys.executable, '-I', str(Path(TOOL.__file__)), '--openi-manifest', str(oi),
                      '--modelscope-manifest', str(ms), '--container-dir', CONTAINER]
            accepted = subprocess.run(common + ['--modelscope-weight', '100', '--signed-ttl', '720', '--out', str(root / 'signed')],
                                      capture_output=True, text=True, check=False)
            self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
            self.assertIn('mssign.lua', json.loads(accepted.stdout)['filesSha256'])
            self.assertEqual(json.loads((root / 'signed' / 'routes.json').read_text())['modelscopeWeight'], 100)
            for index, flags in enumerate((['--modelscope-weight', '50'], ['--signed-ttl', '30'], ['--signed-ttl', 'x'])):
                denied = subprocess.run(common + flags + ['--out', str(root / ('rejected-' + str(index)))], capture_output=True, text=True, check=False)
                with self.subTest(flags=flags):
                    self.assertNotEqual(denied.returncode, 0)
                    self.assertFalse((root / ('rejected-' + str(index))).exists())

    def test_entry_count_remains_bounded_at_next_release_limit(self):
        self.assertEqual(TOOL.MAX_ENTRIES, 150000)
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

    def test_five_reviewed_mirrors_keep_exact_targets_and_reject_six(self):
        self.assertEqual(TOOL.MAX_OPENI_MIRRORS, 5)
        openi, models = fixture()
        scene = {'requestPath': '/assets/test/scene.bin', 'fileName': 'releases/' + TOOL.RELEASE + '/assets/test/scene.bin',
                 'bytes': 9, 'sha256': 'd' * 64, 'mime': 'application/octet-stream'}
        fx = {'requestPath': '/assets/local/fx/prefabs/test.json', 'fileName': 'releases/' + TOOL.RELEASE + '/assets/local/fx/prefabs/test.json',
              'bytes': 2, 'sha256': 'e' * 64, 'mime': 'application/json'}
        for row in (scene, fx):
            openi['entries'].append(row)
            models['entries'].append({**row, 'fileName': TOOL.MODEL_PREFIX + '/' + row['fileName'].split('/', 2)[2]})
        mirrors = [TOOL.RELEASE, 'old-second-fixture', 'v023-delta-fixture', 'v025-delta-fixture', 'v030-delta-fixture']
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
        self.assertNotIn(b'sixth-fixture', files['header.lua'])
        openi['mirrorReleases'] = mirrors + ['sixth-fixture']
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
        self.assertEqual(TOOL.MAX_MODEL_PREFIXES, 9)
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
