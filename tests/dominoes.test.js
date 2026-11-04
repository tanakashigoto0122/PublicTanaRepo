import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMINO_SIZE, FALLEN_ANGLE, MAX_DOMINOES, OVERLAP_DISTANCE, SPACING_RANGE, headingOf, heartPath, isFallen, pathLength,
  placeAlongPath, removeTooClose, resamplePath, spiralPath, summary, tiltAngle, zigzagPath,
} from '../games/dominoes/logic.js';

function close(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

test('定数', () => {
  assert.equal(DOMINO_SIZE.length, 3);
  assert.ok(SPACING_RANGE.max < DOMINO_SIZE[1], '間隔の上限は高さより短い（届かないと連鎖しない）');
  assert.ok(MAX_DOMINOES > 0);
});

test('pathLength は折れ線の長さ', () => {
  assert.equal(pathLength([]), 0);
  assert.equal(pathLength([[0, 0]]), 0);
  assert.equal(pathLength([[0, 0], [3, 4], [3, 6]]), 7);
});

test('resamplePath は角をまたいでも等間隔に点を取る', () => {
  const points = resamplePath([[0, 0], [1, 0], [1, 1]], 0.5);
  assert.equal(points.length, 5);
  const expected = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1]];
  points.forEach((p, i) => {
    close(p[0], expected[i][0], `x ${i}`);
    close(p[1], expected[i][1], `z ${i}`);
  });
  // 間隔に満たない端は捨てる
  assert.equal(resamplePath([[0, 0], [1.2, 0]], 0.5).length, 3);
  assert.deepEqual(resamplePath([], 0.5), []);
  assert.deepEqual(resamplePath([[0, 0], [1, 0]], 0), []);
  // 細かく刻んだ線でも間隔は変わらない
  const fine = Array.from({ length: 101 }, (_, i) => [i / 100, 0]);
  const again = resamplePath(fine, 0.25);
  assert.equal(again.length, 5);
  close(again[4][0], 1, '最後の点', 1e-9);
});

test('headingOf は +z を 0、+x を π/2 とする', () => {
  close(headingOf([0, 0], [0, 1]), 0, '+z');
  close(headingOf([0, 0], [1, 0]), Math.PI / 2, '+x');
  close(Math.abs(headingOf([0, 0], [0, -1])), Math.PI, '-z');
});

test('placeAlongPath は線に沿った位置と進む向きを返す', () => {
  const placed = placeAlongPath([[0, 0], [2, 0]], 0.5);
  assert.equal(placed.length, 5);
  assert.ok(placed.every((p) => Math.abs(p.yaw - Math.PI / 2) < 1e-9));
  // 角では前後の向きの間になる
  const corner = placeAlongPath([[0, 0], [1, 0], [1, 1]], 0.5);
  close(corner[2].yaw, Math.PI / 4, '角');
  // 短すぎる線には置かない
  assert.deepEqual(placeAlongPath([[0, 0], [0.1, 0]], 0.5), []);
});

test('placeAlongPath は線が交差・折り返した所で重なるドミノを飛ばす', () => {
  // 十字に交差する線：交点の近くの 2 本目のドミノは飛ばす
  const cross = placeAlongPath([[-2, 0], [2, 0], [2, 2], [0, 2], [0, -2]], 0.5);
  for (let i = 0; i < cross.length; i++) {
    for (let j = i + 2; j < cross.length; j++) {
      const d = Math.hypot(cross[i].position[0] - cross[j].position[0], cross[i].position[1] - cross[j].position[1]);
      assert.ok(d >= OVERLAP_DISTANCE, `${i} と ${j} が重なっている（${d.toFixed(2)}）`);
    }
  }
  const all = placeAlongPath([[-2, 0], [2, 0]], 0.5).length + placeAlongPath([[2, 0], [2, 2], [0, 2], [0, -2]], 0.5).length;
  assert.ok(cross.length < all);
  // 同じ所を往復すると、帰り道は置かない
  const back = placeAlongPath([[0, 0], [3, 0], [0, 0]], 0.5);
  assert.equal(back.length, placeAlongPath([[0, 0], [3, 0]], 0.5).length);
});

test('removeTooClose は既存のドミノに近い候補を除く', () => {
  const existing = [{ position: [0, 0] }];
  const candidates = [{ position: [0.1, 0] }, { position: [0.5, 0] }, { position: [0, 2] }];
  assert.deepEqual(removeTooClose(candidates, existing, 0.3), candidates.slice(1));
  assert.deepEqual(removeTooClose(candidates, [], 0.3), candidates);
});

test('tiltAngle と isFallen', () => {
  close(tiltAngle([0, 0, 0, 1]), 0, '立っている');
  // y 軸まわりに回しても傾かない
  close(tiltAngle([0, Math.sin(0.6), 0, Math.cos(0.6)]), 0, 'y 軸まわり', 1e-9);
  // x 軸まわりに 90 度
  const lying = [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)];
  close(tiltAngle(lying), Math.PI / 2, '寝ている', 1e-9);
  assert.ok(isFallen(lying));
  const slight = [Math.sin(0.2), 0, 0, Math.cos(0.2)];
  assert.ok(!isFallen(slight));
  const edge = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
  assert.ok(!isFallen(edge(FALLEN_ANGLE - 0.01)));
  assert.ok(isFallen(edge(FALLEN_ANGLE + 0.01)));
});

test('summary', () => {
  assert.equal(summary(0, 0, null), 'ドミノがありません。');
  assert.equal(summary(10, 10, 3.21), '全部倒れた！ 10 個（3.2 秒）');
  assert.equal(summary(4, 10, null), '4 / 10 個倒れた');
});

test('お手本の形は、ドミノが並べられる長さの折れ線になる', () => {
  for (const [name, path] of [['うずまき', spiralPath()], ['ハート', heartPath()], ['ジグザグ', zigzagPath()]]) {
    assert.ok(path.length >= 2, name);
    assert.ok(path.every((p) => p.length === 2 && p.every(Number.isFinite)), name);
    const count = placeAlongPath(path, 0.55).length;
    assert.ok(count > 20 && count <= MAX_DOMINOES, `${name}: ${count} 個`);
  }
  // うずまきは外へ広がる
  const spiral = spiralPath({ turns: 2 });
  const r = (p) => Math.hypot(p[0], p[1]);
  assert.ok(r(spiral[spiral.length - 1]) > r(spiral[0]) + 2);
  // つづら折りは半円で次の行へ折り返す
  const zigzag = zigzagPath({ width: 2, rows: 2, rowGap: 1 });
  assert.deepEqual(zigzag[0], [-1, -0.5]);
  assert.deepEqual(zigzag[1], [1, -0.5]);
  assert.deepEqual(zigzag[zigzag.length - 1], [-1, 0.5]);
  const turn = zigzag.slice(2, -2);
  assert.ok(turn.every(([x, z]) => Math.abs(Math.hypot(x - 1, z) - 0.5) < 1e-9 && x > 1), '半円の上');
});
