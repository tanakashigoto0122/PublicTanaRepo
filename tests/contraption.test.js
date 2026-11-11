import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD, GOAL_WALL, PART_TYPES, ROTATE_STEP, SANDBOX, STAGES, canPlace, canPut, clampToBoard, corners, fixedRects,
  inGoal, makePart, markCleared, parseCleared, pointInPart, rectsOverlap, remainingParts, rotatePart, snap,
} from '../games/contraption/logic.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('ステージの形', () => {
  assert.equal(STAGES.length, 5);
  for (const stage of [...STAGES, SANDBOX]) {
    assert.ok(stage.title && stage.hint);
    assert.ok(stage.fixed.some((item) => item.type === 'ball'), '玉がある');
    for (const type of Object.keys(stage.parts)) assert.ok(PART_TYPES[type], type);
    for (const item of stage.fixed) {
      assert.ok(item.x >= 0 && item.x <= BOARD.width && item.y >= 0 && item.y <= BOARD.height, `${stage.title} ${item.type}`);
    }
  }
  for (const stage of STAGES) assert.ok(stage.fixed.some((item) => item.type === 'goal'), 'かごがある');
  // goalBall は玉の番号
  const seesaw = STAGES.find((stage) => stage.goalBall !== undefined);
  assert.ok(seesaw.fixed.filter((item) => item.type === 'ball')[seesaw.goalBall].light);
});

test('snap と clampToBoard', () => {
  assert.ok(close(snap(1.234), 1.2));
  assert.ok(close(snap(1.25, 0.5), 1.5));
  assert.deepEqual(clampToBoard([-1, 20]), [0, BOARD.height]);
  assert.deepEqual(clampToBoard([3, 4]), [3, 4]);
});

test('rotatePart は 15 度ずつ回り、-90〜90 度に収まる', () => {
  assert.ok(close(rotatePart(0), ROTATE_STEP));
  let angle = 0;
  for (let i = 0; i < 12; i++) angle = rotatePart(angle);
  assert.equal(angle, 0, '12 回（180 度）で元の形');
  assert.ok(close(rotatePart(Math.PI / 2 - ROTATE_STEP / 2), -Math.PI / 2 + ROTATE_STEP / 2));
});

test('pointInPart は回した長方形の中か', () => {
  const plank = { x: 2, y: 2, w: 2, h: 0.2, angle: 0 };
  assert.equal(pointInPart([2.9, 2], plank), true);
  assert.equal(pointInPart([2, 2.3], plank), false);
  assert.equal(pointInPart([2, 2.3], plank, 0.25), true, '広めにつかむ');
  const upright = { ...plank, angle: Math.PI / 2 };
  assert.equal(pointInPart([2, 2.9], upright), true);
  assert.equal(pointInPart([2.9, 2], upright), false);
});

test('corners と rectsOverlap', () => {
  const square = { x: 0, y: 0, w: 2, h: 2, angle: 0 };
  assert.deepEqual(corners(square), [[-1, -1], [1, -1], [1, 1], [-1, 1]]);
  assert.equal(rectsOverlap(square, { ...square, x: 1.5 }), true);
  assert.equal(rectsOverlap(square, { ...square, x: 2.01 }), false, '触れているだけ');
  // 45 度回した正方形は、角が近づいても辺の間にすき間がある
  const diamond = { x: 2.3, y: 0, w: 2, h: 2, angle: Math.PI / 4 };
  assert.equal(rectsOverlap(square, diamond), true);
  assert.equal(rectsOverlap(square, { ...diamond, x: 2.5 }), false);
});

test('remainingParts・canPlace と makePart', () => {
  const stage = STAGES[0];
  const ramp = makePart('ramp', [3.04, 4.96], 0.3);
  assert.deepEqual([ramp.type, ramp.w, ramp.h, ramp.angle], ['ramp', PART_TYPES.ramp.w, PART_TYPES.ramp.h, 0.3]);
  assert.ok(close(ramp.x, 3) && close(ramp.y, 5));
  assert.deepEqual(remainingParts(stage, []), { ramp: 2 });
  assert.deepEqual(remainingParts(stage, [ramp]), { ramp: 1 });
  assert.equal(canPlace(stage, [ramp], 'ramp'), true);
  assert.equal(canPlace(stage, [ramp, ramp], 'ramp'), false);
  assert.equal(canPlace(stage, [], 'domino'), false, 'このステージにない部品');
  assert.equal(canPlace(SANDBOX, Array(50).fill(ramp), 'ramp'), true, 'じゆうはいくつでも');
  assert.deepEqual(makePart('block', [-3, 99]).y, BOARD.height);
});

test('canPut は動かせない物やほかの部品と重なる所に置かせない', () => {
  const stage = STAGES[1];
  const wall = stage.fixed.find((item) => item.type === 'ledge' && item.h > 1);
  assert.equal(canPut(stage, makePart('ramp', [wall.x, wall.y])), false, '壁の上');
  const free = makePart('ramp', [6, 6]);
  assert.equal(canPut(stage, free), true);
  const other = makePart('ramp', [6.5, 6]);
  assert.equal(canPut(stage, free, [free, other]), false, 'ほかの部品と重なる');
  assert.equal(canPut(stage, free, [free]), true, '自分自身とは比べない');
  // かごの中にも置けない
  const goal = STAGES[0].fixed.find((item) => item.type === 'goal');
  assert.equal(canPut(STAGES[0], makePart('block', [goal.x, goal.y + 0.3])), false);
  assert.ok(fixedRects(STAGES[4]).length > STAGES[4].fixed.length, 'シーソーは支点と動く範囲');
});

test('inGoal はかごの壁の内側で、底から壁の高さまで', () => {
  const goal = { x: 5, y: 1, w: 1.4 };
  assert.equal(inGoal([5, 1.2], goal), true);
  assert.equal(inGoal([5.65, 1.2], goal), false, '壁のすぐそば');
  assert.equal(inGoal([5, 1 + GOAL_WALL + 0.3], goal), false, '上を飛んでいる');
  assert.equal(inGoal([5, 0.9], goal), false);
});

test('markCleared と parseCleared', () => {
  assert.deepEqual(markCleared([2, 0], 1), [0, 1, 2]);
  assert.deepEqual(markCleared([0], 0), [0]);
  assert.deepEqual(parseCleared('[0,3,99,-1,"a",1.5]'), [0, 3]);
  assert.deepEqual(parseCleared('broken'), []);
  assert.deepEqual(parseCleared(null), []);
  assert.deepEqual(parseCleared('{"a":1}'), []);
});
