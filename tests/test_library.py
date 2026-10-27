import io
import json
import os
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
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


def make_zip(path, members):
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return path


def make_png(width, height):
    """Just enough of a PNG for its size to be read: signature and IHDR."""
    return (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height)
            + b"\x08\x06\x00\x00\x00" + b"\x00" * 4)


def textured_glb():
    """A .glb with two embedded images: one base color, one normal map shared by two materials."""
    color, normal = make_png(512, 256), make_png(64, 64)
    gltf = {
        "asset": {"version": "2.0"},
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(color)},
                        {"buffer": 0, "byteOffset": len(color), "byteLength": len(normal)}],
        "images": [{"bufferView": 0, "mimeType": "image/png", "name": "albedo"},
                   {"bufferView": 1, "mimeType": "image/png"}],
        "textures": [{"source": 0}, {"source": 1}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "normalTexture": {"index": 1}},
                      {"normalTexture": {"index": 1}}],
    }
    return make_glb(gltf, color + normal), color, normal


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

    def test_zip_is_unpacked_into_its_own_folder(self):
        zip_path = make_zip(os.path.join(self._tmp.name, "panda.zip"), {
            "panda/model.fbx": b"fbx", "panda/textures/base.png": b"png",
            "__MACOSX/panda/._model.fbx": b"junk", "panda/.DS_Store": b"junk"})
        with open(zip_path, "rb") as handle:
            rel = library.add_file(self.root, "panda.zip", handle, os.path.getsize(zip_path))
        self.assertEqual(rel, "panda")
        found = sorted(os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, "/")
                       for d, _, names in os.walk(self.root) for f in names)
        self.assertEqual(found, ["panda/panda/model.fbx", "panda/panda/textures/base.png"])
        self.assertEqual([i["folder"] for i in viewer.build_index(self.root)], ["panda/panda"])

    def test_zip_without_models_or_escaping_paths_is_refused(self):
        no_model = make_zip(os.path.join(self._tmp.name, "pics.zip"), {"a.png": b"png"})
        with self.assertRaises(ValueError):
            library.extract_zip(no_model, self.root, "pics.zip")
        evil = make_zip(os.path.join(self._tmp.name, "evil.zip"), {"ok.glb": b"glb", "../../escape.txt": b"x"})
        with self.assertRaises(ValueError):
            library.extract_zip(evil, self.root, "evil.zip")
        self.assertFalse(os.path.exists(os.path.join(self._tmp.name, "escape.txt")))
        self.assertEqual(os.listdir(self.root), [])
        with self.assertRaises(ValueError):
            library.extract_zip(os.path.join(self._tmp.name, "pics.zip"), self.root, "../up.zip")

    def test_import_zip_from_downloads(self):
        downloads = os.path.join(self._tmp.name, "Downloads")
        os.makedirs(downloads)
        make_zip(os.path.join(downloads, "robot.zip"), {"robot.glb": b"glb", "robot.png": b"png"})
        make_zip(os.path.join(downloads, "photos.zip"), {"a.png": b"png"})
        [item] = library.list_importable(downloads, self.root)
        self.assertEqual((item["name"], item["zip"], item["models"], item["imported"]), ("robot.zip", True, 1, False))
        added, errors = library.import_files(downloads, ["robot.zip"], self.root, move=True)
        self.assertEqual((added, errors), (["robot"], {}))
        self.assertTrue(os.path.exists(os.path.join(self.root, "robot", "robot.glb")))
        self.assertFalse(os.path.exists(os.path.join(downloads, "robot.zip")))

    def test_move_model_keeps_manifest_and_meta(self):
        touch(self.root, "20251009-120000_abc.glb")
        touch(self.root, "20251009-120000_abc_preview.webp")
        with open(os.path.join(self.root, "manifest.json"), "w") as handle:
            json.dump({"abc:GLB": {"task_id": "abc", "format": "GLB", "file": "20251009-120000_abc.glb"}}, handle)
        library.set_meta(self.root, "20251009-120000_abc.glb", favorite=True)
        files = ["20251009-120000_abc.glb", "20251009-120000_abc_preview.webp"]
        library.move_model(self.root, files, "game/props")
        [item] = viewer.build_index(self.root)
        self.assertEqual((item["folder"], item["task_id"], item["favorite"]), ("game/props", "abc", True))
        self.assertEqual(item["preview"], "game/props/20251009-120000_abc_preview.webp")
        with open(os.path.join(self.root, "manifest.json")) as handle:
            self.assertEqual(json.load(handle)["abc:GLB"]["file"], "game/props/20251009-120000_abc.glb")
        library.move_model(self.root, ["game/props/20251009-120000_abc.glb",
                                       "game/props/20251009-120000_abc_preview.webp"], "")
        self.assertTrue(os.path.exists(os.path.join(self.root, "20251009-120000_abc.glb")))

    def test_move_model_refuses_collisions_and_bad_folders(self):
        touch(self.root, "cat.glb")
        touch(self.root, "box/cat.glb")
        with self.assertRaises(ValueError):
            library.move_model(self.root, ["cat.glb"], "box")
        for bad in ("..", "a/../..", "x:y"):
            with self.assertRaises(ValueError):
                library.move_model(self.root, ["cat.glb"], bad)
        self.assertTrue(os.path.exists(os.path.join(self.root, "cat.glb")))

    def test_tags_are_cleaned_and_indexed(self):
        touch(self.root, "cat.glb")
        entry = library.set_meta(self.root, "cat.glb", tags=[" キャラ ", "キャラ", "", "Game", "game", "x" * 40])
        self.assertEqual(entry["tags"], ["キャラ", "Game", "x" * 30])
        [item] = viewer.build_index(self.root)
        self.assertEqual(item["tags"], ["キャラ", "Game", "x" * 30])
        library.set_meta(self.root, "cat.glb", tags=[])
        self.assertEqual(library.read_meta(self.root), {})

    def test_find_duplicates(self):
        touch(self.root, "a.glb", b"same bytes")
        touch(self.root, "studio/a copy.glb", b"same bytes")
        touch(self.root, "b.glb", b"other byte")  # same size, different content
        touch(self.root, "c.glb", b"unique")
        touch(self.root, ".trash/a.glb", b"same bytes")
        self.assertEqual(library.find_duplicates(self.root), [["a.glb", "studio/a copy.glb"]])

    def test_textures_are_listed_read_and_exported(self):
        glb, color, normal = textured_glb()
        touch(self.root, "robot.glb", glb)
        items = library.list_textures(self.root, "robot.glb")
        self.assertEqual([(t["index"], t["uses"], t["width"], t["height"], t["bytes"]) for t in items],
                         [(0, ["ベースカラー"], 512, 256, len(color)), (1, ["法線"], 64, 64, len(normal))])
        self.assertEqual(library.read_texture(self.root, "robot.glb", 1), (normal, "image/png"))
        folder = library.export_textures(self.root, "robot.glb")
        self.assertEqual(folder, "textures/robot")
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "textures", "robot"))),
                         ["01_ベースカラー.png", "02_法線.png"])
        touch(self.root, "plain.glb", make_glb(CUBE))
        with self.assertRaises(ValueError):
            library.export_textures(self.root, "plain.glb")

    def test_image_size_reads_jpeg_and_webp(self):
        jpeg = b"\xff\xd8" + b"\xff\xe0\x00\x04xx" + b"\xff\xc0\x00\x11\x08" + struct.pack(">HH", 300, 400) + b"\x00" * 8
        self.assertEqual(library.image_size(jpeg), (400, 300))
        vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x00" * 8 + (639).to_bytes(3, "little") + (479).to_bytes(3, "little")
        self.assertEqual(library.image_size(vp8x), (640, 480))
        self.assertIsNone(library.image_size(b"nothing"))

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

    def test_move_endpoint(self):
        touch(self.root, "cat.glb")
        status, res = self.call("POST", viewer.MOVE_PATH, json.dumps({"files": ["cat.glb"], "folder": "animals"}).encode())
        self.assertEqual((status, res), (200, {"moved": {"cat.glb": "animals/cat.glb"}}))

    def test_texture_and_duplicate_endpoints(self):
        glb, color, _ = textured_glb()
        touch(self.root, "robot.glb", glb)
        touch(self.root, "robot copy.glb", glb)
        listed = json.load(urllib.request.urlopen(self.base + viewer.TEXTURES_PATH + "?model=robot.glb"))
        self.assertEqual(len(listed["textures"]), 2)
        with urllib.request.urlopen(self.base + viewer.TEXTURE_PATH + "?model=robot.glb&index=0") as res:
            self.assertEqual((res.read(), res.headers["Content-Type"]), (color, "image/png"))
        dups = json.load(urllib.request.urlopen(self.base + viewer.DUPLICATES_PATH))
        self.assertEqual(dups["groups"], [["robot copy.glb", "robot.glb"]])
        status, res = self.call("POST", viewer.EXPORT_TEXTURES_PATH, b'{"model": "robot.glb"}')
        self.assertEqual((status, res), (200, {"folder": "textures/robot"}))

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
