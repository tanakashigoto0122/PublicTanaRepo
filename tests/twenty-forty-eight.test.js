import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRandomTile, canMoveAny, createEmpty, createInitial, hasWon, move, slideLine,
} from '../games/twenty-forty-eight/logic.js';

test('slideLine は左に詰めて同じ数字を合体させる', () => {
  assert.deepEqual(slideLine([2, 0, 2, 0]), { line: [4, 0, 0, 0], score: 4 });
  assert.deepEqual(slideLine([0, 0, 0, 2]), { line: [2, 0, 0, 0], score: 0 });
  assert.deepEqual(slideLine([2, 4, 8, 16]), { line: [2, 4, 8, 16], score: 0 });
});

test('slideLine は 1 タイルを 1 回しか合体させない', () => {
  assert.deepEqual(slideLine([2, 2, 2, 2]), { line: [4, 4, 0, 0], score: 8 });
  assert.deepEqual(slideLine([4, 4, 8, 0]), { line: [8, 8, 0, 0], score: 8 });
  assert.deepEqual(slideLine([2, 2, 2, 0]), { line: [4, 2, 0, 0], score: 4 });
});

test('move は 4 方向に動かせる', () => {
  const board = [
    2, 0, 0, 2,
    0, 4, 0, 0,
    0, 0, 0, 0,
    2, 0, 0, 0,
  ];
  assert.deepEqual(move(board, 'left').board, [
    4, 0, 0, 0,
    4, 0, 0, 0,
    0, 0, 0, 0,
    2, 0, 0, 0,
  ]);
  assert.deepEqual(move(board, 'right').board, [
    0, 0, 0, 4,
    0, 0, 0, 4,
    0, 0, 0, 0,
    0, 0, 0, 2,
  ]);
  assert.deepEqual(move(board, 'up').board, [
    4, 4, 0, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const down = move(board, 'down');
  assert.deepEqual(down.board, [
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    4, 4, 0, 2,
  ]);
  assert.equal(down.score, 4);
  assert.ok(down.moved);
  // 元の盤面は変更しない
  assert.equal(board[0], 2);
});

test('動けない方向では moved が false になる', () => {
  const board = [
    2, 4, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  assert.equal(move(board, 'left').moved, false);
  assert.equal(move(board, 'up').moved, false);
  assert.ok(move(board, 'right').moved);
  assert.throws(() => move(board, 'diagonal'));
});

test('addRandomTile は空きマスに 2 か 4 を 1 つ置く', () => {
  const board = createEmpty(4);
  assert.deepEqual(addRandomTile(board, () => 0), [2, ...new Array(15).fill(0)]);
  // 2 回目の乱数が 0.9 以上なら 4
  const values = [0.99, 0.95];
  const four = addRandomTile(board, () => values.shift());
  assert.equal(four[15], 4);
  assert.equal(four.filter((v) => v !== 0).length, 1);

  const full = new Array(16).fill(2);
  assert.deepEqual(addRandomTile(full), full);
});

test('createInitial はタイルを 2 枚置く', () => {
  for (let i = 0; i < 20; i++) {
    const board = createInitial(4);
    const tiles = board.filter((v) => v !== 0);
    assert.equal(tiles.length, 2);
    assert.ok(tiles.every((v) => v === 2 || v === 4));
  }
});

test('canMoveAny は空きか隣り合う同じ数字があれば true', () => {
  const stuck = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  assert.equal(canMoveAny(stuck), false);
  const mergeable = stuck.slice();
  mergeable[1] = 2;
  assert.ok(canMoveAny(mergeable));
  assert.ok(canMoveAny(createEmpty(4).map((v, i) => (i === 5 ? 2 : v))));
});

test('hasWon は 2048 以上のタイルで true', () => {
  assert.equal(hasWon([1024, 0, 0, 0]), false);
  assert.ok(hasWon([2048, 0, 0, 0]));
  assert.ok(hasWon([0, 8, 0, 0], 8));
});
