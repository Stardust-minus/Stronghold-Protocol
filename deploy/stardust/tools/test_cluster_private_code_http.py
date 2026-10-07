"""Opt-in real isolated Nginx private aliases/gate/fallback; no actual TLS/password acceptance."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import unittest
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cluster_code_unit_fixture', BASE / 'test_cluster_private_code.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
code = fixtures.code


@unittest.skipUnless(os.environ.get('CLUSTER_PRIVATE_CODE_HTTP') == '1', 'opt-in existing verified Nginx HTTP fixture')
class PrivateCodeHttpTests(unittest.TestCase):
    profile, source_kind = 'beta', 'tree'
    def test_real_gate_alias_headers_head_conditional_origin_and_same_cluster_fallback(self):
        fixture = fixtures.PrivateCodeTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.root.chmod(0o755)
        p = code.profiles.get_profile(self.profile)
        if self.source_kind == 'commit':
            fixture.value.update(kind='commit', baseRevision='e' * 40); fixture.refresh(); fixture.build = 'e' * 40
        value = code.prepare(fixture.source, fixture.manifest, fixture.digest, fixture.build, fixture.output,
                             profile=self.profile, source_kind=self.source_kind)
        requests = []

        class Backend(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                path = urlsplit(self.path).path
                if path == '/check':
                    status = 204 if self.headers.get('X-Fixture-Auth') == 'allowed' else 401
                    requests.append({'kind': 'gate', 'status': status})
                    self.send_response(status)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                body = ('same-cluster:' + self.path).encode()
                requests.append({'kind': 'code', 'path': self.path, 'method': self.command,
                                 'realIp': self.headers.get('X-Real-IP'), 'forwarded': self.headers.get('X-Forwarded-For')})
                self.send_response(200)
                self.send_header('Content-Type', 'text/css' if path.startswith('/css/') else 'application/javascript')
                # The generated proxy must hide these deliberately wrong fixture policies.
                self.send_header('Cache-Control', 'public, max-age=9999')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('X-Content-Type-Options', 'wrong')
                self.send_header('X-Frame-Options', 'wrong')
                self.send_header('Referrer-Policy', 'wrong')
                self.send_header('Content-Security-Policy', 'wrong')
                self.send_header('Strict-Transport-Security', 'wrong')
                self.send_header('X-Robots-Tag', 'wrong')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

        backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(backend.server_close)
        self.addCleanup(backend.shutdown)
        backend_port = backend.server_address[1]
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        default_runtime = BASE.parents[2] / '.cache/stardust/material-lb-fixture-lua-20261006-sCWmy8/runtime'
        binary = Path(os.environ.get('CLUSTER_CODE_NGINX', str(default_runtime / 'nginx')))
        loader = Path(os.environ.get('CLUSTER_CODE_LOADER', str(default_runtime / 'ld-linux-x86-64.so.2')))
        runtime = Path(os.environ.get('CLUSTER_CODE_LIBS', str(default_runtime)))
        self.assertTrue(binary.is_file() and loader.is_file())
        include = (fixture.output / value['nginx'][0]['path']).read_text()
        original_alias = '/www/sites/' + p.site + '/localcode/' + p.code_prefix + fixture.build
        include = include.replace(original_alias, str(fixture.output / ('localcode/' + p.code_prefix + fixture.build)))
        include = include.replace('http://' + p.wg_core + ':' + str(p.coordinator_port), 'http://127.0.0.1:' + str(backend_port))
        generated = fixture.root / 'private.conf'
        generated.write_text(include)
        config = fixture.root / 'nginx.conf'
        config.write_text(f'''worker_processes 1;
error_log {fixture.root}/error.log warn;
pid {fixture.root}/nginx.pid;
events {{ worker_connections 64; }}
http {{
    access_log off;
    client_body_temp_path {fixture.root}/body;
    proxy_temp_path {fixture.root}/proxy;
    fastcgi_temp_path {fixture.root}/fastcgi;
    scgi_temp_path {fixture.root}/scgi;
    uwsgi_temp_path {fixture.root}/uwsgi;
    map $uri ${p.security_map}_frame {{ default SAMEORIGIN; }}
    map $uri ${p.security_map}_csp {{ default "default-src 'none'"; }}
    map $http_origin ${p.security_map}_private_origin_denied {{ default 1; '' 0; 'https://{p.site}' 0; }}
    server {{
        listen 127.0.0.1:{port};
        server_name {p.site};
        {chr(10).join(code.security_headers('fixture', profile=self.profile))}
        if (${p.security_map}_private_origin_denied) {{ return 403; }}
        error_page 401 = @fixture_unauthorized;
        location @fixture_unauthorized {{ return 401; }}
        location = /_gate/check {{
            internal;
            auth_request off;
            proxy_pass http://127.0.0.1:{backend_port}/check;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
        }}
        include {generated};
        location / {{ return 404; }}
    }}
}}
''')
        command = [str(loader), '--library-path', str(runtime), str(binary), '-p', str(fixture.root) + '/', '-c', str(config)]
        syntax = subprocess.run([*command, '-t'], capture_output=True, text=True, timeout=5)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        process = subprocess.Popen([*command, '-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def cleanup():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)

        self.addCleanup(cleanup)
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                    break
            except OSError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    self.fail('owned isolated Nginx fixture did not start')
                time.sleep(0.02)

        def request(method, uri, *, auth=True, extra=None):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            headers = {'Host': p.site, 'Origin': p.origin}
            if auth:
                headers['X-Fixture-Auth'] = 'allowed'
            headers.update(extra or {})
            try:
                connection.request(method, uri, headers=headers)
                response = connection.getresponse()
                return response.status, response.getheaders(), response.read()
            finally:
                connection.close()

        def check_private(headers, marker):
            expected = {'cache-control': 'private, no-store', 'strict-transport-security': 'max-age=31536000',
                        'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
                        'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'",
                        'x-robots-tag': 'noindex, nofollow', 'x-ark-code-source': marker}
            for key, value in expected.items():
                self.assertEqual([item for name, item in headers if name.lower() == key], [value], key)
            self.assertFalse(any(name.lower() == 'access-control-allow-origin' for name, _ in headers))

        cases = 0
        status, headers, body = request('GET', '/js/main.js?fixture=one')
        self.assertEqual(status, 200)
        self.assertEqual(body, (fixture.source / 'public/js/main.js').read_bytes())
        check_private(headers, 'edge')
        self.assertEqual(dict(headers)['Content-Type'], 'application/javascript')
        etag = dict(headers)['ETag']
        self.assertFalse(any(row['kind'] == 'code' for row in requests))
        cases += 1
        status, headers, body = request('HEAD', '/css/theme.css')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertEqual(dict(headers)['Content-Type'], 'text/css')
        self.assertEqual(int(dict(headers)['Content-Length']), len((fixture.source / 'public/css/theme.css').read_bytes()))
        check_private(headers, 'edge')
        cases += 1
        status, headers, body = request('GET', '/js/main.js', extra={'If-None-Match': etag})
        self.assertEqual((status, body), (304, b''))
        check_private(headers, 'edge')
        cases += 1
        for method in ('GET', 'HEAD'):
            status, _, body = request(method, '/js/main.js', auth=False, extra={'If-None-Match': etag})
            self.assertEqual(status, 401)
            self.assertNotIn(b'export const fixture', body)
            cases += 1
        status, _, body = request('POST', '/js/main.js')
        self.assertEqual(status, 405)
        self.assertNotIn(b'export const fixture', body)
        cases += 1
        status, _, body = request('GET', '/js/main.js', extra={'Origin': 'https://unrelated.invalid'})
        self.assertEqual(status, 403)
        self.assertNotIn(b'export const fixture', body)
        cases += 1
        status, headers, body = request('GET', '/js/unlisted.js?fixture=unknown', extra={'X-Forwarded-For': 'forged'})
        self.assertEqual(status, 200)
        self.assertEqual(body, b'same-cluster:/js/unlisted.js?fixture=unknown')
        check_private(headers, 'cluster')
        self.assertEqual(requests[-1]['forwarded'], '127.0.0.1')
        cases += 1
        staged = fixture.output / ('localcode/' + p.code_prefix + fixture.build) / 'js/main.js'
        staged.unlink()
        status, headers, body = request('GET', '/js/main.js?fixture=missing')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'same-cluster:/js/main.js?fixture=missing')
        check_private(headers, 'cluster')
        cases += 1
        before = len([row for row in requests if row['kind'] == 'code'])
        status, _, _ = request('GET', '/js/main.js?fixture=unauthorized-missing', auth=False)
        self.assertEqual(status, 401)
        self.assertEqual(len([row for row in requests if row['kind'] == 'code']), before)
        cases += 1
        status, headers, body = request('HEAD', '/css/unlisted.css?fixture=head')
        self.assertEqual((status, body), (200, b''))
        check_private(headers, 'cluster')
        self.assertEqual(requests[-1]['method'], 'HEAD')
        cases += 1
        print(json.dumps({'event': 'cluster-private-code-http-check', 'nginx': 'verified1.28.3',
                          'profile': self.profile, 'sourceKind': self.source_kind, 'cases': cases, 'passed': cases, 'actualTLSorPasswordAcceptance': False,
                          'scope': 'owned loopback Nginx aliases/stock headers/fixture auth/HEAD/304/fixed-cluster fallback'}))


class BetaCommitPrivateCodeHttpTests(PrivateCodeHttpTests):
    source_kind = 'commit'


class FormalPrivateCodeHttpTests(PrivateCodeHttpTests):
    profile, source_kind = 'formal', 'commit'


if __name__ == '__main__':
    unittest.main()
