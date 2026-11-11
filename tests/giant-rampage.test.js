import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS_PER_GROWTH, BLOCK_SIZE, CITY_HALF, GAME_SECONDS, LOT_SPACING, MAX_HEIGHT, START_HEIGHT, buildingBlocks,
  cityLayout, clampToCity, formatTime, giantHeight, isToppled, joystickVector, stompVelocity, walkSpeed,
} from '../games/giant-rampage/logic.js';

function seeded(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

test('ほかのゲームの関数', () => {
  assert.equal(GAME_SECONDS, 60);
  assert.equal(formatTime(1.25), '1.3');
  assert.equal(joystickVector(0, 0, 50).magnitude, 0);
});

test('cityLayout は真ん中を広場にして、街の中にビルを建てる', () => {
  const buildings = cityLayout({ random: seeded(3) });
  assert.ok(buildings.length > 10);
  for (const b of buildings) {
    assert.ok(!(b.x === 0 && b.z === 0), '真ん中は広場');
    assert.equal(Math.abs(b.x % LOT_SPACING), 0);
    assert.ok(Math.abs(b.x) + b.w * BLOCK_SIZE / 2 < CITY_HALF);
    assert.ok(Math.abs(b.z) + b.d * BLOCK_SIZE / 2 < CITY_HALF);
    assert.ok(b.floors >= 3 && b.w >= 2 && b.d >= 2);
    assert.ok(b.color >= 0 && b.color < 4);
  }
  // 乱数が 0.15 より小さいと空き地になる
  assert.equal(cityLayout({ random: () => 0.5 }).length, 24, '空き地なし（5×5 の区画から広場を除く）');
  assert.equal(cityLayout({ random: () => 0.1 }).length, 0, '全部空き地');
});

test('buildingBlocks は階ごとに箱を積む', () => {
  const blocks = buildingBlocks({ x: 5, z: -5, w: 2, d: 3, floors: 4 }, 1);
  assert.equal(blocks.length, 24);
  assert.deepEqual(blocks[0], [4.5, 0.5, -6]);
  assert.deepEqual(blocks.at(-1), [5.5, 3.5, -4]);
  const xs = blocks.map((b) => b[0]);
  assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 5, 'ビルの真ん中が区画の真ん中');
});

test('isToppled は落ちた・ずれた・傾いたとき', () => {
  const start = [0, 1.25, 0];
  const still = [0, 0, 0, 1];
  assert.equal(isToppled(start, [0, 1.25, 0], still), false);
  assert.equal(isToppled(start, [0, 1.25 - BLOCK_SIZE * 0.5, 0], still), true, '落ちた');
  assert.equal(isToppled(start, [BLOCK_SIZE, 1.25, 0], still), true, 'ずれた');
  const tilted = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
  assert.equal(isToppled(start, start, tilted), true, '45 度傾いた');
  const slight = [Math.sin(Math.PI / 36), 0, 0, Math.cos(Math.PI / 36)];
  assert.equal(isToppled(start, start, slight), false, '10 度なら倒れていない');
});

test('giantHeight と walkSpeed', () => {
  assert.equal(giantHeight(0), START_HEIGHT);
  assert.equal(giantHeight(BLOCKS_PER_GROWTH - 1), START_HEIGHT);
  assert.equal(giantHeight(BLOCKS_PER_GROWTH), START_HEIGHT + 1);
  assert.equal(giantHeight(100000), MAX_HEIGHT);
  assert.ok(walkSpeed(MAX_HEIGHT) > walkSpeed(START_HEIGHT));
});

test('stompVelocity は近いほど強く外向き、範囲の外は null', () => {
  assert.equal(stompVelocity([5, 0.5, 0], [0, 0, 0], 4, 6), null);
  const near = stompVelocity([1, 0.25, 0], [0, 0, 0], 4, 6);
  const far = stompVelocity([3, 0.25, 0], [0, 0, 0], 4, 6);
  assert.ok(near[0] > 0 && near[2] === 0 && near[1] > 0);
  assert.ok(near[1] > far[1] && near[0] > far[0]);
  const high = stompVelocity([1, 5, 0], [0, 0, 0], 4, 6);
  assert.ok(high[1] < near[1], '高い所の箱は跳ねにくい');
  const center = stompVelocity([0, 0.25, 0], [0, 0, 0], 4, 6);
  assert.deepEqual([center[0], center[2]], [0, 0], '真下は上だけ');
});

test('clampToCity', () => {
  assert.deepEqual(clampToCity([0, 0]), [0, 0]);
  assert.deepEqual(clampToCity([100, -100], 1), [CITY_HALF - 1, -(CITY_HALF - 1)]);
});
