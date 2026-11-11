import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CPU_LEVELS, DOHYO_HEIGHT, RING_RADIUS, START_GAP, WINS_NEEDED, addVelocity, averageSpacing, bodySummary,
  collideBodies, cpuMove, createBody, createMatch, floorAt, hopVelocity, isOut, normalize2, recordRound, roundWinner,
  stepBody, stiffnessFromSoftness, surfaceSamples, translateBody,
} from '../games/jelly-sumo/logic.js';

// 半径 r の球の表面に n 個の粒
function sphere(n, r) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const ring = Math.sqrt(1 - y * y);
    const t = i * 2.39996;
    p.push(Math.cos(t) * ring * r, y * r + r, Math.sin(t) * ring * r);
  }
  return Float32Array.from(p);
}

function wrestler(x) {
  const rest = sphere(100, 0.6);
  const body = createBody(rest, averageSpacing(rest) * 2.5);
  translateBody(body, [x, DOHYO_HEIGHT, 0]);
  return body;
}

const options = { dt: 1 / 120, stiffness: stiffnessFromSoftness(45), bounce: 0.25, wall: 6, floorAt };

test('floorAt は土俵の上だけ高い', () => {
  assert.equal(floorAt(0, 0), DOHYO_HEIGHT);
  assert.equal(floorAt(RING_RADIUS, 0), DOHYO_HEIGHT);
  assert.equal(floorAt(RING_RADIUS + 0.01, 0), 0);
  assert.equal(floorAt(-3, 3), 0);
});

test('土俵の上に置いた体は台の上で止まる', () => {
  const body = wrestler(0);
  for (let i = 0; i < 240; i++) stepBody(body, options);
  const summary = bodySummary(body.positions);
  assert.ok(Math.abs(summary.lowest - DOHYO_HEIGHT) < 0.01);
  assert.equal(isOut(summary), false);
});

test('isOut は土俵の外か、台から落ちたとき', () => {
  assert.equal(isOut({ center: [0, 1, 0], lowest: DOHYO_HEIGHT }), false);
  assert.equal(isOut({ center: [RING_RADIUS + 0.1, 1, 0], lowest: DOHYO_HEIGHT }), true);
  assert.equal(isOut({ center: [0, 1, RING_RADIUS * 0.99], lowest: DOHYO_HEIGHT }), false);
  assert.equal(isOut({ center: [2, 0.5, 0], lowest: 0 }), true, '台から落ちた');
});

test('collideBodies は離れていれば何もせず、重なれば押し返す', () => {
  const a = wrestler(-2);
  const b = wrestler(2);
  const before = b.positions.slice();
  assert.equal(collideBodies(a, b, 0.3), 0);
  assert.deepEqual(b.positions, before);
  const c = wrestler(-0.5);
  const d = wrestler(0.5);
  addVelocity(c, [3, 0, 0]);
  assert.ok(collideBodies(c, d, 0.3) > 0);
  const [ca, cb] = [bodySummary(c.positions).center, bodySummary(d.positions).center];
  assert.ok(ca[0] < -0.5 && cb[0] > 0.5, '押し返される');
  // ぶつかった勢いが相手に渡る
  const vx = (body) => body.velocities.filter((_, i) => i % 3 === 0).reduce((s, v) => s + v, 0);
  assert.ok(vx(d) > 0);
  assert.ok(vx(c) < 3 * 100);
});

test('跳ねて押し続けると、何もしない相手を土俵の外へ出せる', () => {
  const a = wrestler(-START_GAP);
  const b = wrestler(START_GAP);
  const spacing = averageSpacing(sphere(100, 0.6));
  let hop = 0;
  let out = false;
  for (let i = 0; i < 120 * 10 && !out; i++) {
    hop -= options.dt;
    const [sa, sb] = [bodySummary(a.positions), bodySummary(b.positions)];
    if (a.grounded.some(Boolean) && hop <= 0) {
      addVelocity(a, hopVelocity([sb.center[0] - sa.center[0], sb.center[2] - sa.center[2]]));
      hop = 0.35;
    }
    stepBody(a, options);
    stepBody(b, options);
    collideBodies(a, b, spacing);
    out = isOut(bodySummary(b.positions));
  }
  assert.ok(out);
  assert.equal(isOut(bodySummary(a.positions)), false);
});

test('normalize2 と hopVelocity', () => {
  assert.deepEqual(normalize2([3, 4]), [0.6, 0.8]);
  assert.deepEqual(normalize2([0, 0]), [0, 0]);
  const hop = hopVelocity([1, 0]);
  const dash = hopVelocity([2, 0], { dash: true });
  assert.ok(hop[0] > 0 && hop[1] > 0 && hop[2] === 0);
  assert.ok(dash[0] > hop[0] * 2, 'ぶちかましは速い');
  assert.ok(dash[1] < hop[1], 'ぶちかましは低い');
  assert.ok(hopVelocity([1, 0], { power: 0.5 })[0] < hop[0]);
  assert.deepEqual(hopVelocity([0, 0]).filter((_, i) => i !== 1), [0, 0]);
});

test('cpuMove は相手へ向かい、端では真ん中へ戻ろうとする', () => {
  const still = () => 0.5;
  const toward = cpuMove([0, 0], [1, 0], CPU_LEVELS.normal, still);
  assert.ok(toward.dir[0] > 0.99);
  // 相手が外側にいても、端にいるときは内側へ寄る
  const edge = cpuMove([0, -RING_RADIUS * 0.95], [0.5, -RING_RADIUS * 0.95], CPU_LEVELS.normal, still);
  assert.ok(edge.dir[1] > 0, '真ん中（+z）へ向かう');
  assert.equal(cpuMove([0, 0], [1, 0], CPU_LEVELS.strong, () => 0).dash, true, '近くて乱数が小さければぶちかまし');
  assert.equal(cpuMove([0, 0], [3, 0], CPU_LEVELS.strong, () => 0).dash, false, '遠ければしない');
  assert.ok(CPU_LEVELS.weak.power < CPU_LEVELS.strong.power);
});

test('recordRound と roundWinner', () => {
  let match = createMatch();
  assert.deepEqual(match, { wins: [0, 0], round: 1, winner: null });
  match = recordRound(match, 1);
  assert.deepEqual(match, { wins: [0, 1], round: 2, winner: null });
  match = recordRound(match, 0);
  for (let i = 1; i < WINS_NEEDED; i++) match = recordRound(match, 0);
  assert.equal(match.winner, 0);
  assert.deepEqual(match.wins, [WINS_NEEDED, 1]);
  assert.equal(roundWinner(false, false, 1, 1), null);
  assert.equal(roundWinner(true, false, 3, 1), 1);
  assert.equal(roundWinner(false, true, 1, 3), 0);
  assert.equal(roundWinner(true, true, 2.5, 3), 0, '両方出たら真ん中に近いほう');
  assert.equal(roundWinner(true, true, 3, 2.5), 1);
});

test('surfaceSamples は面の上に、面積に比例して点を置く', () => {
  // 1×1 の正方形（2 枚の三角形、index あり）と、横に離れた 1×2 の長方形（index なし）
  const square = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), index: [0, 1, 2, 0, 2, 3] };
  const rect = { positions: Float32Array.from([5, 0, 0, 6, 0, 0, 6, 2, 0, 5, 0, 0, 6, 2, 0, 5, 2, 0]), index: null };
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const points = surfaceSamples([square, rect], 3000, random);
  assert.equal(points.length, 3000);
  for (const [x, y, z] of points) {
    assert.equal(z, 0);
    const inSquare = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    const inRect = x >= 5 && x <= 6 && y >= 0 && y <= 2;
    assert.ok(inSquare || inRect);
  }
  const share = points.filter(([x]) => x >= 5).length / points.length;
  assert.ok(Math.abs(share - 2 / 3) < 0.05, `面積の比 ${share}`);
  // 面積のない三角形しかなければ空
  assert.deepEqual(surfaceSamples([{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), index: null }], 5), []);
});
