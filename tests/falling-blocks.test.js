import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLS, ROWS, TYPES, applyAction, clearLines, collides, createBag, createEmptyBoard, createGame,
  dropDistance, dropInterval, levelForLines, lockPiece, pieceCells, rotateMatrix, scoreForLines,
  spawnPiece, tryMove, tryRotate, typeId,
} from '../games/falling-blocks/logic.js';

// 0 から始まる固定の乱数列。createBag にこれを渡すと袋の順番が決まる。
const fixedRandom = () => 0;

function fillRow(board, y, value = 1) {
  const next = board.slice();
  for (let x = 0; x < COLS; x++) next[y * COLS + x] = value;
  return next;
}

test('rotateMatrix は時計回りに回し、4 回で元に戻る', () => {
  const t = [[0, 1, 0], [1, 1, 1], [0, 0, 0]];
  assert.deepEqual(rotateMatrix(t), [[0, 1, 0], [0, 1, 1], [0, 1, 0]]);
  assert.deepEqual(rotateMatrix(rotateMatrix(rotateMatrix(rotateMatrix(t)))), t);
});

test('spawnPiece は中央の上端に出し、どの形も 1 段目から見える', () => {
  for (const type of TYPES) {
    const piece = spawnPiece(type);
    const cells = pieceCells(piece);
    assert.equal(cells.length, 4);
    assert.equal(Math.min(...cells.map((c) => c.y)), 0, `${type} の上端`);
    assert.ok(!collides(createEmptyBoard(), piece));
  }
  assert.deepEqual(pieceCells(spawnPiece('I')).map((c) => c.x), [3, 4, 5, 6]);
});

test('collides は左右と下の端、固定ブロックを判定し、上端より上は許す', () => {
  const board = createEmptyBoard();
  const piece = spawnPiece('O');
  assert.equal(collides(board, { ...piece, x: -1 }), true);
  assert.equal(collides(board, { ...piece, x: COLS - 1 }), true);
  assert.equal(collides(board, { ...piece, y: ROWS - 1 }), true);
  assert.equal(collides(board, { ...piece, y: -1 }), false);
  const blocked = board.slice();
  blocked[1 * COLS + 4] = 1;
  assert.equal(collides(blocked, { ...piece, y: 1 }), true);
});

test('tryMove は動かせないとき null を返す', () => {
  const board = createEmptyBoard();
  const piece = { ...spawnPiece('O'), x: 0 };
  assert.equal(tryMove(board, piece, -1, 0), null);
  assert.deepEqual(tryMove(board, piece, 1, 0), { ...piece, x: 1 });
});

test('tryRotate は壁際で横にずらして回転し、どうしても無理なら null', () => {
  const board = createEmptyBoard();
  // 縦向きの I を左の壁にぴったり付ける
  const vertical = tryRotate(board, spawnPiece('I'));
  const xs = pieceCells(vertical).map((c) => c.x);
  const atWall = { ...vertical, x: vertical.x - Math.min(...xs) };
  const rotated = tryRotate(board, atWall);
  assert.ok(rotated);
  assert.ok(pieceCells(rotated).every((c) => c.x >= 0));

  // 周りが全部埋まっていれば回せない
  const full = new Array(COLS * ROWS).fill(1);
  const t = { ...spawnPiece('T'), y: 5 };
  for (const { x, y } of pieceCells(t)) full[y * COLS + x] = 0;
  assert.equal(tryRotate(full, t), null);
});

test('dropDistance は床か固定ブロックまでの段数を返す', () => {
  const board = createEmptyBoard();
  assert.equal(dropDistance(board, spawnPiece('O')), ROWS - 2);
  const withFloor = fillRow(board, ROWS - 1);
  assert.equal(dropDistance(withFloor, spawnPiece('O')), ROWS - 3);
});

test('lockPiece は種類の番号で固定し、上端からはみ出すと overflow', () => {
  const board = createEmptyBoard();
  const piece = { ...spawnPiece('T'), y: ROWS - 2 };
  const { board: locked, overflow } = lockPiece(board, piece);
  assert.equal(overflow, false);
  assert.equal(locked.filter((v) => v === typeId('T')).length, 4);
  assert.equal(board.every((v) => v === 0), true);
  assert.equal(lockPiece(board, { ...piece, y: -1 }).overflow, true);
});

test('clearLines はそろった行を消して上を詰める', () => {
  let board = createEmptyBoard();
  board = fillRow(board, ROWS - 1);
  board = fillRow(board, ROWS - 3);
  board[(ROWS - 2) * COLS] = 5;
  const { board: next, cleared } = clearLines(board);
  assert.equal(cleared, 2);
  assert.equal(next.length, COLS * ROWS);
  assert.equal(next[(ROWS - 1) * COLS], 5);
  assert.equal(next.filter((v) => v !== 0).length, 1);
  assert.equal(clearLines(createEmptyBoard()).cleared, 0);
});

test('得点・レベル・落下速度', () => {
  assert.equal(scoreForLines(0, 1), 0);
  assert.equal(scoreForLines(1, 1), 100);
  assert.equal(scoreForLines(4, 3), 2400);
  assert.equal(levelForLines(0), 1);
  assert.equal(levelForLines(9), 1);
  assert.equal(levelForLines(10), 2);
  assert.equal(dropInterval(1), 800);
  assert.ok(dropInterval(5) < dropInterval(4));
  assert.equal(dropInterval(100), 100);
});

test('createBag は 7 種類を 1 つずつ含む', () => {
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(createBag().sort(), TYPES.slice().sort());
  }
  assert.deepEqual(createBag(fixedRandom), ['O', 'T', 'S', 'Z', 'J', 'L', 'I']);
});

test('createGame は空の盤面にピースを出し、次のピースを用意する', () => {
  const game = createGame(fixedRandom);
  assert.equal(game.piece.type, 'O');
  assert.ok(game.queue.length >= TYPES.length);
  assert.equal(game.score, 0);
  assert.equal(game.level, 1);
  assert.equal(game.over, false);
});

test('applyAction で左右移動・回転・落下ができ、壁では止まる', () => {
  let game = createGame(fixedRandom);
  const x = game.piece.x;
  game = applyAction(game, 'left');
  assert.equal(game.piece.x, x - 1);
  for (let i = 0; i < COLS; i++) game = applyAction(game, 'left');
  assert.equal(Math.min(...pieceCells(game.piece).map((c) => c.x)), 0);
  const atWall = game;
  assert.equal(applyAction(atWall, 'left'), atWall);

  const before = game.piece.y;
  game = applyAction(game, 'tick');
  assert.equal(game.piece.y, before + 1);
  assert.equal(game.score, 0);
  game = applyAction(game, 'soft');
  assert.equal(game.score, 1);

  const t = applyAction({ ...game, piece: spawnPiece('T') }, 'rotate');
  assert.notDeepEqual(t.piece.matrix, spawnPiece('T').matrix);
  assert.throws(() => applyAction(game, 'jump'));
});

test('hard は一番下まで落として固定し、次のピースを出す', () => {
  const game = createGame(fixedRandom);
  const next = applyAction(game, 'hard', fixedRandom);
  assert.equal(next.board.filter((v) => v !== 0).length, 4);
  assert.equal(next.score, (ROWS - 2) * 2);
  assert.equal(next.piece.type, game.queue[0]);
  assert.equal(next.queue.length, game.queue.length - 1 + (game.queue.length <= TYPES.length ? TYPES.length : 0));
});

test('そろった行は消えて得点とライン数が増える', () => {
  // 一番下の行を左 8 マスだけ埋め、O を右端に落として 2 段のうち 1 段をそろえる
  let board = createEmptyBoard();
  for (let x = 0; x < COLS - 2; x++) board[(ROWS - 1) * COLS + x] = 1;
  let game = { ...createGame(fixedRandom), board, piece: { ...spawnPiece('O'), x: COLS - 2 } };
  game = applyAction(game, 'hard', fixedRandom);
  assert.equal(game.lines, 1);
  assert.equal(game.score, (ROWS - 2) * 2 + 100);
  // 消えた行の上にあった O の上半分が一番下に下りてくる
  assert.equal(game.board[(ROWS - 1) * COLS + COLS - 1], typeId('O'));
  assert.equal(game.board.filter((v) => v !== 0).length, 2);
});

test('出現位置が埋まっているとゲームオーバーになり、その後は操作を受け付けない', () => {
  // 上から 2 段目までを残して積み上げた盤面で固定すると、次のピースが出せない
  let board = createEmptyBoard();
  for (let y = 2; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (x !== y % COLS) board[y * COLS + x] = 1;
  }
  let game = { ...createGame(fixedRandom), board };
  game = applyAction(game, 'hard', fixedRandom);
  assert.equal(game.over, true);
  assert.equal(applyAction(game, 'left'), game);
  assert.equal(applyAction(game, 'tick'), game);
});
