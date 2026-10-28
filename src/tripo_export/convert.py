"""Converting a .glb/.gltf to STL (for 3D printing) or OBJ, on this PC, without using credits.

Only the standard library is used. Meshes are read through their accessors with every node's
transform applied, so the output matches what the viewer shows. Compressed meshes (Draco,
meshopt) cannot be read and are reported as such.
"""

import hashlib
import math
import os
import struct
import tempfile
from array import array
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from . import library

_COMPONENTS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
_NORMALIZE = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_COMPRESSED = ("KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression")
TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN = 4, 5, 6
Matrix = List[float]  # 4x4, column-major like glTF


class Gltf:
    """A parsed glTF with its binary buffers loaded."""

    def __init__(self, root: str, model: str):
        self.path = library.safe_path(root, model)
        self.root, self.model = root, model
        self.json = library._gltf_json(self.path)
        used = set(self.json.get("extensionsUsed") or []) | set(self.json.get("extensionsRequired") or [])
        if used & set(_COMPRESSED):
            raise ValueError("圧縮されたモデル（Draco / meshopt）は変換できません。"
                             "Tripo で圧縮なし（compress なし）の GLB を使ってください")
        self.buffers = [self._load_buffer(i, b) for i, b in enumerate(self.json.get("buffers") or [])]

    def _load_buffer(self, index: int, buffer: Dict[str, Any]) -> bytes:
        uri = buffer.get("uri")
        if uri is None:
            if not self.path.lower().endswith(".glb") or index != 0:
                raise ValueError("バッファが見つかりません")
            with open(self.path, "rb") as handle:
                handle.seek(library._glb_bin_offset(self.path))
                return handle.read(buffer["byteLength"])
        if uri.startswith("data:"):
            import base64
            return base64.b64decode(uri.partition(",")[2])
        folder = os.path.dirname(self.model)
        with open(library.safe_path(self.root, f"{folder}/{uri}" if folder else uri), "rb") as handle:
            return handle.read()

    def accessor(self, index: int) -> List[Tuple[float, ...]]:
        """An accessor's elements as tuples of numbers (normalized integers become 0..1 / -1..1)."""
        acc = self.json["accessors"][index]
        if "bufferView" not in acc:
            raise ValueError("中身のない（sparse だけの）アクセサーには対応していません")
        view = self.json["bufferViews"][acc["bufferView"]]
        code = _COMPONENTS[acc["componentType"]]
        width = _WIDTH[acc["type"]]
        count = acc["count"]
        size = struct.calcsize(code)
        stride = view.get("byteStride") or size * width
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        data = self.buffers[view.get("buffer", 0)]
        if stride == size * width:
            flat = array(code)
            flat.frombytes(data[start:start + count * stride])
            if flat.itemsize != size:  # array codes can differ in size from struct codes on some platforms
                flat = array(code, struct.unpack(f"<{count * width}{code}", data[start:start + count * stride]))
        else:
            row = struct.Struct(f"<{width}{code}")
            flat = array("d")
            for i in range(count):
                flat.extend(row.unpack_from(data, start + i * stride))
        if acc.get("normalized") and acc["componentType"] in _NORMALIZE:
            scale = _NORMALIZE[acc["componentType"]]
            values = [max(v / scale, -1.0) for v in flat]
        else:
            values = list(flat)
        return [tuple(values[i:i + width]) for i in range(0, len(values), width)]


def _multiply(a: Matrix, b: Matrix) -> Matrix:
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _local_matrix(node: Dict[str, Any]) -> Matrix:
    if "matrix" in node:
        return list(map(float, node["matrix"]))
    tx, ty, tz = node.get("translation", (0, 0, 0))
    qx, qy, qz, qw = node.get("rotation", (0, 0, 0, 1))
    sx, sy, sz = node.get("scale", (1, 1, 1))
    rot = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
           2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
           2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)]
    return [rot[0] * sx, rot[1] * sx, rot[2] * sx, 0, rot[3] * sy, rot[4] * sy, rot[5] * sy, 0,
            rot[6] * sz, rot[7] * sz, rot[8] * sz, 0, tx, ty, tz, 1]


_IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _mesh_nodes(gltf: Dict[str, Any]) -> Iterator[Tuple[int, Matrix]]:
    """(mesh index, world matrix) for every mesh instance in the default scene."""
    nodes = gltf.get("nodes") or []
    scenes = gltf.get("scenes") or []
    if scenes:
        roots = scenes[gltf.get("scene", 0)].get("nodes") or []
    else:
        children = {c for n in nodes for c in n.get("children") or []}
        roots = [i for i in range(len(nodes)) if i not in children]
    stack = [(i, _IDENTITY) for i in roots]
    while stack:
        index, parent = stack.pop()
        node = nodes[index]
        world = _multiply(parent, _local_matrix(node))
        if "mesh" in node:
            yield node["mesh"], world
        stack.extend((c, world) for c in node.get("children") or [])


def _apply(m: Matrix, p: Sequence[float], w: float = 1.0) -> Tuple[float, float, float]:
    x, y, z = p[0], p[1], p[2]
    return (m[0] * x + m[4] * y + m[8] * z + m[12] * w,
            m[1] * x + m[5] * y + m[9] * z + m[13] * w,
            m[2] * x + m[6] * y + m[10] * z + m[14] * w)


def _triangles(indices: List[int], mode: int) -> List[Tuple[int, int, int]]:
    if mode == TRIANGLES:
        return [(indices[i], indices[i + 1], indices[i + 2]) for i in range(0, len(indices) - 2, 3)]
    if mode == TRIANGLE_STRIP:
        return [(indices[i], indices[i + 1], indices[i + 2]) if i % 2 == 0 else (indices[i + 1], indices[i], indices[i + 2])
                for i in range(len(indices) - 2)]
    if mode == TRIANGLE_FAN:
        return [(indices[0], indices[i], indices[i + 1]) for i in range(1, len(indices) - 1)]
    return []  # points and lines have no surface


class Part:
    """One drawn primitive in world space: positions, optional normals/UVs, triangles, material."""

    def __init__(self, positions, normals, uvs, triangles, material):
        self.positions, self.normals, self.uvs = positions, normals, uvs
        self.triangles, self.material = triangles, material


def read_parts(g: Gltf) -> List[Part]:
    parts = []
    for mesh_index, world in _mesh_nodes(g.json):
        # Normals go through the inverse transpose; for the rotations and scales in practice
        # re-normalizing after the linear part is close enough.
        for prim in g.json["meshes"][mesh_index].get("primitives") or []:
            attrs = prim.get("attributes") or {}
            if "POSITION" not in attrs:
                continue
            positions = [_apply(world, p) for p in g.accessor(attrs["POSITION"])]
            indices = ([int(i[0]) for i in g.accessor(prim["indices"])] if "indices" in prim
                       else list(range(len(positions))))
            triangles = _triangles(indices, prim.get("mode", TRIANGLES))
            if not triangles:
                continue
            normals = None
            if "NORMAL" in attrs:
                normals = []
                for n in g.accessor(attrs["NORMAL"]):
                    x, y, z = _apply(world, n, 0.0)
                    length = math.sqrt(x * x + y * y + z * z) or 1.0
                    normals.append((x / length, y / length, z / length))
            uvs = [tuple(uv[:2]) for uv in g.accessor(attrs["TEXCOORD_0"])] if "TEXCOORD_0" in attrs else None
            parts.append(Part(positions, normals, uvs, triangles, prim.get("material")))
    if not parts:
        raise ValueError("変換できる三角形がありません")
    return parts


def _output_path(root: str, model: str, suffix: str) -> str:
    stem = os.path.splitext(model)[0]
    return library.unique_path(library.safe_path(root, stem + suffix))


def to_stl(root: str, model: str) -> str:
    """Binary STL in millimetres, Z up, centred on X/Y and resting on Z = 0 (ready for a slicer)."""
    parts = read_parts(Gltf(root, model))
    # glTF is Y-up in metres; printers expect Z-up in millimetres.
    points = [[(x * 1000.0, -z * 1000.0, y * 1000.0) for x, y, z in part.positions] for part in parts]
    xs = [p[0] for pts in points for p in pts]
    ys = [p[1] for pts in points for p in pts]
    zs = [p[2] for pts in points for p in pts]
    shift = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs))
    count = sum(len(part.triangles) for part in parts)
    path = _output_path(root, model, ".stl")
    with open(path, "wb") as handle:
        handle.write(b"tripo-export STL (mm)".ljust(80, b" "))
        handle.write(struct.pack("<I", count))
        record = struct.Struct("<12fH")
        for part, pts in zip(parts, points):
            moved = [(x - shift[0], y - shift[1], z - shift[2]) for x, y, z in pts]
            for a, b, c in part.triangles:
                p, q, r = moved[a], moved[b], moved[c]
                u = (q[0] - p[0], q[1] - p[1], q[2] - p[2])
                v = (r[0] - p[0], r[1] - p[1], r[2] - p[2])
                n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
                handle.write(record.pack(n[0] / length, n[1] / length, n[2] / length, *p, *q, *r, 0))
    return library._rel(root, path)


def to_obj(root: str, model: str) -> str:
    """OBJ + MTL (metres, Y up) in a new folder, with each material's base color texture."""
    g = Gltf(root, model)
    parts = read_parts(g)
    folder = _output_path(root, model, "_obj")
    os.makedirs(folder)
    name = os.path.splitext(os.path.basename(model))[0]
    materials = g.json.get("materials") or []
    textures = g.json.get("textures") or []
    mtl_lines, written_images = [], {}
    for index, material in enumerate(materials):
        pbr = material.get("pbrMetallicRoughness") or {}
        r, gr, b, a = pbr.get("baseColorFactor", (1, 1, 1, 1))
        mtl_lines += [f"newmtl material_{index}", f"Kd {r:.4f} {gr:.4f} {b:.4f}", f"d {a:.4f}",
                      "Ka 0 0 0", "Ks 0 0 0", "illum 1"]
        ref = pbr.get("baseColorTexture")
        source = textures[ref["index"]].get("source") if ref and ref.get("index", -1) < len(textures) else None
        if source is not None:
            if source not in written_images:
                data, mime = library.read_texture(root, model, source)
                image_name = f"{name}_tex{source}{library._MIME_EXT.get(mime, '.png')}"
                with open(os.path.join(folder, image_name), "wb") as handle:
                    handle.write(data)
                written_images[source] = image_name
            mtl_lines.append(f"map_Kd {written_images[source]}")
        mtl_lines.append("")
    with open(os.path.join(folder, name + ".mtl"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(mtl_lines) + "\n")
    with open(os.path.join(folder, name + ".obj"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"# tripo-export OBJ (metres, Y up)\nmtllib {name}.mtl\n")
        base = 1
        for number, part in enumerate(parts):
            handle.write(f"o part_{number}\n")
            if part.material is not None:
                handle.write(f"usemtl material_{part.material}\n")
            handle.writelines(f"v {x:.6f} {y:.6f} {z:.6f}\n" for x, y, z in part.positions)
            if part.uvs:
                handle.writelines(f"vt {u:.6f} {1 - v:.6f}\n" for u, v in part.uvs)  # OBJ's V points up
            if part.normals:
                handle.writelines(f"vn {x:.6f} {y:.6f} {z:.6f}\n" for x, y, z in part.normals)

            def ref(i: int) -> str:
                n = i + base
                if part.uvs and part.normals:
                    return f"{n}/{n}/{n}"
                if part.uvs:
                    return f"{n}/{n}"
                return f"{n}//{n}" if part.normals else str(n)

            handle.writelines(f"f {ref(a)} {ref(b)} {ref(c)}\n" for a, b, c in part.triangles)
            base += len(part.positions)
    return library._rel(root, folder)


def convert(root: str, model: str, fmt: str) -> str:
    if os.path.splitext(model)[1].lower() not in library.VIEWABLE:
        raise ValueError("変換できるのは GLB / glTF だけです")
    fmt = fmt.lower()
    if fmt == "stl":
        return to_stl(root, model)
    if fmt == "obj":
        return to_obj(root, model)
    if fmt == "mixamo":
        return to_mixamo_zip(root, model)
    raise ValueError(f"対応していない形式です: {fmt}")


# ---- Polygon reduction with gltfpack (meshoptimizer) ----------------------------------------

GLTFPACK_ENV = "TRIPO_GLTFPACK"


def gltfpack_path() -> Optional[str]:
    """gltfpack: $TRIPO_GLTFPACK, the copy bundled in vendor/ (the exe has one), or PATH."""
    import shutil

    candidates = [os.environ.get(GLTFPACK_ENV),
                  os.path.join(os.path.dirname(__file__), "vendor", "gltfpack.exe" if os.name == "nt" else "gltfpack"),
                  shutil.which("gltfpack")]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def simplify(root: str, model: str, ratio: float) -> str:
    """Write ``<stem>_lite.glb`` with about ``ratio`` of the triangles (0 < ratio < 1).

    gltfpack keeps UV seams and normals sensible and stops early rather than wrecking the shape
    (its default 1% error limit), so the result can keep somewhat more than asked for.
    ``-noq`` keeps plain float attributes so every loader (and convert.py) can read the file.
    """
    import subprocess

    path = library.safe_path(root, model)
    if os.path.splitext(path)[1].lower() not in library.VIEWABLE:
        raise ValueError("ポリゴン削減できるのは GLB / glTF だけです")
    if not 0 < ratio < 1:
        raise ValueError("残す割合は 0 より大きく 1 より小さくしてください")
    tool = gltfpack_path()
    if not tool:
        raise ValueError("ポリゴン削減のツール（gltfpack）が見つかりません")
    target = library.unique_path(os.path.splitext(path)[0] + library.LITE_SUFFIX + ".glb")
    _gltfpack(tool, path, target, ratio)
    return library._rel(root, target)


def _gltfpack(tool: str, source: str, target: str, ratio: float) -> None:
    """Run gltfpack's simplifier into ``target`` (written whole or not at all)."""
    import subprocess

    part = target + ".part.glb"
    try:
        result = subprocess.run(
            [tool, "-i", source, "-o", part, "-si", f"{ratio:.4f}", "-noq"],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode != 0 or not os.path.isfile(part):
            message = (result.stderr or result.stdout).strip().splitlines()
            raise ValueError("ポリゴン削減に失敗しました: " + (message[-1] if message else f"code {result.returncode}"))
        os.replace(part, target)
    finally:
        if os.path.exists(part):
            os.remove(part)


# ---- Light previews of heavy models ---------------------------------------------------------

# A model this heavy is shown from a simplified copy first: WebView2 needs several GB for a
# multi-million-triangle model, enough to starve the rest of the PC.
PREVIEW_TRIANGLES = 200_000
PREVIEW_KEEP = 8  # cached copies kept; older ones are removed


def preview_dir() -> str:
    return os.path.join(tempfile.gettempdir(), "tripo-viewer-preview")


def preview_copy(root: str, model: str, max_triangles: int = PREVIEW_TRIANGLES) -> str:
    """Absolute path of a copy of ``model`` with at most about ``max_triangles`` triangles.

    The copy is made with gltfpack into a cache outside the model folder (the folder is not
    touched) and reused while the model file is unchanged. A model that is light enough
    already is returned as it is.
    """
    path = library.safe_path(root, model)
    if os.path.splitext(path)[1].lower() not in library.VIEWABLE:
        raise ValueError("軽い版を作れるのは GLB / glTF だけです")
    triangles = library.glb_stats(root, model)["triangles"]
    if triangles <= max_triangles:
        return path
    stat = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{stat.st_size}|{stat.st_mtime_ns}|{max_triangles}".encode()).hexdigest()
    folder = preview_dir()
    target = os.path.join(folder, key[:20] + ".glb")
    if os.path.isfile(target):
        os.utime(target)  # recently used: keep it
        return target
    tool = gltfpack_path()
    if not tool:
        raise ValueError("軽い版を作るツール（gltfpack）が見つかりません")
    os.makedirs(folder, exist_ok=True)
    _gltfpack(tool, path, target, max_triangles / triangles)
    old = sorted((os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".glb")),
                 key=os.path.getmtime, reverse=True)
    for stale in old[PREVIEW_KEEP:]:
        try:
            os.remove(stale)
        except OSError:
            pass
    return target


# ---- Rigs (skeletons) -----------------------------------------------------------------------

# Body parts a humanoid rig needs; each matches joint names of Mixamo, Unity/VRM, Blender and
# similar conventions once prefixes like "mixamorig:" or "J_Bip_C_" are stripped.
_HUMANOID_PARTS = {
    "hips": ("hips", "pelvis", "hip"),
    "spine": ("spine", "chest"),
    "head": ("head",),
    "left arm": ("leftarm", "leftupperarm", "upperarml", "luparm", "lupperarm", "arml", "larm", "leftshoulder"),
    "right arm": ("rightarm", "rightupperarm", "upperarmr", "ruparm", "rupperarm", "armr", "rarm", "rightshoulder"),
    "left leg": ("leftupleg", "leftupperleg", "leftthigh", "thighl", "lthigh", "upperlegl", "leftleg", "legl", "lleg"),
    "right leg": ("rightupleg", "rightupperleg", "rightthigh", "thighr", "rthigh", "upperlegr", "rightleg", "legr", "rleg"),
}


def _plain(name: str) -> str:
    name = name.lower().rsplit(":", 1)[-1]
    for prefix in ("j_bip_c_", "j_bip_l_", "j_bip_r_", "bip01_", "bip001_", "def-", "orgbip_"):
        if name.startswith(prefix):
            side = {"j_bip_l_": "left", "j_bip_r_": "right"}.get(prefix, "")
            name = side + name[len(prefix):]
    return "".join(ch for ch in name.replace(".", "").replace("_", "").replace(" ", "").replace("-", ""))


def _world_matrices(gltf: Dict[str, Any]) -> Tuple[Dict[int, Matrix], Dict[int, int]]:
    """Rest-pose world matrix and parent of every node reachable from the scene roots."""
    nodes = gltf.get("nodes") or []
    parents = {c: i for i, n in enumerate(nodes) for c in n.get("children") or []}
    world: Dict[int, Matrix] = {}
    stack = [(i, _IDENTITY) for i in range(len(nodes)) if i not in parents]
    while stack:
        index, parent = stack.pop()
        world[index] = _multiply(parent, _local_matrix(nodes[index]))
        stack.extend((c, world[index]) for c in nodes[index].get("children") or [])
    return world, parents


def rig_info(root: str, model: str) -> Dict[str, Any]:
    """The first skin's joints (name, rest position, parent joint) and whether it looks humanoid."""
    path = library.safe_path(root, model)
    if os.path.splitext(path)[1].lower() not in library.VIEWABLE:
        raise ValueError("GLB / glTF だけ対応しています")
    gltf = library._gltf_json(path)
    skins = gltf.get("skins") or []
    if not skins:
        return {"skins": 0, "joints": [], "humanoid": False, "missing": [], "style": None}
    nodes = gltf.get("nodes") or []
    world, parents = _world_matrices(gltf)
    joint_nodes = skins[0].get("joints") or []
    position = {n: _apply(world.get(n, _IDENTITY), (0, 0, 0)) for n in joint_nodes}
    joints = []
    for node in joint_nodes:
        parent = parents.get(node)
        while parent is not None and parent not in position:  # skip non-joint nodes in between
            parent = parents.get(parent)
        joints.append({"name": nodes[node].get("name") or f"joint{node}",
                       "position": [round(v, 5) for v in position[node]],
                       "parent": joint_nodes.index(parent) if parent is not None else None})
    names = [_plain(j["name"]) for j in joints]
    missing = [part for part, keys in _HUMANOID_PARTS.items()
               if not any(any(name == k or name.endswith(k) for k in keys) for name in names)]
    raw = " ".join(j["name"] for j in joints).lower()
    style = ("Mixamo" if "mixamorig" in raw else "VRM / Unity" if "j_bip" in raw
             else "Blender (Rigify)" if "def-" in raw else None)
    return {"skins": len(skins), "joints": joints, "humanoid": not missing, "missing": missing, "style": style}


def to_mixamo_zip(root: str, model: str) -> str:
    """A zip with the model as OBJ + MTL + textures, the upload format Mixamo accepts."""
    import shutil
    import zipfile

    folder_rel = to_obj(root, model)
    folder = library.safe_path(root, folder_rel)
    target = library.unique_path(library.safe_path(root, os.path.splitext(model)[0] + "_mixamo.zip"))
    try:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(os.listdir(folder)):
                archive.write(os.path.join(folder, name), name)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return library._rel(root, target)
