import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUNDS, FILTERS, MAX_CHARACTERS, STAGE_HALF, STAMPS, clamp01, clampToStage, createStamp, photoFileName,
  resizeStamp, slotPosition, stampPixels, starPositions,
} from '../games/photo-studio/logic.js';

test('背景とフィルターの決まり', () => {
  for (const preset of Object.values(BACKGROUNDS)) {
    assert.ok(preset.label);
    for (const key of ['top', 'bottom', 'floor']) assert.match(preset[key], /^--/, '色は CSS 変数の名前');
  }
  assert.equal(FILTERS.none.css, 'none');
  for (const filter of Object.values(FILTERS)) assert.ok(filter.label && filter.css);
  assert.ok(STAMPS.length >= 5);
});

test('createStamp は位置を写真の中に収める', () => {
  assert.deepEqual(createStamp('⭐'), { text: '⭐', x: 0.5, y: 0.5, size: 0.12, rotation: 0 });
  const outside = createStamp('A', { x: -1, y: 3 });
  assert.deepEqual([outside.x, outside.y], [0, 1]);
  assert.equal(clamp01(0.3), 0.3);
});

test('resizeStamp は小さすぎ・大きすぎにしない', () => {
  const stamp = createStamp('⭐');
  assert.ok(Math.abs(resizeStamp(stamp, 2).size - 0.24) < 1e-9);
  assert.equal(resizeStamp(stamp, 100).size, 0.6);
  assert.equal(resizeStamp(stamp, 0.01).size, 0.04);
  assert.equal(stamp.size, 0.12, '元のスタンプは変えない');
});

test('stampPixels は割合をピクセルにする（大きさは短い辺に対して）', () => {
  const pixels = stampPixels({ x: 0.25, y: 0.5, size: 0.1, rotation: 1 }, 800, 400);
  assert.deepEqual(pixels, { x: 200, y: 200, size: 40, rotation: 1 });
});

test('clampToStage と slotPosition', () => {
  assert.deepEqual(clampToStage([10, -10]), [STAGE_HALF, -STAGE_HALF]);
  assert.deepEqual(clampToStage([1, 2]), [1, 2]);
  assert.deepEqual(slotPosition(0), [0, 0]);
  const [right] = slotPosition(1);
  const [left] = slotPosition(2);
  assert.ok(right > 0 && left < 0 && Math.abs(right + left) < 1e-9, '左右に同じだけ離す');
  for (let i = 0; i < MAX_CHARACTERS; i++) assert.ok(Math.abs(slotPosition(i)[0]) <= STAGE_HALF);
});

test('photoFileName は日時から作る', () => {
  assert.equal(photoFileName(new Date(2026, 10, 9, 8, 5, 3).getTime()), 'photo-20261109-080503.png');
});

test('starPositions は差し替えた乱数で決まる', () => {
  const stars = starPositions(3, () => 0.5);
  assert.equal(stars.length, 3);
  assert.deepEqual(stars[0], [0.5, 0.3, 1.25]);
});
