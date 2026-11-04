import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIND_COUNT, MODEL_HEIGHT, addVelocity, averageSpacing, bindVertices, buildClusters, createBody, dampRotation,
  deformVertices, invertMatrix,
  detectFormat, extractRotation, maxSpeed, multiplyMatrixVector, quatMultiply, quatToMatrix, stepBody,
  stiffnessFromSoftness, translateBody,
} from '../games/jelly-lab/logic.js';

function close(actual, expected, message, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

// 1 辺 1 の立方体の 8 つの角に、床から少し浮かせて粒を置く
function cube(y = 0.5) {
  const points = [];
  for (const x of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) points.push(x, y + dy, z);
  return Float32Array.from(points);
}

function axisAngle([x, y, z], angle) {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

test('ほかのゲームの関数と定数', () => {
  assert.equal(detectFormat('mecha.glb'), 'glb');
  assert.equal(MODEL_HEIGHT, 2);
});

test('quatToMatrix と quatMultiply は回転を表す', () => {
  const q = axisAngle([0, 0, 1], Math.PI / 2);
  const v = multiplyMatrixVector(quatToMatrix(q), [1, 0, 0]);
  close(v[0], 0, 'x');
  close(v[1], 1, 'y');
  const twice = quatToMatrix(quatMultiply(q, q));
  close(multiplyMatrixVector(twice, [1, 0, 0])[0], -1, '180 度');
});

test('extractRotation は回転行列からその回転を取り出す', () => {
  const q = axisAngle([1, 2, 3].map((v) => v / Math.hypot(1, 2, 3)), 1.2);
  const r = quatToMatrix(q);
  // 回転に少し大きさの違う伸びを掛けても、回転だけが残る
  const stretched = r.map((v, i) => v * [1.5, 0.8, 1.2][i % 3]);
  const found = quatToMatrix(extractRotation(stretched, [0, 0, 0, 1], 30));
  for (let i = 0; i < 9; i++) close(found[i], r[i], `要素 ${i}`, 1e-3);
  // 回転していなければ、そのまま
  assert.deepEqual(extractRotation([1, 0, 0, 0, 1, 0, 0, 0, 1]), [0, 0, 0, 1]);
});

test('buildClusters と averageSpacing', () => {
  const points = Float32Array.from([0, 0, 0, 1, 0, 0, 3, 0, 0]);
  assert.deepEqual(buildClusters(points, 1.5), [[0, 1], [0, 1], [2]]);
  // 体には、粒ごとのまとまりに加えて全体のまとまりが 1 つ付く
  assert.deepEqual(createBody(points, 1.5).clusters.at(-1), [0, 1, 2]);
  close(averageSpacing(points), (1 + 1 + 2) / 3, '平均');
  assert.equal(averageSpacing(Float32Array.from([0, 0, 0])), 0);
});

test('stepBody：落とすと床で止まり、形は元に戻る', () => {
  const body = createBody(cube(2), 10);
  for (let i = 0; i < 400; i++) stepBody(body, { dt: 1 / 120, stiffness: 0.5 });
  const ys = [];
  for (let i = 1; i < body.positions.length; i += 3) ys.push(body.positions[i]);
  close(Math.min(...ys), 0, '床に着く', 0.02);
  close(Math.max(...ys) - Math.min(...ys), 1, '高さは元のまま', 0.05);
  assert.ok(maxSpeed(body) < 0.5, '止まりかけている');
});

test('stepBody：柔らかいほど、着地でつぶれる', () => {
  const squash = (stiffness) => {
    const body = createBody(cube(3), 1.05);
    let lowest = Infinity;
    for (let i = 0; i < 300; i++) {
      stepBody(body, { dt: 1 / 120, stiffness, bounce: 0 });
      const ys = [];
      for (let j = 1; j < body.positions.length; j += 3) ys.push(body.positions[j]);
      lowest = Math.min(lowest, Math.max(...ys) - Math.min(...ys));
    }
    return lowest;
  };
  assert.ok(squash(0.05) < squash(0.6), '柔らかいほうが低くつぶれる');
});

test('stepBody：つかんだ粒は指の位置へ引っぱられ、壁の外へは出ない', () => {
  const body = createBody(cube(), 10);
  body.pinned.set(0, [-0.5, 2, -0.5]);
  for (let i = 0; i < 300; i++) stepBody(body, { dt: 1 / 120, stiffness: 0.3, gravity: 0 });
  close(body.positions[1], 2, 'つかんだ粒の高さ', 0.1);
  body.pinned.clear();
  addVelocity(body, [100, 0, 0]);
  for (let i = 0; i < 60; i++) stepBody(body, { dt: 1 / 120, stiffness: 0.3, wall: 3 });
  for (let i = 0; i < body.positions.length; i += 3) assert.ok(body.positions[i] <= 3 + 1e-6);
});

test('invertMatrix は逆行列を返し、逆行列がなければ null', () => {
  const m = [2, 0, 0, 0, 4, 0, 1, 0, 1];
  const inverse = invertMatrix(m);
  const v = multiplyMatrixVector(m, multiplyMatrixVector(inverse, [1, 2, 3]));
  [1, 2, 3].forEach((value, i) => close(v[i], value, `元に戻る ${i}`));
  assert.equal(invertMatrix([1, 2, 3, 2, 4, 6, 0, 0, 1]), null);
});

test('dampRotation は回転だけを弱め、まっすぐ進む速さは残す', () => {
  const body = createBody(cube(), 10);
  // y 軸まわりに回しながら +x へ進む
  for (let i = 0; i < body.positions.length; i += 3) {
    body.velocities[i] = 1 - body.positions[i + 2] * 2;
    body.velocities[i + 2] = body.positions[i] * 2;
  }
  dampRotation(body, 1);
  for (let i = 0; i < body.velocities.length; i += 3) {
    close(body.velocities[i], 1, '進む速さ');
    close(body.velocities[i + 2], 0, '回転は止まる');
  }
});

test('stepBody：置いただけの体は、転がり続けずに止まる', () => {
  // わざと偏った粒の並び：立方体の角に、片側の面だけ粒を足す
  const points = [...cube(0.5)];
  for (const y of [0.2, 0.5, 0.8]) for (const z of [-0.3, 0, 0.3]) points.push(0.5, y, z);
  const body = createBody(Float32Array.from(points), 0.8);
  for (let i = 0; i < 120 * 6; i++) stepBody(body, { dt: 1 / 120, stiffness: 0.3 });
  assert.ok(maxSpeed(body) < 0.2, `止まっている（${maxSpeed(body).toFixed(3)}）`);
});

test('translateBody は全体を動かし、速さを 0 にする', () => {
  const body = createBody(cube(), 10);
  addVelocity(body, [1, 2, 3]);
  translateBody(body, [0, 5, 0]);
  close(body.positions[1], 5, '持ち上げた');
  assert.equal(maxSpeed(body), 0);
});

test('bindVertices は近い粒ほど重く、合計 1 にする', () => {
  const particles = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5]);
  const { indices, weights } = bindVertices(Float32Array.from([0.1, 0, 0]), particles);
  assert.equal(indices[0], 0);
  assert.ok(weights[0] > weights[1]);
  close([...weights.slice(0, BIND_COUNT)].reduce((a, b) => a + b, 0), 1, '合計');
  assert.ok(![...indices.slice(0, BIND_COUNT)].includes(4), '遠い粒は使わない');
});

test('deformVertices：粒が動かなければ頂点もそのまま、平行移動すれば一緒に動く', () => {
  const body = createBody(cube(), 10);
  const vertices = Float32Array.from([0, 0.5, 0, 0.4, 0.9, -0.3]);
  const binding = bindVertices(vertices, body.rest);
  const out = new Float32Array(vertices.length);
  deformVertices(out, vertices, binding, body);
  for (let i = 0; i < vertices.length; i++) close(out[i], vertices[i], `そのまま ${i}`);
  translateBody(body, [1, 2, 3]);
  deformVertices(out, vertices, binding, body);
  close(out[0], 1, 'x');
  close(out[1], 2.5, 'y');
  close(out[5], 2.7, 'z');
});

test('stiffnessFromSoftness は柔らかいほど小さい', () => {
  close(stiffnessFromSoftness(0), 0.6, '硬い');
  close(stiffnessFromSoftness(100), 0.03, '柔らかい');
  assert.ok(stiffnessFromSoftness(30) > stiffnessFromSoftness(70));
  close(stiffnessFromSoftness(500), 0.03, '範囲外');
});
