"""Local gallery viewer for a folder of exported models.

``serve`` starts an HTTP server bound to localhost that serves the folder plus a single-page
viewer (``viewer.html``) and a JSON index built by ``build_index``. Nothing leaves the machine
except the model-viewer script, which the page loads from a CDN.
"""

import functools
import json
import os
import re
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

from .exporter import MANIFEST_NAME

INDEX_PATH = "/__viewer/models.json"
# model-viewer renders glTF only; other formats are offered as downloads on the same card.
VIEWABLE = (".glb", ".gltf")
MODEL_EXTENSIONS = VIEWABLE + (".fbx", ".obj", ".stl", ".3mf", ".usdz")
IMAGE_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg")
PREVIEW_SUFFIX = "_preview"
_DATE_PREFIX = re.compile(r"^(\d{8}-\d{6})_(.+)$")


def _parse_stem(stem: str) -> Dict[str, Optional[str]]:
    """Split ``20251009-120000_<task_id>`` (the exporter's naming) into its parts."""
    match = _DATE_PREFIX.match(stem)
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
            key = entry.get("task_id") or parsed["key"]
            stat = os.stat(path)
            item = models.setdefault(key, {
                "id": key,
                "task_id": entry.get("task_id"),
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

    result = []
    for item in models.values():
        item["preview"] = next((previews[s] for s in item.pop("_stems") if s in previews), None)
        result.append(item)
    result.sort(key=lambda m: m["created"] or m["modified"], reverse=True)
    return result


class _Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, page: bytes, **kwargs: Any):
        self._page = page
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send(self._page, "text/html; charset=utf-8")
        elif path == INDEX_PATH:
            body = json.dumps({"root": os.path.abspath(self.directory), "models": build_index(self.directory)},
                              ensure_ascii=False).encode("utf-8")
            self._send(body, "application/json; charset=utf-8")
        else:
            super().do_GET()

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


SimpleHTTPRequestHandler.extensions_map.update({".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
                                                ".webp": "image/webp", ".usdz": "model/vnd.usdz+zip"})


def make_server(root: str, port: int = 8765) -> ThreadingHTTPServer:
    """Create (but do not start) the viewer server; port 0 picks a free port."""
    page_path = os.path.join(os.path.dirname(__file__), "viewer.html")
    with open(page_path, "rb") as handle:
        page = handle.read()
    handler = functools.partial(_Handler, directory=root, page=page)
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        if port == 0:
            raise
        return ThreadingHTTPServer(("127.0.0.1", 0), handler)  # requested port is busy


def serve(root: str, port: int = 8765, open_browser: bool = True) -> None:
    if not os.path.isdir(root):
        raise FileNotFoundError(f"folder not found: {root}")
    server = make_server(root, port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Viewer for {os.path.abspath(root)}")
    print(f"Open {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
