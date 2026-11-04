import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT, MODEL_HEIGHT, applyOffset, brushWeights, buildSpatialHash, customName, detectFormat, falloff,
  fillZeroNormals,
  groupByPosition, groupedNormals, guessFacing, inflate, neighborAverage, pushHistory, smooth, springStep,
  toFloatArray,
} from '../games/model-sculpt/logic.js';

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

// x 軸上に 0, 0.5, 1, 1.5, 2 と並んだ 5 個の頂点
function line() {
  return new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1.5, 0, 0, 2, 0, 0]);
}

test('ほかのゲームの関数と定数', () => {
  assert.equal(detectFormat('mecha.glb'), 'glb');
  assert.equal(guessFacing([1, 1, 1]), 0);
  assert.equal(MODEL_HEIGHT, 2);
});

test('falloff は中心で 1、縁で 0、間はなめらかに下がる', () => {
  assert.equal(falloff(0), 1);
  assert.equal(falloff(1), 0);
  assert.equal(falloff(2), 0);
  close(falloff(0.5), 0.5625, '真ん中');
  assert.ok(falloff(0.3) > falloff(0.6));
});

test('brushWeights は半径の中の頂点だけを、近いほど強く選ぶ', () => {
  const { indices, weights } = brushWeights(line(), [0, 0, 0], 1.2);
  assert.deepEqual([...indices], [0, 1, 2]);
  assert.equal(weights[0], 1);
  assert.ok(weights[0] > weights[1] && weights[1] > weights[2]);
  assert.equal(brushWeights(line(), [10, 0, 0], 1).indices.length, 0);
  assert.equal(brushWeights(line(), [0, 0, 0], 0).indices.length, 0);
});

test('applyOffset はつかんだ時の位置から、効き具合に応じてずらす', () => {
  const base = line();
  const positions = base.slice();
  const brush = brushWeights(base, [0, 0, 0], 1.2);
  applyOffset(positions, base, brush, [0, 1, 0]);
  close(positions[1], 1, '中心は全部動く');
  close(positions[4], brush.weights[1], '途中は少し');
  close(positions[10], 0, '外は動かない');
  // 何度呼んでも base から計算するので、ずれがたまらない
  applyOffset(positions, base, brush, [0, 1, 0]);
  close(positions[1], 1, '2 回目も同じ');
});

test('inflate は法線の向きに、へこますときは逆に動かす', () => {
  const positions = line();
  const normals = new Float32Array(15);
  for (let i = 1; i < 15; i += 3) normals[i] = 1;
  const brush = brushWeights(positions, [0, 0, 0], 1.2);
  inflate(positions, normals, brush, 0.2);
  close(positions[1], 0.2, 'ふくらむ');
  inflate(positions, normals, brush, -0.2);
  close(positions[1], 0, 'へこむ');
});

test('buildSpatialHash と neighborAverage は近くの頂点だけを平均する', () => {
  const positions = line();
  const hash = buildSpatialHash(positions, 0.6);
  const average = neighborAverage(positions, hash, [1, 0, 0]);
  // 0.5, 1, 1.5 の平均
  close(average[0], 1, 'x');
  assert.deepEqual(neighborAverage(positions, hash, [50, 0, 0]), [50, 0, 0]);
  // only に入れた頂点だけで平均する
  const partial = buildSpatialHash(positions, 0.6, [2, 3]);
  close(neighborAverage(positions, partial, [1, 0, 0])[0], 1.25, '1 と 1.5 の平均');
});

test('smooth は飛び出た頂点を平らにならす', () => {
  const positions = line();
  positions[7] = 1; // 真ん中の頂点だけ y = 1 に飛び出ている
  const brush = brushWeights(positions, [1, 1, 0], 0.5);
  assert.deepEqual([...brush.indices], [2]);
  // 半径 1.2 なら、下に並ぶ 0.5・1・1.5 の頂点が近所に入る
  const copy = positions.slice();
  smooth(positions, brush, 1.2, 1);
  assert.ok(positions[7] < 1, '下がる');
  // 近所の範囲を渡しても、全部を使ったときと同じ結果になる
  smooth(copy, brush, 1.2, 1, brushWeights(copy, [1, 1, 0], 0.5 + 1.2).indices);
  close(copy[7], positions[7], '範囲つき');
  assert.ok(positions[7] > 0, '一度で平らにはならない');
  close(positions[4], 0, 'ブラシの外は動かない');
});

test('springStep は揺れながら元の位置に戻っていく', () => {
  const rest = line();
  const positions = rest.slice();
  positions[1] = 1;
  const velocities = new Float32Array(15);
  let largest = Infinity;
  let overshoot = false;
  for (let i = 0; i < 600 && largest > 1e-4; i++) {
    largest = springStep(positions, velocities, rest, [0]);
    if (positions[1] < 0) overshoot = true;
  }
  assert.ok(overshoot, '一度は行き過ぎて揺れる');
  close(positions[1], 0, '最後は元の位置', 1e-3);
  assert.ok(largest <= 1e-4);
});

test('groupByPosition は同じ位置の頂点に同じ番号を付ける', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0.000001]);
  const { groupOf, groupCount } = groupByPosition(positions);
  assert.deepEqual([...groupOf], [0, 1, 0, 1]);
  assert.equal(groupCount, 2);
});

test('groupedNormals は継ぎ目の頂点の法線をそろえる', () => {
  // 頂点 0 と 2 は同じ位置で、法線が +x と +y に分かれている
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0]);
  const normals = new Float32Array([1, 0, 0, 0, 0, 1, 0, 1, 0]);
  const result = groupedNormals(normals, groupByPosition(positions));
  close(result[0], Math.SQRT1_2, '頂点 0 の x');
  close(result[1], Math.SQRT1_2, '頂点 0 の y');
  assert.deepEqual([...result.slice(6, 9)], [...result.slice(0, 3)]);
  assert.deepEqual([...result.slice(3, 6)], [0, 0, 1]);
});

test('fillZeroNormals は長さ 0 の法線だけを上向きにする', () => {
  const normals = new Float32Array([0, 0, 0, 1, 0, 0]);
  assert.deepEqual([...fillZeroNormals(normals)], [0, 1, 0, 1, 0, 0]);
});

test('pushHistory は新しいものから HISTORY_LIMIT 件まで残す', () => {
  let history = [];
  for (let i = 0; i < HISTORY_LIMIT + 3; i++) history = pushHistory(history, i);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[history.length - 1], HISTORY_LIMIT + 2);
  assert.equal(history[0], 3);
});

test('toFloatArray は getX などで読める値を並べる', () => {
  const values = [[1, 2], [3, 4]];
  const attribute = { count: 2, itemSize: 2, getX: (i) => values[i][0], getY: (i) => values[i][1] };
  assert.deepEqual([...toFloatArray(attribute)], [1, 2, 3, 4]);
});

test('customName', () => {
  assert.equal(customName('mecha-lite.glb'), 'mecha-lite-custom.glb');
  assert.equal(customName('robot-custom.glb'), 'robot-custom.glb');
  assert.equal(customName('.glb'), 'model-custom.glb');
});
