import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARDNESS_STEPS, PARTS, SOLVER_ITERATIONS, addGlue, clampLevel, contactParams, jointParams, pairHardness, partHeight,
  partLayout, placePieces, quantizeHardness, setAllStiffness, setStiffnessOf,
} from '../games/soft-blocks/logic.js';

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test('clampLevel と quantizeHardness', () => {
  assert.equal(clampLevel(-3), 0);
  assert.equal(clampLevel(130), 100);
  assert.equal(clampLevel(NaN), 0);
  assert.equal(quantizeHardness(0), 0);
  assert.equal(quantizeHardness(12), 0);
  assert.equal(quantizeHardness(13), 25);
  assert.equal(quantizeHardness(62), 50);
  assert.equal(quantizeHardness(63), 75);
  assert.equal(quantizeHardness(200), 100);
  for (const step of HARDNESS_STEPS) assert.equal(quantizeHardness(step), step);
});

test('contactParams は硬いほど硬く、0 でも計算できる範囲に収まる', () => {
  let previous = null;
  for (const step of HARDNESS_STEPS) {
    const p = contactParams(step);
    if (previous) {
      assert.ok(p.stiffness > previous.stiffness);
      assert.ok(p.relaxation < previous.relaxation);
    }
    previous = p;
  }
  close(contactParams(0).stiffness, 10 ** 1.5, '最小');
  close(contactParams(100).stiffness, 1e7, '最大');
  assert.equal(pairHardness(25, 100), 25);
  assert.equal(pairHardness(75, 50), 50);
});

test('jointParams は硬さが上がるほど硬く、範囲外は端にそろえる', () => {
  assert.ok(jointParams(80).stiffness > jointParams(20).stiffness);
  close(jointParams(0).stiffness, 10 ** 1.2, '最小');
  close(jointParams(100).stiffness, 10 ** 3.2, '最大');
  assert.ok(SOLVER_ITERATIONS >= 50);
  assert.deepEqual(jointParams(-10), jointParams(0));
  assert.deepEqual(jointParams(150), jointParams(100));
});

test('addGlue は種類と硬さを持ち、重複と自分自身を拒む', () => {
  let glues = addGlue([], 5, 2, { stiffness: 30 });
  assert.deepEqual(glues, [{ a: 2, b: 5, type: 'lock', stiffness: 30 }]);
  assert.equal(addGlue(glues, 2, 5), glues);
  assert.equal(addGlue(glues, 3, 3), glues);
  glues = addGlue(glues, 5, 7, { type: 'ball', stiffness: 200 });
  assert.deepEqual(glues[1], { a: 5, b: 7, type: 'ball', stiffness: 100 });
  assert.deepEqual(addGlue([], 1, 2), [{ a: 1, b: 2, type: 'lock', stiffness: 100 }]);
});

test('setStiffnessOf は指定した物体の固定の接着だけを変える', () => {
  const glues = [
    { a: 1, b: 2, type: 'lock', stiffness: 100 },
    { a: 2, b: 3, type: 'ball', stiffness: 100 },
    { a: 3, b: 4, type: 'lock', stiffness: 100 },
  ];
  const next = setStiffnessOf(glues, 2, 20);
  assert.deepEqual(next.map((g) => g.stiffness), [20, 100, 100]);
  assert.equal(glues[0].stiffness, 100);
  assert.deepEqual(setStiffnessOf(glues, 9, 0).map((g) => g.stiffness), [100, 100, 100]);
  assert.deepEqual(setAllStiffness(glues, -5).map((g) => g.stiffness), [0, 100, 0]);
});

test('しなる板とロープは 1 列につながる', () => {
  for (const [kind, type, count] of [['bendy', 'lock', 6], ['rope', 'ball', 10]]) {
    const { pieces, joints } = partLayout(kind);
    assert.equal(pieces.length, count, kind);
    assert.equal(joints.length, count - 1, kind);
    assert.ok(joints.every((j, n) => j.i === n && j.j === n + 1 && j.type === type && j.internal));
    // 隣どうしのピースは隙間なく並び、継ぎ目の位置が一致する
    for (const { i, j, pivotI, pivotJ } of joints) {
      const a = pieces[i].offset[0] + pivotI[0];
      const b = pieces[j].offset[0] + pivotJ[0];
      close(a, b, `${kind} 継ぎ目 ${i}`);
    }
    // 底の中心が原点になるように並ぶ
    close(pieces[0].offset[0] + pieces[count - 1].offset[0], 0, `${kind} 左右対称`);
    close(pieces[0].offset[1] - pieces[0].size[1] / 2, 0, `${kind} 底`);
  }
});

test('ゼリーは 2×2×2 の箱を面で隣り合う 12 か所でつなぐ', () => {
  const { pieces, joints } = partLayout('jelly');
  assert.equal(pieces.length, 8);
  assert.equal(joints.length, 12);
  const degree = new Array(8).fill(0);
  for (const { i, j } of joints) {
    degree[i]++;
    degree[j]++;
  }
  // どの箱も 3 つの箱と隣り合う
  assert.ok(degree.every((d) => d === 3));
  close(partHeight('jelly'), 1, '高さ');
  assert.throws(() => partLayout('cloth'));
  assert.deepEqual(Object.keys(PARTS), ['bendy', 'rope', 'jelly']);
});

test('placePieces は向きと置く場所を反映する', () => {
  const straight = placePieces('bendy', [1, 2, 3], 0);
  close(straight[0].position[0], 1 - 1.25, '左端の x');
  close(straight[0].position[1], 2 + 0.125, '高さ');
  close(straight[0].position[2], 3, 'z');
  // 90 度回すと x 方向の並びが -z 方向になる
  const turned = placePieces('bendy', [0, 0, 0], Math.PI / 2);
  close(turned[0].position[0], 0, '回した x');
  close(turned[0].position[2], 1.25, '回した z');
  close(turned[5].position[2], -1.25, '回した反対側の z');
  close(partHeight('bendy'), 0.25, '板の高さ');
});
