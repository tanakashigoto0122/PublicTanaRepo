import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGERTIPS, HAND_BONES, INDEX_TIP, LANDMARK_COUNT, MIDDLE_BASE, PINCH_END, PINCH_START, THUMB_TIP, WRIST,
  brushWeights, detectFormat, handToWorld, midpoint, nearestVertex, palmSize, pushOut, smoothPoints, springVector,
  updatePinch, vectorLength,
} from '../games/hand-clay/logic.js';

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

// 手首が (0.5, 0.8)、中指の付け根が (0.5, 0.6) の手（手のひらの大きさ 0.2）。親指と人差し指の先の距離を指定する
function hand(pinchGap = 0.2, shift = 0) {
  const points = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5 + shift, y: 0.7, z: 0 }));
  points[WRIST] = { x: 0.5 + shift, y: 0.8, z: 0 };
  points[MIDDLE_BASE] = { x: 0.5 + shift, y: 0.6, z: 0 };
  points[THUMB_TIP] = { x: 0.45 + shift, y: 0.5, z: -0.02 };
  points[INDEX_TIP] = { x: 0.45 + shift + pinchGap, y: 0.5, z: -0.02 };
  return points;
}

const VIEW = { width: 3, height: 3, centerY: 1 };

test('手の骨は 21 個の関節をつなぐ', () => {
  const used = new Set(HAND_BONES.flat());
  assert.equal(used.size, LANDMARK_COUNT);
  assert.ok(HAND_BONES.every(([a, b]) => a < LANDMARK_COUNT && b < LANDMARK_COUNT));
  assert.deepEqual(FINGERTIPS, [4, 8, 12, 16, 20]);
  assert.equal(detectFormat('mecha.glb'), 'glb');
  assert.ok(brushWeights);
});

test('palmSize は手首から中指の付け根まで', () => {
  close(palmSize(hand()), 0.2, '手のひら');
});

test('updatePinch は近づけるとつまみ、少し離しただけでは離さない', () => {
  assert.equal(updatePinch(false, hand(0.2 * PINCH_START * 0.9)), true);
  assert.equal(updatePinch(false, hand(0.2 * (PINCH_START + PINCH_END) / 2)), false, 'まだつまんでいない');
  assert.equal(updatePinch(true, hand(0.2 * (PINCH_START + PINCH_END) / 2)), true, 'つまんだまま');
  assert.equal(updatePinch(true, hand(0.2 * PINCH_END * 1.1)), false, '離した');
});

test('handToWorld は鏡のように左右を反転し、近づけると奥へ進む', () => {
  const world = handToWorld(hand(), { view: VIEW, palmRef: 0.2, startZ: 1.2 });
  // 手首は画像の真ん中の下のほう → 世界の真ん中・下のほう
  close(world[WRIST][0], 0, '手首の x');
  close(world[WRIST][1], 1 + (0.5 - 0.8) * 3, '手首の y');
  close(world[WRIST][2], 1.2, '最初の奥行き');
  // 画像の右へ動かすと、世界では左（鏡）
  const right = handToWorld(hand(0.2, 0.1), { view: VIEW, palmRef: 0.2 });
  assert.ok(right[WRIST][0] < 0);
  // 手のひらが 1.5 倍に映る（カメラに近づいた）と、奥（z が小さい方）へ
  const bigger = hand();
  bigger[MIDDLE_BASE] = { x: 0.5, y: 0.5, z: 0 };
  const near = handToWorld(bigger, { view: VIEW, palmRef: 0.2, startZ: 1.2, depthGain: 2 });
  close(near[WRIST][2], 1.2 - 0.5 * 2, '奥へ');
  // カメラに近い関節（z が負）は、手首より奥
  assert.ok(handToWorld(hand(), { view: VIEW, palmRef: 0.2 })[THUMB_TIP][2] < 1.2);
});

test('smoothPoints は前の位置から少しずつ近づく', () => {
  const next = [[1, 1, 1]];
  assert.deepEqual(smoothPoints(null, next), [[1, 1, 1]]);
  assert.deepEqual(smoothPoints([[0, 0, 0]], next, 0.25), [[0.25, 0.25, 0.25]]);
  assert.deepEqual(smoothPoints([[0, 0, 0], [0, 0, 0]], next, 0.25), [[1, 1, 1]], '数が違えば新しい位置');
  assert.deepEqual(midpoint([0, 0, 0], [2, 4, 6]), [1, 2, 3]);
});

test('nearestVertex は一番近い頂点を返す', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 3, 0]);
  assert.deepEqual(nearestVertex(positions, [0.9, 0.1, 0]).index, 1);
  close(nearestVertex(positions, [0, 2, 0]).distance, 1, '距離');
  assert.equal(nearestVertex(new Float32Array(0), [0, 0, 0]).index, -1);
});

test('pushOut は球の中の頂点だけを表面まで押し出す', () => {
  const positions = new Float32Array([0, 0, 0.1, 0, 0, 0.5, 5, 5, 5, 0, 0, 0]);
  const moved = pushOut(positions, [{ center: [0, 0, 0.3], radius: 0.3 }]);
  // 頂点 0 は中心より手前（z が小さい）にいたので、手前の表面へ
  close(positions[2], 0.3 - 0.3, '頂点 0 は表面へ');
  close(positions[5], 0.6, '頂点 1 は奥の表面へ');
  assert.deepEqual([...positions.slice(6, 9)], [5, 5, 5], '遠い頂点は動かない');
  // 頂点 3 はちょうど表面（距離 = 半径）にあるので動かさない
  assert.deepEqual(moved, [0, 1]);
  assert.deepEqual([...positions.slice(9, 12)], [0, 0, 0]);
  // 球の外ならそのまま
  assert.deepEqual(pushOut(new Float32Array([1, 1, 1]), [{ center: [0, 0, 0], radius: 0.5 }]), []);
  assert.deepEqual(pushOut(new Float32Array([1, 1, 1]), []), []);
});

test('springVector は揺れながら 0 に戻る', () => {
  let state = { value: [1, 0, 0], velocity: [0, 0, 0] };
  let overshoot = false;
  for (let i = 0; i < 600; i++) {
    state = springVector(state.value, state.velocity);
    if (state.value[0] < 0) overshoot = true;
  }
  assert.ok(overshoot, '行き過ぎて揺れる');
  assert.ok(vectorLength(state.value) < 1e-3, '最後は 0');
  close(vectorLength([3, 4, 0]), 5, '長さ');
});
