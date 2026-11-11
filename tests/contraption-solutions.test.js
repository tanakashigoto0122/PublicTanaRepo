// からくり装置のステージが、決まった置き方で解けて、何も置かなければ解けないことを確かめる。
// 物理は同梱の cannon-es を直接読み込む（ページと同じ physics.js を使う）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CANNON from '../assets/vendor/cannon-es/dist/cannon-es.js';
import { GOAL_HOLD, ROTATE_STEP, STAGES, canPut, inGoal, makePart } from '../games/contraption/logic.js';
import { buildWorld } from '../games/contraption/physics.js';

function clears(stageIndex, layout, seconds = 12) {
  const stage = STAGES[stageIndex];
  const placed = layout.map(([type, x, y, steps = 0]) => makePart(type, [x, y], steps * ROTATE_STEP));
  for (const part of placed) assert.ok(canPut(stage, part, placed), `${stage.title}: 置ける所 ${JSON.stringify(part)}`);
  const { world, balls, goals } = buildWorld(CANNON, stage, placed);
  const scoring = stage.goalBall === undefined ? balls : [balls[stage.goalBall]];
  let hold = 0;
  for (let i = 0; i < seconds * 120; i++) {
    world.step(1 / 120);
    const inside = scoring.some((b) => goals.some((g) => inGoal([b.position.x, b.position.y], g)));
    hold = inside ? hold + 1 / 120 : 0;
    if (hold >= GOAL_HOLD) return true;
  }
  return false;
}

const SOLUTIONS = [
  [['ramp', 2.9, 3.4, -2]],
  [['ramp', 3.4, 4.4, 1], ['ramp', 4, 1, -1]],
  [['domino', 4.4, 2.5], ['domino', 5.05, 2.5], ['domino', 5.55, 2.5], ['domino', 6.05, 2.5]],
  [['spring', 3.2, 2, -2]],
  [['block', 3, 7]],
];

for (const [index, solution] of SOLUTIONS.entries()) {
  test(`${index + 1} 面「${STAGES[index].title}」は解けて、何も置かなければ解けない`, () => {
    assert.equal(clears(index, solution), true);
    assert.equal(clears(index, []), false);
  });
}
