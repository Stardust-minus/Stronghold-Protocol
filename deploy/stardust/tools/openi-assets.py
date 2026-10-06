#!/usr/bin/env python3
"""Prepare/upload the public asset subset; never modifies the prepared stage.

Offline: python3 openi-assets.py --stage STAGE --prefix releases/NEW-ID \
    --out resolver-plan.json --plan-only
Runtime: replace --plan-only with --upload --checkpoint upload.checkpoint.json.
Verify the matched static stage first. Its release-manifest selects the fixed
fallback release; new stages require an explicit safe mirror prefix.
Use --resume only with that matching checkpoint. A plan-only manifest is NOT a
remote-readiness assertion. Only --upload reads /root/.openi/token.json; there
are deliberately no token arguments, environment variables or SDK dependencies.
Upload verifies PUT MD5 ETags and the complete registered path/size inventory;
it does not claim a remote SHA-256 re-download or browser verification.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit

logging.disable(logging.CRITICAL)  # Must precede HTTP library use: no signed URL logs.
import httpx

RELEASE = "v012-workers-20261004"  # Legacy default; prepared stages select their own release.
RELEASE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}")
DATASET = "Stardust_minus/arknight_assets"
API_ORIGIN = "https://openi.pcl.ac.cn"
OSS_ORIGIN = "https://obs.cn-south-222.ai.pcl.cn"
OSS_PREFIX = "/fefced50e2d744508e4bc7e2792e1087-urchin2/ea9189b2-1aa3-4108-ae36-9dfb0ab139f4/"
FALLBACK_ORIGIN = "https://ark-asset.hanabi-ai.cn:25442"
CREDENTIALS = Path("/root/.openi/token.json")
CACHE_CONTROL = "public, max-age=31536000, immutable"
MIME_OVERRIDES = {".mp3": "audio/mpeg", ".webp": "image/webp", ".skel": "application/octet-stream",
                  ".atlas": "text/plain", ".obj": "text/plain", ".json": "application/json"}
# Only the fixed prepared art/media formats, not fonts, vendor, scripts or data.
ASSET_EXTENSIONS = {".png", ".webp", ".mp3", ".skel", ".atlas", ".obj", ".json"}
AUDIO_EXTENSIONS = {"", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav"}


class ToolError(Exception):
    """Only constant, credential-free reason codes may reach terminal output."""


def require(condition, reason):
    if not condition:
        raise ToolError(reason)


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 512 and
            re.fullmatch(r"[A-Za-z0-9_\[\]./-]+", value) is not None and
            all(p and not p.startswith(".") for p in value.split("/")), "unsafe-path")
    return value


def checked_path(path):
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            require(not stat.S_ISLNK(info.st_mode), "local-symlink")
            if part != path:
                require(stat.S_ISDIR(info.st_mode), "local-parent-not-directory")
            elif stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, "local-hardlink")
    return path


def read_file(path):
    path = checked_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "unsafe-local-file")
        return source.read()


def parse_json(content):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate-json-key")
            result[key] = value
        return result
    try:
        return json.loads(content, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError):
        raise ToolError("invalid-json") from None


def atomic_json(path, value):
    path = checked_path(path)
    require(path.parent.is_dir(), "output-parent-missing")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".openi-", delete=False) as output:
            temporary = output.name
            json.dump(value, output, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            os.unlink(temporary)


@dataclass(frozen=True)
class Asset:
    path: str
    file_name: str
    bytes: int
    sha256: str
    mime: str


@dataclass(frozen=True)
class Plan:
    stage: Path
    source_root: Path
    prefix: str
    files: tuple
    manifest: dict
    fingerprint: str


def verified_content(stage, asset):
    content = read_file(stage / asset.path)
    require(len(content) == asset.bytes, "source-size-mismatch")
    require(hashlib.sha256(content).hexdigest() == asset.sha256, "source-hash-mismatch")
    return content


def prepare(stage, prefix):
    stage = checked_path(stage)
    require(stage.is_dir(), "stage-not-directory")
    source = parse_json(read_file(stage / "release-manifest.json"))
    require(isinstance(source, dict) and source.get("schemaVersion") == 1 and
            isinstance(source.get("release"), str) and RELEASE_ID.fullmatch(source["release"]) is not None and
            isinstance(source.get("sourceRevision"), str) and
            re.fullmatch(r"[0-9a-f]{40}", source["sourceRevision"]) is not None and
            isinstance(source.get("files"), list) and isinstance(source.get("media"), list),
            "invalid-release-manifest")
    release = source["release"]
    # Preserve the historical CLI default only for its original stage. A new release
    # must choose an explicit mirror prefix, never silently reuse the old inventory.
    if prefix is None:
        require(release == RELEASE, "new-release-requires-explicit-prefix")
        prefix = "releases/v012-openi-20261004"
    relative_path(prefix)
    require(prefix.startswith("releases/") and RELEASE_ID.fullmatch(prefix[len("releases/"):]) is not None,
            "prefix-must-be-new-release")
    source_root = checked_path(stage / "releases" / release)
    require(source_root.is_dir(), "prepared-release-directory-missing")
    files, entries, seen = {}, {}, set()
    for row in source["files"]:
        require(isinstance(row, dict), "invalid-file-record")
        path = relative_path(row.get("path"))
        require(path not in seen, "duplicate-source-path")
        seen.add(path)
        if not path.startswith("assets/"):
            require(path.startswith(("fonts/", "vendor/")), "non-public-source-path")
            continue
        ext = Path(path).suffix
        require(ext in ASSET_EXTENSIONS and type(row.get("bytes")) is int and row["bytes"] > 0 and
                isinstance(row.get("sha256"), str) and
                re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is not None, "invalid-asset-record")
        if ext == ".mp3":
            require(path.startswith("assets/audio/"), "audio-outside-audio-directory")
            name = prefix + "/media/" + path[len("assets/audio/"):-4]
        else:
            require(not path.startswith("assets/audio/"), "unexpected-audio-format")
            # JSON is only allowed for the prepared local model/map material metadata.
            require(ext != ".json" or path.startswith("assets/local/"), "non-art-json")
            name = prefix + "/" + path
        relative_path(name)
        mime = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        asset = Asset(path, name, row["bytes"], row["sha256"], mime)
        verified_content(source_root, asset)
        files[path] = asset
        entries["/" + path] = asset
    require(files and len({f.file_name for f in files.values()}) == len(files), "remote-name-collision")
    assets_root = checked_path(source_root / "assets")
    require(assets_root.is_dir(), "assets-directory-missing")
    actual = set()
    for parent, directories, names in os.walk(assets_root, followlinks=False):
        for name in directories:
            require(checked_path(Path(parent) / name).is_dir(), "unsafe-asset-directory")
        for name in names:
            actual.add(relative_path((Path(parent) / name).relative_to(source_root).as_posix()))
    require(actual == set(files), "local-inventory-mismatch")
    for row in source["media"]:
        require(isinstance(row, dict), "invalid-media-record")
        asset = files.get(row.get("file"))
        requested = row.get("requestedExtension")
        require(asset is not None and asset.path.startswith("assets/audio/") and
                asset.path.endswith(".mp3") and isinstance(requested, str) and
                requested in AUDIO_EXTENSIONS and row.get("ext") == ".mp3", "invalid-media-file")
        url = "/media/" + asset.path[len("assets/audio/"):-4] + requested
        require(row.get("url") == url and url not in entries, "invalid-media-alias")
        entries[url] = asset  # MIME comes from the actual source, not requested extension.
    ordered = tuple(files[key] for key in sorted(files))
    resolver = {"schemaVersion": 1, "release": release, "dataset": DATASET,
                "apiOrigin": API_ORIGIN, "ossOrigin": OSS_ORIGIN, "ossPathPrefix": OSS_PREFIX,
                "fallbackBase": FALLBACK_ORIGIN + "/releases/" + release, "entries": [
                    {"requestPath": key, "fileName": asset.file_name, "bytes": asset.bytes,
                     "sha256": asset.sha256, "mime": asset.mime}
                    for key, asset in sorted(entries.items())]}
    identity = {"stage": str(stage), "sourceRevision": source["sourceRevision"],
                "prefix": prefix, "manifest": resolver}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True,
                                           separators=(",", ":")).encode()).hexdigest()
    return Plan(stage, source_root, prefix, ordered, resolver, fingerprint)


def destination(path, plan):
    path = checked_path(path)
    require(not path.is_relative_to(plan.stage), "output-inside-source-stage")
    require(path.parent.is_dir(), "output-parent-missing")
    return path


def checkpoint(plan, path, resume):
    expected = {"schemaVersion": 1, "planSha256": plan.fingerprint, "dataset": DATASET,
                "prefix": plan.prefix, "files": {
                    f.file_name: {"sha256": f.sha256, "state": "pending"} for f in plan.files}}
    if not resume:
        require(not path.exists(), "checkpoint-already-exists-use-resume")
        return expected
    require(path.is_file(), "resume-checkpoint-missing")
    saved = parse_json(read_file(path))
    require(isinstance(saved, dict) and set(saved) == set(expected) and
            all(saved[key] == expected[key] for key in expected if key != "files") and
            isinstance(saved["files"], dict) and set(saved["files"]) == set(expected["files"]),
            "checkpoint-plan-mismatch")
    for name, record in saved["files"].items():
        require(isinstance(record, dict) and set(record) == {"sha256", "state"} and
                record["sha256"] == expected["files"][name]["sha256"] and
                record["state"] in {"pending", "uploaded", "registered"}, "invalid-checkpoint-state")
    return saved


def load_credentials():
    saved = parse_json(read_file(CREDENTIALS))
    require(isinstance(saved, dict) and saved.get("endpoint") == API_ORIGIN and
            isinstance(saved.get("token"), str) and saved["token"] and
            not any(c.isspace() or ord(c) < 32 or ord(c) > 126 for c in saved["token"]),
            "invalid-local-credentials")
    return saved["token"]


class OpenI:
    def __init__(self, api, oss, retries=2, sleeper=time.sleep, listing_limit=20000):
        self.api, self.oss = api, oss
        self.retries, self.sleeper = retries, sleeper
        self.listing_limit, self.listing_calls = listing_limit, 0

    def request(self, client, method, url, **kwargs):
        for attempt in range(self.retries + 1):
            response = None
            try:
                response = client.request(method, url, **kwargs)
            except httpx.TransportError:
                pass  # Never include library exceptions: they can contain signed URLs.
            retry = response is None or response.status_code == 429 or response.status_code >= 500
            if not retry:
                require(200 <= response.status_code < 300, "http-request-rejected")
                return response
            require(attempt < self.retries, "http-retries-exhausted")
            delay = min(2 ** attempt, 4)
            if response is not None and response.status_code == 429:
                value = response.headers.get("Retry-After")
                if value is not None:
                    try:
                        delay = float(value) if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value) else max(
                            0, parsedate_to_datetime(value).timestamp() - time.time())
                    except (ValueError, TypeError, OverflowError):
                        raise ToolError("invalid-retry-after") from None
                    require(0 <= delay <= 30, "retry-delay-exceeds-bound")
            self.sleeper(delay)
        raise ToolError("http-retries-exhausted")

    def call(self, method, path, **kwargs):
        response = self.request(self.api, method, API_ORIGIN + "/api/v1" + path, **kwargs)
        body = parse_json(response.content)
        require(isinstance(body, dict) and type(body.get("code")) is int and body["code"] == 0,
                "api-operation-rejected")
        return body.get("data")

    def dataset_id(self):
        data = self.call("GET", "/dataset", params={"dataset_name": DATASET})
        require(isinstance(data, dict) and data.get("can_edit_file") is True and
                data.get("is_private") is False, "dataset-must-be-editable-and-public")
        subject_id = data.get("id")
        require((type(subject_id) is int and subject_id > 0) or
                (isinstance(subject_id, str) and re.fullmatch(
                    r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", subject_id) is not None),
                "invalid-dataset-subject-id")
        return subject_id

    def children(self, parent):
        marker, markers, rows, names, pages = "", set(), [], set(), 0
        while True:
            self.listing_calls += 1
            pages += 1
            require(self.listing_calls <= self.listing_limit, "inventory-request-limit")
            require(pages <= 64, "inventory-page-limit")
            data = self.call("GET", "/dataset/files", params={"dataset_name": DATASET,
                             "parent_dir": parent, "page_size": 1000, "marker": marker})
            require(isinstance(data, dict) and isinstance(data.get("file_list"), list) and
                    type(data.get("has_next")) is bool and len(data["file_list"]) <= 1000,
                    "invalid-inventory-page")
            for row in data["file_list"]:
                require(isinstance(row, dict) and type(row.get("IsDir")) is bool and
                        isinstance(row.get("FileName"), str), "invalid-inventory-record")
                raw = row["FileName"].removesuffix("/") if row["IsDir"] else row["FileName"]
                leaf = raw[len(parent) + 1:] if parent and raw.startswith(parent + "/") else raw
                relative_path(leaf)
                require("/" not in leaf, "inventory-path-escaped-parent")
                name = relative_path(parent + "/" + leaf if parent else leaf)
                require(name not in names, "duplicate-inventory-path")
                names.add(name)
                require(len(names) <= self.listing_limit, "inventory-child-limit")
                require(row["IsDir"] or (type(row.get("Size")) is int and row["Size"] >= 0),
                        "invalid-inventory-size")
                rows.append((name, row["IsDir"], row.get("Size", 0)))
            if not data["has_next"]:
                return rows
            marker = data.get("marker")
            require(isinstance(marker, str) and 0 < len(marker) <= 4096 and marker not in markers,
                    "inventory-marker-loop")
            markers.add(marker)

    def inventory(self, prefix, expected_files=None):
        relative_path(prefix)
        allowed_directories = None
        if expected_files is not None:
            allowed_directories = {prefix}
            for name in expected_files:
                directory = name.rsplit("/", 1)[0]
                while directory.startswith(prefix + "/"):
                    allowed_directories.add(directory)
                    directory = directory.rsplit("/", 1)[0]
        self.listing_calls = 0
        parent = ""
        for part in prefix.split("/"):
            wanted = parent + "/" + part if parent else part
            found = [row for row in self.children(parent) if row[0] == wanted]
            if not found:
                return False, {}
            require(found[0][1], "prefix-blocked-by-file")
            parent = wanted
        inventory, pending, visited = {}, [prefix], set()
        while pending:
            directory = pending.pop()
            require(directory not in visited and len(visited) < self.listing_limit and
                    directory.count("/") <= 32, "inventory-directory-limit")
            visited.add(directory)
            for name, is_dir, size in self.children(directory):
                if is_dir:
                    require(allowed_directories is None or name in allowed_directories,
                            "unexpected-inventory-directory")
                    require(len(visited) + len(pending) < self.listing_limit, "inventory-directory-limit")
                    pending.append(name)
                else:
                    require(name not in inventory and len(inventory) < self.listing_limit,
                            "inventory-file-limit")
                    inventory[name] = size
        return True, inventory

    def put(self, plan, asset, dataset_id):
        content = verified_content(plan.source_root, asset)
        data = self.call("GET", "/upload/direct/get_upload_url", params={
            "file_name": asset.file_name, "subject_id": dataset_id, "subject_type": 1,
            "file_type": asset.mime, "size": asset.bytes, "extra": "{}"})
        require(isinstance(data, dict) and isinstance(data.get("url"), str), "invalid-upload-url")
        url = data["url"]
        try:
            parsed = urlsplit(url)
            safe = (not any(ord(c) <= 32 for c in url) and parsed.scheme == "https" and
                    parsed.hostname == urlsplit(OSS_ORIGIN).hostname and parsed.port in (None, 443) and
                    parsed.username is None and parsed.password is None and not parsed.fragment and
                    bool(parsed.query) and unquote(parsed.path, errors="strict") == OSS_PREFIX + asset.file_name)
        except (ValueError, UnicodeError):
            safe = False
        require(safe, "unsafe-upload-url")
        response = self.request(self.oss, "PUT", url, content=content,
                                headers={"Cache-Control": CACHE_CONTROL})
        # No Content-Type: the live signature does not sign that header (adding it yields 403).
        require(response.status_code == 200 and
                response.headers.get("ETag", "").lower() == '"' + hashlib.md5(content).hexdigest() + '"',
                "put-etag-mismatch")

    def register(self, names, dataset_id):
        self.call("POST", "/upload/direct/complete_upload",
                  params={"subject_id": dataset_id, "subject_type": 1},
                  json={"file_name_list": names})


def upload(plan, remote, state, checkpoint_path, *, resume=False, workers=4, progress=print):
    require(type(workers) is int and 1 <= workers <= 4, "invalid-worker-count")
    dataset_id = remote.dataset_id()
    expected = {f.file_name: f.bytes for f in plan.files}
    present, inventory = remote.inventory(plan.prefix, expected)
    records = state["files"]
    require(resume or not present, "existing-prefix-without-matching-checkpoint")
    require(all(name in expected and size == expected[name] and
                records[name]["state"] != "pending" for name, size in inventory.items()),
            "unrelated-or-conflicting-remote-file")
    require(all(record["state"] != "registered" or name in inventory
                for name, record in records.items()), "registered-remote-file-missing")
    atomic_json(checkpoint_path, state)  # Claim a clean prefix before uploading any bytes.
    pending = [f for f in plan.files if records[f.file_name]["state"] == "pending"]
    completed = sum(r["state"] != "pending" for r in records.values())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for start in range(0, len(pending), 100):
            futures = {pool.submit(remote.put, plan, asset, dataset_id): asset
                       for asset in pending[start:start + 100]}
            failed = False
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception:
                    failed = True
                else:
                    records[futures[future].file_name]["state"] = "uploaded"
                    completed += 1
            atomic_json(checkpoint_path, state)  # Every submitted PUT has now settled.
            progress(f"put_verified={completed}/{len(plan.files)}")
            require(not failed, "put-batch-failed-resume-checkpoint")
    names = sorted(name for name, record in records.items() if record["state"] == "uploaded")
    for start in range(0, len(names), 100):
        batch = names[start:start + 100]
        remote.register(batch, dataset_id)
        for name in batch:
            records[name]["state"] = "registered"
        atomic_json(checkpoint_path, state)
        progress(f"registered={sum(r['state'] == 'registered' for r in records.values())}/{len(plan.files)}")
    present, inventory = remote.inventory(plan.prefix, expected)
    require(present and inventory == expected, "final-remote-inventory-mismatch")
    return len(inventory)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "ERROR: invalid-cli-arguments-use-help\n")  # Do not echo accidental secrets in argv.


def main(argv=None):
    parser = SafeParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--prefix", help="New releases require an explicit releases/SAFE-ID mirror prefix")
    parser.add_argument("--out", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan-only", action="store_true")
    mode.add_argument("--upload", action="store_true")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    args = parser.parse_args(argv)
    try:
        require(args.upload or not (args.checkpoint or args.resume), "resume-requires-upload")
        require(not args.upload or args.checkpoint is not None, "upload-requires-checkpoint")
        plan = prepare(args.stage, args.prefix)
        output = destination(args.out, plan)
        verified = 0
        if args.upload:
            saved_path = destination(args.checkpoint, plan)
            require(saved_path != output, "checkpoint-cannot-be-manifest")
            state = checkpoint(plan, saved_path, args.resume)
            token = load_credentials()  # This is the ONLY real credential-read call site.
            with httpx.Client(headers={"Authorization": "Bearer " + token}, timeout=60,
                              follow_redirects=False, trust_env=False) as api, \
                 httpx.Client(timeout=60, follow_redirects=False, trust_env=False) as oss:
                del token
                remote = OpenI(api, oss, listing_limit=max(1000, len(plan.files) * 4))
                verified = upload(plan, remote, state, saved_path, resume=args.resume, workers=args.workers)
        atomic_json(output, plan.manifest)
        print(f"mode={'upload-ready' if args.upload else 'plan-only'} files={len(plan.files)} "
              f"bytes={sum(f.bytes for f in plan.files)} entries={len(plan.manifest['entries'])} "
              f"remote_metadata_verified={verified}")
        print(f"manifest={output}")
        return 0
    except ToolError as error:
        print("ERROR: " + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR: interrupted-use-matching-resume-checkpoint", file=sys.stderr)
        return 130
    except Exception:
        print("ERROR: operation-failed-no-sensitive-details", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
