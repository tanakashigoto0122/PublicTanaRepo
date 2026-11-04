import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_RATIO, TEXTURE_SIZES, compactIndices, detectFormat, formatBytes, normalizeVectors, outputName, percentOf, ratioFromSlider,
  remapAttribute, sliderFromRatio, targetIndexCount, textureSizeLabel,
} from '../games/model-lite/logic.js';

function close(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

test('3D ビューアの関数も使える', () => {
  assert.equal(detectFormat('mecha.glb'), 'glb');
  assert.equal(formatBytes(2048), '2.0 KB');
});

test('ratioFromSlider と sliderFromRatio は対数で対応する', () => {
  close(ratioFromSlider(0), MIN_RATIO, '0');
  close(ratioFromSlider(50), 0.1, '50');
  close(ratioFromSlider(100), 1, '100');
  close(ratioFromSlider(-10), MIN_RATIO, '下限');
  close(ratioFromSlider(150), 1, '上限');
  for (const ratio of [0.01, 0.05, 0.2, 0.5, 1]) close(ratioFromSlider(sliderFromRatio(ratio)), ratio, `往復 ${ratio}`);
  close(sliderFromRatio(0.001), 0, '範囲外');
});

test('targetIndexCount は 3 の倍数で、少なくとも三角形 1 枚', () => {
  assert.equal(targetIndexCount(3000, 0.1), 300);
  assert.equal(targetIndexCount(3000, 0.0995), 297);
  assert.equal(targetIndexCount(30, 0.01), 3);
  assert.equal(targetIndexCount(3000, 1), 3000);
});

test('compactIndices は使われている頂点だけを、出てきた順に詰める', () => {
  const { indices, remap, vertexCount } = compactIndices(new Uint32Array([5, 2, 7, 2, 7, 9]), 10);
  assert.deepEqual([...indices], [0, 1, 2, 1, 2, 3]);
  assert.equal(vertexCount, 4);
  assert.deepEqual([...remap], [-1, -1, 1, -1, -1, 0, -1, 2, -1, 3]);
  assert.equal(compactIndices(new Uint32Array([]), 3).vertexCount, 0);
});

test('remapAttribute は頂点の値を新しい順に並べ直す', () => {
  // 頂点 0〜3 の位置（x, y, z）
  const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  const { remap, vertexCount } = compactIndices(new Uint32Array([3, 1, 3]), 4);
  assert.deepEqual([...remapAttribute(positions, 3, remap, vertexCount)], [3, 3, 3, 1, 1, 1]);
  // 2 つずつの値（UV）
  const uvs = new Float32Array([0, 0.5, 1, 0.25, 0.75, 0.125, 0.5, 1]);
  assert.deepEqual([...remapAttribute(uvs, 2, remap, vertexCount)], [0.5, 1, 1, 0.25]);
});

test('normalizeVectors は長さを 1 にそろえ、長さ 0 はそのまま', () => {
  const values = new Float32Array([3, 0, 4, 0, 0, 0, 0, 0.999, 0]);
  normalizeVectors(values, 3);
  // Float32Array なので、小数の誤差は float32 の精度で見る
  close(values[0], 0.6, 'x', 1e-6);
  close(values[2], 0.8, 'z', 1e-6);
  assert.deepEqual([...values.slice(3, 6)], [0, 0, 0]);
  close(values[7], 1, '長さが少しずれた法線', 1e-6);
});

test('percentOf・outputName・textureSizeLabel', () => {
  assert.equal(percentOf(5, 100), '5.0%');
  assert.equal(percentOf(123, 1000), '12%');
  assert.equal(percentOf(1, 0), '-');
  assert.equal(outputName('mecha.glb'), 'mecha-lite.glb');
  assert.equal(outputName('my.robot.obj'), 'my.robot-lite.glb');
  assert.equal(outputName('.glb'), 'model-lite.glb');
  assert.equal(textureSizeLabel(Infinity), 'そのまま');
  assert.equal(textureSizeLabel(1024), '1024 px まで');
  assert.equal(TEXTURE_SIZES[0], Infinity);
});
