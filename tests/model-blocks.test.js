import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HULL_POINTS, MIN_THICKNESS, MODEL_SIZE_RANGE, PARTS, boxSize, buildPolyhedron, detectFormat,
  farthestPointSample, isValidModelRecord, mergeCoplanarFaces, modelMass, normalizeScale, strideIndices,
} from '../games/model-blocks/logic.js';

test('やわらか積み木と 3D ビューアの関数も使える', () => {
  assert.deepEqual(Object.keys(PARTS), ['bendy', 'rope', 'jelly']);
  assert.equal(detectFormat('robot.GLB'), 'glb');
  assert.equal(detectFormat('photo.png'), null);
});

test('normalizeScale は一番長い辺を target にそろえる', () => {
  assert.equal(normalizeScale([2, 4, 1], 1), 0.25);
  assert.equal(normalizeScale([0.5, 0.1, 0.2], 2), 4);
  assert.equal(normalizeScale([0, 0, 0], 3), 1);
  assert.ok(MODEL_SIZE_RANGE.min < MODEL_SIZE_RANGE.max);
});

test('boxSize と modelMass は平らなモデルでも壊れない', () => {
  assert.deepEqual(boxSize([1, 0, 2]), [1, MIN_THICKNESS, 2]);
  assert.deepEqual(boxSize([1, 1, 1]), [1, 1, 1]);
  assert.equal(modelMass([1, 1, 1]), 0.4);
  assert.equal(modelMass([0, 0, 0]), 0.2);
  assert.equal(modelMass([10, 10, 10]), 30);
});

test('strideIndices は等間隔に最大 max 個選ぶ', () => {
  assert.deepEqual(strideIndices(3, 5), [0, 1, 2]);
  assert.deepEqual(strideIndices(10, 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(strideIndices(0, 5), []);
  const picked = strideIndices(100000, 3000);
  assert.equal(picked.length, 3000);
  assert.ok(picked.every((v, i) => i === 0 || v > picked[i - 1]));
  assert.ok(picked[picked.length - 1] < 100000);
});

test('farthestPointSample は外側の点を優先して、重複なく選ぶ', () => {
  // 立方体の 8 頂点と、内側にたくさんの点
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  const inner = Array.from({ length: 200 }, (_, i) => [Math.sin(i) * 0.3, Math.cos(i) * 0.3, ((i % 7) - 3) * 0.1]);
  const picked = farthestPointSample([...inner, ...corners], 8);
  assert.equal(picked.length, 8);
  assert.deepEqual(picked.map((p) => p.join()).sort(), corners.map((p) => p.join()).sort());
  // 点が少なければそのまま返す
  assert.deepEqual(farthestPointSample(corners, 20), corners);
  // 同じ点ばかりなら、それ以上は選ばない
  assert.equal(farthestPointSample(new Array(50).fill([1, 1, 1]), 5).length, 1);
  assert.ok(MAX_HULL_POINTS >= 8);
});

test('buildPolyhedron は同じ位置の頂点をまとめ、潰れた面を捨てる', () => {
  // 四面体の 4 面（外から見て反時計回り）と、潰れた面 1 つ
  const a = [0, 0, 0];
  const b = [1, 0, 0];
  const c = [0, 1, 0];
  const d = [0, 0, 1];
  const { vertices, faces } = buildPolyhedron([
    [a, c, b],
    [a, b, d],
    [a, d, c],
    [b, c, d],
    [a, [1e-9, 0, 0], b],
  ]);
  assert.equal(vertices.length, 4);
  assert.equal(faces.length, 4);
  assert.ok(faces.every((f) => f.length === 3 && new Set(f).size === 3));
  assert.deepEqual([...faces[0]].sort(), [0, 1, 2]);
  assert.ok(facesPointOutward(vertices, faces));
});

// 面の頂点が、外向きの法線から見て反時計回りに並んでいるか（最初の 3 点で作る法線が外を向くか）
function facesPointOutward(vertices, faces) {
  const center = [0, 1, 2].map((k) => vertices.reduce((sum, v) => sum + v[k], 0) / vertices.length);
  return faces.every((face) => {
    const [a, b, c] = face.map((i) => vertices[i]);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    return n[0] * (a[0] - center[0]) + n[1] * (a[1] - center[1]) + n[2] * (a[2] - center[2]) > 0;
  });
}

test('buildPolyhedron は箱の三角形 12 枚を四角形 6 枚にまとめ、外向きの順に並べる', () => {
  const v = (x, y, z) => [x, y, z];
  const [a, b, c, d] = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)];
  const [e, f, g, h] = [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)];
  // 各面を三角形 2 枚で、外から見て反時計回りに
  const quads = [[a, d, c, b], [e, f, g, h], [a, b, f, e], [d, h, g, c], [a, e, h, d], [b, c, g, f]];
  const loops = quads.flatMap(([p, q, r, s]) => [[p, q, r], [p, r, s]]);
  const { vertices, faces } = buildPolyhedron(loops);
  assert.equal(vertices.length, 8);
  assert.equal(faces.length, 6);
  assert.ok(faces.every((face) => face.length === 4));
  assert.ok(facesPointOutward(vertices, faces));
});

test('mergeCoplanarFaces は同じ平面でない面をそのまま残す', () => {
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const merged = mergeCoplanarFaces(vertices, faces);
  assert.equal(merged.length, 4);
  assert.ok(facesPointOutward(vertices, merged));
});

test('isValidModelRecord は保存データの形を確かめる', () => {
  const good = { id: 'm1', name: 'robot.glb', format: 'glb', data: new ArrayBuffer(4) };
  assert.ok(isValidModelRecord(good));
  assert.ok(!isValidModelRecord(null));
  assert.ok(!isValidModelRecord({ ...good, id: '' }));
  assert.ok(!isValidModelRecord({ ...good, format: 'fbx' }));
  assert.ok(!isValidModelRecord({ ...good, data: 'text' }));
  assert.ok(!isValidModelRecord({ ...good, name: 5 }));
});
