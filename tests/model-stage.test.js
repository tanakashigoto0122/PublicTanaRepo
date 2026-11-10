import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceRotation, modelScale } from '../games/model-stage/logic.js';

test('回転は速度と経過時間に従い、停止と角度の折り返しに対応する', () => {
  assert.ok(Math.abs(advanceRotation(0, 0.1, 6) - Math.PI / 50) < 1e-12);
  assert.equal(advanceRotation(1, 0.1, 0), 1);
  assert.ok(advanceRotation(Math.PI * 2 - 0.01, 0.1, 6) < 0.1);
  assert.equal(advanceRotation(0, -1, 3), 0);
  assert.equal(advanceRotation(0, 20, 100), advanceRotation(0, 0.1, 12));
  assert.throws(() => advanceRotation(0, NaN, 3), TypeError);
});

test('幅・高さ・奥行きの最大を2に合わせる。空や不正な寸法は拒否', () => {
  assert.equal(modelScale([4, 1, 2]), 0.5);
  assert.equal(modelScale([0, 8, 0]), 0.25);
  assert.equal(modelScale([0, 0, 1]), 2);
  assert.throws(() => modelScale([0, 0, 0]), RangeError);
  for (const size of [[-1, 1, 1], [Infinity, 1, 1], [1, 2], null]) assert.throws(() => modelScale(size), TypeError);
});
