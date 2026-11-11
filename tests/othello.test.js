import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK, EMPTY, LEVELS, SIZE, WHITE, cellWeights, chooseMove, countStones, createBoard, evaluate, flipsFor, legalMoves, nextTurn,
  opponent, play, winner,
} from '../games/othello/logic.js';

const at = (row, col) => row * SIZE + col;

function seeded(seed = 1) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// 文字の盤面（. 空き、x 黒、o 白）から盤面を作る
function fromText(text) {
  const cells = text.replace(/\s/g, '');
  return [...cells].map((c) => (c === 'x' ? BLACK : c === 'o' ? WHITE : EMPTY));
}

test('最初の盤面と、黒の置ける 4 か所', () => {
  const board = createBoard();
  assert.deepEqual(countStones(board), { black: 2, white: 2 });
  assert.deepEqual(legalMoves(board, BLACK), [at(2, 3), at(3, 2), at(4, 5), at(5, 4)]);
  assert.equal(opponent(BLACK), WHITE);
});

test('置くとはさんだ石が裏返る。置けない所は null', () => {
  const board = createBoard();
  assert.deepEqual(flipsFor(board, at(2, 3), BLACK), [at(3, 3)]);
  const next = play(board, at(2, 3), BLACK);
  assert.deepEqual(countStones(next), { black: 4, white: 1 });
  assert.equal(next[at(3, 3)], BLACK);
  assert.equal(play(board, at(0, 0), BLACK), null, 'はさめない');
  assert.equal(play(board, at(3, 3), BLACK), null, '石がある');
  assert.deepEqual(countStones(board), { black: 2, white: 2 }, '元の盤面は変えない');
});

test('いくつもの向きを一度に裏返し、端では止まる', () => {
  const board = fromText(`
    ........
    .ooo....
    .oxo....
    .ooo....
    ........
    ........
    ........
    x.......`);
  // 左上の角 (0,0) に黒：斜めに (1,1) をはさむ（(2,2) が黒）
  assert.deepEqual(flipsFor(board, at(0, 0), BLACK), [at(1, 1)]);
  // (4,4) に黒：左上へ (3,3) をはさむ
  assert.deepEqual(flipsFor(board, at(4, 4), BLACK), [at(3, 3)]);
  // 端まで白が続いて黒で終わらない列は裏返らない
  const edge = fromText(`
    oooooooo
    ........
    ........
    ........
    ........
    ........
    ........
    ........`);
  assert.equal(legalMoves(edge, BLACK).length, 0);
});

test('nextTurn はパスと終わりを判定する', () => {
  const board = createBoard();
  assert.equal(nextTurn(board, BLACK), WHITE);
  // 白が置けない局面：黒がもう一度
  const pass = fromText(`
    xo......
    ........
    ........
    ........
    ........
    ........
    ........
    ........`);
  assert.equal(legalMoves(pass, WHITE).length, 0);
  assert.equal(nextTurn(pass, WHITE), BLACK, '白は置けない → 黒は (0,2) に置ける');
  const full = new Array(64).fill(BLACK);
  assert.equal(nextTurn(full, BLACK), null);
  assert.equal(winner(full), BLACK);
  assert.equal(winner([...new Array(32).fill(BLACK), ...new Array(32).fill(WHITE)]), 0);
});

test('CPU は隅が取れるなら取る', () => {
  const board = fromText(`
    ........
    .o......
    ..x.....
    ...xo...
    ...ox...
    ........
    ........
    ........`);
  assert.ok(legalMoves(board, WHITE).length > 0);
  // 黒が (0,0) に置くと (1,1) をはさめる
  assert.ok(legalMoves(board, BLACK).includes(at(0, 0)));
  for (const level of [LEVELS.normal, LEVELS.hard]) assert.equal(chooseMove(board, BLACK, level), at(0, 0));
});

test('chooseMove は置けなければ null、よわいはときどきでたらめ', () => {
  assert.equal(chooseMove(new Array(64).fill(BLACK), WHITE), null);
  const board = createBoard();
  const moves = legalMoves(board, BLACK);
  assert.ok(moves.includes(chooseMove(board, BLACK, LEVELS.easy, seeded(5))));
});

test('evaluate は終局では石の差で決まる', () => {
  const board = [...new Array(40).fill(BLACK), ...new Array(24).fill(WHITE)];
  assert.equal(evaluate(board, BLACK), 16000);
  assert.equal(evaluate(board, WHITE), -16000);
});

function playGame(blackLevel, whiteLevel, random) {
  let board = createBoard();
  let turn = BLACK;
  while (turn !== null) {
    const move = chooseMove(board, turn, turn === BLACK ? blackLevel : whiteLevel, random);
    board = play(board, move, turn);
    turn = nextTurn(board, turn);
  }
  return winner(board);
}

test('cellWeights は、埋まった隅の隣を悪くしない', () => {
  const empty = createBoard();
  assert.ok(cellWeights(empty)[at(1, 1)] < 0);
  const taken = empty.slice();
  taken[at(0, 0)] = WHITE;
  assert.ok(cellWeights(taken)[at(1, 1)] > 0);
  assert.equal(cellWeights(taken)[at(6, 6)], cellWeights(empty)[at(6, 6)], 'ほかの隅は変わらない');
});

test('つよいはよわいに勝ち越す（先手・後手を入れかえて 2 局）', () => {
  const random = seeded(11);
  let hardWins = 0;
  for (let game = 0; game < 2; game++) {
    const hardIsBlack = game % 2 === 0;
    const result = playGame(hardIsBlack ? LEVELS.hard : LEVELS.easy, hardIsBlack ? LEVELS.easy : LEVELS.hard, random);
    if (result === (hardIsBlack ? BLACK : WHITE)) hardWins++;
  }
  assert.equal(hardWins, 2, `つよいの勝ち ${hardWins} / 2`);
});
