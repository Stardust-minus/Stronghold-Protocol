"""Local-only unittest coverage: temporary stages and httpx.MockTransport only.

Run: python3 -m unittest discover -s deploy/stardust/tools -p test_openi_assets.py -v
No installed credentials, sockets, real API or static-stage mutation are used.
"""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote, unquote

import httpx

MODULE_PATH = Path(__file__).with_name("openi-assets.py")
SPEC = importlib.util.spec_from_file_location("openi_assets", MODULE_PATH)
tool = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = tool
SPEC.loader.exec_module(tool)
SECRET = "fixture-secret-never-print"
DATASET_ID = "ea9189b2-1aa3-4108-ae36-9dfb0ab139f4"


class FakeAPI:
    def __init__(self):
        self.registered, self.uploaded = {}, {}
        self.api_requests, self.oss_requests, self.registration_batches = [], [], []
        self.directories = set()
        self.registration_error = False
        self.bad_etag = False
        self.bad_url = None
        self.failed_put = None
        self.extra_after_registration = None
        self.full_names = False
        self.active = self.max_active = 0
        self.lock = threading.Lock()
        self.api = httpx.Client(headers={"Authorization": "Bearer " + SECRET},
                                transport=httpx.MockTransport(self.handle_api), follow_redirects=False)
        self.oss = httpx.Client(transport=httpx.MockTransport(self.handle_oss), follow_redirects=False)
        self.remote = tool.OpenI(self.api, self.oss, sleeper=lambda _: None, listing_limit=1000)

    def close(self):
        self.api.close()
        self.oss.close()

    def page(self, parent):
        paths = dict(self.registered)
        paths["openi_resource.version"] = 27
        rows = {}
        prefix = parent + "/" if parent else ""
        for path, size in paths.items():
            if not path.startswith(prefix):
                continue
            child = path[len(prefix):].split("/")[0]
            is_dir = "/" in path[len(prefix):]
            rows[child] = {"FileName": prefix + child if self.full_names else child,
                           "IsDir": is_dir, "Size": 0 if is_dir else size}
        for directory in self.directories:
            if directory.startswith(prefix) and directory != parent:
                child = directory[len(prefix):].split("/")[0]
                rows[child] = {"FileName": child, "IsDir": True, "Size": 0}
        return {"file_list": list(rows.values()), "has_next": False, "marker": ""}

    def handle_api(self, request):
        self.api_requests.append(request)
        path, params = request.url.path, request.url.params
        routes = {"/api/v1/dataset": "GET", "/api/v1/dataset/files": "GET",
                  "/api/v1/upload/direct/get_upload_url": "GET",
                  "/api/v1/upload/direct/complete_upload": "POST"}
        if (request.url.scheme != "https" or request.url.host != "openi.pcl.ac.cn" or
                path not in routes or request.method != routes[path]):
            raise AssertionError("expected exact namespaced API route and method")
        if path == "/api/v1/dataset":
            return httpx.Response(200, json={"code": 0, "data": {
                "id": DATASET_ID, "can_edit_file": True, "is_private": False}})
        if path == "/api/v1/dataset/files":
            return httpx.Response(200, json={"code": 0, "data": self.page(params["parent_dir"])})
        if path == "/api/v1/upload/direct/get_upload_url":
            name = params["file_name"]
            url = self.bad_url or tool.OSS_ORIGIN + quote(tool.OSS_PREFIX + name, safe="/") + "?signed=" + SECRET
            return httpx.Response(200, json={"code": 0, "data": {"url": url}})
        if path == "/api/v1/upload/direct/complete_upload":
            names = json.loads(request.content)["file_name_list"]
            self.registration_batches.append(names)
            if self.active:
                raise AssertionError("registration raced unsettled PUT")
            if self.registration_error:
                return httpx.Response(200, json={"code": 1, "message": SECRET})
            for name in names:
                self.registered[name] = len(self.uploaded[name])
            if self.extra_after_registration:
                self.registered[self.extra_after_registration] = 5
            return httpx.Response(200, json={"code": 0, "data": {}})
        raise AssertionError("unexpected fixture API path")

    def handle_oss(self, request):
        self.oss_requests.append(request)
        name = unquote(request.url.path)[len(tool.OSS_PREFIX):]
        if name == self.failed_put:
            raise httpx.ConnectError(SECRET + " " + str(request.url), request=request)
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(0.001)
            self.uploaded[name] = request.content
            etag = "0" * 32 if self.bad_etag else hashlib.md5(request.content).hexdigest()
            return httpx.Response(200, headers={"ETag": '"' + etag + '"'})
        finally:
            with self.lock:
                self.active -= 1


class AssetsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        self.source = self.stage / "releases" / tool.RELEASE
        self.source.mkdir(parents=True)
        self.prefix = "releases/unit-test-new"
        self.output = self.root / "resolver.json"
        self.saved = self.root / "upload.checkpoint.json"
        self.manifest = {"schemaVersion": 1, "release": tool.RELEASE,
                         "sourceRevision": "a" * 40, "files": [], "media": []}
        payloads = {"assets/audio/bgm/theme.mp3": b"fixture actual mp3 bytes",
                    "assets/audio/sfx/click.mp3": b"second mp3 fixture",
                    "assets/ui/[opt]image.png": b"fixture image",
                    "assets/spine/unit.atlas": b"atlas text",
                    "assets/spine/unit.skel": b"skeleton binary",
                    "assets/local/model.obj": b"model text",
                    "assets/local/materials.json": b'{"fixture":true}',
                    "fonts/ignored.woff2": b"excluded fonts",
                    "vendor/ignored.module.js": b"excluded code"}
        for path, content in payloads.items():
            self.add_file(path, content)
            if path.endswith(".mp3"):
                stem = "/media/" + path[len("assets/audio/"):-4]
                for ext in sorted(tool.AUDIO_EXTENSIONS):
                    self.manifest["media"].append({"url": stem + ext, "requestedExtension": ext,
                        "file": path, "ext": ".mp3", "mime": "deliberately-untrusted-mime"})
        self.save_manifest()

    def add_file(self, path, content):
        output = self.source / path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        self.manifest["files"].append({"path": path, "bytes": len(content),
                                      "sha256": hashlib.sha256(content).hexdigest()})

    def save_manifest(self):
        (self.stage / "release-manifest.json").write_text(json.dumps(self.manifest))

    def plan(self):
        return tool.prepare(self.stage, self.prefix)

    def fake(self):
        fake = FakeAPI()
        self.addCleanup(fake.close)
        return fake

    def state(self, plan, resume=False):
        return tool.checkpoint(plan, self.saved, resume)

    def run_upload(self, plan, fake, state=None, resume=False):
        return tool.upload(plan, fake.remote, state or self.state(plan), self.saved,
                           resume=resume, progress=lambda _: None)

    def cli(self, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = tool.main(["--stage", str(self.stage), "--prefix", self.prefix,
                                "--out", str(self.output), *extra])
        return result, stdout.getvalue(), stderr.getvalue()

    def test_mapping_excludes_fonts_vendor_and_uses_actual_mime(self):
        plan = self.plan()
        self.assertEqual(len(plan.files), 7)
        entries = {e["requestPath"]: e for e in plan.manifest["entries"]}
        self.assertEqual(len(entries), 23)
        for path in ["/assets/audio/bgm/theme.mp3", "/media/bgm/theme", "/media/bgm/theme.ogg"]:
            self.assertEqual(entries[path]["fileName"], self.prefix + "/media/bgm/theme")
            self.assertEqual(entries[path]["mime"], "audio/mpeg")
        self.assertEqual(entries["/assets/spine/unit.skel"]["mime"], "application/octet-stream")
        self.assertEqual(entries["/assets/spine/unit.atlas"]["mime"], "text/plain")
        self.assertEqual(entries["/assets/local/model.obj"]["mime"], "text/plain")
        self.assertEqual(entries["/assets/local/materials.json"]["mime"], "application/json")
        self.assertEqual(entries["/assets/ui/[opt]image.png"]["fileName"],
                         self.prefix + "/assets/ui/[opt]image.png")
        self.assertFalse(any("fonts" in e or "vendor" in e for e in entries))
        self.assertEqual(self.plan().fingerprint, plan.fingerprint)

    def test_legacy_stage_keeps_release_fallback_and_cli_default(self):
        plan = tool.prepare(self.stage, None)
        self.assertEqual(plan.prefix, "releases/v012-openi-20261004")
        self.assertEqual(plan.source_root, self.source)
        self.assertEqual(plan.manifest["release"], tool.RELEASE)
        self.assertEqual(plan.manifest["fallbackBase"], tool.FALLBACK_ORIGIN + "/releases/" + tool.RELEASE)
        with patch.object(tool, "load_credentials", side_effect=AssertionError("credential read")), \
             patch.object(tool.httpx, "Client", side_effect=AssertionError("network client")), \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(tool.main(["--stage", str(self.stage), "--out", str(self.output), "--plan-only"]), 0)
        self.assertEqual(json.loads(self.output.read_text()), plan.manifest)

    def test_new_release_maps_voice_and_webp_with_matched_fixed_fallback(self):
        release = "v013-hangzhou-20261006-a9dfd17"
        self.source = self.source.rename(self.stage / "releases" / release)
        self.manifest["release"] = release
        self.manifest["fallbackBase"] = "https://untrusted.invalid/releases/wrong"
        self.add_file("assets/local/map/autochess/TX_autochessi_D.webp", b"fixture WebP bytes")
        voice = "assets/audio/voice/cn/char_103_angel/cn_019.mp3"
        self.add_file(voice, b"fixture CN voice mp3")
        stem = "/media/" + voice[len("assets/audio/"):-4]
        for ext in sorted(tool.AUDIO_EXTENSIONS):
            self.manifest["media"].append({"url": stem + ext, "requestedExtension": ext,
                                          "file": voice, "ext": ".mp3"})
        self.save_manifest()
        before = {p.relative_to(self.stage): p.read_bytes() for p in self.stage.rglob("*") if p.is_file()}
        guess_type = tool.mimetypes.guess_type
        with patch.object(tool, "load_credentials", side_effect=AssertionError("credential read")), \
             patch.object(tool.httpx, "Client", side_effect=AssertionError("network client")), \
             patch.object(tool.mimetypes, "guess_type", side_effect=lambda path:
                          ("application/x-untrusted", None) if path.endswith(".webp") else guess_type(path)):
            result, _, stderr = self.cli("--plan-only")
        self.assertEqual((result, stderr), (0, ""))
        plan = self.plan()
        self.assertEqual(plan.source_root, self.source)
        self.assertEqual(len(plan.files), 9)
        self.assertEqual(plan.manifest["release"], release)
        self.assertEqual(plan.manifest["fallbackBase"], tool.FALLBACK_ORIGIN + "/releases/" + release)
        entries = {e["requestPath"]: e for e in plan.manifest["entries"]}
        webp = entries["/assets/local/map/autochess/TX_autochessi_D.webp"]
        self.assertEqual(webp["fileName"], self.prefix + "/assets/local/map/autochess/TX_autochessi_D.webp")
        self.assertEqual(webp["mime"], "image/webp")
        for path in ["/" + voice, stem, stem + ".ogg"]:
            self.assertEqual(entries[path]["fileName"], self.prefix + stem)
            self.assertEqual(entries[path]["mime"], "audio/mpeg")
        self.assertEqual(json.loads(self.output.read_text()), plan.manifest)
        self.assertEqual(before, {p.relative_to(self.stage): p.read_bytes()
                                  for p in self.stage.rglob("*") if p.is_file()})

    def test_new_release_requires_explicit_mirror_prefix(self):
        release = "v013-ui-20261006"
        self.source = self.source.rename(self.stage / "releases" / release)
        self.manifest["release"] = release
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "new-release-requires-explicit-prefix"):
            tool.prepare(self.stage, None)
        with patch.object(tool, "load_credentials", side_effect=AssertionError("credential read")), \
             patch.object(tool.httpx, "Client", side_effect=AssertionError("network client")), \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as stderr:
            result = tool.main(["--stage", str(self.stage), "--out", str(self.output), "--plan-only"])
        self.assertEqual(result, 1)
        self.assertIn("new-release-requires-explicit-prefix", stderr.getvalue())
        self.assertFalse(self.output.exists())
        self.assertEqual(self.plan().manifest["release"], release)

    def test_release_identifiers_reject_traversal_urls_and_noncanonical_names(self):
        for release in [None, 3, [], "", ".", "..", "../other", "releases/other", "/absolute",
                        "x/y", "x\\y", "x%2fy", "x?token=fixture", "x#fragment", "x..y",
                        ".hidden", "_hidden", "-hidden", "x.", "x y", "x\n", "x" * 97]:
            self.manifest["release"] = release
            self.save_manifest()
            with self.subTest(release_type=type(release).__name__), \
                 patch.object(tool, "verified_content", side_effect=AssertionError("must validate release first")), \
                 self.assertRaisesRegex(tool.ToolError, "invalid-release-manifest"):
                self.plan()

    def test_manifest_release_must_select_an_existing_prepared_directory(self):
        self.manifest["release"] = "v013-not-this-directory"
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "prepared-release-directory-missing"):
            self.plan()

    def test_release_and_mirror_identifier_bounds_match_static_resolver_contract(self):
        release = "A" + "_" * 95
        self.source = self.source.rename(self.stage / "releases" / release)
        self.manifest["release"] = release
        self.save_manifest()
        plan = tool.prepare(self.stage, "releases/" + release)
        self.assertEqual(plan.manifest["release"], release)
        for prefix in ["releases/a.b", "releases/a..b", "releases/_hidden", "releases/-hidden",
                       "releases/" + "x" * 97, "releases/a."]:
            with self.subTest(prefix_kind=prefix[:24]), self.assertRaises(tool.ToolError):
                tool.prepare(self.stage, prefix)

    def test_webp_keeps_exact_hash_inventory_and_audio_scope_checks(self):
        path = "assets/local/map/autochess/TX_autochessi_D.webp"
        self.add_file(path, b"fixture WebP bytes")
        self.save_manifest()
        self.plan()
        (self.source / path).write_bytes(b"different WebP bytes")
        with self.assertRaisesRegex(tool.ToolError, "source-size-mismatch"):
            self.plan()
        (self.source / path).write_bytes(b"fixture WebP bytes")
        (self.source / "assets/local/map/autochess/extra.webp").write_bytes(b"extra")
        with self.assertRaisesRegex(tool.ToolError, "local-inventory-mismatch"):
            self.plan()
        (self.source / "assets/local/map/autochess/extra.webp").unlink()
        self.add_file("assets/audio/disguised.webp", b"not permitted audio")
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "unexpected-audio-format"):
            self.plan()

    def test_new_release_keeps_code_secret_and_non_art_json_excluded(self):
        release = "v013-new-public-material"
        self.source = self.source.rename(self.stage / "releases" / release)
        self.manifest["release"] = release
        for path, reason in [("assets/private.js", "invalid-asset-record"),
                             ("assets/private.pem", "invalid-asset-record"),
                             ("assets/data/accounts.json", "non-art-json"),
                             ("data/config.json", "non-public-source-path")]:
            self.add_file(path, b"must not publish")
            self.save_manifest()
            with self.subTest(path_kind=Path(path).suffix), self.assertRaisesRegex(tool.ToolError, reason):
                self.plan()
            self.manifest["files"].pop()
            (self.source / path).unlink()
        self.save_manifest()
        self.plan()

    def test_resume_refuses_changed_fallback_release_even_when_bytes_and_prefix_match(self):
        original = self.plan()
        tool.atomic_json(self.saved, self.state(original))
        release = "v013-same-assets-new-fallback"
        self.source = self.source.rename(self.stage / "releases" / release)
        self.manifest["release"] = release
        self.save_manifest()
        changed = self.plan()
        self.assertEqual(changed.files, original.files)
        self.assertNotEqual(changed.fingerprint, original.fingerprint)
        with self.assertRaisesRegex(tool.ToolError, "checkpoint-plan-mismatch"):
            self.state(changed, resume=True)

    def test_plan_only_never_reads_credentials_or_constructs_clients(self):
        before = {p.relative_to(self.stage): p.read_bytes() for p in self.stage.rglob("*") if p.is_file()}
        with patch.object(tool, "load_credentials", side_effect=AssertionError("credential read")), \
             patch.object(tool.httpx, "Client", side_effect=AssertionError("network client")):
            result, stdout, stderr = self.cli("--plan-only")
        self.assertEqual((result, stderr), (0, ""))
        self.assertIn("mode=plan-only", stdout)
        self.assertIn("remote_metadata_verified=0", stdout)
        self.assertEqual(json.loads(self.output.read_text()), self.plan().manifest)
        self.assertEqual(before, {p.relative_to(self.stage): p.read_bytes()
                                  for p in self.stage.rglob("*") if p.is_file()})

    def test_size_and_hash_failures(self):
        path = self.source / "assets/audio/bgm/theme.mp3"
        original = path.read_bytes()
        for content, reason in [(b"short", "source-size-mismatch"),
                                (b"x" * len(original), "source-hash-mismatch")]:
            path.write_bytes(content)
            with self.assertRaisesRegex(tool.ToolError, reason):
                self.plan()

    def test_symlink_hardlink_and_extra_file_refused(self):
        path = self.source / "assets/ui/[opt]image.png"
        original = path.read_bytes()
        external = self.root / "external.png"
        external.write_bytes(original)
        path.unlink()
        path.symlink_to(external)
        with self.assertRaisesRegex(tool.ToolError, "local-symlink"):
            self.plan()
        path.unlink()
        os.link(external, path)
        with self.assertRaisesRegex(tool.ToolError, "local-hardlink"):
            self.plan()
        path.unlink()
        path.write_bytes(original)
        (path.parent / "extra.png").write_bytes(b"extra")
        with self.assertRaisesRegex(tool.ToolError, "local-inventory-mismatch"):
            self.plan()

    def test_symlink_directory_and_stage_refused(self):
        link = self.source / "assets/link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(tool.ToolError, "local-symlink"):
            self.plan()
        link.unlink()
        stage_link = self.root / "linked-stage"
        stage_link.symlink_to(self.stage, target_is_directory=True)
        with self.assertRaisesRegex(tool.ToolError, "local-symlink"):
            tool.prepare(stage_link, self.prefix)

    def test_unsafe_paths_and_prefixes(self):
        for prefix in ["/releases/x", "releases/../x", "releases/%2e%2e", "releases/x?secret",
                       "compat/x", "releases/x/y", "releases/.hidden", "releases/x\\y"]:
            with self.subTest(prefix=prefix), self.assertRaises(tool.ToolError):
                tool.prepare(self.stage, prefix)
        self.manifest["files"][0]["path"] = "assets/../../credentials"
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "unsafe-path"):
            self.plan()

    def test_code_and_non_art_json_refused(self):
        self.add_file("assets/secret.js", b"not art")
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "invalid-asset-record"):
            self.plan()
        self.manifest["files"].pop()
        (self.source / "assets/secret.js").unlink()
        self.add_file("assets/data/accounts.json", b"{}")
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "non-art-json"):
            self.plan()

    def test_duplicate_path_and_unmapped_alias_refused(self):
        self.manifest["files"].append(self.manifest["files"][0].copy())
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "duplicate-source-path"):
            self.plan()
        self.manifest["files"].pop()
        self.manifest["media"][0]["url"] = "/media/wrong"
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "invalid-media-alias"):
            self.plan()

    def test_destination_cannot_mutate_stage_or_follow_link(self):
        plan = self.plan()
        with self.assertRaisesRegex(tool.ToolError, "output-inside-source-stage"):
            tool.destination(self.stage / "new.json", plan)
        self.output.symlink_to(self.root / "elsewhere")
        with self.assertRaisesRegex(tool.ToolError, "local-symlink"):
            tool.destination(self.output, plan)

    def test_all_api_operations_use_exact_api_v1_routes(self):
        plan, fake = self.plan(), self.fake()
        self.run_upload(plan, fake)
        self.assertEqual({(request.method, request.url.path) for request in fake.api_requests}, {
            ("GET", "/api/v1/dataset"), ("GET", "/api/v1/dataset/files"),
            ("GET", "/api/v1/upload/direct/get_upload_url"),
            ("POST", "/api/v1/upload/direct/complete_upload")})
        for path in ["/dataset", "/dataset/files", "/upload/direct/get_upload_url",
                     "/upload/direct/complete_upload", "/api/v1/api/v1/dataset"]:
            with self.subTest(path=path), self.assertRaisesRegex(AssertionError, "exact namespaced API route"):
                fake.api.get(tool.API_ORIGIN + path)

    def test_upload_headers_auth_separation_etags_and_registration(self):
        plan, fake = self.plan(), self.fake()
        verified = self.run_upload(plan, fake)
        self.assertEqual(verified, len(plan.files))
        self.assertEqual(len(fake.oss_requests), len(plan.files))
        self.assertGreater(fake.max_active, 1)
        self.assertLessEqual(fake.max_active, 4)
        for request in fake.oss_requests:
            self.assertEqual(request.method, "PUT")
            self.assertNotIn("authorization", request.headers)
            self.assertNotIn("content-type", request.headers)
            self.assertEqual(request.headers["cache-control"], tool.CACHE_CONTROL)
        for request in fake.api_requests:
            self.assertEqual(request.headers["authorization"], "Bearer " + SECRET)
            if request.url.path in {"/api/v1/upload/direct/get_upload_url", "/api/v1/upload/direct/complete_upload"}:
                self.assertEqual(request.url.params["subject_id"], DATASET_ID)
                self.assertEqual(request.url.params["subject_type"], "1")
            if request.url.path == "/api/v1/upload/direct/get_upload_url":
                self.assertEqual(request.url.params["extra"], "{}")
                self.assertEqual(request.url.params["subject_type"], "1")
                expected = next(f for f in plan.files if f.file_name == request.url.params["file_name"])
                self.assertEqual(request.url.params["file_type"], expected.mime)
                self.assertEqual(request.url.params["size"], str(expected.bytes))
        self.assertEqual(len(fake.registration_batches), 1)
        saved = self.saved.read_text()
        self.assertNotIn(SECRET, saved)
        self.assertNotIn("https://", saved)
        self.assertNotIn("?", saved)
        self.assertTrue(all(r["state"] == "registered" for r in json.loads(saved)["files"].values()))

    def test_registration_failure_is_not_success_and_resume_does_not_put_again(self):
        plan, fake = self.plan(), self.fake()
        fake.registration_error = True
        with self.assertRaisesRegex(tool.ToolError, "api-operation-rejected"):
            self.run_upload(plan, fake)
        self.assertEqual(len(fake.oss_requests), len(plan.files))
        state = self.state(plan, resume=True)
        self.assertTrue(all(r["state"] == "uploaded" for r in state["files"].values()))
        fake.registration_error = False
        self.run_upload(plan, fake, state, resume=True)
        self.assertEqual(len(fake.oss_requests), len(plan.files))
        self.assertTrue(all(r["state"] == "registered" for r in state["files"].values()))

    def test_put_failure_waits_then_saves_successes_without_registering(self):
        plan, fake = self.plan(), self.fake()
        fake.failed_put = plan.files[0].file_name
        with self.assertRaisesRegex(tool.ToolError, "put-batch-failed"):
            self.run_upload(plan, fake)
        self.assertEqual(fake.active, 0)
        self.assertEqual(fake.registration_batches, [])
        state = self.state(plan, resume=True)
        self.assertEqual(state["files"][fake.failed_put]["state"], "pending")
        self.assertEqual(sum(r["state"] == "uploaded" for r in state["files"].values()), len(plan.files) - 1)
        fake.failed_put = None
        self.run_upload(plan, fake, state, resume=True)

    def test_bad_etag_blocks_registration(self):
        plan, fake = self.plan(), self.fake()
        fake.bad_etag = True
        with self.assertRaisesRegex(tool.ToolError, "put-batch-failed"):
            self.run_upload(plan, fake)
        self.assertEqual(fake.registration_batches, [])
        self.assertTrue(all(r["state"] == "pending" for r in self.state(plan, resume=True)["files"].values()))

    def test_signed_url_host_path_scheme_and_fragment_safety(self):
        plan, fake = self.plan(), self.fake()
        asset = plan.files[0]
        good = tool.OSS_ORIGIN + tool.OSS_PREFIX + asset.file_name + "?signature=" + SECRET
        for bad in [good.replace("https://", "http://"), good.replace("obs.cn-south-222.ai.pcl.cn", "evil.invalid"),
                    good.replace(asset.file_name, self.prefix + "/wrong"), good + "#fragment",
                    good.replace("https://", "https://user@"), "\n" + good,
                    good.replace("?signature", "/../wrong?signature")]:
            fake.bad_url = bad
            with self.subTest(url_kind=bad.split(":")[0]), self.assertRaisesRegex(tool.ToolError, "unsafe-upload-url"):
                fake.remote.put(plan, asset, DATASET_ID)
        self.assertEqual(fake.oss_requests, [])

    def test_existing_prefix_without_checkpoint_and_empty_prefix_refused(self):
        plan, fake = self.plan(), self.fake()
        fake.registered[plan.files[0].file_name] = plan.files[0].bytes
        with self.assertRaisesRegex(tool.ToolError, "existing-prefix-without-matching-checkpoint"):
            self.run_upload(plan, fake)
        self.assertFalse(self.saved.exists())
        self.assertEqual(fake.oss_requests, [])
        fake.registered.clear()
        fake.directories.add(self.prefix)
        with self.assertRaisesRegex(tool.ToolError, "existing-prefix-without-matching-checkpoint"):
            self.run_upload(plan, fake)

    def test_resume_refuses_unrelated_pending_wrong_size_or_missing_registered_file(self):
        plan, fake = self.plan(), self.fake()
        state = self.state(plan)
        asset = plan.files[0]
        for name, size in [(self.prefix + "/unrelated.png", 1), (asset.file_name, asset.bytes)]:
            fake.registered = {name: size}
            with self.assertRaisesRegex(tool.ToolError, "unrelated-or-conflicting-remote-file"):
                self.run_upload(plan, fake, state, resume=True)
        state["files"][asset.file_name]["state"] = "uploaded"
        fake.registered = {asset.file_name: asset.bytes + 1}
        with self.assertRaisesRegex(tool.ToolError, "unrelated-or-conflicting-remote-file"):
            self.run_upload(plan, fake, state, resume=True)
        state["files"][asset.file_name]["state"] = "registered"
        fake.registered.clear()
        with self.assertRaisesRegex(tool.ToolError, "registered-remote-file-missing"):
            self.run_upload(plan, fake, state, resume=True)
        self.assertEqual(fake.oss_requests, [])

    def test_matching_completed_resume_only_verifies(self):
        plan, fake = self.plan(), self.fake()
        self.run_upload(plan, fake)
        calls = len(fake.oss_requests)
        registrations = len(fake.registration_batches)
        self.run_upload(plan, fake, self.state(plan, resume=True), resume=True)
        self.assertEqual((len(fake.oss_requests), len(fake.registration_batches)), (calls, registrations))

    def test_checkpoint_matches_source_prefix_dataset_and_aliases(self):
        plan = self.plan()
        state = self.state(plan)
        tool.atomic_json(self.saved, state)
        with self.assertRaisesRegex(tool.ToolError, "checkpoint-already-exists"):
            self.state(plan)
        other = tool.prepare(self.stage, "releases/different")
        with self.assertRaisesRegex(tool.ToolError, "checkpoint-plan-mismatch"):
            self.state(other, resume=True)
        state["dataset"] = "someone-else/dataset"
        tool.atomic_json(self.saved, state)
        with self.assertRaisesRegex(tool.ToolError, "checkpoint-plan-mismatch"):
            self.state(plan, resume=True)
        state["dataset"] = tool.DATASET
        tool.atomic_json(self.saved, state)
        self.manifest["media"].pop()
        self.save_manifest()
        with self.assertRaisesRegex(tool.ToolError, "checkpoint-plan-mismatch"):
            self.state(self.plan(), resume=True)

    def test_final_inventory_must_be_exact_before_manifest_is_ready(self):
        plan, fake = self.plan(), self.fake()
        fake.extra_after_registration = self.prefix + "/assets/extra.png"
        with self.assertRaisesRegex(tool.ToolError, "final-remote-inventory-mismatch"):
            self.run_upload(plan, fake)
        self.assertFalse(self.output.exists())

    def test_bounded_repeated_markers_and_escaping_inventory_paths(self):
        fake = self.fake()
        def loop(request):
            return httpx.Response(200, json={"code": 0, "data": {
                "file_list": [], "has_next": True, "marker": "same-marker"}})
        with httpx.Client(transport=httpx.MockTransport(loop)) as api:
            remote = tool.OpenI(api, fake.oss)
            with self.assertRaisesRegex(tool.ToolError, "inventory-marker-loop"):
                remote.children(self.prefix)
            self.assertEqual(remote.listing_calls, 2)
        for path in ["../escape", "/outside/file", "other/place.png", "x%2fy", ".hidden"]:
            def unsafe(request, path=path):
                return httpx.Response(200, json={"code": 0, "data": {"file_list": [
                    {"FileName": path, "IsDir": False, "Size": 1}], "has_next": False}})
            with httpx.Client(transport=httpx.MockTransport(unsafe)) as api:
                with self.subTest(path=path), self.assertRaises(tool.ToolError):
                    tool.OpenI(api, fake.oss).children(self.prefix)

    def test_bounded_unique_markers_and_full_path_inventory(self):
        fake = self.fake()
        counter = iter(range(100))
        def endless(request):
            return httpx.Response(200, json={"code": 0, "data": {
                "file_list": [], "has_next": True, "marker": str(next(counter))}})
        with httpx.Client(transport=httpx.MockTransport(endless)) as api:
            remote = tool.OpenI(api, fake.oss, listing_limit=3)
            with self.assertRaisesRegex(tool.ToolError, "inventory-request-limit"):
                remote.children(self.prefix)
        fake.full_names = True
        plan = self.plan()
        self.run_upload(plan, fake)

    def test_bounded_retry_after_and_nonretryable_4xx(self):
        fake = self.fake()
        for statuses, retry_after, expected_calls, expected_delay in [
                ([429, 200], "2", 2, [2.0]), ([503, 200], None, 2, [1]),
                ([403], None, 1, []), ([429], "31", 1, [])]:
            calls, delays = [], []
            def handle(request):
                calls.append(request)
                status = statuses[min(len(calls) - 1, len(statuses) - 1)]
                return httpx.Response(status, headers={"Retry-After": retry_after} if retry_after else {},
                                      text=SECRET)
            with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                remote = tool.OpenI(client, fake.oss, sleeper=delays.append)
                if statuses[-1] == 200:
                    remote.request(client, "GET", tool.API_ORIGIN + "/fixture")
                else:
                    with self.assertRaises(tool.ToolError):
                        remote.request(client, "GET", tool.API_ORIGIN + "/fixture")
            self.assertEqual(len(calls), expected_calls)
            self.assertEqual(delays, expected_delay)

    def test_credentials_exact_endpoint_and_upload_only(self):
        credential_fixture = self.root / "fixture-token.json"
        for endpoint, valid in [(tool.API_ORIGIN, True), (tool.API_ORIGIN + "/", False),
                                ("https://evil.invalid", False)]:
            credential_fixture.write_text(json.dumps({"endpoint": endpoint, "token": SECRET}))
            with patch.object(tool, "CREDENTIALS", credential_fixture):
                if valid:
                    self.assertEqual(tool.load_credentials(), SECRET)
                else:
                    with self.assertRaisesRegex(tool.ToolError, "invalid-local-credentials"):
                        tool.load_credentials()
        with patch.object(tool, "load_credentials", side_effect=AssertionError("must not read")):
            result, _, _ = self.cli("--upload")
            self.assertEqual(result, 1)
        self.assertGreaterEqual(logging.root.manager.disable, logging.CRITICAL)

    def test_cli_sensitive_exceptions_response_bodies_and_signed_urls_redacted(self):
        fake = self.fake()
        fake.registration_error = True
        with patch.object(tool, "load_credentials", return_value=SECRET), \
             patch.object(tool.httpx, "Client", side_effect=[fake.api, fake.oss]):
            result, stdout, stderr = self.cli("--upload", "--checkpoint", str(self.saved))
        self.assertEqual(result, 1)
        self.assertFalse(self.output.exists())
        self.assertNotIn("upload-ready", stdout)
        for sensitive in [SECRET, "signed=", "Authorization", "Bearer", tool.OSS_ORIGIN]:
            self.assertNotIn(sensitive, stdout + stderr + self.saved.read_text())
        with patch.object(tool, "load_credentials", side_effect=RuntimeError(SECRET + " Location https://evil.invalid/?token")):
            self.saved.unlink()
            result, stdout, stderr = self.cli("--upload", "--checkpoint", str(self.saved))
        self.assertEqual(result, 1)
        self.assertNotIn(SECRET, stdout + stderr)
        self.assertNotIn("Location", stdout + stderr)
        self.assertNotIn("https://", stdout + stderr)

    def test_source_change_after_plan_fails_before_signed_url_acquisition(self):
        plan, fake = self.plan(), self.fake()
        asset = plan.files[0]
        (plan.source_root / asset.path).write_bytes(b"x" * asset.bytes)
        with self.assertRaisesRegex(tool.ToolError, "source-hash-mismatch"):
            fake.remote.put(plan, asset, DATASET_ID)
        self.assertEqual(fake.api_requests, [])
        self.assertEqual(fake.oss_requests, [])

    def test_batched_registration_only_after_all_puts_settle(self):
        for number in range(198):
            self.add_file(f"assets/ui/batch-{number}.png", f"image-{number}".encode())
        self.save_manifest()
        plan, fake = self.plan(), self.fake()
        self.run_upload(plan, fake)
        self.assertEqual(len(plan.files), 205)
        self.assertEqual([len(batch) for batch in fake.registration_batches], [100, 100, 5])
        last_acquire = max(i for i, r in enumerate(fake.api_requests)
                           if r.url.path == "/api/v1/upload/direct/get_upload_url")
        first_registration = min(i for i, r in enumerate(fake.api_requests)
                                 if r.url.path == "/api/v1/upload/direct/complete_upload")
        self.assertGreater(first_registration, last_acquire)
        self.assertLessEqual(fake.max_active, 4)

    def test_unexpected_empty_remote_directory_refused_on_resume(self):
        plan, fake = self.plan(), self.fake()
        fake.directories.add(self.prefix + "/unrelated")
        with self.assertRaisesRegex(tool.ToolError, "unexpected-inventory-directory"):
            self.run_upload(plan, fake, self.state(plan), resume=True)
        self.assertEqual(fake.oss_requests, [])

    def test_inventory_per_directory_page_limit(self):
        fake = self.fake()
        count = 0
        def endless(request):
            nonlocal count
            count += 1
            return httpx.Response(200, json={"code": 0, "data": {
                "file_list": [], "has_next": True, "marker": str(count)}})
        with httpx.Client(transport=httpx.MockTransport(endless)) as api:
            remote = tool.OpenI(api, fake.oss)
            with self.assertRaisesRegex(tool.ToolError, "inventory-page-limit"):
                remote.children(self.prefix)
        self.assertEqual(count, 64)

    def test_unknown_cli_arguments_do_not_echo_secrets(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as failure:
            tool.main(["--token", SECRET])
        self.assertEqual(failure.exception.code, 2)
        self.assertNotIn(SECRET, stderr.getvalue())

    def test_dataset_subject_id_accepts_canonical_uuid_and_legacy_positive_integer(self):
        fake = self.fake()
        for subject_id in [DATASET_ID, 7]:
            body = {"code": 0, "data": {"id": subject_id, "can_edit_file": True, "is_private": False}}
            with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as api:
                self.assertEqual(tool.OpenI(api, fake.oss).dataset_id(), subject_id)
        for subject_id in [None, True, False, 0, -1, 7.0, "7", "", "not-a-uuid",
                           DATASET_ID.upper(), "{" + DATASET_ID + "}", DATASET_ID.replace("-", ""),
                           DATASET_ID + "?token=" + SECRET, [DATASET_ID]]:
            body = {"code": 0, "data": {"id": subject_id, "can_edit_file": True, "is_private": False}}
            with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as api:
                with self.assertRaisesRegex(tool.ToolError, "invalid-dataset-subject-id"):
                    tool.OpenI(api, fake.oss).dataset_id()

    def test_private_readonly_or_error_dataset_refused(self):
        fake = self.fake()
        for body in [{"code": 0, "data": {"id": DATASET_ID, "can_edit_file": False, "is_private": False}},
                     {"code": 0, "data": {"id": DATASET_ID, "can_edit_file": True, "is_private": True}},
                     {"code": 123, "message": SECRET}, {"code": 0, "data": None}]:
            with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as api:
                with self.assertRaises(tool.ToolError):
                    tool.OpenI(api, fake.oss).dataset_id()
        self.assertEqual(fake.oss_requests, [])

    def test_cli_signed_transport_exception_redacted(self):
        fake = self.fake()
        fake.failed_put = self.plan().files[0].file_name
        with patch.object(tool, "load_credentials", return_value=SECRET), \
             patch.object(tool.httpx, "Client", side_effect=[fake.api, fake.oss]):
            result, stdout, stderr = self.cli("--upload", "--checkpoint", str(self.saved))
        self.assertEqual(result, 1)
        self.assertIn("put-batch-failed", stderr)
        self.assertNotIn(SECRET, stdout + stderr + self.saved.read_text())
        self.assertNotIn("signed=", stdout + stderr)
        self.assertNotIn(tool.OSS_ORIGIN, stdout + stderr)
        self.assertFalse(self.output.exists())

    def test_cli_success_creates_ready_manifest_after_inventory(self):
        fake = self.fake()
        with patch.object(tool, "load_credentials", return_value=SECRET), \
             patch.object(tool.httpx, "Client", side_effect=[fake.api, fake.oss]):
            result, stdout, stderr = self.cli("--upload", "--checkpoint", str(self.saved))
        self.assertEqual((result, stderr), (0, ""))
        self.assertIn("mode=upload-ready", stdout)
        self.assertIn("remote_metadata_verified=7", stdout)
        self.assertEqual(json.loads(self.output.read_text()), self.plan().manifest)


if __name__ == "__main__":
    unittest.main()
