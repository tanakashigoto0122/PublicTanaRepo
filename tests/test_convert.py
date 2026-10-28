import json
import math
import os
import struct
import tempfile
import unittest
from unittest import mock

from rigged_sample import JOINTS, rigged_glb
from test_library import make_glb, make_png, touch
from tripo_export import convert, library

# A unit square in the XZ plane (two triangles), facing +Y.
SQUARE = [(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)]
SQUARE_INDICES = [0, 2, 1, 0, 3, 2]


def mesh_glb(nodes, indices=SQUARE_INDICES, mode=None, extra=None, image=None):
    """A .glb whose single mesh is SQUARE (with UVs), drawn by ``nodes``."""
    pos = b"".join(struct.pack("<3f", *p) for p in SQUARE)
    uvs = b"".join(struct.pack("<2f", *uv) for uv in [(0, 0), (1, 0), (1, 1), (0, 1)])
    idx = b"".join(struct.pack("<H", i) for i in indices)
    idx += b"\0" * (-len(idx) % 4)
    blobs = [pos, uvs, idx] + ([image] if image else [])
    views, binary = [], b""
    for blob in blobs:
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(blob)})
        binary += blob + b"\0" * (-len(blob) % 4)
    prim = {"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}
    if mode is not None:
        prim["mode"] = mode
    material = {"pbrMetallicRoughness": {"baseColorFactor": [1, 0.5, 0.25, 1]}}
    gltf = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
        "meshes": [{"primitives": [prim]}], "materials": [material],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views,
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3"},
                      {"bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC2"},
                      {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"}],
    }
    if image:
        gltf["images"] = [{"bufferView": 3, "mimeType": "image/png"}]
        gltf["textures"] = [{"source": 0}]
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    gltf.update(extra or {})
    return make_glb(gltf, binary)


def read_stl(path):
    with open(path, "rb") as handle:
        data = handle.read()
    count = struct.unpack("<I", data[80:84])[0]
    self_len = 84 + 50 * count
    assert len(data) == self_len, (len(data), self_len)
    return [struct.unpack_from("<12f", data, 84 + 50 * i) for i in range(count)]


def bump_glb(height=0.2):
    """A 40x40 grid of quads (3200 triangles) with a bump, so there is something to simplify."""
    n = 41
    pos = [(i / (n - 1) - 0.5, height * math.exp(-((i - 20) ** 2 + (j - 20) ** 2) / 60), j / (n - 1) - 0.5)
           for j in range(n) for i in range(n)]
    idx = [k for j in range(n - 1) for i in range(n - 1)
           for k in (j * n + i, (j + 1) * n + i, j * n + i + 1, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1)]
    binary = b"".join(struct.pack("<3f", *p) for p in pos)
    indices = b"".join(struct.pack("<I", k) for k in idx)
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
            "buffers": [{"byteLength": len(binary) + len(indices)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(binary)},
                            {"buffer": 0, "byteOffset": len(binary), "byteLength": len(indices)}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
                           "min": [-0.5, 0, -0.5], "max": [0.5, height, 0.5]},
                          {"bufferView": 1, "componentType": 5125, "count": len(idx), "type": "SCALAR"}]}
    return make_glb(gltf, binary + indices)


class ConvertTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_stl_applies_node_transforms_and_sits_on_the_bed(self):
        # Parent scaled x2, child rotated 90 degrees about X (square stands up) and lifted 1 m.
        half = math.sqrt(0.5)
        nodes = [{"scale": [2, 2, 2], "children": [1]},
                 {"mesh": 0, "rotation": [half, 0, 0, half], "translation": [0, 1, 0]}]
        touch(self.root, "stand.glb", mesh_glb(nodes))
        rel = convert.convert(self.root, "stand.glb", "STL")
        self.assertEqual(rel, "stand.stl")
        tris = read_stl(os.path.join(self.root, "stand.stl"))
        self.assertEqual(len(tris), 2)
        xs = [v for t in tris for v in t[3::3]]
        ys = [v for t in tris for v in t[4::3]]
        zs = [v for t in tris for v in t[5::3]]
        # 1 m square scaled to 2 m, standing upright: 2000 mm wide (X) and tall (Z), flat in Y.
        self.assertAlmostEqual(max(xs) - min(xs), 2000, places=2)
        self.assertAlmostEqual(max(zs) - min(zs), 2000, places=2)
        self.assertAlmostEqual(max(ys) - min(ys), 0, places=2)
        self.assertAlmostEqual(min(zs), 0, places=2)
        self.assertAlmostEqual(min(xs) + max(xs), 0, places=2)

    def test_stl_normals_follow_the_winding(self):
        touch(self.root, "flat.glb", mesh_glb([{"mesh": 0}]))
        tris = read_stl(os.path.join(self.root, convert.convert(self.root, "flat.glb", "stl")))
        for t in tris:
            # glTF +Y (up) becomes STL +Z.
            self.assertAlmostEqual(t[2], 1.0, places=5)

    def test_triangle_strips_and_fans(self):
        touch(self.root, "strip.glb", mesh_glb([{"mesh": 0}], indices=[0, 1, 3, 2], mode=convert.TRIANGLE_STRIP))
        self.assertEqual(len(read_stl(os.path.join(self.root, convert.convert(self.root, "strip.glb", "stl")))), 2)
        touch(self.root, "fan.glb", mesh_glb([{"mesh": 0}], indices=[0, 1, 2, 3], mode=convert.TRIANGLE_FAN))
        self.assertEqual(len(read_stl(os.path.join(self.root, convert.convert(self.root, "fan.glb", "stl")))), 2)

    def test_obj_has_materials_uvs_and_texture(self):
        touch(self.root, "tile.glb", mesh_glb([{"mesh": 0}], image=make_png(8, 8)))
        folder = convert.convert(self.root, "tile.glb", "obj")
        self.assertEqual(folder, "tile_obj")
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, folder))),
                         ["tile.mtl", "tile.obj", "tile_tex0.png"])
        with open(os.path.join(self.root, folder, "tile.obj")) as handle:
            obj = handle.read().splitlines()
        self.assertEqual(sum(1 for line in obj if line.startswith("v ")), 4)
        self.assertEqual(sum(1 for line in obj if line.startswith("vt ")), 4)
        self.assertIn("f 1/1 3/3 2/2", obj)
        self.assertIn("vt 1.000000 0.000000", obj)  # V flipped: glTF (1, 1) is OBJ (1, 0)
        with open(os.path.join(self.root, folder, "tile.mtl")) as handle:
            mtl = handle.read()
        self.assertIn("Kd 1.0000 0.5000 0.2500", mtl)
        self.assertIn("map_Kd tile_tex0.png", mtl)

    @unittest.skipUnless(convert.gltfpack_path(), "gltfpack is not installed here (the exe bundles it)")
    def test_preview_copy_is_cached_outside_the_folder(self):
        cache = os.path.join(self.root, "cache")
        touch(self.root, "bump.glb", bump_glb())
        with mock.patch.object(convert, "preview_dir", return_value=cache), \
             mock.patch.object(convert, "PREVIEW_KEEP", 1):
            light = convert.preview_copy(self.root, "bump.glb", max_triangles=800)
            self.assertEqual(os.path.dirname(light), cache)
            self.assertLess(library.glb_stats(cache, os.path.basename(light))["triangles"], 1600)
            self.assertEqual(convert.preview_copy(self.root, "bump.glb", max_triangles=800), light)  # reused
            # Light enough already: the model itself.
            self.assertEqual(convert.preview_copy(self.root, "bump.glb", max_triangles=5000),
                             os.path.join(self.root, "bump.glb"))
            # A changed model gets a new copy, and only the newest PREVIEW_KEEP copies stay.
            touch(self.root, "bump.glb", bump_glb(height=0.3))
            newer = convert.preview_copy(self.root, "bump.glb", max_triangles=800)
            self.assertNotEqual(newer, light)
            self.assertEqual(os.listdir(cache), [os.path.basename(newer)])
        self.assertEqual(sorted(os.listdir(self.root)), ["bump.glb", "cache"])  # nothing else in the folder

    def test_existing_output_is_not_overwritten(self):
        touch(self.root, "flat.glb", mesh_glb([{"mesh": 0}]))
        touch(self.root, "flat.stl", b"mine")
        self.assertEqual(convert.convert(self.root, "flat.glb", "stl"), "flat (2).stl")
        with open(os.path.join(self.root, "flat.stl"), "rb") as handle:
            self.assertEqual(handle.read(), b"mine")

    def test_lite_copy_swaps_images_and_keeps_geometry(self):
        touch(self.root, "tile.glb", mesh_glb([{"mesh": 0}], image=make_png(2048, 2048)))
        small = make_png(512, 512) + b"smaller image data"
        rel = library.replace_images(self.root, "tile.glb", {0: (small, "image/png")})
        self.assertEqual(rel, "tile_lite.glb")
        [texture] = library.list_textures(self.root, "tile_lite.glb")
        self.assertEqual((texture["width"], texture["bytes"]), (512, len(small)))
        self.assertEqual(library.read_texture(self.root, "tile_lite.glb", 0), (small, "image/png"))
        original = convert.Gltf(self.root, "tile.glb")
        lite = convert.Gltf(self.root, "tile_lite.glb")
        for index in range(3):  # positions, UVs and indices are unchanged
            self.assertEqual(original.accessor(index), lite.accessor(index))
        self.assertEqual(len(read_stl(os.path.join(self.root, convert.convert(self.root, "tile_lite.glb", "stl")))), 2)
        with self.assertRaises(ValueError):
            library.replace_images(self.root, "tile.glb", {0: (b"not an image", "image/png")})
        with self.assertRaises(ValueError):
            library.replace_images(self.root, "tile.glb", {5: (small, "image/png")})

    @unittest.skipUnless(convert.gltfpack_path(), "gltfpack is not installed here (the exe bundles it)")
    def test_simplify_reduces_triangles_and_lite_copy_can_shrink_in_place(self):
        touch(self.root, "bump.glb", bump_glb())
        rel = convert.simplify(self.root, "bump.glb", 0.25)
        self.assertEqual(rel, "bump_lite.glb")
        before = library.glb_stats(self.root, "bump.glb")["triangles"]
        after = library.glb_stats(self.root, rel)["triangles"]
        self.assertEqual(before, 3200)
        self.assertLess(after, before * 0.6)
        self.assertGreater(after, 0)
        self.assertEqual(convert.simplify(self.root, "bump.glb", 0.5), "bump_lite (2).glb")
        with self.assertRaises(ValueError):
            convert.simplify(self.root, "bump.glb", 1.5)

    def test_in_place_rewrite_only_for_lite_copies(self):
        touch(self.root, "tile.glb", mesh_glb([{"mesh": 0}], image=make_png(64, 64)))
        small = make_png(16, 16)
        with self.assertRaises(ValueError):
            library.replace_images(self.root, "tile.glb", {0: (small, "image/png")}, in_place=True)
        lite = library.replace_images(self.root, "tile.glb", {0: (make_png(32, 32), "image/png")})
        self.assertEqual(library.replace_images(self.root, lite, {0: (small, "image/png")}, in_place=True), lite)
        self.assertEqual(library.list_textures(self.root, lite)[0]["width"], 16)
        self.assertEqual(sorted(os.listdir(self.root)), ["tile.glb", "tile_lite.glb"])

    def test_rig_info_reads_joints_and_recognises_a_humanoid(self):
        touch(self.root, "hero.glb", rigged_glb())
        rig = convert.rig_info(self.root, "hero.glb")
        self.assertEqual((rig["skins"], len(rig["joints"]), rig["humanoid"], rig["style"]), (1, 7, True, "Mixamo"))
        head = next(j for j in rig["joints"] if j["name"].endswith("Head"))
        self.assertEqual(head["position"], [0, 1.6, 0])  # hips 1.0 + spine 0.2 + head 0.4
        self.assertEqual(rig["joints"][head["parent"]]["name"], "mixamorig:Spine")
        self.assertIsNone(rig["joints"][0]["parent"])

    def test_rig_info_names_from_other_tools(self):
        vrm = ["J_Bip_C_Hips", "J_Bip_C_Spine", "J_Bip_C_Head", "J_Bip_L_UpperArm", "J_Bip_R_UpperArm",
               "J_Bip_L_UpperLeg", "J_Bip_R_UpperLeg"]
        touch(self.root, "vrm.glb", rigged_glb(vrm))
        self.assertEqual(convert.rig_info(self.root, "vrm.glb")["style"], "VRM / Unity")
        self.assertTrue(convert.rig_info(self.root, "vrm.glb")["humanoid"])
        tail = ["root", "bone1", "bone2", "bone3", "bone4", "bone5", "bone6"]
        touch(self.root, "snake.glb", rigged_glb(tail))
        rig = convert.rig_info(self.root, "snake.glb")
        self.assertFalse(rig["humanoid"])
        self.assertIn("head", rig["missing"])
        touch(self.root, "flat.glb", mesh_glb([{"mesh": 0}]))
        self.assertEqual(convert.rig_info(self.root, "flat.glb")["skins"], 0)

    def test_mixamo_zip_holds_obj_mtl_and_textures(self):
        import zipfile
        touch(self.root, "tile.glb", mesh_glb([{"mesh": 0}], image=make_png(8, 8)))
        rel = convert.convert(self.root, "tile.glb", "mixamo")
        self.assertEqual(rel, "tile_mixamo.zip")
        with zipfile.ZipFile(os.path.join(self.root, rel)) as archive:
            self.assertEqual(sorted(archive.namelist()), ["tile.mtl", "tile.obj", "tile_tex0.png"])
        self.assertEqual(sorted(os.listdir(self.root)), ["tile.glb", "tile_mixamo.zip"])

    def test_compressed_and_unsupported_inputs_are_refused(self):
        touch(self.root, "draco.glb", mesh_glb([{"mesh": 0}], extra={"extensionsRequired": ["KHR_draco_mesh_compression"]}))
        with self.assertRaisesRegex(ValueError, "Draco"):
            convert.convert(self.root, "draco.glb", "stl")
        touch(self.root, "chair.fbx", b"fbx")
        with self.assertRaises(ValueError):
            convert.convert(self.root, "chair.fbx", "stl")
        touch(self.root, "flat.glb", mesh_glb([{"mesh": 0}]))
        with self.assertRaises(ValueError):
            convert.convert(self.root, "flat.glb", "ply")


if __name__ == "__main__":
    unittest.main()
