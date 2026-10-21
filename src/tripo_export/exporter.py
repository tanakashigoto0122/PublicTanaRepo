"""Finding, downloading and converting Tripo API tasks.

Everything here talks to a ``tripo3d.TripoClient`` (or any object with the same async
methods), so the logic can be tested without network access.
"""

import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional

USAGE_PAGE_SIZE = 50
# Result URLs are signed and expire about 5 minutes after they are issued, so tasks are
# queried in small batches and each batch is downloaded before the next one is queried.
QUERY_BATCH_SIZE = 20
DOWNLOAD_CONCURRENCY = 4
CONVERT_TIMEOUT_SECONDS = 900
GENERATE_TIMEOUT_SECONDS = 1800
MANIFEST_NAME = "manifest.json"

# Formats accepted by POST /v3/models/convert. GLB is what generation returns natively.
CONVERT_FORMATS = ("GLTF", "USDZ", "FBX", "OBJ", "STL", "3MF")
FORMATS = ("GLB",) + CONVERT_FORMATS

Log = Callable[[str], None]


def _status(value: Any) -> str:
    # TaskStatus is a str enum; plain strings come from the usage endpoint.
    return str(getattr(value, "value", value) or "").lower()


def _extension(url: str, fallback: str) -> str:
    ext = os.path.splitext(url.split("?")[0].rsplit("/", 1)[-1])[1]
    return ext or fallback


def _date_prefix(task: Any) -> str:
    create_time = getattr(task, "create_time", None)
    if not create_time:
        return ""
    return datetime.fromtimestamp(create_time).strftime("%Y%m%d-%H%M%S_")


class Manifest:
    """Records what has been exported so re-runs skip finished work.

    Stored as ``manifest.json`` in the output directory, keyed by ``<task_id>:<format>``.
    """

    def __init__(self, out_dir: str):
        self.path = os.path.join(out_dir, MANIFEST_NAME)
        self.entries: Dict[str, Dict[str, Any]] = {}
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as handle:
                self.entries = json.load(handle)

    @staticmethod
    def key(task_id: str, fmt: str) -> str:
        return f"{task_id}:{fmt.upper()}"

    def has(self, task_id: str, fmt: str) -> bool:
        entry = self.entries.get(self.key(task_id, fmt))
        out_dir = os.path.dirname(self.path)
        return bool(entry) and os.path.exists(os.path.join(out_dir, entry["file"]))

    def add(self, task_id: str, fmt: str, file_name: str, **extra: Any) -> None:
        self.entries[self.key(task_id, fmt)] = {
            "task_id": task_id,
            "format": fmt.upper(),
            "file": file_name,
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **extra,
        }

    def save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.entries, handle, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, self.path)


@dataclass
class ExportSummary:
    exported: List[str] = field(default_factory=list)
    skipped: List[str] = field(default_factory=list)
    no_model: List[str] = field(default_factory=list)
    failed: Dict[str, str] = field(default_factory=dict)


async def list_history(client: Any, page_size: int = USAGE_PAGE_SIZE, limit: Optional[int] = None) -> List[Any]:
    """Return the account's task history (``GET /v3/account/usage``), newest first.

    Pages are read until one comes back short. Tasks created while paging can shift the
    offsets, so rows are de-duplicated by task ID.
    """
    seen = set()
    items: List[Any] = []
    offset = 0
    while limit is None or len(items) < limit:
        page = await client.get_usage(limit=page_size, offset=offset)
        for item in page:
            if item.task_id and item.task_id not in seen:
                seen.add(item.task_id)
                items.append(item)
        if len(page) < page_size:
            break
        offset += page_size
    return items if limit is None else items[:limit]


async def _download(client: Any, url: str, path: str) -> None:
    # Download to a temporary name so an interrupted run never leaves a file that looks done.
    part = path + ".part"
    try:
        await client.download_file(url, part)
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)


async def _download_output(client: Any, task: Any, attr: str, path: str) -> Any:
    """Download ``task.output.<attr>`` to ``path``; return the task (re-queried if that was needed).

    Signed URLs expire about 5 minutes after the task was queried, and a slow batch can outlive
    them, so on failure the task is fetched again for fresh URLs and the download retried once.
    """
    try:
        await _download(client, getattr(task.output, attr), path)
        return task
    except Exception:
        if not hasattr(client, "get_task"):
            raise
    task = await client.get_task(task.task_id)
    url = getattr(task.output, attr, None)
    if not url:
        raise RuntimeError(f"{attr} is no longer available")
    await _download(client, url, path)
    return task


def is_conversion(item: Any) -> bool:
    """True for format-conversion tasks, which only repackage another task's model."""
    return "convert" in str(getattr(item, "type", None) or "").lower()


async def save_task_model(
    client: Any,
    task: Any,
    out_dir: str,
    fmt: str = "GLB",
    with_preview: bool = False,
    convert_options: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Download one successful task's model in ``fmt``; return the file name, or None if it has no model.

    For any format other than GLB a conversion task is created first, which consumes credits.
    """
    fmt = fmt.upper()
    if not getattr(task.output, "model_url", None):
        return None
    base = f"{_date_prefix(task)}{task.task_id}"

    # The preview comes first: a conversion can take minutes, long enough for its URL to expire.
    preview = getattr(task.output, "rendered_image", None)
    if with_preview and preview:
        task = await _download_output(
            client, task, "rendered_image", os.path.join(out_dir, base + "_preview" + _extension(preview, ".webp")))

    if fmt == "GLB":
        file_name = base + _extension(task.output.model_url, ".glb")
        await _download_output(client, task, "model_url", os.path.join(out_dir, file_name))
    else:
        convert_id = await client.convert_model(task.task_id, fmt, **(convert_options or {}))
        converted = await client.wait_for_task(convert_id, timeout=CONVERT_TIMEOUT_SECONDS)
        if _status(converted.status) != "success":
            reason = getattr(converted, "error_msg", None) or _status(converted.status)
            raise RuntimeError(f"conversion to {fmt} failed: {reason}")
        url = getattr(converted.output, "model_url", None)
        if not url:
            raise RuntimeError(f"conversion to {fmt} returned no model")
        file_name = base + _extension(url, "." + fmt.lower())
        await _download_output(client, converted, "model_url", os.path.join(out_dir, file_name))
    return file_name


async def export_all(
    client: Any,
    out_dir: str,
    fmt: str = "GLB",
    task_ids: Optional[Iterable[str]] = None,
    with_preview: bool = False,
    convert_options: Optional[Dict[str, Any]] = None,
    concurrency: int = DOWNLOAD_CONCURRENCY,
    log: Log = print,
    progress: Optional[Callable[[int, int], None]] = None,
) -> ExportSummary:
    """Download every model in the account (or just ``task_ids``) into ``out_dir``.

    Already exported tasks (per the manifest) are skipped, so an interrupted run can simply
    be started again. ``progress(done, total)`` is called as each pending task finishes.
    """
    fmt = fmt.upper()
    if fmt not in FORMATS:
        raise ValueError(f"unsupported format {fmt!r}; choose from {', '.join(FORMATS)}")
    os.makedirs(out_dir, exist_ok=True)
    manifest = Manifest(out_dir)
    summary = ExportSummary()

    if task_ids is None:
        log("Reading task history...")
        history = await list_history(client)
        # Conversions (including the ones earlier non-GLB exports created) are copies of another
        # task's model; exporting them again would duplicate files, and converting them costs credits.
        conversions = [item for item in history if is_conversion(item)]
        ids = [item.task_id for item in history
               if not is_conversion(item) and _status(item.status) in ("", "success")]
        log(f"{len(history)} tasks in history, {len(ids)} succeeded"
            + (f" ({len(conversions)} format conversions left out)." if conversions else "."))
    else:
        ids = list(dict.fromkeys(task_ids))

    pending = []
    for task_id in ids:
        if manifest.has(task_id, fmt):
            summary.skipped.append(task_id)
        else:
            pending.append(task_id)
    if summary.skipped:
        log(f"{len(summary.skipped)} already exported, skipping.")

    semaphore = asyncio.Semaphore(max(1, concurrency))
    done = 0

    def advance() -> None:
        nonlocal done
        done += 1
        if progress:
            progress(done, len(pending))

    if progress:
        progress(0, len(pending))

    async def handle(task: Any) -> None:
        async with semaphore:
            try:
                if _status(task.status) != "success":
                    summary.failed[task.task_id] = f"status {_status(task.status)}"
                    return
                file_name = await save_task_model(client, task, out_dir, fmt, with_preview, convert_options)
            except Exception as exc:  # one bad task must not stop the export
                summary.failed[task.task_id] = str(exc) or type(exc).__name__
                log(f"  ! {task.task_id}: {summary.failed[task.task_id]}")
                return
            finally:
                advance()
            if file_name is None:
                summary.no_model.append(task.task_id)
                return
            manifest.add(task.task_id, fmt, file_name, type=getattr(task, "type", None))
            manifest.save()
            summary.exported.append(task.task_id)
            log(f"  [{done}/{len(pending)}] {file_name}")

    for start in range(0, len(pending), QUERY_BATCH_SIZE):
        batch = pending[start:start + QUERY_BATCH_SIZE]
        result = await client.list_tasks(batch)
        for task_id in result.missed:
            summary.failed[task_id] = "not found (invalid, another API key, or expired)"
            advance()
        await asyncio.gather(*(handle(task) for task in result.tasks.values()))

    return summary


async def generate(
    client: Any,
    out_dir: str,
    prompt: Optional[str] = None,
    image: Optional[str] = None,
    model_version: Optional[str] = None,
    fmt: str = "GLB",
    with_preview: bool = False,
    options: Optional[Dict[str, Any]] = None,
    log: Log = print,
) -> str:
    """Generate a model from a text prompt or an image, wait for it and download it.

    Returns the downloaded file name. The task is recorded in the manifest, so a later
    ``export_all`` into the same directory will not download it again.
    """
    if (prompt is None) == (image is None):
        raise ValueError("pass exactly one of prompt or image")
    kwargs = dict(options or {})
    if model_version:
        kwargs["model_version"] = model_version
    if prompt is not None:
        task_id = await client.text_to_model(prompt=prompt, **kwargs)
    else:
        task_id = await client.image_to_model(image=image, **kwargs)
    log(f"Task {task_id} created, waiting for it to finish...")

    task = await client.wait_for_task(task_id, timeout=GENERATE_TIMEOUT_SECONDS, verbose=True)
    if _status(task.status) != "success":
        reason = getattr(task, "error_msg", None) or _status(task.status)
        raise RuntimeError(f"task {task_id} did not succeed: {reason}")

    os.makedirs(out_dir, exist_ok=True)
    file_name = await save_task_model(client, task, out_dir, fmt, with_preview)
    if file_name is None:
        raise RuntimeError(f"task {task_id} finished without a model")
    manifest = Manifest(out_dir)
    manifest.add(task_id, fmt, file_name, type=getattr(task, "type", None), prompt=prompt, image=image)
    manifest.save()
    return file_name
