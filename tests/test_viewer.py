import json
import os
import tempfile
import threading
import unittest
import urllib.request

from tripo_export import viewer


def touch(root, rel, data=b"x"):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


class BuildIndexTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_groups_formats_and_reads_manifest(self):
        touch(self.root, "20251009-120000_abc.glb", b"glb")
        touch(self.root, "20251009-120000_abc.fbx", b"fbx!")
        touch(self.root, "20251009-120000_abc_preview.webp")
        with open(os.path.join(self.root, "manifest.json"), "w") as handle:
            json.dump({
                "abc:GLB": {"task_id": "abc", "format": "GLB", "file": "20251009-120000_abc.glb", "prompt": "a cat"},
                "abc:FBX": {"task_id": "abc", "format": "FBX", "file": "20251009-120000_abc.fbx"},
            }, handle)
        [item] = viewer.build_index(self.root)
        self.assertEqual(item["task_id"], "abc")
        self.assertEqual(item["prompt"], "a cat")
        self.assertEqual(item["created"], "2025-10-09T12:00:00")
        self.assertEqual(item["model"], "20251009-120000_abc.glb")
        self.assertEqual(item["preview"], "20251009-120000_abc_preview.webp")
        self.assertEqual(sorted(f["format"] for f in item["files"]), ["FBX", "GLB"])

    def test_lists_files_without_manifest_in_subfolders(self):
        touch(self.root, "studio/robot.glb")
        touch(self.root, "chair.obj")
        touch(self.root, "half.glb.part")
        touch(self.root, "notes.txt")
        items = {i["id"]: i for i in viewer.build_index(self.root)}
        self.assertEqual(set(items), {"robot", "chair"})
        self.assertEqual(items["robot"]["model"], "studio/robot.glb")
        self.assertIsNone(items["chair"]["model"])
        self.assertIsNone(items["robot"]["task_id"])

    def test_task_id_from_exporter_file_name_without_manifest(self):
        touch(self.root, "20251009-120000_abc.glb")
        [item] = viewer.build_index(self.root)
        self.assertEqual(item["task_id"], "abc")

    def test_newest_first(self):
        touch(self.root, "20240101-000000_old.glb")
        touch(self.root, "20250101-000000_new.glb")
        self.assertEqual([i["id"] for i in viewer.build_index(self.root)], ["new", "old"])


class ServerTests(unittest.TestCase):
    def test_serves_page_index_and_files(self):
        with tempfile.TemporaryDirectory() as root:
            touch(root, "20250101-000000_a.glb", b"model-bytes")
            server = viewer.make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                page = urllib.request.urlopen(base + "/").read().decode()
                self.assertIn("model-viewer", page)
                index = json.load(urllib.request.urlopen(base + viewer.INDEX_PATH))
                self.assertEqual(index["models"][0]["id"], "a")
                with urllib.request.urlopen(base + "/20250101-000000_a.glb") as res:
                    self.assertEqual(res.read(), b"model-bytes")
                    self.assertEqual(res.headers["Content-Type"], "model/gltf-binary")
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
