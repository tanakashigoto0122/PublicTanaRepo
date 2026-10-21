import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

from tripo_export import library, viewer


def touch(root, rel, data=b"x"):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self._tmp.name, "models")
        os.makedirs(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_safe_path_stays_inside(self):
        self.assertTrue(library.safe_path(self.root, "a/b.glb").startswith(self.root))
        for bad in ("../x.glb", "", ".", os.path.abspath(os.sep)):
            with self.assertRaises(ValueError):
                library.safe_path(self.root, bad)

    def test_add_file_never_overwrites(self):
        touch(self.root, "cat.glb", b"old")
        rel = library.add_file(self.root, "C:\\Users\\me\\cat.glb", io.BytesIO(b"new"), 3)
        self.assertEqual(rel, "cat (2).glb")
        with open(os.path.join(self.root, "cat.glb"), "rb") as handle:
            self.assertEqual(handle.read(), b"old")

    def test_add_file_rejects_other_files_and_short_uploads(self):
        with self.assertRaises(ValueError):
            library.add_file(self.root, "notes.txt", io.BytesIO(b"x"), 1)
        with self.assertRaises(ValueError):
            library.add_file(self.root, "cut.glb", io.BytesIO(b"ab"), 10)
        self.assertEqual(os.listdir(self.root), [])

    def test_rename_keeps_date_prefix_preview_and_manifest(self):
        touch(self.root, "20251009-120000_abc.glb")
        touch(self.root, "20251009-120000_abc.fbx")
        touch(self.root, "20251009-120000_abc_preview.webp")
        with open(os.path.join(self.root, "manifest.json"), "w") as handle:
            json.dump({"abc:GLB": {"task_id": "abc", "format": "GLB", "file": "20251009-120000_abc.glb"}}, handle)
        files = ["20251009-120000_abc.glb", "20251009-120000_abc.fbx", "20251009-120000_abc_preview.webp"]
        library.rename_model(self.root, files, "  赤いパンダ ")
        self.assertEqual(sorted(os.listdir(self.root)), [
            "20251009-120000_赤いパンダ.fbx", "20251009-120000_赤いパンダ.glb",
            "20251009-120000_赤いパンダ_preview.webp", "manifest.json"])
        with open(os.path.join(self.root, "manifest.json"), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["abc:GLB"]["file"], "20251009-120000_赤いパンダ.glb")
        [item] = viewer.build_index(self.root)
        self.assertEqual((item["task_id"], item["title"], item["created"]), ("abc", "赤いパンダ", "2025-10-09T12:00:00"))

    def test_rename_refuses_bad_names_and_existing_files(self):
        touch(self.root, "studio/a.glb")
        touch(self.root, "studio/b.glb")
        for bad in ("", "x/y", "a:b", ".hidden"):
            with self.assertRaises(ValueError):
                library.rename_model(self.root, ["studio/a.glb"], bad)
        with self.assertRaises(ValueError):
            library.rename_model(self.root, ["studio/a.glb"], "b")
        self.assertTrue(os.path.exists(os.path.join(self.root, "studio", "a.glb")))

    def test_delete_moves_to_trash_folder_off_windows(self):
        touch(self.root, "a.glb")
        touch(self.root, ".trash/a.glb")
        with mock.patch.object(library.sys, "platform", "linux"):
            self.assertEqual(library.delete_model(self.root, ["a.glb"]), library.TRASH_DIR)
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, ".trash"))), ["a (2).glb", "a.glb"])
        self.assertEqual(viewer.build_index(self.root), [])

    # Leaves a file in the real Recycle Bin, so it only runs when asked for.
    @unittest.skipUnless(os.name == "nt" and os.environ.get("TRIPO_TEST_RECYCLE"),
                         "set TRIPO_TEST_RECYCLE=1 on Windows to try the real Recycle Bin")
    def test_delete_uses_recycle_bin_on_windows(self):
        touch(self.root, "a.glb")
        self.assertEqual(library.delete_model(self.root, ["a.glb"]), "ごみ箱")
        self.assertEqual(os.listdir(self.root), [])

    def test_list_and_import_downloads(self):
        downloads = os.path.join(self._tmp.name, "Downloads")
        touch(downloads, "robot.glb", b"robot")
        touch(downloads, "chair.fbx", b"chair")
        touch(downloads, "photo.png")
        touch(self.root, "old/robot.glb", b"robot")
        items = {i["name"]: i for i in library.list_importable(downloads, self.root)}
        self.assertEqual(set(items), {"robot.glb", "chair.fbx"})
        self.assertTrue(items["robot.glb"]["imported"])
        self.assertFalse(items["chair.fbx"]["imported"])

        added, errors = library.import_files(downloads, ["chair.fbx", "../x.glb", "missing.glb"], self.root, move=True)
        self.assertEqual(added, ["chair.fbx"])
        self.assertEqual(set(errors), {"../x.glb", "missing.glb"})
        self.assertFalse(os.path.exists(os.path.join(downloads, "chair.fbx")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "chair.fbx")))


class ChangeEndpointTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.server = viewer.make_server(self.root, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = self.server.url.rstrip("/")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def call(self, method, path, body=b"", token=None, host=None):
        headers = {viewer.TOKEN_HEADER: self.server.token if token is None else token}
        if host:
            headers["Host"] = host
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.load(res)
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.load(err)

    def test_page_carries_the_token(self):
        page = urllib.request.urlopen(self.base + "/").read().decode()
        self.assertIn(self.server.token, page)
        self.assertNotIn("__VIEWER_TOKEN__", page)

    def test_upload_rename_delete(self):
        status, res = self.call("PUT", viewer.UPLOAD_PATH + "?name=%E7%8C%AB.glb", b"glb-bytes")
        self.assertEqual((status, res), (200, {"path": "猫.glb"}))
        status, res = self.call("POST", viewer.RENAME_PATH, json.dumps({"files": ["猫.glb"], "name": "cat"}).encode())
        self.assertEqual((status, res["renamed"]), (200, {"猫.glb": "cat.glb"}))
        with mock.patch.object(library.sys, "platform", "linux"):
            status, res = self.call("POST", viewer.DELETE_PATH, json.dumps({"files": ["cat.glb"]}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(os.listdir(os.path.join(self.root, ".trash")), ["cat.glb"])

    def test_changes_need_token_and_local_host(self):
        self.assertEqual(self.call("PUT", viewer.UPLOAD_PATH + "?name=a.glb", b"x", token="wrong")[0], 403)
        self.assertEqual(self.call("PUT", viewer.UPLOAD_PATH + "?name=a.glb", b"x", host="evil.example:80")[0], 403)
        self.assertEqual(os.listdir(self.root), [])

    def test_bad_requests_are_reported(self):
        status, res = self.call("POST", viewer.RENAME_PATH, json.dumps({"files": ["../x.glb"], "name": "y"}).encode())
        self.assertEqual(status, 400)
        self.assertIn("error", res)
        self.assertEqual(self.call("POST", "/__viewer/nope", b"{}")[0], 404)


if __name__ == "__main__":
    unittest.main()
