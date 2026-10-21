"""Local gallery viewer for a folder of exported models.

``serve`` starts an HTTP server bound to localhost that serves the folder plus a single-page
viewer (``viewer.html``) and a JSON index built by ``build_index``. model-viewer is bundled in
``vendor/``, so the viewer works offline and nothing leaves the machine.

The page can also add, rename and delete models (``library.py``) through POST/PUT endpoints.
Those need the per-server token that is written into the page, and a localhost Host header, so
other web pages (including DNS-rebinding ones) cannot change the folder.
"""

import functools
import json
import os
import secrets
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

from . import library
from .exporter import MANIFEST_NAME
from .library import DATE_PREFIX, IMAGE_EXTENSIONS, MODEL_EXTENSIONS, PREVIEW_SUFFIX, VIEWABLE

INDEX_PATH = "/__viewer/models.json"
MODEL_VIEWER_PATH = "/__viewer/model-viewer.min.js"
UPLOAD_PATH = "/__viewer/upload"
THUMBNAIL_PATH = "/__viewer/thumbnail"
SCREENSHOT_PATH = "/__viewer/screenshot"
META_PATH = "/__viewer/meta"
STATS_PATH = "/__viewer/stats"
RENAME_PATH = "/__viewer/rename"
DELETE_PATH = "/__viewer/delete"
MOVE_PATH = "/__viewer/move"
TOKEN_HEADER = "X-Viewer-Token"
TOKEN_PLACEHOLDER = b"__VIEWER_TOKEN__"
MAX_UPLOAD_BYTES = 2 * 1024 ** 3


def _parse_stem(stem: str) -> Dict[str, Optional[str]]:
    """Split ``20251009-120000_<task_id>`` (the exporter's naming) into its parts."""
    match = DATE_PREFIX.match(stem)
    if not match:
        return {"key": stem, "created": None}
    created = datetime.strptime(match.group(1), "%Y%m%d-%H%M%S").isoformat()
    return {"key": match.group(2), "created": created}


def build_index(root: str) -> List[Dict[str, Any]]:
    """Describe every model under ``root``, one entry per task (or per file stem when unknown).

    Files written by ``tripo-export`` are matched to their manifest entry for the prompt and
    task ID; any other model files in the folder (e.g. downloaded by hand from Tripo Studio)
    are listed too.
    """
    manifest: Dict[str, Dict[str, Any]] = {}
    manifest_path = os.path.join(root, MANIFEST_NAME)
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as handle:
            for entry in json.load(handle).values():
                manifest[entry["file"]] = entry
    # Other formats of a recorded file share its stem, even after the model was renamed.
    stem_tasks = {os.path.splitext(name)[0]: entry["task_id"] for name, entry in manifest.items()}

    models: Dict[str, Dict[str, Any]] = {}
    previews: Dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or name.endswith(".part"):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            stem, ext = os.path.splitext(rel)
            ext = ext.lower()
            if ext in IMAGE_EXTENSIONS and stem.endswith(PREVIEW_SUFFIX):
                previews[stem[: -len(PREVIEW_SUFFIX)]] = rel
                continue
            if ext not in MODEL_EXTENSIONS:
                continue

            entry = manifest.get(rel, {})
            parsed = _parse_stem(os.path.basename(stem))
            key = entry.get("task_id") or stem_tasks.get(stem) or parsed["key"]
            stat = os.stat(path)
            item = models.setdefault(key, {
                "id": key,
                # Without a manifest, the exporter's "<date>_<task_id>" naming still names the task.
                "task_id": entry.get("task_id") or stem_tasks.get(stem) or (parsed["key"] if parsed["created"] else None),
                "title": parsed["key"],
                "prompt": None,
                "created": parsed["created"],
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "model": None,
                "preview": None,
                "files": [],
                "_stems": [],
            })
            item["_stems"].append(stem)
            item["prompt"] = item["prompt"] or entry.get("prompt")
            item["files"].append({"path": rel, "format": ext[1:].upper(), "size": stat.st_size})
            if ext in VIEWABLE and item["model"] is None:
                item["model"] = rel

    meta = library.read_meta(root)
    result = []
    for item in models.values():
        item["preview"] = next((previews[s] for s in item.pop("_stems") if s in previews), None)
        # The main file names the model for favorites and memos, and its folder is the filter.
        key = item["model"] or item["files"][0]["path"]
        item["key"] = key
        item["folder"] = key.rpartition("/")[0]
        item["favorite"] = bool((meta.get(key) or {}).get("favorite"))
        item["memo"] = (meta.get(key) or {}).get("memo") or ""
        result.append(item)
    result.sort(key=lambda m: m["created"] or m["modified"], reverse=True)
    return result


class _Handler(SimpleHTTPRequestHandler):
    """Serves ``server.root`` (which the desktop app can change at runtime) plus the viewer assets."""

    def __init__(self, request: Any, client_address: Any, server: "ViewerServer"):
        super().__init__(request, client_address, server, directory=server.root)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            page = _asset("viewer.html").replace(TOKEN_PLACEHOLDER, self.server.token.encode())
            self._send(page, "text/html; charset=utf-8")
        elif path == INDEX_PATH:
            body = json.dumps({"root": os.path.abspath(self.directory), "models": build_index(self.directory)},
                              ensure_ascii=False).encode("utf-8")
            self._send(body, "application/json; charset=utf-8")
        elif path == MODEL_VIEWER_PATH:
            self._send(_asset("vendor/model-viewer.min.js"), "text/javascript; charset=utf-8", cache=True)
        elif path == STATS_PATH:
            model = (parse_qs(urlsplit(self.path).query).get("model") or [""])[0]
            try:
                result, status = library.glb_stats(self.directory, model), 200
            except (ValueError, OSError) as exc:
                result, status = {"error": str(exc)}, 400
            self._send(json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8",
                       status=status)
        else:
            super().do_GET()

    def do_PUT(self) -> None:
        def upload() -> Dict[str, Any]:
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            length = int(self.headers.get("Content-Length") or 0)
            if url.path == THUMBNAIL_PATH:
                model = (query.get("model") or [""])[0]
                return {"path": library.save_preview(self.directory, model, self.rfile, length)}
            if url.path == SCREENSHOT_PATH:
                name = (query.get("name") or [""])[0]
                return {"path": library.save_screenshot(self.directory, name, self.rfile, length)}
            if url.path != UPLOAD_PATH:
                raise LookupError(self.path)
            if not 0 < length <= MAX_UPLOAD_BYTES:
                raise ValueError("ファイルが空か、大きすぎます")
            name = (query.get("name") or [""])[0]
            return {"path": library.add_file(self.directory, name, self.rfile, length)}

        self._change(upload)

    def do_POST(self) -> None:
        def change() -> Dict[str, Any]:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            files = [str(f) for f in body.get("files") or []]
            path = urlsplit(self.path).path
            if path == RENAME_PATH:
                return {"renamed": library.rename_model(self.directory, files, str(body.get("name") or ""))}
            if path == DELETE_PATH:
                return {"moved_to": library.delete_model(self.directory, files)}
            if path == MOVE_PATH:
                return {"moved": library.move_model(self.directory, files, str(body.get("folder") or ""))}
            if path == META_PATH:
                return library.set_meta(self.directory, str(body.get("key") or ""),
                                        favorite=body.get("favorite"), memo=body.get("memo"))
            raise LookupError(path)

        self._change(change)

    def _change(self, action: Callable[[], Dict[str, Any]]) -> None:
        """Run a request that changes the folder, after checking it came from the viewer page."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost") or not secrets.compare_digest(
                self.headers.get(TOKEN_HEADER) or "", self.server.token):
            self._send(b'{"error": "forbidden"}', "application/json", status=403)
            return
        try:
            result, status = action(), 200
        except LookupError:
            result, status = {"error": "not found"}, 404
        except (ValueError, OSError) as exc:
            result, status = {"error": str(exc)}, 400
        self._send(json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8",
                   status=status)

    def _send(self, body: bytes, content_type: str, cache: bool = False, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


SimpleHTTPRequestHandler.extensions_map.update({".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
                                                ".webp": "image/webp", ".usdz": "model/vnd.usdz+zip"})


@functools.lru_cache(maxsize=None)
def _asset(name: str) -> bytes:
    with open(os.path.join(os.path.dirname(__file__), name), "rb") as handle:
        return handle.read()


class ViewerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: str, port: int):
        self.root = root
        self.token = secrets.token_urlsafe(24)
        super().__init__(("127.0.0.1", port), _Handler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}/"


def make_server(root: str, port: int = 8765) -> ViewerServer:
    """Create (but do not start) the viewer server; port 0 picks a free port."""
    try:
        return ViewerServer(root, port)
    except OSError:
        if port == 0:
            raise
        return ViewerServer(root, 0)  # requested port is busy


def serve(root: str, port: int = 8765, open_browser: bool = True) -> None:
    if not os.path.isdir(root):
        raise FileNotFoundError(f"folder not found: {root}")
    server = make_server(root, port)
    url = server.url
    print(f"Viewer for {os.path.abspath(root)}")
    print(f"Open {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
