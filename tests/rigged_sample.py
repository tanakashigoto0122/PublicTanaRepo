"""A tiny skinned humanoid .glb for tests: Mixamo-style joints and one box skinned to the hips."""

import json
import struct

# name, parent index, local translation (metres)
JOINTS = [
    ("mixamorig:Hips", None, (0, 1.0, 0)),
    ("mixamorig:Spine", 0, (0, 0.2, 0)),
    ("mixamorig:Head", 1, (0, 0.4, 0)),
    ("mixamorig:LeftArm", 1, (0.2, 0.3, 0)),
    ("mixamorig:RightArm", 1, (-0.2, 0.3, 0)),
    ("mixamorig:LeftUpLeg", 0, (0.1, -0.1, 0)),
    ("mixamorig:RightUpLeg", 0, (-0.1, -0.1, 0)),
]


def rigged_glb(names=None):
    names = names or [j[0] for j in JOINTS]
    s = 0.15
    pos = [(x * s, 1.0 + y * s * 2, z * s) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    tris = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]
    world = []
    for _name, parent, (x, y, z) in JOINTS:
        px, py, pz = world[parent] if parent is not None else (0, 0, 0)
        world.append((px + x, py + y, pz + z))
    ibm = b"".join(struct.pack("<16f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1) for x, y, z in world)
    blobs = [b"".join(struct.pack("<3f", *p) for p in pos),
             b"".join(struct.pack("<4B", 0, 0, 0, 0) for _ in pos),
             b"".join(struct.pack("<4f", 1, 0, 0, 0) for _ in pos),
             b"".join(struct.pack("<H", i) for i in tris), ibm]
    views, binary = [], b""
    for blob in blobs:
        binary += b"\0" * (-len(binary) % 4)
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(blob)})
        binary += blob
    binary += b"\0" * (-len(binary) % 4)
    nodes = [{"name": "Body", "mesh": 0, "skin": 0}]
    for (_n, parent, t), name in zip(JOINTS, names):
        nodes.append({"name": name, "translation": list(t), "children": []})
    for i, (_n, parent, _t) in enumerate(JOINTS):
        if parent is not None:
            nodes[parent + 1]["children"].append(i + 1)
    gltf = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": nodes,
        "skins": [{"joints": list(range(1, len(JOINTS) + 1)), "inverseBindMatrices": 4, "skeleton": 1}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}, "indices": 3}]}],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views,
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3",
                       "min": [-s, 1 - 2 * s, -s], "max": [s, 1 + 2 * s, s]},
                      {"bufferView": 1, "componentType": 5121, "count": 8, "type": "VEC4"},
                      {"bufferView": 2, "componentType": 5126, "count": 8, "type": "VEC4"},
                      {"bufferView": 3, "componentType": 5123, "count": len(tris), "type": "SCALAR"},
                      {"bufferView": 4, "componentType": 5126, "count": len(JOINTS), "type": "MAT4"}],
    }
    text = json.dumps(gltf).encode()
    text += b" " * (-len(text) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


if __name__ == "__main__":
    import sys
    with open(sys.argv[1], "wb") as handle:
        handle.write(rigged_glb())
