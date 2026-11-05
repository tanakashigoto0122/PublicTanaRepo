import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOR_TOUCH, GAME_SECONDS, JELLY_HEIGHT, TARGET_AREA, TARGET_RADIUS, WALL, bodySummary, createBody, formatTime,
  grabMembers, isOnTarget, placeTarget, stepBody, updatePinch,
} from '../games/jelly-catch/logic.js';

function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('ほかのゲームの関数と定数', () => {
  assert.equal(GAME_SECONDS, 60);
  assert.equal(formatTime(3.21), '3.2');
  assert.ok(JELLY_HEIGHT > 0 && WALL > TARGET_AREA.maxX);
  assert.ok(createBody && stepBody && updatePinch);
});

test('placeTarget は範囲の中に、前の場所から離して置く', () => {
  for (let i = 0; i < 50; i++) {
    const [x, z] = placeTarget({ avoid: [0, 0], minDistance: 2 });
    assert.ok(x >= TARGET_AREA.minX && x <= TARGET_AREA.maxX);
    assert.ok(z >= TARGET_AREA.minZ && z <= TARGET_AREA.maxZ);
    assert.ok(Math.hypot(x, z) >= 2);
  }
  // 決まった乱数なら決まった場所
  assert.deepEqual(placeTarget({ random: sequence([0.5, 0.5]) }), [0, TARGET_AREA.minZ + 0.5 * (TARGET_AREA.maxZ - TARGET_AREA.minZ)]);
  // どうしても離せなければ、反対側の端
  assert.deepEqual(placeTarget({ random: () => 1, avoid: [TARGET_AREA.maxX, TARGET_AREA.maxZ], minDistance: 2 }), [TARGET_AREA.minX, 0]);
});

test('bodySummary は真ん中と一番低い高さ', () => {
  const { center, lowest } = bodySummary(Float32Array.from([0, 0, 0, 2, 4, 6]));
  assert.deepEqual(center, [1, 2, 3]);
  assert.equal(lowest, 0);
});

test('isOnTarget は、床に触れていて円の中で、つかんでいないとき', () => {
  const target = [1, -1];
  const landed = { center: [1.2, 0.5, -1.3], lowest: 0 };
  assert.equal(isOnTarget(landed, target, false), true);
  assert.equal(isOnTarget(landed, target, true), false, 'つかんでいる');
  assert.equal(isOnTarget({ ...landed, lowest: FLOOR_TOUCH * 2 }, target, false), false, '浮いている');
  assert.equal(isOnTarget({ ...landed, center: [1 + TARGET_RADIUS * 1.1, 0.5, -1] }, target, false), false, '円の外');
});

test('grabMembers は近くの粒、なければ届く範囲で一番近い粒', () => {
  const positions = Float32Array.from([0, 0, 0, 0.1, 0, 0, 1, 0, 0]);
  assert.deepEqual(grabMembers(positions, [0, 0, 0], 0.2, 0.5), [0, 1]);
  assert.deepEqual(grabMembers(positions, [0.7, 0, 0], 0.1, 0.5), [2]);
  assert.deepEqual(grabMembers(positions, [5, 0, 0], 0.1, 0.5), []);
});
