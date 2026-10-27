import json
import math
import os
import struct
import tempfile
import unittest

from test_library import make_glb, make_png, touch
from tripo_export import convert

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

    def test_existing_output_is_not_overwritten(self):
        touch(self.root, "flat.glb", mesh_glb([{"mesh": 0}]))
        touch(self.root, "flat.stl", b"mine")
        self.assertEqual(convert.convert(self.root, "flat.glb", "stl"), "flat (2).stl")
        with open(os.path.join(self.root, "flat.stl"), "rb") as handle:
            self.assertEqual(handle.read(), b"mine")

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
