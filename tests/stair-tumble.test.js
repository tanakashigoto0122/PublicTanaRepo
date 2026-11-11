import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANDING, MAX_IMPACT_SPEED, PART_NAMES, STEP_COUNT, STEP_RISE, STEP_RUN, assignParts, distanceToPart, impactScore,
  layoutRagdoll, pushPower, stairBoxes, updateSettle,
} from '../games/stair-tumble/logic.js';

const H = 1.6;

function part(layout, name) {
  return layout.parts.find((p) => p.name === name);
}

test('layoutRagdoll は 11 の部位と 10 の関節で、すべての部位に名前がある', () => {
  const layout = layoutRagdoll({ height: H, width: 0.5, depth: 0.3 });
  assert.equal(layout.parts.length, 11);
  assert.equal(layout.joints.length, 10);
  assert.equal(layout.tPose, false);
  for (const p of layout.parts) assert.ok(PART_NAMES[p.name], p.name);
  const names = new Set(layout.parts.map((p) => p.name));
  for (const joint of layout.joints) assert.ok(names.has(joint.a) && names.has(joint.b));
  // 頭が一番上、すねが一番下で、足元は 0
  assert.ok(Math.abs(part(layout, 'head').center[1] + part(layout, 'head').radius - H) < 1e-9);
  const shin = part(layout, 'shinL');
  assert.ok(Math.abs(shin.center[1] - shin.half[1]) < 1e-9);
  // 左は +x、右は -x
  assert.ok(part(layout, 'thighL').center[0] > 0 && part(layout, 'thighR').center[0] < 0);
  assert.ok(part(layout, 'upperArmL').center[0] > part(layout, 'chest').half[0]);
});

test('layoutRagdoll は横に広いモデルを腕を広げた形にする', () => {
  const layout = layoutRagdoll({ height: H, width: 1.5, depth: 0.3 });
  assert.equal(layout.tPose, true);
  const hand = part(layout, 'lowerArmL');
  assert.ok(Math.abs(hand.center[0] + hand.half[0] - 0.75) < 1e-9, '手の先が横幅の端');
  assert.ok(hand.center[1] > H * 0.6, '腕は肩の高さ');
});

test('部位どうしの箱が重ならない（腕と胸、左右の脚）', () => {
  for (const width of [0.3, 0.5, 1.5]) {
    const layout = layoutRagdoll({ height: H, width, depth: 0.3 });
    const overlap = (a, b) => [0, 1, 2].every((k) => Math.abs(a.center[k] - b.center[k]) < a.half[k] + b.half[k] - 1e-9);
    assert.equal(overlap(part(layout, 'upperArmL'), part(layout, 'chest')), false, `width ${width}`);
    assert.equal(overlap(part(layout, 'thighL'), part(layout, 'thighR')), false, `width ${width}`);
  }
});

test('distanceToPart は箱と球の表面までの距離', () => {
  const box = { shape: 'box', center: [0, 0, 0], half: [1, 1, 1] };
  assert.equal(distanceToPart([3, 0, 0], box), 2);
  assert.equal(distanceToPart([0, 0, 0], box), -1);
  assert.ok(Math.abs(distanceToPart([2, 2, 1], box) - Math.SQRT2) < 1e-9);
  assert.equal(distanceToPart([0, 5, 0], { shape: 'sphere', center: [0, 2, 0], radius: 1 }), 2);
});

test('assignParts は近い部位に付け、境目では 2 つに分ける', () => {
  const parts = [
    { shape: 'box', center: [0, 0, 0], half: [1, 1, 1] },
    { shape: 'box', center: [0, 3, 0], half: [1, 1, 1] },
  ];
  const { indices, weights } = assignParts(Float32Array.from([0, 0, 0, 0, 3, 0, 0, 1.5, 0]), parts, 0.5);
  assert.deepEqual([indices[0], weights[0]], [0, 1]);
  assert.deepEqual([indices[4], weights[4]], [1, 1]);
  // 真ん中は半分ずつ
  assert.equal(weights[8], 0.5);
  assert.equal(weights[9], 0.5);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(weights[i * 4] + weights[i * 4 + 1] - 1) < 1e-6);
});

test('stairBoxes は踊り場と、下へ行くほど低い段', () => {
  const { boxes, top, bottomX } = stairBoxes();
  assert.equal(top, STEP_COUNT * STEP_RISE);
  assert.equal(bottomX, STEP_COUNT * STEP_RUN);
  assert.equal(boxes[0].center[0], -LANDING / 2);
  assert.equal(boxes[0].center[1] + boxes[0].half[1], top);
  const tops = boxes.slice(1).map((b) => b.center[1] + b.half[1]);
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] < tops[i - 1]);
  assert.equal(boxes.length, STEP_COUNT, '一番下の段は床と同じ高さなので箱がない');
});

test('impactScore は速いほど大きく、頭は高く、上限がある', () => {
  assert.equal(impactScore(1, 'chest'), 0);
  assert.ok(impactScore(4, 'chest') > impactScore(3, 'chest'));
  assert.ok(impactScore(4, 'head') > impactScore(4, 'shinL'));
  assert.equal(impactScore(1000, 'head'), impactScore(MAX_IMPACT_SPEED, 'head'));
  assert.equal(impactScore(Number.NaN, 'head'), 0);
});

test('pushPower と updateSettle', () => {
  assert.equal(pushPower(0, 800), 0);
  assert.equal(pushPower(140, 800), 0.5);
  assert.equal(pushPower(10000, 800), 1);
  assert.equal(pushPower(100, 0), 0);
  let state = { time: 0, settled: false };
  state = updateSettle(state, [0.1, 0.1], 1);
  assert.deepEqual(state, { time: 1, settled: false });
  state = updateSettle(state, [0.1, 2], 1);
  assert.deepEqual(state, { time: 0, settled: false }, '動いたらやり直し');
  state = updateSettle(updateSettle(state, [0], 1), [0], 1);
  assert.equal(state.settled, true);
});
