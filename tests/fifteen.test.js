import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMove, createSolved, isSolved, move, neighbors, shuffle } from '../games/fifteen/logic.js';

test('createSolved は 1..15 と空きマスを並べる', () => {
  assert.deepEqual(createSolved(4), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0]);
  assert.ok(isSolved(createSolved(4)));
});

test('neighbors は盤面の端を越えない', () => {
  assert.deepEqual(neighbors(0, 4).sort((a, b) => a - b), [1, 4]);
  assert.deepEqual(neighbors(5, 4).sort((a, b) => a - b), [1, 4, 6, 9]);
  assert.deepEqual(neighbors(15, 4).sort((a, b) => a - b), [11, 14]);
});

test('move は空きマスの隣だけ動かせる', () => {
  const board = createSolved(4);
  assert.ok(canMove(board, 14, 4));
  assert.equal(move(board, 0, 4), null);

  const next = move(board, 14, 4);
  assert.equal(next[15], 15);
  assert.equal(next[14], 0);
  assert.ok(!isSolved(next));
  // 元の盤面は変更しない
  assert.ok(isSolved(board));
});

// 転倒数と空きマスの行から、4x4 盤面が解けるかを判定する
function isSolvable(board, size) {
  const tiles = board.filter((v) => v !== 0);
  let inversions = 0;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if (tiles[i] > tiles[j]) inversions++;
    }
  }
  const emptyRowFromBottom = size - Math.floor(board.indexOf(0) / size);
  return (inversions + emptyRowFromBottom) % 2 === 1;
}

test('shuffle は未完成かつ解ける盤面を返す', () => {
  for (let i = 0; i < 50; i++) {
    const board = shuffle(createSolved(4), 4);
    assert.ok(!isSolved(board));
    assert.ok(isSolvable(board, 4));
    assert.deepEqual([...board].sort((a, b) => a - b), [...Array(16).keys()]);
  }
});
