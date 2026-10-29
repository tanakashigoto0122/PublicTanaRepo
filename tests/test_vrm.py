"""VRM avatars (.vrm: a .glb with VRM extensions), built here from tiny synthetic models."""

import json
import os
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from rigged_sample import JOINTS, rigged_glb
from test_convert import mesh_glb, read_stl
from test_library import make_glb, make_png, touch
from tripo_export import convert, library, viewer

BONES = ["hips", "spine", "head", "leftUpperArm", "rightUpperArm", "leftUpperLeg", "rightUpperLeg"]


def split_glb(data):
    json_length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + json_length])
    binary = data[20 + json_length + 8:]
    return gltf, binary


def vrm0_meta(**changes):
    meta = {"title": "テストちゃん", "version": "1.0", "author": "作者A", "contactInformation": "https://example.com",
            "reference": "", "texture": 0, "allowedUserName": "Everyone", "violentUssageName": "Disallow",
            "sexualUssageName": "Disallow", "commercialUssageName": "Disallow", "otherPermissionUrl": "",
            "licenseName": "Redistribution_Prohibited", "otherLicenseUrl": ""}
    meta.update(changes)
    return meta


def vrm1_meta(**changes):
    meta = {"name": "Test Avatar", "version": "2", "authors": ["Author B", "Author C"], "licenseUrl": "https://vrm.dev/licenses/1.0/",
            "avatarPermission": "everyone", "commercialUsage": "personalProfit", "allowRedistribution": True,
            "modification": "allowModification", "creditNotation": "required", "thumbnailImage": 0}
    meta.update(changes)
    return meta


def make_vrm(spec="0.x", meta=None, joint_names=None, with_image=True):
    """A skinned humanoid (rigged_sample) with VRM extensions and, optionally, a thumbnail image."""
    gltf, binary = split_glb(rigged_glb(joint_names))
    if with_image:
        png = make_png(64, 64)
        binary += b"\0" * (-len(binary) % 4)
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(png)})
        binary += png + b"\0" * (-len(png) % 4)
        gltf["buffers"][0]["byteLength"] = len(binary)
        gltf["images"] = [{"bufferView": len(gltf["bufferViews"]) - 1, "mimeType": "image/png"}]
        gltf["textures"] = [{"source": 0}]
        gltf["materials"] = [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}]
        gltf["meshes"][0]["primitives"][0]["material"] = 0
    if spec == "0.x":
        meta = meta if meta is not None else vrm0_meta()
        bones = [{"bone": b, "node": i + 1} for i, b in enumerate(BONES)]
        gltf["extensions"] = {"VRM": {"specVersion": "0.0", "meta": meta, "humanoid": {"humanBones": bones}}}
        gltf["extensionsUsed"] = ["VRM"]
    else:
        meta = meta if meta is not None else vrm1_meta()
        bones = {b: {"node": i + 1} for i, b in enumerate(BONES)}
        gltf["extensions"] = {"VRMC_vrm": {"specVersion": "1.0", "meta": meta, "humanoid": {"humanBones": bones}}}
        gltf["extensionsUsed"] = ["VRMC_vrm"]
    return make_glb(gltf, binary)


class VrmLibraryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_vrm0_meta_and_license(self):
        touch(self.root, "avatar.vrm", make_vrm("0.x"))
        meta = library.vrm_meta(self.root, "avatar.vrm")
        self.assertEqual((meta["spec"], meta["title"], meta["authors"], meta["thumbnail"]),
                         ("0.x", "テストちゃん", ["作者A"], 0))
        self.assertIn(["ライセンス", "再配布禁止"], meta["license"])
        self.assertIn(["商用利用", "不可"], meta["license"])
        self.assertIn(["アバターとして使える人", "誰でも"], meta["license"])
        self.assertFalse(meta["redistribution"])
        self.assertNotIn("ライセンス URL", [label for label, _ in meta["license"]])  # empty fields are left out
        self.assertEqual(library.vrm_spec(os.path.join(self.root, "avatar.vrm")), "0.x")

    def test_vrm0_open_license_and_unknown_values(self):
        touch(self.root, "cc0.vrm", make_vrm("0.x", vrm0_meta(licenseName="CC0", commercialUssageName="Sometimes",
                                                               texture=-1)))
        meta = library.vrm_meta(self.root, "cc0.vrm")
        self.assertTrue(meta["redistribution"])
        self.assertIn(["商用利用", "Sometimes"], meta["license"])  # shown as written
        self.assertIsNone(meta["thumbnail"])

    def test_vrm1_meta_and_license(self):
        touch(self.root, "avatar.vrm", make_vrm("1.0"))
        meta = library.vrm_meta(self.root, "avatar.vrm")
        self.assertEqual((meta["spec"], meta["title"], meta["authors"], meta["thumbnail"]),
                         ("1.0", "Test Avatar", ["Author B", "Author C"], 0))
        self.assertIn(["再配布", "可"], meta["license"])
        self.assertIn(["商用利用", "個人なら営利も可"], meta["license"])
        self.assertIn(["ライセンス URL", "https://vrm.dev/licenses/1.0/"], meta["license"])
        self.assertTrue(meta["redistribution"])
        touch(self.root, "closed.vrm", make_vrm("1.0", vrm1_meta(allowRedistribution=False)))
        self.assertFalse(library.vrm_meta(self.root, "closed.vrm")["redistribution"])

    def test_plain_glb_is_not_a_vrm(self):
        touch(self.root, "plain.glb", mesh_glb([{"mesh": 0}]))
        self.assertIsNone(library.vrm_meta(self.root, "plain.glb"))
        self.assertIsNone(library.vrm_spec(os.path.join(self.root, "plain.glb")))
        touch(self.root, "broken.vrm", b"not a glb")
        self.assertIsNone(library.vrm_spec(os.path.join(self.root, "broken.vrm")))

    def test_stats_textures_and_rig(self):
        touch(self.root, "avatar.vrm", make_vrm("0.x", joint_names=[f"bone{i}" for i in range(len(JOINTS))]))
        stats = library.glb_stats(self.root, "avatar.vrm")
        self.assertEqual((stats["triangles"], stats["skins"], stats["textures"]), (12, 1, 1))
        [texture] = library.list_textures(self.root, "avatar.vrm")
        self.assertEqual((texture["width"], texture["uses"]), (64, ["ベースカラー", "サムネイル"]))
        # MToon textures referenced only from the VRM extensions still count as used.
        gltf, binary = split_glb(make_vrm("0.x"))
        gltf["extensions"]["VRM"]["materialProperties"] = [{"textureProperties": {"_ShadeTexture": 0}}]
        gltf["extensions"]["VRM"]["meta"]["texture"] = -1
        del gltf["materials"][0]["pbrMetallicRoughness"]
        touch(self.root, "toon0.vrm", make_glb(gltf, binary))
        self.assertEqual(library.list_textures(self.root, "toon0.vrm")[0]["uses"], ["影色"])
        gltf, binary = split_glb(make_vrm("1.0"))
        gltf["materials"][0] = {"extensions": {"VRMC_materials_mtoon": {"matcapTexture": {"index": 0}}}}
        gltf["extensions"]["VRMC_vrm"]["meta"].pop("thumbnailImage")
        touch(self.root, "toon1.vrm", make_glb(gltf, binary))
        self.assertEqual(library.list_textures(self.root, "toon1.vrm")[0]["uses"], ["マットキャップ"])
        # Joint names say nothing, but the VRM's own bone map makes it humanoid.
        rig = convert.rig_info(self.root, "avatar.vrm")
        self.assertEqual((rig["humanoid"], rig["style"], len(rig["joints"])), (True, "VRM", 7))
        gltf, binary = split_glb(make_vrm("1.0"))
        del gltf["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]["head"]
        touch(self.root, "headless.vrm", make_glb(gltf, binary))
        rig = convert.rig_info(self.root, "headless.vrm")
        self.assertEqual((rig["humanoid"], rig["missing"]), (False, ["head"]))

    def test_index_lists_vrm_as_viewable(self):
        touch(self.root, "a/avatar.vrm", make_vrm("0.x"))
        touch(self.root, "new.vrm", make_vrm("1.0"))
        touch(self.root, "cat.glb", mesh_glb([{"mesh": 0}]))
        items = {i["key"]: i for i in viewer.build_index(self.root)}
        self.assertEqual(items["a/avatar.vrm"]["model"], "a/avatar.vrm")
        self.assertEqual(items["a/avatar.vrm"]["files"][0]["format"], "VRM")
        self.assertEqual((items["a/avatar.vrm"]["vrm"], items["new.vrm"]["vrm"], items["cat.glb"]["vrm"]),
                         ("0.x", "1.0", None))
        self.assertTrue(library.is_model_file("x.VRM"))

    def test_stl_conversion_and_texture_lite_keep_vrm(self):
        touch(self.root, "avatar.vrm", make_vrm("1.0"))
        self.assertEqual(len(read_stl(os.path.join(self.root, convert.convert(self.root, "avatar.vrm", "stl")))), 12)
        lite = library.replace_images(self.root, "avatar.vrm", {0: (make_png(16, 16), "image/png")})
        self.assertEqual(lite, "avatar_lite.vrm")
        self.assertEqual(library.vrm_meta(self.root, lite)["title"], "Test Avatar")
        self.assertEqual(library.list_textures(self.root, lite)[0]["width"], 16)
        self.assertEqual(library.glb_stats(self.root, lite)["triangles"], 12)

    @unittest.skipUnless(convert.gltfpack_path(), "gltfpack is not installed here (the exe bundles it)")
    def test_simplify_vrm_writes_a_plain_glb(self):
        touch(self.root, "avatar.vrm", make_vrm("0.x"))
        rel = convert.simplify(self.root, "avatar.vrm", 0.5)
        self.assertEqual(rel, "avatar_lite.glb")
        self.assertEqual(library.glb_stats(self.root, rel)["skins"], 1)
        self.assertEqual(sorted(os.listdir(self.root)), ["avatar.vrm", "avatar_lite.glb"])  # no temp copies left

    def test_send_to_unity_copies_vrm(self):
        project = os.path.join(self.root, "Game")
        os.makedirs(os.path.join(project, "Assets", "TripoGame"))
        touch(self.root, "avatar.vrm", b"vrm")
        self.assertEqual(library.send_to_unity(self.root, ["avatar.vrm"], project),
                         ["Assets/TripoGame/Characters/avatar.vrm"])


class VrmServerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.server = viewer.make_server(self.root, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = self.server.url.rstrip("/")

    def tearDown(self):
        viewer.stop_share()
        self.server.shutdown()
        self.server.server_close()
        self._tmp.cleanup()

    def get(self, url):
        try:
            with urllib.request.urlopen(url) as res:
                return res.status, res.headers.get("Content-Type"), res.read()
        except urllib.error.HTTPError as err:
            with err:
                return err.code, err.headers.get("Content-Type"), err.read()

    def test_meta_thumbnail_and_file(self):
        data = make_vrm("0.x")
        touch(self.root, "avatar.vrm", data)
        touch(self.root, "nothumb.vrm", make_vrm("0.x", vrm0_meta(texture=-1)))
        status, _, body = self.get(self.base + viewer.VRM_PATH + "?model=avatar.vrm")
        self.assertEqual((status, json.loads(body)["vrm"]["title"]), (200, "テストちゃん"))
        self.assertEqual(self.get(self.base + viewer.VRM_THUMBNAIL_PATH + "?model=avatar.vrm"),
                         (200, "image/png", make_png(64, 64)))
        self.assertEqual(self.get(self.base + viewer.VRM_THUMBNAIL_PATH + "?model=nothumb.vrm")[0], 404)
        self.assertEqual(self.get(self.base + viewer.VRM_PATH + "?model=../x.vrm")[0], 400)
        self.assertEqual(self.get(self.base + "/avatar.vrm"), (200, "model/gltf-binary", data))

    def test_share_turns_vrm0_round(self):
        touch(self.root, "old.vrm", make_vrm("0.x"))
        touch(self.root, "new.vrm", make_vrm("1.0"))
        page = self.get(viewer.start_share(self.root, "old.vrm", "a", host="127.0.0.1")["url"])[2].decode()
        self.assertIn('orientation="0deg 0deg 180deg"', page)
        url = viewer.start_share(self.root, "new.vrm", "b", host="127.0.0.1")["url"]
        self.assertIn('orientation="0deg 0deg 0deg"', self.get(url)[2].decode())
        self.assertEqual(self.get(url + "model.glb")[2], make_vrm("1.0"))


if __name__ == "__main__":
    unittest.main()
