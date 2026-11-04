import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOST, COURSE_LENGTH, PAD_BOOST, FEATURE_TYPES, MAX_ANGLE, MAX_LAUNCH_SPEED, MIN_DRAG, REST_SECONDS, REST_SPEED,
  characterScale, courseLayout, detectFormat, distanceFrom, formatDistance, isResting, launchVelocity,
  markerPositions, restTimer, trajectory,
} from '../games/launch-distance/logic.js';

function close(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('ほかのゲームの関数と定数', () => {
  assert.equal(detectFormat('mecha-lite.glb'), 'glb');
  assert.equal(characterScale([1, 1, 1]), 2);
  assert.equal(BOOST.length, 2);
  assert.ok(BOOST[0] < PAD_BOOST[0], '空中のブーストはパッドより弱い');
  assert.ok(COURSE_LENGTH > 100);
});

test('launchVelocity は引っぱった向きと逆へ飛ばす', () => {
  // 左下へ 45 度引っぱると、右上へ 45 度
  const shot = launchVelocity(-100, 100, 200);
  close(shot.angle, Math.PI / 4, '角度');
  close(shot.power, Math.hypot(100, 100) / 200, '強さ');
  close(shot.vx, shot.vy, '45 度');
  assert.ok(shot.vx > 0 && shot.vy > 0);
  // 引っぱりが最大を超えたら強さは 1
  const full = launchVelocity(-500, 0, 200);
  close(full.power, 1, '最大');
  close(full.vx, MAX_LAUNCH_SPEED, '真横');
  close(full.vy, 0, '真横');
  // 前へ引っぱっても後ろ向きには飛ばない（真上近くまでに収める）
  close(launchVelocity(100, 100, 200).angle, MAX_ANGLE, '上限');
  close(launchVelocity(-100, -50, 200).angle, 0, '下向きは水平に');
  assert.equal(launchVelocity(MIN_DRAG / 2, 0, 200), null);
  assert.equal(launchVelocity(-50, 50, 0), null);
});

test('trajectory は放物線で、地面の手前で止まる', () => {
  const points = trajectory([0, 1], [10, 10], 10, { step: 0.1, maxPoints: 100 });
  assert.deepEqual(points[0], [0, 1]);
  close(points[10][0], 10, '1 秒後の x');
  close(points[10][1], 1 + 10 - 5, '1 秒後の y');
  assert.ok(points.every(([, y]) => y >= 0));
  // 頂点は真ん中あたり（vy / g = 1 秒）
  const top = points.reduce((a, b) => (b[1] > a[1] ? b : a));
  close(top[0], 10, '頂点の x', 1e-6);
  assert.ok(trajectory([0, 1], [5, 5], 10, { maxPoints: 5 }).length === 5);
  assert.deepEqual(trajectory([0, -1], [1, 0]), []);
});

test('courseLayout は最初を空けて、間をあけて仕掛けを並べる', () => {
  const features = courseLayout({ length: 300 });
  assert.ok(features.length > 3);
  assert.ok(features[0].x >= 15);
  for (let i = 0; i < features.length; i++) {
    assert.ok(FEATURE_TYPES.includes(features[i].type));
    assert.ok(features[i].x < 300);
    if (i > 0) assert.ok(features[i].x >= features[i - 1].x + features[i - 1].width + 15, '15 m 以上あける');
  }
  const fixed = () => courseLayout({ length: 200, random: sequence([0.2, 0.7, 0.4, 0.9, 0.1]) });
  assert.deepEqual(fixed(), fixed());
  assert.deepEqual(new Set(courseLayout({ length: 5000 }).map((f) => f.type)), new Set(FEATURE_TYPES));
});

test('distanceFrom・formatDistance・markerPositions', () => {
  assert.equal(distanceFrom(2, 12.5), 10.5);
  assert.equal(distanceFrom(2, -3), 0);
  assert.equal(formatDistance(123.456), '123.5 m');
  assert.deepEqual(markerPositions(100, 25), [25, 50, 75, 100]);
});

test('restTimer と isResting', () => {
  let timer = 0;
  timer = restTimer(timer, REST_SPEED * 2, 0.5);
  assert.equal(timer, 0);
  timer = restTimer(timer, REST_SPEED / 2, REST_SECONDS / 2);
  assert.ok(!isResting(timer));
  timer = restTimer(timer, REST_SPEED / 2, REST_SECONDS / 2);
  assert.ok(isResting(timer));
  assert.equal(restTimer(timer, REST_SPEED, 0.1), 0);
});
