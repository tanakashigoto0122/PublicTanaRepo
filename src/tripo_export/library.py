"""Changing the model folder: adding, renaming, deleting and importing model files.

The viewer server and the desktop app call these. Every path the page sends is relative to the
folder and is checked to stay inside it.
"""

import base64
import hashlib
import io
import json
import os
import re
import shutil
import struct
import sys
import zipfile
from datetime import datetime
from typing import Any, BinaryIO, Dict, List, Optional, Tuple

from .exporter import MANIFEST_NAME

# model-viewer renders glTF only; other formats are offered as downloads on the same card.
VIEWABLE = (".glb", ".gltf")
MODEL_EXTENSIONS = VIEWABLE + (".fbx", ".obj", ".stl", ".3mf", ".usdz")
IMAGE_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg")
PREVIEW_SUFFIX = "_preview"
DATE_PREFIX = re.compile(r"^(\d{8}-\d{6})_(.+)$")
TRASH_DIR = ".trash"
# Favorites and memos, keyed by each model's main file (relative path). A dot file, so the
# folder can move between PCs with it and the index skips it.
META_NAME = ".tripo-viewer.json"
SCREENSHOT_DIR = "screenshots"
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

    The name is made unique rather than overwriting. A .zip is unpacked into a new folder
    instead (see ``extract_zip``). Returns the new file's (or folder's) relative path.
    """
    name = check_name(os.path.basename(name.replace("\\", "/")))
    if is_zip(name):
        temp = os.path.join(os.path.abspath(root), f".upload-{os.getpid()}-{id(stream)}.zip")
        try:
            _write(temp, stream, length)
            return extract_zip(temp, root, name)
        finally:
            if os.path.exists(temp):
                os.remove(temp)
    if not is_model_file(name):
        raise ValueError(f"モデルファイルではありません: {name}（対応: {', '.join(e[1:].upper() for e in MODEL_EXTENSIONS)}）")
    path = unique_path(safe_path(root, name))
    _write(path, stream, length)
    return _rel(root, path)


def _write(path: str, stream: BinaryIO, length: int) -> None:
    # Through a temporary name, so a cut-off upload never leaves a file that looks complete.
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


MAX_PREVIEW_BYTES = 20 * 1024 * 1024


def save_preview(root: str, model: str, stream: BinaryIO, length: int) -> str:
    """Save a WebP image as the thumbnail of ``model`` (``<stem>_preview.webp``, replacing one there).

    Returns the image's relative path.
    """
    path = safe_path(root, model)
    if not (is_model_file(model) and os.path.isfile(path)):
        raise ValueError(f"モデルが見つかりません: {model}")
    if not 12 <= length <= MAX_PREVIEW_BYTES:
        raise ValueError("画像が空か、大きすぎます")
    data = stream.read(length)
    if len(data) != length or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("WebP 画像ではありません")
    target = os.path.splitext(path)[0] + PREVIEW_SUFFIX + ".webp"
    _write(target, io.BytesIO(data), length)
    return _rel(root, target)


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
        _write_json(path, entries)


def _write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, path)


def read_meta(root: str) -> Dict[str, Dict[str, Any]]:
    """``{main file: {"favorite": bool, "memo": str, "tags": [str]}}``; empty when there is no or a broken file."""
    try:
        with open(os.path.join(root, META_NAME), encoding="utf-8") as handle:
            data = json.load(handle).get("models")
    except (OSError, ValueError, AttributeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_meta(root: str, meta: Dict[str, Dict[str, Any]]) -> None:
    _write_json(os.path.join(root, META_NAME), {"models": {k: v for k, v in meta.items() if v}})


MAX_TAG_LENGTH = 30


def clean_tags(tags: Any) -> List[str]:
    """Tags stripped, without empties or repeats (case-insensitive), each at most 30 characters."""
    seen, result = set(), []
    for tag in tags if isinstance(tags, list) else []:
        tag = str(tag).strip()[:MAX_TAG_LENGTH]
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            result.append(tag)
    return result


def set_meta(root: str, key: str, favorite: Optional[bool] = None, memo: Optional[str] = None,
             tags: Optional[List[str]] = None) -> Dict[str, Any]:
    """Set the favorite flag, memo and/or tags of the model whose main file is ``key``."""
    if not os.path.isfile(safe_path(root, key)):
        raise ValueError(f"モデルが見つかりません: {key}")
    meta = read_meta(root)
    entry = dict(meta.get(key) or {})
    if favorite is not None:
        entry["favorite"] = bool(favorite)
    if memo is not None:
        entry["memo"] = str(memo).strip()
    if tags is not None:
        entry["tags"] = clean_tags(tags)
    entry = {k: v for k, v in entry.items() if v}
    meta[key] = entry
    _save_meta(root, meta)
    return entry


def _move_meta(root: str, renames: Dict[str, Optional[str]]) -> None:
    """Follow renamed files (or drop deleted ones, mapped to None) in the meta file."""
    meta = read_meta(root)
    if not any(key in meta for key in renames):
        return
    for old, new in renames.items():
        if old in meta:
            entry = meta.pop(old)
            if new:
                meta[new] = entry
    _save_meta(root, meta)


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
    _move_meta(root, dict(renames))
    return renames


def move_model(root: str, files: List[str], folder: str) -> Dict[str, str]:
    """Move every file of one model into ``folder`` (relative to ``root``; "" is the top).

    The folder is created when missing. Refuses when a file of that name is already there, so
    a model's formats and preview stay together. Returns ``{old: new}`` relative paths.
    """
    parts = [check_name(part) for part in folder.replace("\\", "/").split("/") if part.strip()]
    target_dir = safe_path(root, "/".join(parts)) if parts else os.path.abspath(root)
    plan = {}
    for rel in files:
        path = safe_path(root, rel)
        if not os.path.exists(path):
            raise ValueError(f"ファイルが見つかりません: {rel}")
        target = os.path.join(target_dir, os.path.basename(path))
        if os.path.normcase(target) != os.path.normcase(path) and os.path.exists(target):
            raise ValueError(f"移動先に同じ名前のファイルがあります: {_rel(root, target)}")
        plan[path] = target
    os.makedirs(target_dir, exist_ok=True)
    moves = {}
    for path, target in plan.items():
        if os.path.normcase(target) != os.path.normcase(path):
            os.replace(path, target)
            moves[_rel(root, path)] = _rel(root, target)
    _update_manifest(root, moves)
    _move_meta(root, dict(moves))
    return moves


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
        where = "ごみ箱"
    else:
        trash = os.path.join(os.path.abspath(root), TRASH_DIR)
        os.makedirs(trash, exist_ok=True)
        for path in paths:
            os.replace(path, unique_path(os.path.join(trash, os.path.basename(path))))
        where = TRASH_DIR
    _move_meta(root, {_rel(root, p): None for p in paths})
    return where


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


MAX_ZIP_BYTES = 2 * 1024 ** 3


def is_zip(name: str) -> bool:
    return name.lower().endswith(".zip")


def zip_model_count(path: str) -> int:
    """How many model files a .zip holds (0 when it is not a readable zip)."""
    try:
        with zipfile.ZipFile(path) as archive:
            return sum(1 for n in archive.namelist() if is_model_file(n) and not n.startswith("__MACOSX/"))
    except (OSError, zipfile.BadZipFile):
        return 0


def extract_zip(zip_path: str, root: str, name: str) -> str:
    """Unpack a .zip holding models (with their textures) into a new folder ``root/<zip name>``.

    Every member must stay inside that folder; macOS metadata is skipped. Returns the folder's
    relative path.
    """
    stem = check_name(os.path.splitext(os.path.basename(name))[0] or "zip")
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise ValueError(f"zip ファイルとして読めません: {name}")
    with archive:
        members = [m for m in archive.infolist()
                   if not m.is_dir() and not m.filename.startswith("__MACOSX/")
                   and not os.path.basename(m.filename).startswith(".")]
        if not any(is_model_file(m.filename) for m in members):
            raise ValueError(f"zip の中にモデルファイルがありません: {name}")
        if sum(m.file_size for m in members) > MAX_ZIP_BYTES:
            raise ValueError(f"zip の中身が大きすぎます: {name}")
        folder = unique_path(safe_path(root, stem))
        # Check every member before writing anything, so a refused zip leaves nothing behind.
        targets = [(member, safe_path(folder, member.filename)) for member in members]
        os.makedirs(folder)
        for member, target in targets:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, _COPY_CHUNK)
    return _rel(root, folder)


def list_importable(source: str, root: str) -> List[Dict[str, Any]]:
    """Model files (and .zip files holding models) directly in ``source``, newest first.

    Each is flagged when ``root`` already has it: a model file with the same name and size
    anywhere in ``root``, or for a zip, a folder named after it at the top of ``root``.
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
        if not os.path.isfile(path):
            continue
        if is_zip(name):
            models = zip_model_count(path)
            if not models:
                continue
            imported = os.path.isdir(os.path.join(root, os.path.splitext(name)[0]))
        elif is_model_file(name):
            models, imported = 1, (name.lower(), os.path.getsize(path)) in have
        else:
            continue
        stat = os.stat(path)
        items.append({"name": name, "size": stat.st_size, "modified": stat.st_mtime,
                      "imported": imported, "models": models, "zip": is_zip(name)})
    items.sort(key=lambda item: item["modified"], reverse=True)
    return items


def import_files(source: str, names: List[str], root: str, move: bool = False) -> Tuple[List[str], Dict[str, str]]:
    """Copy (or move) the named files from ``source`` into the top of ``root``.

    A .zip is unpacked into its own folder (and deleted afterwards when moving). Returns the new
    relative paths and ``{name: error}`` for files that could not be imported; one bad file
    does not stop the others.
    """
    added: List[str] = []
    errors: Dict[str, str] = {}
    for name in names:
        try:
            if os.path.basename(name) != name or not (is_model_file(name) or is_zip(name)):
                raise ValueError("モデルファイルではありません")
            src = os.path.join(source, name)
            if is_zip(name):
                added.append(extract_zip(src, root, name))
                if move:
                    os.remove(src)
                continue
            target = unique_path(safe_path(root, name))
            (shutil.move if move else shutil.copy2)(src, target)
            added.append(_rel(root, target))
        except (ValueError, OSError) as exc:
            errors[name] = str(exc) or type(exc).__name__
    return added, errors


_GLB_MAGIC = 0x46546C67
_GLB_JSON_CHUNK = 0x4E4F534A
_TRIANGLES = 4


def _gltf_json(path: str) -> Dict[str, Any]:
    """The JSON part of a .glb (only the header and JSON chunk are read) or a whole .gltf."""
    with open(path, "rb") as handle:
        if path.lower().endswith(".gltf"):
            return json.load(handle)
        header = handle.read(20)
        if len(header) < 20:
            raise ValueError("GLB ファイルが短すぎます")
        magic, _version, _length, chunk_length, chunk_type = struct.unpack("<5I", header)
        if magic != _GLB_MAGIC or chunk_type != _GLB_JSON_CHUNK:
            raise ValueError("GLB ファイルではありません")
        return json.loads(handle.read(chunk_length))


def glb_stats(root: str, model: str) -> Dict[str, int]:
    """Triangle, vertex, material, texture and animation counts of a .glb/.gltf.

    Counted per mesh, as stored (a mesh drawn twice by two nodes counts once).
    """
    path = safe_path(root, model)
    if os.path.splitext(path)[1].lower() not in VIEWABLE:
        raise ValueError("GLB / glTF だけ対応しています")
    gltf = _gltf_json(path)
    accessors = gltf.get("accessors") or []

    def count(index: Any) -> int:
        try:
            return int(accessors[index]["count"])
        except (IndexError, KeyError, TypeError, ValueError):
            return 0

    triangles = vertices = 0
    for mesh in gltf.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            points = count((prim.get("attributes") or {}).get("POSITION"))
            vertices += points
            if prim.get("mode", _TRIANGLES) == _TRIANGLES:
                indices = prim.get("indices")
                triangles += (count(indices) if indices is not None else points) // 3
    return {"triangles": triangles, "vertices": vertices, "meshes": len(gltf.get("meshes") or []),
            "materials": len(gltf.get("materials") or []), "textures": len(gltf.get("images") or []),
            "animations": len(gltf.get("animations") or []), "skins": len(gltf.get("skins") or [])}


MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def save_screenshot(root: str, name: str, stream: BinaryIO, length: int) -> str:
    """Save a PNG as ``screenshots/<name>_<date-time>.png`` in ``root``; returns its relative path."""
    if not len(_PNG_MAGIC) < length <= MAX_SCREENSHOT_BYTES:
        raise ValueError("画像が空か、大きすぎます")
    data = stream.read(length)
    if len(data) != length or not data.startswith(_PNG_MAGIC):
        raise ValueError("PNG 画像ではありません")
    try:
        name = check_name(name)
    except ValueError:
        name = "screenshot"
    folder = safe_path(root, SCREENSHOT_DIR)
    os.makedirs(folder, exist_ok=True)
    path = unique_path(os.path.join(folder, f"{name}_{datetime.now():%Y%m%d-%H%M%S}.png"))
    _write(path, io.BytesIO(data), length)
    return _rel(root, path)


# (path, size, mtime) -> SHA-1, so repeated checks only hash files that changed.
_hash_cache: Dict[Tuple[str, int, float], str] = {}


def _file_hash(path: str, size: int, mtime: float) -> str:
    key = (path, size, mtime)
    if key not in _hash_cache:
        digest = hashlib.sha1()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(_COPY_CHUNK), b""):
                digest.update(chunk)
        _hash_cache[key] = digest.hexdigest()
    return _hash_cache[key]


def find_duplicates(root: str) -> List[List[str]]:
    """Groups of model files under ``root`` with identical content, largest files first.

    Only files sharing a size are hashed, so this stays quick on big folders.
    """
    by_size: Dict[int, List[Tuple[str, float]]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if is_model_file(name) and not name.startswith("."):
                path = os.path.join(dirpath, name)
                stat = os.stat(path)
                by_size.setdefault(stat.st_size, []).append((path, stat.st_mtime))
    groups = []
    for size in sorted(by_size, reverse=True):
        if len(by_size[size]) < 2:
            continue
        by_hash: Dict[str, List[str]] = {}
        for path, mtime in by_size[size]:
            by_hash.setdefault(_file_hash(path, size, mtime), []).append(_rel(root, path))
        groups.extend(sorted(paths) for paths in by_hash.values() if len(paths) > 1)
    return groups


_TEXTURE_USES = (("baseColorTexture", "ベースカラー"), ("metallicRoughnessTexture", "金属・粗さ"),
                 ("normalTexture", "法線"), ("occlusionTexture", "AO（陰影）"), ("emissiveTexture", "発光"))
_MIME_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/ktx2": ".ktx2"}
TEXTURE_DIR = "textures"


def _glb_bin_offset(path: str) -> int:
    """File offset where a .glb's BIN chunk data starts."""
    with open(path, "rb") as handle:
        _magic, _version, _length, json_length, _type = struct.unpack("<5I", handle.read(20))
    return 20 + json_length + 8


def image_size(data: bytes) -> Optional[Tuple[int, int]]:
    """Width and height from a PNG, JPEG or WebP header, or None."""
    if data.startswith(_PNG_MAGIC) and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return width, height
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        kind = data[12:16]
        if kind == b"VP8 ":
            width, height = struct.unpack("<HH", data[26:30])
            return width & 0x3FFF, height & 0x3FFF
        if kind == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if kind == b"VP8X":
            return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", data[i + 5:i + 9])
                return width, height
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    return None


def _image_bytes(root: str, model: str, gltf: Dict[str, Any], index: int) -> Tuple[bytes, str]:
    path = safe_path(root, model)
    images = gltf.get("images") or []
    if not 0 <= index < len(images):
        raise ValueError("その番号の画像はありません")
    image = images[index]
    mime = image.get("mimeType") or ""
    if "bufferView" in image:
        view = gltf["bufferViews"][image["bufferView"]]
        if not path.lower().endswith(".glb"):
            raise ValueError("glTF の外部バッファの画像には対応していません")
        with open(path, "rb") as handle:
            handle.seek(_glb_bin_offset(path) + view.get("byteOffset", 0))
            return handle.read(view["byteLength"]), mime
    uri = image.get("uri") or ""
    if uri.startswith("data:"):
        header, _, payload = uri.partition(",")
        return base64.b64decode(payload), header[5:].split(";")[0]
    folder = os.path.dirname(model)
    with open(safe_path(root, f"{folder}/{uri}" if folder else uri), "rb") as handle:
        data = handle.read()
    ext = os.path.splitext(uri)[1].lower()
    return data, mime or next((m for m, e in _MIME_EXT.items() if e == ext), "")


def list_textures(root: str, model: str) -> List[Dict[str, Any]]:
    """The images of a .glb/.gltf: format, size in bytes and pixels, and what each is used for."""
    path = safe_path(root, model)
    if os.path.splitext(path)[1].lower() not in VIEWABLE:
        raise ValueError("GLB / glTF だけ対応しています")
    gltf = _gltf_json(path)
    uses: Dict[int, List[str]] = {}
    textures = gltf.get("textures") or []
    for material in gltf.get("materials") or []:
        slots = dict(material.get("pbrMetallicRoughness") or {}, **material)
        for slot, label in _TEXTURE_USES:
            ref = slots.get(slot)
            if isinstance(ref, dict) and 0 <= ref.get("index", -1) < len(textures):
                source = textures[ref["index"]].get("source")
                if source is not None and label not in uses.setdefault(source, []):
                    uses[source].append(label)
    result = []
    for index, image in enumerate(gltf.get("images") or []):
        try:
            data, mime = _image_bytes(root, model, gltf, index)
        except (ValueError, OSError, KeyError, IndexError):
            data, mime = b"", image.get("mimeType") or ""
        size = image_size(data)
        result.append({"index": index, "name": image.get("name") or "", "mime": mime, "bytes": len(data),
                       "width": size[0] if size else None, "height": size[1] if size else None,
                       "uses": uses.get(index, [])})
    return result


def read_texture(root: str, model: str, index: int) -> Tuple[bytes, str]:
    return _image_bytes(root, model, _gltf_json(safe_path(root, model)), index)


def export_textures(root: str, model: str) -> str:
    """Write a model's images to ``textures/<model name>/`` in ``root``; returns that folder."""
    stem = os.path.splitext(os.path.basename(model))[0]
    items = list_textures(root, model)
    if not items:
        raise ValueError("このモデルには画像（テクスチャ）がありません")
    folder = unique_path(safe_path(root, f"{TEXTURE_DIR}/{check_name(stem)}"))
    os.makedirs(folder)
    for item in items:
        data, mime = read_texture(root, model, item["index"])
        name = _BAD_NAME.sub("_", f"{item['index'] + 1:02d}_{'_'.join(item['uses']) or '未使用'}")
        with open(os.path.join(folder, name + _MIME_EXT.get(mime, ".bin")), "wb") as handle:
            handle.write(data)
    return _rel(root, folder)


MAX_VIDEO_BYTES = 500 * 1024 * 1024
_WEBM_MAGIC = b"\x1a\x45\xdf\xa3"


def save_video(root: str, name: str, stream: BinaryIO, length: int) -> str:
    """Save a WebM as ``screenshots/<name>_<date-time>.webm`` in ``root``; returns its relative path."""
    if not len(_WEBM_MAGIC) < length <= MAX_VIDEO_BYTES:
        raise ValueError("動画が空か、大きすぎます")
    head = stream.read(len(_WEBM_MAGIC))
    if head != _WEBM_MAGIC:
        raise ValueError("WebM 動画ではありません")
    try:
        name = check_name(name)
    except ValueError:
        name = "turntable"
    folder = safe_path(root, SCREENSHOT_DIR)
    os.makedirs(folder, exist_ok=True)
    path = unique_path(os.path.join(folder, f"{name}_{datetime.now():%Y%m%d-%H%M%S}.webm"))
    _write(path, _Prefixed(head, stream), length)
    return _rel(root, path)


class _Prefixed:
    """A stream that first returns bytes already read from it (here, the checked signature)."""

    def __init__(self, head: bytes, stream: BinaryIO):
        self.head, self.stream = head, stream

    def read(self, size: int) -> bytes:
        if self.head:
            chunk, self.head = self.head[:size], self.head[size:]
            return chunk
        return self.stream.read(size)


# Background images for the 3D view, kept in a dot folder so the model index skips them.
BACKGROUND_DIR = ".backgrounds"
BACKGROUND_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".hdr")
MAX_BACKGROUND_BYTES = 100 * 1024 * 1024


def save_background(root: str, name: str, stream: BinaryIO, length: int) -> str:
    """Store an image (PNG/JPEG/WebP, or a .hdr environment) for use as a background."""
    name = check_name(os.path.basename(name.replace("\\", "/")))
    if os.path.splitext(name)[1].lower() not in BACKGROUND_EXTENSIONS:
        raise ValueError("背景に使えるのは PNG / JPEG / WebP / HDR 画像です")
    if not 0 < length <= MAX_BACKGROUND_BYTES:
        raise ValueError("画像が空か、大きすぎます")
    folder = safe_path(root, BACKGROUND_DIR)
    os.makedirs(folder, exist_ok=True)
    path = unique_path(os.path.join(folder, name))
    _write(path, stream, length)
    return _rel(root, path)


def list_backgrounds(root: str) -> List[str]:
    folder = os.path.join(os.path.abspath(root), BACKGROUND_DIR)
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return []
    return [f"{BACKGROUND_DIR}/{n}" for n in names
            if os.path.splitext(n)[1].lower() in BACKGROUND_EXTENSIONS and os.path.isfile(os.path.join(folder, n))]


LITE_SUFFIX = "_lite"


def replace_images(root: str, model: str, images: Dict[int, Tuple[bytes, str]], in_place: bool = False) -> str:
    """Write ``<stem>_lite.glb`` next to a .glb with some embedded images replaced.

    With ``in_place`` a file that is already a lite copy (from ``convert.simplify``) is
    rewritten instead; originals are never overwritten.

    ``images`` maps image index to (new bytes, MIME type), e.g. the same textures at a smaller
    size. The binary chunk is rebuilt with every buffer view re-packed (4-byte aligned) and the
    original file is left as it is. Returns the new file's relative path.
    """
    path = safe_path(root, model)
    if not path.lower().endswith(".glb"):
        raise ValueError("軽量化できるのは GLB だけです")
    gltf = _gltf_json(path)
    if len(gltf.get("buffers") or []) != 1 or "uri" in gltf["buffers"][0]:
        raise ValueError("外部ファイルを参照する GLB には対応していません")
    gltf_images = gltf.get("images") or []
    swap = {}
    for index, (data, mime) in images.items():
        if not 0 <= index < len(gltf_images) or "bufferView" not in gltf_images[index]:
            raise ValueError(f"その番号の画像はありません: {index}")
        if mime not in _MIME_EXT or not image_size(data):
            raise ValueError("PNG / JPEG / WebP の画像を渡してください")
        swap[gltf_images[index]["bufferView"]] = (index, data, mime)
    with open(path, "rb") as handle:
        handle.seek(_glb_bin_offset(path))
        old = handle.read(gltf["buffers"][0]["byteLength"])
    chunks, offset = [], 0
    for number, view in enumerate(gltf.get("bufferViews") or []):
        if number in swap:
            index, data, mime = swap[number]
            gltf_images[index]["mimeType"] = mime
        else:
            start = view.get("byteOffset", 0)
            data = old[start:start + view["byteLength"]]
        pad = -offset % 4
        chunks.append(b"\0" * pad + data)
        offset += pad
        view["byteOffset"], view["byteLength"] = offset, len(data)
        offset += len(data)
    binary = b"".join(chunks)
    binary += b"\0" * (-len(binary) % 4)
    gltf["buffers"][0]["byteLength"] = len(binary)
    text = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    body = (struct.pack("<II", len(text), _GLB_JSON_CHUNK) + text
            + struct.pack("<II", len(binary), 0x004E4942) + binary)
    if in_place and not os.path.splitext(os.path.basename(path))[0].split(" (")[0].endswith(LITE_SUFFIX):
        raise ValueError("上書きできるのは軽量化したファイル（_lite.glb）だけです")
    target = path if in_place else unique_path(os.path.splitext(path)[0] + LITE_SUFFIX + ".glb")
    _write(target, io.BytesIO(struct.pack("<III", _GLB_MAGIC, 2, 12 + len(body)) + body), 12 + len(body))
    return _rel(root, target)
