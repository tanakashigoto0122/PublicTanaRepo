import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, fitDistance, formatBytes, formatCount, formatDimensions, lightPosition,
} from '../games/model-viewer/logic.js';

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test('detectFormat は対応する拡張子だけを大文字小文字を問わず返す', () => {
  assert.equal(detectFormat('robot.glb'), 'glb');
  assert.equal(detectFormat('Robot.GLTF'), 'gltf');
  assert.equal(detectFormat('my.model.obj'), 'obj');
  assert.equal(detectFormat('part.STL'), 'stl');
  assert.equal(detectFormat('photo.png'), null);
  assert.equal(detectFormat('noextension'), null);
  assert.equal(detectFormat('dir.glb/file'), null);
  assert.equal(detectFormat(''), null);
});

test('lightPosition は角度から光源の位置を求める', () => {
  const front = lightPosition(0, 0, 10);
  close(front.x, 0, 'x');
  close(front.y, 0, 'y');
  close(front.z, 10, 'z');

  const right = lightPosition(90, 0, 10);
  close(right.x, 10, 'x');
  close(right.z, 0, 'z');

  const top = lightPosition(123, 90, 5);
  close(top.y, 5, 'y');
  close(Math.hypot(top.x, top.z), 0, '真上なら水平成分は 0');

  const p = lightPosition(37, 25, 8);
  close(Math.hypot(p.x, p.y, p.z), 8, '距離は保たれる');
});

test('fitDistance は狭いほうの視野角に合わせ、半径に比例する', () => {
  const square = fitDistance(1, 90, 1, 1);
  close(square, 1 / Math.sin(Math.PI / 4), '正方形の画面');
  // 縦長の画面では横の視野が狭くなるので、より遠ざかる
  assert.ok(fitDistance(1, 45, 0.5) > fitDistance(1, 45, 1));
  // 横長の画面では縦の視野で決まるので、それ以上は変わらない
  close(fitDistance(1, 45, 2), fitDistance(1, 45, 3), '横長');
  close(fitDistance(2, 45, 1), fitDistance(1, 45, 1) * 2, '半径に比例');
  assert.equal(fitDistance(0, 45, 1), 1);
  assert.equal(fitDistance(NaN, 45, 1), 1);
});

test('formatBytes は単位を付けて丸める', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 4), '3072 GB');
});

test('formatCount と formatDimensions', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(0), '0');
  assert.equal(formatDimensions({ x: 1, y: 0.123456, z: 1234.5 }), '1 × 0.123 × 1230');
});
