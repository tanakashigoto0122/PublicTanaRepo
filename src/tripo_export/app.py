"""Desktop app (Windows first): the gallery viewer in a native window, plus export and generation.

The window is pywebview (Edge WebView2 on Windows) pointed at the same local server that
``tripo-export view`` uses. ``viewer.html`` notices ``window.pywebview`` and shows the app
toolbar, which calls the public methods of ``AppApi``. Long jobs run on a worker thread and the
page polls ``get_job`` for progress.
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import traceback
from typing import Any, Callable, Dict, List, Optional

from . import __version__, library
from .exporter import FORMATS, export_all, generate
from .viewer import ViewerServer, make_server

APP_NAME = "Tripo Model Manager"
KEYRING_SERVICE = "tripo-model-manager"
KEYRING_USER = "api-key"
DEFAULT_MODEL_VERSION = "v3.1-20260211"
IMAGE_TYPES = ("画像ファイル (*.png;*.jpg;*.jpeg;*.webp)",)


def config_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "TripoModelManager")


def default_folder() -> str:
    return os.path.join(os.path.expanduser("~"), "Documents", "TripoModels")


class Settings:
    """Non-secret settings in ``settings.json``; the API key goes to the OS keychain
    (Windows Credential Manager) via keyring."""

    def __init__(self, directory: str):
        self.path = os.path.join(directory, "settings.json")
        self.values: Dict[str, Any] = {"folder": default_folder(), "china": False,
                                       "model_version": DEFAULT_MODEL_VERSION}
        try:
            with open(self.path, encoding="utf-8") as handle:
                self.values.update(json.load(handle))
        except (OSError, ValueError):
            pass
        self._session_key: Optional[str] = None

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(self.values, handle, ensure_ascii=False, indent=2)

    def api_key(self) -> Optional[str]:
        if self._session_key:
            return self._session_key
        try:
            import keyring
            key = keyring.get_password(KEYRING_SERVICE, KEYRING_USER)
        except Exception:
            key = None
        return key or os.environ.get("TRIPO_API_KEY")

    def set_api_key(self, key: str) -> bool:
        """Store the key; returns False when no keychain is available (kept for this session only)."""
        self._session_key = key
        try:
            import keyring
            if key:
                keyring.set_password(KEYRING_SERVICE, KEYRING_USER, key)
            else:
                keyring.delete_password(KEYRING_SERVICE, KEYRING_USER)
            self._session_key = None
            return True
        except Exception:
            return False


class Job:
    """State of the one background job (export or generation) the app runs at a time."""

    def __init__(self, kind: str):
        self.kind = kind
        self.running = True
        self.done = 0
        self.total = 0
        self.log: List[str] = []
        self.result: Optional[str] = None
        self.error: Optional[str] = None

    def snapshot(self) -> Dict[str, Any]:
        return {"kind": self.kind, "running": self.running, "done": self.done, "total": self.total,
                "log": self.log[-200:], "result": self.result, "error": self.error}


NO_HISTORY_TEXT = ("API の生成履歴にモデルがありませんでした。Tripo Studio（Web 版）で作ったモデルは API からは"
                   "見えないので、Studio でダウンロードした GLB をこのフォルダに入れると一覧に表示されます")


def _error_text(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    if "Invalid API key" in text:
        return "API キーが正しくありません。platform.tripo3d.ai で発行したキー（tsk_ で始まる）を設定してください"
    return text


class AppApi:
    """Methods exposed to the page as ``window.pywebview.api.*``.

    pywebview exposes every public attribute, so internal state is kept in underscored names.
    """

    def __init__(self, server: ViewerServer, settings: Settings,
                 client_factory: Optional[Callable[[str, bool], Any]] = None):
        self._server = server
        self._settings = settings
        self._client_factory = client_factory or _make_client
        self._window: Any = None
        self._job: Optional[Job] = None
        self._lock = threading.Lock()

    # -- state and settings -------------------------------------------------

    def get_state(self) -> Dict[str, Any]:
        return {"folder": self._server.root, "has_key": bool(self._settings.api_key()),
                "china": bool(self._settings.values.get("china")),
                "model_version": self._settings.values.get("model_version") or DEFAULT_MODEL_VERSION,
                "formats": list(FORMATS), "version": __version__}

    def save_settings(self, values: Dict[str, Any]) -> Dict[str, Any]:
        stored = True
        if values.get("api_key") is not None:
            key = values["api_key"].strip()
            if key and not key.startswith("tsk_"):
                return {"error": "API キーは tsk_ で始まる文字列です"}
            stored = self._settings.set_api_key(key)
        for name in ("china", "model_version"):
            if name in values:
                self._settings.values[name] = values[name]
        self._settings.save()
        state = self.get_state()
        if not stored:
            state["warning"] = "キーを Windows に保存できなかったため、このアプリを閉じるまでだけ有効です"
        return state

    def get_balance(self) -> Dict[str, Any]:
        try:
            balance = self._run(self._with_client(lambda client: client.get_balance()))
        except Exception as exc:
            return {"error": _error_text(exc)}
        return {"balance": balance.balance, "frozen": balance.frozen}

    # -- files and folders --------------------------------------------------

    def choose_folder(self) -> Optional[str]:
        import webview

        picked = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._server.root)
        if not picked:
            return None
        return self.set_folder(picked[0] if isinstance(picked, (list, tuple)) else picked)

    def set_folder(self, folder: str) -> str:
        os.makedirs(folder, exist_ok=True)
        self._server.root = folder
        self._settings.values["folder"] = folder
        self._settings.save()
        return folder

    def pick_image(self) -> Optional[str]:
        import webview

        picked = self._window.create_file_dialog(webview.FileDialog.OPEN, file_types=IMAGE_TYPES)
        if not picked:
            return None
        return picked[0] if isinstance(picked, (list, tuple)) else picked

    def open_folder(self) -> None:
        _reveal(self._server.root)

    def reveal(self, rel_path: str) -> None:
        root = os.path.abspath(self._server.root)
        path = os.path.abspath(os.path.join(root, rel_path))
        if os.path.commonpath([root, path]) == root and os.path.exists(path):
            _reveal(path, select=True)

    def list_downloads(self) -> Dict[str, Any]:
        """Model files in the Downloads folder (e.g. saved from Tripo Studio), for importing."""
        source = library.downloads_dir()
        return {"source": source, "files": library.list_importable(source, self._server.root)}

    def import_downloads(self, names: List[str], move: bool = False) -> Dict[str, Any]:
        added, errors = library.import_files(library.downloads_dir(), list(names), self._server.root, move=bool(move))
        return {"added": added, "errors": errors}

    # -- background jobs ----------------------------------------------------

    def get_job(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._job.snapshot() if self._job else None

    def start_export(self, options: Dict[str, Any]) -> Dict[str, Any]:
        fmt = str(options.get("format") or "GLB").upper()
        folder = self._server.root

        async def work(client: Any, job: Job) -> str:
            def progress(done: int, total: int) -> None:
                job.done, job.total = done, total

            summary = await export_all(client, folder, fmt=fmt, with_preview=bool(options.get("preview")),
                                       log=job.log.append, progress=progress)
            if not (summary.exported or summary.skipped or summary.no_model or summary.failed):
                return NO_HISTORY_TEXT
            text = f"保存 {len(summary.exported)} 件 / 保存済みのためスキップ {len(summary.skipped)} 件"
            if summary.no_model:
                text += f" / モデルなし {len(summary.no_model)} 件"
            if summary.failed:
                text += f" / 失敗 {len(summary.failed)} 件"
                job.log.extend(f"失敗 {task_id}: {reason}" for task_id, reason in summary.failed.items())
            return text

        return self._start("export", work)

    def start_generate(self, options: Dict[str, Any]) -> Dict[str, Any]:
        prompt = (options.get("prompt") or "").strip() or None
        image = options.get("image") or None
        if options.get("source") == "image":
            prompt = None
            if not image:
                return {"error": "画像を選んでください"}
        else:
            image = None
            if not prompt:
                return {"error": "プロンプトを入力してください"}
        extra: Dict[str, Any] = {}
        if options.get("face_limit"):
            extra["face_limit"] = int(options["face_limit"])
        if options.get("detailed"):
            extra["texture_quality"] = "detailed"
            extra["geometry_quality"] = "detailed"
        if options.get("no_texture"):
            extra["texture"] = False
            extra["pbr"] = False
        model_version = options.get("model_version") or DEFAULT_MODEL_VERSION
        self._settings.values["model_version"] = model_version
        self._settings.save()
        folder = self._server.root

        async def work(client: Any, job: Job) -> str:
            name = await generate(client, folder, prompt=prompt, image=image, model_version=model_version,
                                  fmt=str(options.get("format") or "GLB").upper(),
                                  with_preview=bool(options.get("preview")), options=extra, log=job.log.append)
            return f"保存しました: {name}"

        return self._start("generate", work)

    def _start(self, kind: str, work: Callable[[Any, Job], Any]) -> Dict[str, Any]:
        if not self._settings.api_key():
            return {"error": "先に設定で API キーを入力してください"}
        with self._lock:
            if self._job and self._job.running:
                return {"error": "別の処理が実行中です"}
            job = self._job = Job(kind)

        def run() -> None:
            try:
                job.result = self._run(self._with_client(lambda client: work(client, job)))
            except Exception as exc:
                job.error = _error_text(exc)
                job.log.append(traceback.format_exc(limit=3))
            finally:
                job.running = False

        threading.Thread(target=run, name=f"tripo-{kind}", daemon=True).start()
        return {"ok": True}

    async def _with_client(self, use: Callable[[Any], Any]) -> Any:
        key = self._settings.api_key()
        if not key:
            raise RuntimeError("API キーが設定されていません")
        client = self._client_factory(key, bool(self._settings.values.get("china")))
        try:
            return await use(client)
        finally:
            await client.close()

    @staticmethod
    def _run(coro: Any) -> Any:
        return asyncio.run(coro)


def _make_client(api_key: str, china: bool) -> Any:
    from tripo3d import TripoClient

    return TripoClient(api_key=api_key, IS_GLOBAL=not china)


def _reveal(path: str, select: bool = False) -> None:
    if sys.platform == "win32":
        if select:
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path] if select else ["open", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path) if select else path])


def self_test(report_path: Optional[str]) -> int:
    """Check that a packaged build has everything it needs, without opening a window.

    A windowed .exe has no console, so the result is written to ``report_path``.
    """
    import tempfile
    import urllib.request

    lines = []
    status = 0
    try:
        import keyring  # noqa: F401
        import tripo3d
        import webview  # noqa: F401
        lines.append(f"tripo3d {getattr(tripo3d, '__version__', '?')}, webview ok, keyring ok")
        from .convert import gltfpack_path
        if not gltfpack_path():
            raise RuntimeError("gltfpack is not bundled")
        lines.append("gltfpack ok")
        with tempfile.TemporaryDirectory() as folder:
            server = make_server(folder, port=0)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                for path in ("", "__viewer/models.json", "__viewer/model-viewer.min.js"):
                    with urllib.request.urlopen(server.url + path) as res:
                        lines.append(f"GET /{path} -> {res.status}, {len(res.read())} bytes")
            finally:
                server.shutdown()
                server.server_close()
        lines.append("OK")
    except Exception:
        lines.append(traceback.format_exc())
        status = 1
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
    else:
        print("\n".join(lines))
    return status


def main(argv: Optional[List[str]] = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    # A windowed (no console) build has no stdout/stderr; the SDK prints progress, so give it somewhere to go.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")
    if argv and argv[0] == "--self-test":
        sys.exit(self_test(argv[1] if len(argv) > 1 else None))

    import webview

    settings = Settings(config_dir())
    folder = settings.values.get("folder") or default_folder()
    os.makedirs(folder, exist_ok=True)
    server = make_server(folder, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    api = AppApi(server, settings)
    window = webview.create_window(APP_NAME, server.url + "?app=1", js_api=api,
                                   width=1280, height=860, min_size=(720, 520))
    api._window = window

    smoke_report = argv[1] if argv[:1] == ["--smoke-window"] and len(argv) > 1 else None
    func = None
    if smoke_report:
        # CI check: open the real window, wait for the page to wire up the app toolbar, then quit.
        def func() -> None:
            import time

            result = "timeout"
            for _ in range(60):
                time.sleep(1)
                try:
                    ready = window.evaluate_js("document.body.classList.contains('app') && !!window.pywebview")
                except Exception as exc:
                    result = f"error: {exc}"
                    continue
                if ready:
                    result = "OK"
                    break
            with open(smoke_report, "w", encoding="utf-8") as handle:
                handle.write(result + "\n")
            window.destroy()

    webview.start(func, private_mode=False, storage_path=os.path.join(config_dir(), "webview"))
    server.shutdown()


if __name__ == "__main__":
    main()
