import asyncio
import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from tripo_export import exporter
from tripo_export.cli import _read_ids, build_parser


def make_task(task_id, status="success", model_url=None, preview=None, create_time=1760000000):
    if model_url is None:
        model_url = f"https://cdn.example/{task_id}/model.glb?sig=x"
    return SimpleNamespace(
        task_id=task_id, status=status, type="text_to_model", create_time=create_time, error_msg=None,
        output=SimpleNamespace(model_url=model_url, rendered_image=preview),
    )


class FakeClient:
    def __init__(self, tasks, usage=None, missed=()):
        self.tasks = {t.task_id: t for t in tasks}
        self.usage = usage if usage is not None else [
            SimpleNamespace(task_id=t.task_id, status=t.status) for t in tasks
        ]
        self.missed = set(missed)
        self.downloads = []
        self.batches = []
        self.converted = []
        self.fail_urls = set()

    async def get_usage(self, limit=50, offset=0):
        return self.usage[offset:offset + limit]

    async def list_tasks(self, ids):
        self.batches.append(list(ids))
        return SimpleNamespace(
            tasks={i: self.tasks[i] for i in ids if i in self.tasks and i not in self.missed},
            missed=[i for i in ids if i in self.missed or i not in self.tasks],
        )

    async def download_file(self, url, path):
        if url in self.fail_urls:
            with open(path, "wb") as handle:
                handle.write(b"partial")
            raise RuntimeError("boom")
        self.downloads.append(url)
        with open(path, "wb") as handle:
            handle.write(url.encode())

    async def convert_model(self, task_id, fmt, **kwargs):
        self.converted.append((task_id, fmt))
        conv_id = f"conv-{task_id}"
        self.tasks[conv_id] = make_task(conv_id, model_url=f"https://cdn.example/{conv_id}/model.{fmt.lower()}")
        return conv_id

    async def wait_for_task(self, task_id, **kwargs):
        return self.tasks[task_id]

    async def text_to_model(self, prompt, **kwargs):
        self.created = ("text", prompt, kwargs)
        self.tasks["new"] = make_task("new")
        return "new"

    async def image_to_model(self, image, **kwargs):
        self.created = ("image", image, kwargs)
        self.tasks["new"] = make_task("new")
        return "new"


def run(coro):
    return asyncio.run(coro)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def export(self, client, **kwargs):
        return run(exporter.export_all(client, self.out, log=lambda _: None, **kwargs))

    def test_exports_every_successful_task_from_history(self):
        client = FakeClient([make_task("a"), make_task("b"), make_task("c", status="failed")])
        summary = self.export(client)
        self.assertEqual(sorted(summary.exported), ["a", "b"])
        self.assertEqual(client.batches, [["a", "b"]])
        files = sorted(f for f in os.listdir(self.out) if f.endswith(".glb"))
        self.assertEqual(len(files), 2)
        self.assertTrue(all(f.endswith(("_a.glb", "_b.glb")) for f in files))

    def test_history_paginates_and_dedupes(self):
        tasks = [make_task(f"t{i}") for i in range(120)]
        usage = [SimpleNamespace(task_id=t.task_id, status="success") for t in tasks]
        usage.insert(50, usage[49])  # a row shifted onto the next page
        client = FakeClient(tasks, usage=usage)
        items = run(exporter.list_history(client))
        self.assertEqual([i.task_id for i in items], [t.task_id for t in tasks])

    def test_batches_are_small_so_urls_do_not_expire(self):
        client = FakeClient([make_task(f"t{i}") for i in range(45)])
        self.export(client)
        self.assertEqual([len(b) for b in client.batches], [20, 20, 5])

    def test_rerun_skips_already_exported(self):
        client = FakeClient([make_task("a"), make_task("b")])
        self.export(client)
        client.downloads.clear()
        summary = self.export(client)
        self.assertEqual(sorted(summary.skipped), ["a", "b"])
        self.assertEqual(client.downloads, [])

    def test_deleted_file_is_downloaded_again(self):
        client = FakeClient([make_task("a")])
        self.export(client)
        with open(os.path.join(self.out, exporter.MANIFEST_NAME)) as handle:
            manifest = json.load(handle)
        os.remove(os.path.join(self.out, manifest["a:GLB"]["file"]))
        summary = self.export(client)
        self.assertEqual(summary.exported, ["a"])

    def test_failed_download_leaves_no_file_and_does_not_stop_others(self):
        client = FakeClient([make_task("a"), make_task("b")])
        client.fail_urls.add(client.tasks["a"].output.model_url)
        summary = self.export(client)
        self.assertEqual(summary.exported, ["b"])
        self.assertIn("a", summary.failed)
        self.assertEqual([f for f in os.listdir(self.out) if "_a" in f], [])

    def test_missed_and_modelless_tasks_are_reported(self):
        client = FakeClient([make_task("a"), make_task("img", model_url="")], missed=["a"])
        summary = self.export(client, task_ids=["a", "img", "a"])
        self.assertEqual(client.batches, [["a", "img"]])
        self.assertIn("a", summary.failed)
        self.assertEqual(summary.no_model, ["img"])

    def test_convert_format(self):
        client = FakeClient([make_task("a")])
        summary = self.export(client, fmt="fbx")
        self.assertEqual(summary.exported, ["a"])
        self.assertEqual(client.converted, [("a", "FBX")])
        self.assertTrue(any(f.endswith("_a.fbx") for f in os.listdir(self.out)))

    def test_preview(self):
        client = FakeClient([make_task("a", preview="https://cdn.example/a/r.webp")])
        self.export(client, with_preview=True)
        self.assertTrue(any(f.endswith("_a_preview.webp") for f in os.listdir(self.out)))

    def test_rejects_unknown_format(self):
        with self.assertRaises(ValueError):
            self.export(FakeClient([]), fmt="blend")

    def test_generate_records_manifest(self):
        client = FakeClient([])
        name = run(exporter.generate(client, self.out, prompt="a cat", model_version="v3.1-20260211",
                                     log=lambda _: None))
        self.assertEqual(client.created, ("text", "a cat", {"model_version": "v3.1-20260211"}))
        self.assertTrue(os.path.exists(os.path.join(self.out, name)))
        summary = self.export(client, task_ids=["new"])
        self.assertEqual(summary.skipped, ["new"])


class CliTests(unittest.TestCase):
    def test_read_ids_accepts_plain_and_csv(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as handle:
            handle.write("task_id,prompt\nabc,cat\n\n# note\ndef\n")
        try:
            self.assertEqual(_read_ids(handle.name), ["abc", "def"])
        finally:
            os.remove(handle.name)

    def test_create_keeps_options(self):
        args = build_parser().parse_args(["create", "text", "-o", "out", "-f", "obj", "a cat"])
        self.assertEqual((args.out, args.format, args.prompt), ("out", "OBJ", "a cat"))


if __name__ == "__main__":
    unittest.main()
