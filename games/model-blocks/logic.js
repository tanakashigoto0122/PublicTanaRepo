// 自分の3D積み木の計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。
// 積み木の部分はやわらか積み木のもの、ファイル形式の判定は 3D ビューアのものを使い、
// ここには持ち込んだ 3D モデルを物理の当たり判定にするための計算を書く。

export * from '../soft-blocks/logic.js';
export { SUPPORTED_FORMATS, detectFormat } from '../model-viewer/logic.js';
import { SUPPORTED_FORMATS } from '../model-viewer/logic.js';

// 当たり判定の凸包に使う点の数の上限。多いほど形に近いが、ぶつかる計算が重くなる
export const MAX_HULL_POINTS = 32;
// 凸包を作る前に、モデルの頂点から間引いて使う点の数の上限（何十万頂点のモデルでも重くならないように）
export const MAX_SAMPLE_POINTS = 3000;
// 当たり判定の箱の一番薄い辺。平らなモデルでも床をすり抜けないようにする
export const MIN_THICKNESS = 0.05;
export const MODEL_SIZE_RANGE = { min: 0.5, max: 4 };

// 一番長い辺が target になる倍率。大きさが 0 のモデルは 1 倍のまま
export function normalizeScale([x, y, z], target) {
  const longest = Math.max(x, y, z);
  return longest > 0 ? target / longest : 1;
}

// 当たり判定の箱の大きさ。薄すぎる辺は MIN_THICKNESS まで厚くする
export function boxSize(size) {
  return size.map((v) => Math.max(v, MIN_THICKNESS));
}

// 重さ（kg）。中身の詰まり具合はわからないので、外枠の箱の体積の 4 割として、極端にならない範囲に収める
export function modelMass(size) {
  const [x, y, z] = boxSize(size);
  return Math.min(30, Math.max(0.2, x * y * z * 0.4));
}

// total 個の中から、最大 max 個を等間隔に選んだ番号
export function strideIndices(total, max) {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const step = total / max;
  return Array.from({ length: max }, (_, i) => Math.floor(i * step));
}

function distanceSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// 互いにできるだけ離れた点を count 個選ぶ（最遠点サンプリング）。形の外側の目立つ点が残りやすい。
// 最初の 1 点は重心から一番遠い点にするので、結果は毎回同じになる。
export function farthestPointSample(points, count) {
  if (points.length <= count) return points.slice();
  const centroid = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / points.length);
  let first = 0;
  for (let i = 1; i < points.length; i++) {
    if (distanceSq(points[i], centroid) > distanceSq(points[first], centroid)) first = i;
  }
  const chosen = [points[first]];
  const nearest = points.map((p) => distanceSq(p, points[first]));
  while (chosen.length < count) {
    let next = 0;
    for (let i = 1; i < points.length; i++) if (nearest[i] > nearest[next]) next = i;
    if (nearest[next] === 0) break;
    chosen.push(points[next]);
    for (let i = 0; i < points.length; i++) nearest[i] = Math.min(nearest[i], distanceSq(points[i], points[next]));
  }
  return chosen;
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? v.map((x) => x / length) : v;
}

// 同じ平面にある面を 1 つの多角形にまとめる。凸包は箱の面も三角形 2 つに分けて作るが、
// 物理エンジンは同じ平面に三角形が並んでいると、上に載せた物が滑り落ちることがあるため。
// まとめた多角形の頂点は、外から見て反時計回りに並べ直す。
export function mergeCoplanarFaces(vertices, faces, tolerance = 1e-6) {
  const groups = [];
  for (const face of faces) {
    const [a, b, c] = face.map((i) => vertices[i]);
    const normal = normalize(cross(subtract(b, a), subtract(c, a)));
    const offset = dot(normal, a);
    const group = groups.find((g) => dot(g.normal, normal) > 1 - tolerance && Math.abs(g.offset - offset) < tolerance);
    if (group) face.forEach((i) => group.indices.add(i));
    else groups.push({ normal, offset, indices: new Set(face) });
  }
  return groups.map(({ normal, indices }) => {
    const list = [...indices];
    const center = [0, 1, 2].map((k) => list.reduce((sum, i) => sum + vertices[i][k], 0) / list.length);
    const u = normalize(subtract(vertices[list[0]], center));
    const w = cross(normal, u);
    const angle = (i) => {
      const d = subtract(vertices[i], center);
      return Math.atan2(dot(d, w), dot(d, u));
    };
    return list.sort((i, j) => angle(i) - angle(j));
  });
}

// 凸包の面（各面の頂点座標を外から見て反時計回りに並べたもの）から、物理エンジン用の頂点と面の番号を作る。
// 同じ位置の頂点は 1 つにまとめ、潰れて 3 頂点未満になった面は捨て、同じ平面の面は 1 つにまとめる。
export function buildPolyhedron(loops, tolerance = 1e-6) {
  const vertices = [];
  const lookup = new Map();
  const indexOf = (p) => {
    const key = p.map((v) => Math.round(v / tolerance)).join(',');
    if (!lookup.has(key)) {
      lookup.set(key, vertices.length);
      vertices.push([...p]);
    }
    return lookup.get(key);
  };
  const faces = [];
  for (const loop of loops) {
    const face = [];
    for (const p of loop) {
      const index = indexOf(p);
      if (face[face.length - 1] !== index && face[0] !== index) face.push(index);
    }
    if (face.length >= 3) faces.push(face);
  }
  return { vertices, faces: mergeCoplanarFaces(vertices, faces) };
}

// IndexedDB に保存した持ち込みモデルの記録として正しいか
export function isValidModelRecord(record) {
  return Boolean(record)
    && typeof record.id === 'string' && record.id.length > 0
    && typeof record.name === 'string'
    && SUPPORTED_FORMATS.includes(record.format)
    && record.data instanceof ArrayBuffer;
}
