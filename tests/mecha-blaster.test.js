import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_HALF, CHARACTER_HEIGHT, CRATE_SIZE, DEAD_ZONE, GAME_SECONDS, characterScale, detectFormat, finalScore,
  formatTime, guessFacing, headingOf, isKnocked, joystickVector, keyboardVector, moveVelocity, tiltAngle,
  towerLayout, turnTowards, wrapAngle,
} from '../games/mecha-blaster/logic.js';

function close(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

// 0 から順に決まった値を返す乱数
function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('定数と 3D ビューアの関数', () => {
  assert.equal(GAME_SECONDS, 60);
  assert.ok(CHARACTER_HEIGHT > CRATE_SIZE);
  assert.equal(detectFormat('mecha-lite.glb'), 'glb');
});

test('joystickVector は遊びを除いて 0〜1 にし、上を前にする', () => {
  assert.deepEqual(joystickVector(0, 0, 50), { x: 0, y: 0, magnitude: 0 });
  assert.deepEqual(joystickVector(50 * DEAD_ZONE * 0.9, 0, 50), { x: 0, y: 0, magnitude: 0 });
  const up = joystickVector(0, -50, 50);
  close(up.x, 0, 'x');
  close(up.y, 1, '上は前');
  close(up.magnitude, 1, '端まで');
  const far = joystickVector(300, 0, 50);
  close(far.x, 1, '半径より外でも 1');
  const half = joystickVector(0, 50 * (DEAD_ZONE + (1 - DEAD_ZONE) / 2), 50);
  close(half.magnitude, 0.5, '半分');
  close(half.y, -0.5, '下は後ろ');
  assert.equal(joystickVector(10, 10, 0).magnitude, 0);
});

test('keyboardVector は斜めでも長さ 1', () => {
  assert.deepEqual(keyboardVector({}), { x: 0, y: 0, magnitude: 0 });
  const diagonal = keyboardVector({ up: true, right: true });
  close(Math.hypot(diagonal.x, diagonal.y), 1, '斜め');
  assert.deepEqual(keyboardVector({ left: true, right: true }), { x: 0, y: 0, magnitude: 0 });
  assert.deepEqual(keyboardVector({ down: true }), { x: 0, y: -1, magnitude: 1 });
});

test('moveVelocity はカメラから見た前・右に動かす', () => {
  // カメラが +z を向いているとき、前は +z、右は -x
  const [fx, fz] = moveVelocity({ x: 0, y: 1 }, 0, 5);
  close(fx, 0, '前 x');
  close(fz, 5, '前 z');
  const [rx, rz] = moveVelocity({ x: 1, y: 0 }, 0, 5);
  close(rx, -5, '右 x');
  close(rz, 0, '右 z');
  // カメラが +x を向いているとき、前は +x
  const [gx, gz] = moveVelocity({ x: 0, y: 1 }, Math.PI / 2, 2);
  close(gx, 2, '前 x');
  close(gz, 0, '前 z', 1e-9);
  close(headingOf(gx, gz), Math.PI / 2, '向き');
});

test('wrapAngle と turnTowards は近い回り方をする', () => {
  close(wrapAngle(3 * Math.PI), Math.PI, '3π');
  close(wrapAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2, '-5π/2');
  close(turnTowards(0, 1, 0.25), 0.25, '少しだけ回る');
  close(turnTowards(0, 0.1, 0.25), 0.1, '届くなら目標へ');
  // 3 から -3 へは、-π/π をまたいで近い側に回る
  close(turnTowards(3, -3, 0.1), wrapAngle(3.1), '近い側');
});

test('tiltAngle と isKnocked', () => {
  close(tiltAngle([0, 0, 0, 1]), 0, '立っている');
  close(tiltAngle([Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]), Math.PI / 2, '寝ている');
  const start = [0, 0.4, 0];
  const still = [0, 0, 0, 1];
  assert.equal(isKnocked(start, [0.1, 0.4, 0.1], still), false);
  assert.equal(isKnocked(start, [0, 0.4 - CRATE_SIZE * 0.5, 0], still), true, '落ちた');
  assert.equal(isKnocked(start, [CRATE_SIZE, 0.4, 0], still), true, 'ずれた');
  const tilted = [0, 0, Math.sin(0.3), Math.cos(0.3)];
  assert.equal(isKnocked(start, start, tilted), true, '傾いた');
});

test('towerLayout は中心を避け、塔どうしを離し、箱を積み上げる', () => {
  const crates = towerLayout({ towers: 6, minHeight: 2, maxHeight: 4 });
  const columns = new Map();
  for (const [x, y, z] of crates) {
    assert.ok(Math.abs(x) <= ARENA_HALF && Math.abs(z) <= ARENA_HALF);
    assert.ok(Math.hypot(x, z) >= 4, 'スタート地点の近くには置かない');
    const key = `${x},${z}`;
    columns.set(key, [...(columns.get(key) ?? []), y]);
  }
  assert.equal(columns.size, 6);
  for (const heights of columns.values()) {
    assert.ok(heights.length >= 2 && heights.length <= 4);
    heights.forEach((y, level) => close(y, CRATE_SIZE * (level + 0.5), '積み上げ'));
  }
  const keys = [...columns.keys()].map((k) => k.split(',').map(Number));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) assert.ok(Math.hypot(keys[i][0] - keys[j][0], keys[i][1] - keys[j][1]) >= 3);
  }
  // 同じ乱数なら同じ並び
  const fixed = () => towerLayout({ towers: 3, random: sequence([0.1, 0.9, 0.8, 0.2, 0.5, 0.95, 0.3]) });
  assert.deepEqual(fixed(), fixed());
  // 置ける場所がなければ、あきらめて置けた分だけ返す
  assert.deepEqual(towerLayout({ towers: 3, random: () => 0.5 }), []);
});

test('finalScore と formatTime', () => {
  assert.equal(finalScore(10, 20, 30), 10);
  assert.equal(finalScore(20, 20, 12.7), 20 + 24);
  assert.equal(finalScore(20, 20, -1), 20);
  assert.equal(formatTime(12.345), '12.3');
  assert.equal(formatTime(-2), '0.0');
});

test('characterScale と guessFacing', () => {
  assert.equal(characterScale([0.3, 1, 0.8]), CHARACTER_HEIGHT);
  assert.equal(characterScale([1, 0, 1]), 1);
  assert.equal(guessFacing([0.34, 1, 0.8]), -Math.PI / 2);
  assert.equal(guessFacing([0.8, 1, 0.4]), 0);
});
