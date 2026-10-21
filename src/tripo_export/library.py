"""Changing the model folder: adding, renaming, deleting and importing model files.

The viewer server and the desktop app call these. Every path the page sends is relative to the
folder and is checked to stay inside it.
"""

import json
import os
import re
import shutil
import sys
from typing import Any, BinaryIO, Dict, List, Tuple

from .exporter import MANIFEST_NAME

# model-viewer renders glTF only; other formats are offered as downloads on the same card.
VIEWABLE = (".glb", ".gltf")
MODEL_EXTENSIONS = VIEWABLE + (".fbx", ".obj", ".stl", ".3mf", ".usdz")
IMAGE_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg")
PREVIEW_SUFFIX = "_preview"
DATE_PREFIX = re.compile(r"^(\d{8}-\d{6})_(.+)$")
TRASH_DIR = ".trash"
# Characters Windows does not allow in file names, plus control characters.
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_COPY_CHUNK = 1024 * 1024


def safe_path(root: str, rel: str) -> str:
    """Absolute path of ``rel`` inside ``root``; ValueError if it points anywhere else."""
    root = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root, rel))
    if not rel or os.path.commonpath([root, path]) != root or path == root:
        raise ValueError(f"not inside the folder: {rel}")
    return path


def _rel(root: str, path: str) -> str:
    return os.path.relpath(path, os.path.abspath(root)).replace(os.sep, "/")


def check_name(name: str) -> str:
    """Return ``name`` stripped, or raise ValueError when it cannot be a file name."""
    name = (name or "").strip()
    if not name or name.startswith(".") or name.endswith(".") or _BAD_NAME.search(name):
        raise ValueError('名前に使えない文字があります（\\ / : * ? " < > | や先頭・末尾の . は使えません）')
    return name


def unique_path(path: str) -> str:
    """``path``, or ``name (2).ext``, ``name (3).ext``... when it is taken."""
    stem, ext = os.path.splitext(path)
    candidate, n = path, 2
    while os.path.exists(candidate):
        candidate, n = f"{stem} ({n}){ext}", n + 1
    return candidate


def is_model_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in MODEL_EXTENSIONS


def add_file(root: str, name: str, stream: BinaryIO, length: int) -> str:
    """Save ``length`` bytes from ``stream`` as a new model file at the top of ``root``.

    The name is made unique rather than overwriting. Returns the new file's relative path.
    """
    name = check_name(os.path.basename(name.replace("\\", "/")))
    if not is_model_file(name):
        raise ValueError(f"モデルファイルではありません: {name}（対応: {', '.join(e[1:].upper() for e in MODEL_EXTENSIONS)}）")
    path = unique_path(safe_path(root, name))
    part = path + ".part"
    try:
        with open(part, "wb") as handle:
            remaining = length
            while remaining > 0:
                chunk = stream.read(min(_COPY_CHUNK, remaining))
                if not chunk:
                    raise ValueError("upload ended early")
                handle.write(chunk)
                remaining -= len(chunk)
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return _rel(root, path)


def _update_manifest(root: str, renames: Dict[str, str]) -> None:
    """Point manifest entries at renamed files, so a later export still skips them."""
    path = os.path.join(root, MANIFEST_NAME)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as handle:
        entries = json.load(handle)
    changed = False
    for entry in entries.values():
        if entry.get("file") in renames:
            entry["file"] = renames[entry["file"]]
            changed = True
    if changed:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)


def rename_model(root: str, files: List[str], new_name: str) -> Dict[str, str]:
    """Give every file of one model (all formats and the preview) the stem ``new_name``.

    A ``<date>_`` prefix from the exporter is kept so the model keeps its creation date.
    Returns ``{old relative path: new relative path}``.
    """
    new_name = check_name(new_name)
    plan = {}
    for rel in files:
        path = safe_path(root, rel)
        folder, base = os.path.split(path)
        stem, ext = os.path.splitext(base)
        suffix = ""
        if ext.lower() in IMAGE_EXTENSIONS and stem.endswith(PREVIEW_SUFFIX):
            stem, suffix = stem[: -len(PREVIEW_SUFFIX)], PREVIEW_SUFFIX
        match = DATE_PREFIX.match(stem)
        prefix = match.group(1) + "_" if match else ""
        target = os.path.join(folder, prefix + new_name + suffix + ext)
        if not os.path.exists(path):
            raise ValueError(f"ファイルが見つかりません: {rel}")
        if os.path.normcase(target) != os.path.normcase(path) and os.path.exists(target):
            raise ValueError(f"同じ名前のファイルがあります: {_rel(root, target)}")
        plan[path] = target
    if len(set(map(os.path.normcase, plan.values()))) != len(plan):
        raise ValueError("ファイル名が重なります")
    renames = {}
    for path, target in plan.items():
        os.replace(path, target)
        renames[_rel(root, path)] = _rel(root, target)
    _update_manifest(root, renames)
    return renames


def _recycle_windows(paths: List[str]) -> None:
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    FO_DELETE = 3
    # Undo-able (Recycle Bin), no "are you sure", but still warn before anything would be destroyed
    # outright (e.g. a drive without a Recycle Bin): FOF_WANTNUKEWARNING overrides FOF_NOCONFIRMATION there.
    flags = 0x0040 | 0x0010 | 0x0004 | 0x4000  # ALLOWUNDO | NOCONFIRMATION | SILENT | WANTNUKEWARNING
    buffer = ctypes.create_unicode_buffer("\0".join(paths) + "\0\0")
    op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom=ctypes.cast(buffer, wintypes.LPCWSTR), fFlags=flags)
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result or op.fAnyOperationsAborted:
        raise OSError(f"ごみ箱に移動できませんでした (code {result})")


def delete_model(root: str, files: List[str]) -> str:
    """Move the files of one model to the Recycle Bin (Windows) or ``<root>/.trash``.

    Returns where they went, for the message shown to the user.
    """
    paths = [safe_path(root, rel) for rel in files]
    paths = [p for p in paths if os.path.exists(p)]
    if not paths:
        raise ValueError("削除するファイルがありません")
    if sys.platform == "win32":
        _recycle_windows(paths)
        return "ごみ箱"
    trash = os.path.join(os.path.abspath(root), TRASH_DIR)
    os.makedirs(trash, exist_ok=True)
    for path in paths:
        os.replace(path, unique_path(os.path.join(trash, os.path.basename(path))))
    return TRASH_DIR


def downloads_dir() -> str:
    """The user's Downloads folder (wherever Windows has it), or ``~/Downloads``."""
    if sys.platform == "win32":
        try:
            import ctypes
            import uuid
            from ctypes import wintypes

            folder_id = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B")  # FOLDERID_Downloads
            guid = (ctypes.c_byte * 16).from_buffer_copy(folder_id.bytes_le)
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) == 0:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                if path:
                    return path
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def list_importable(source: str, root: str) -> List[Dict[str, Any]]:
    """Model files directly in ``source``, newest first, flagging ones ``root`` already has.

    "Already has" means a file with the same name and size anywhere in ``root``.
    """
    have = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if is_model_file(name):
                have.add((name.lower(), os.path.getsize(os.path.join(dirpath, name))))
    items = []
    try:
        names = os.listdir(source)
    except OSError:
        return []
    for name in names:
        path = os.path.join(source, name)
        if not (is_model_file(name) and os.path.isfile(path)):
            continue
        stat = os.stat(path)
        items.append({"name": name, "size": stat.st_size, "modified": stat.st_mtime,
                      "imported": (name.lower(), stat.st_size) in have})
    items.sort(key=lambda item: item["modified"], reverse=True)
    return items


def import_files(source: str, names: List[str], root: str, move: bool = False) -> Tuple[List[str], Dict[str, str]]:
    """Copy (or move) the named files from ``source`` into the top of ``root``.

    Returns the new relative paths and ``{name: error}`` for files that could not be imported;
    one bad file does not stop the others.
    """
    added: List[str] = []
    errors: Dict[str, str] = {}
    for name in names:
        try:
            if os.path.basename(name) != name or not is_model_file(name):
                raise ValueError("モデルファイルではありません")
            target = unique_path(safe_path(root, name))
            (shutil.move if move else shutil.copy2)(os.path.join(source, name), target)
            added.append(_rel(root, target))
        except (ValueError, OSError) as exc:
            errors[name] = str(exc) or type(exc).__name__
    return added, errors
