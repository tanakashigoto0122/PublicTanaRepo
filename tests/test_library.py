import io
import json
import os
import struct
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


def make_glb(gltf, binary=b""):
    """A minimal .glb: header, JSON chunk and an optional BIN chunk (only the JSON is ever read)."""
    data = json.dumps(gltf).encode()
    data += b" " * (-len(data) % 4)
    body = struct.pack("<II", len(data), 0x4E4F534A) + data
    if binary:
        body += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


CUBE = {
    "asset": {"version": "2.0"},
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]},
               {"primitives": [{"attributes": {"POSITION": 2}}, {"attributes": {"POSITION": 2}, "mode": 1}]}],
    "accessors": [{"count": 8}, {"count": 36}, {"count": 6}],
    "materials": [{}, {}], "images": [{}], "animations": [{}], "skins": [{}],
}


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

    def test_save_preview_replaces_thumbnail(self):
        touch(self.root, "studio/cat.glb")
        webp = b"RIFF\x10\x00\x00\x00WEBPVP8 data"
        rel = library.save_preview(self.root, "studio/cat.glb", io.BytesIO(webp), len(webp))
        self.assertEqual(rel, "studio/cat_preview.webp")
        rel = library.save_preview(self.root, "studio/cat.glb", io.BytesIO(webp + b"!"), len(webp) + 1)
        with open(os.path.join(self.root, "studio", "cat_preview.webp"), "rb") as handle:
            self.assertEqual(handle.read(), webp + b"!")
        [item] = viewer.build_index(self.root)
        self.assertEqual(item["preview"], "studio/cat_preview.webp")

    def test_save_preview_checks_model_and_image(self):
        touch(self.root, "cat.glb")
        webp = b"RIFF\x10\x00\x00\x00WEBPVP8 data"
        with self.assertRaises(ValueError):
            library.save_preview(self.root, "dog.glb", io.BytesIO(webp), len(webp))
        with self.assertRaises(ValueError):
            library.save_preview(self.root, "cat.glb", io.BytesIO(b"<svg>not webp</svg>"), 19)
        self.assertEqual(os.listdir(self.root), ["cat.glb"])

    def test_favorite_and_memo_follow_rename_and_delete(self):
        touch(self.root, "studio/cat.glb")
        touch(self.root, "dog.glb")
        library.set_meta(self.root, "studio/cat.glb", favorite=True)
        library.set_meta(self.root, "studio/cat.glb", memo="  ゲーム用  ")
        library.set_meta(self.root, "dog.glb", favorite=True)
        items = {i["key"]: i for i in viewer.build_index(self.root)}
        self.assertEqual((items["studio/cat.glb"]["favorite"], items["studio/cat.glb"]["memo"]), (True, "ゲーム用"))
        self.assertEqual(items["studio/cat.glb"]["folder"], "studio")
        self.assertEqual(items["dog.glb"]["folder"], "")

        library.rename_model(self.root, ["studio/cat.glb"], "neko")
        self.assertEqual(library.read_meta(self.root)["studio/neko.glb"], {"favorite": True, "memo": "ゲーム用"})
        with mock.patch.object(library.sys, "platform", "linux"):
            library.delete_model(self.root, ["dog.glb"])
        self.assertEqual(set(library.read_meta(self.root)), {"studio/neko.glb"})
        library.set_meta(self.root, "studio/neko.glb", favorite=False, memo="")
        self.assertEqual(library.read_meta(self.root), {})
        with self.assertRaises(ValueError):
            library.set_meta(self.root, "missing.glb", favorite=True)

    def test_broken_meta_file_is_ignored(self):
        touch(self.root, "cat.glb")
        touch(self.root, library.META_NAME, b"{not json")
        [item] = viewer.build_index(self.root)
        self.assertFalse(item["favorite"])

    def test_glb_stats(self):
        touch(self.root, "cube.glb", make_glb(CUBE, b"\0" * 16))
        self.assertEqual(library.glb_stats(self.root, "cube.glb"), {
            "triangles": 12 + 2, "vertices": 8 + 6 + 6, "meshes": 2, "materials": 2, "textures": 1,
            "animations": 1, "skins": 1})
        touch(self.root, "cube.gltf", json.dumps(CUBE).encode())
        self.assertEqual(library.glb_stats(self.root, "cube.gltf")["triangles"], 14)
        touch(self.root, "fake.glb", b"not a glb file at all")
        with self.assertRaises(ValueError):
            library.glb_stats(self.root, "fake.glb")

    def test_save_screenshot(self):
        png = b"\x89PNG\r\n\x1a\n" + b"data"
        rel = library.save_screenshot(self.root, "赤い/パンダ", io.BytesIO(png), len(png))
        self.assertRegex(rel, r"^screenshots/screenshot_\d{8}-\d{6}\.png$")
        rel = library.save_screenshot(self.root, "panda", io.BytesIO(png), len(png))
        self.assertTrue(rel.startswith("screenshots/panda_"))
        with self.assertRaises(ValueError):
            library.save_screenshot(self.root, "x", io.BytesIO(b"GIF89a-not-png"), 14)
        self.assertEqual(viewer.build_index(self.root), [])

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

    def test_thumbnail_endpoint(self):
        touch(self.root, "cat.glb")
        webp = b"RIFF\x10\x00\x00\x00WEBPVP8 data"
        status, res = self.call("PUT", viewer.THUMBNAIL_PATH + "?model=cat.glb", webp)
        self.assertEqual((status, res), (200, {"path": "cat_preview.webp"}))
        self.assertEqual(self.call("PUT", viewer.THUMBNAIL_PATH + "?model=cat.glb", webp, token="")[0], 403)

    def test_meta_and_stats_endpoints(self):
        touch(self.root, "cube.glb", make_glb(CUBE))
        status, res = self.call("POST", viewer.META_PATH, json.dumps({"key": "cube.glb", "favorite": True}).encode())
        self.assertEqual((status, res), (200, {"favorite": True}))
        index = json.load(urllib.request.urlopen(self.base + viewer.INDEX_PATH))
        self.assertTrue(index["models"][0]["favorite"])
        stats = json.load(urllib.request.urlopen(self.base + viewer.STATS_PATH + "?model=cube.glb"))
        self.assertEqual(stats["triangles"], 14)
        self.assertEqual(self.call("POST", viewer.META_PATH, b'{"key": "cube.glb"}', token="x")[0], 403)

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
