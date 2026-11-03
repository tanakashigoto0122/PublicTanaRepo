import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALL_LIMIT, MAX_BODIES, SHAPES, addGlue, breakForce, connectedGroup, dropPosition, glueKey, gravityY,
  halfHeight, hasGlue, massOf, newGluePairs, removeGlue, removeGluesOf, restitution, shapeVolume,
  stiffnessParams,
} from '../games/physics-blocks/logic.js';

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test('形の体積・重さ・底までの高さ', () => {
  close(shapeVolume('box'), 1, '箱');
  close(shapeVolume('plank'), 3 * 0.25 * 0.8, '板');
  close(shapeVolume('sphere'), (4 / 3) * Math.PI * 0.125, '球');
  close(shapeVolume('cylinder'), Math.PI * 0.25, '円柱');
  close(massOf('pillar'), 0.5, '柱の重さ');
  assert.equal(halfHeight('pillar'), 1);
  assert.equal(halfHeight('sphere'), 0.5);
  assert.equal(halfHeight('cylinder'), 0.5);
  for (const kind of Object.keys(SHAPES)) assert.ok(massOf(kind) > 0);
  assert.throws(() => shapeVolume('pyramid'));
  assert.throws(() => halfHeight('pyramid'));
  assert.ok(MAX_BODIES > 0);
  assert.ok(FALL_LIMIT < 0);
});

test('dropPosition はタップした面の上から落とし、床より下には置かない', () => {
  assert.deepEqual(dropPosition([1, 0, 2], 'box'), [1, 1.5, 2]);
  assert.deepEqual(dropPosition([0, 3, 0], 'pillar', 0.5), [0, 4.5, 0]);
  assert.deepEqual(dropPosition([0, -2, 0], 'box'), [0, 1.5, 0]);
});

test('stiffnessParams は硬さが上がるほど硬く、範囲の端で止まる', () => {
  let previous = null;
  for (let level = 0; level <= 100; level += 10) {
    const p = stiffnessParams(level);
    if (previous) {
      assert.ok(p.jointStiffness > previous.jointStiffness, `接着 ${level}`);
      assert.ok(p.contactStiffness > previous.contactStiffness, `接触 ${level}`);
      assert.ok(p.relaxation < previous.relaxation, `relaxation ${level}`);
    }
    previous = p;
  }
  close(stiffnessParams(0).jointStiffness, 10 ** 0.5, '最小');
  close(stiffnessParams(100).jointStiffness, 1e7, '最大');
  // 柔らかくしても、ぶつかったときは床を突き抜けない程度の硬さを残す
  assert.ok(stiffnessParams(0).contactStiffness >= 300);
  assert.deepEqual(stiffnessParams(-5), stiffnessParams(0));
  assert.deepEqual(stiffnessParams(150), stiffnessParams(100));
});

test('breakForce は強さに応じて増え、100 で外れなくなる', () => {
  close(breakForce(0), 5, '最小');
  assert.ok(breakForce(50) > breakForce(20));
  assert.ok(Number.isFinite(breakForce(99)));
  assert.equal(breakForce(100), Infinity);
  assert.equal(breakForce(200), Infinity);
});

test('gravityY と restitution', () => {
  assert.equal(gravityY(0), -0);
  close(gravityY(100), -9.82, '通常');
  close(gravityY(200), -19.64, '2 倍');
  close(gravityY(500), -19.64, '上限');
  assert.equal(restitution(0), 0);
  close(restitution(100), 0.9, '最大');
  close(restitution(-1), 0, '下限');
});

test('接着の追加・確認・削除', () => {
  let glues = addGlue([], 3, 1);
  assert.deepEqual(glues, [{ a: 1, b: 3 }]);
  assert.equal(addGlue(glues, 1, 3), glues);
  assert.equal(addGlue(glues, 2, 2), glues);
  assert.ok(hasGlue(glues, 3, 1));
  assert.equal(glueKey(5, 2), '2-5');
  glues = addGlue(addGlue(glues, 3, 4), 2, 4);
  assert.deepEqual(removeGlue(glues, 4, 3), [{ a: 1, b: 3 }, { a: 2, b: 4 }]);
  assert.deepEqual(removeGluesOf(glues, 4), [{ a: 1, b: 3 }]);
  assert.deepEqual(removeGluesOf(glues, 99), glues);
});

test('connectedGroup はつながった物体をたどり、床は越えない', () => {
  // 1-2-3 が 1 つの塊、4-5 が別の塊。2 と 4 は床（0）を介してだけつながる
  const glues = [{ a: 1, b: 2 }, { a: 2, b: 3 }, { a: 0, b: 2 }, { a: 0, b: 4 }, { a: 4, b: 5 }];
  assert.deepEqual([...connectedGroup(glues, 1, 0)].sort(), [1, 2, 3]);
  assert.deepEqual([...connectedGroup(glues, 5, 0)].sort(), [4, 5]);
  assert.deepEqual([...connectedGroup(glues, 9, 0)], [9]);
  // 床を指定しなければ床も通ってたどる
  assert.equal(connectedGroup(glues, 1).size, 6);
});

test('newGluePairs はまだ接着していない触れ合いだけを重複なく返す', () => {
  const glues = [{ a: 1, b: 2 }];
  const contacts = [{ a: 2, b: 1 }, { a: 3, b: 2 }, { a: 2, b: 3 }, { a: 4, b: 4 }, { a: 5, b: 0 }];
  assert.deepEqual(newGluePairs(glues, contacts), [{ a: 2, b: 3 }, { a: 0, b: 5 }]);
  assert.deepEqual(newGluePairs(glues, []), []);
});
