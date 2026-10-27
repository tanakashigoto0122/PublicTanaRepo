// 2048 の盤面ロジック。DOM に依存しないので node:test から直接テストできる。
// 盤面は長さ size*size の配列で、0 が空きマスを表す。

export const DIRECTIONS = ['left', 'right', 'up', 'down'];

export function createEmpty(size = 4) {
  return new Array(size * size).fill(0);
}

// 1 列分を左に詰めて同じ数字を合体させる。1 つのタイルは 1 回の移動で 1 度しか合体しない。
export function slideLine(line) {
  const tiles = line.filter((v) => v !== 0);
  const result = [];
  let score = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      result.push(merged);
      score += merged;
      i++;
    } else {
      result.push(tiles[i]);
    }
  }
  while (result.length < line.length) result.push(0);
  return { line: result, score };
}

// direction 方向に動かす各列のマス番号を、詰める側から順に並べて返す
function lines(size, direction) {
  const result = [];
  for (let a = 0; a < size; a++) {
    const indices = [];
    for (let b = 0; b < size; b++) {
      if (direction === 'left') indices.push(a * size + b);
      else if (direction === 'right') indices.push(a * size + (size - 1 - b));
      else if (direction === 'up') indices.push(b * size + a);
      else indices.push((size - 1 - b) * size + a);
    }
    result.push(indices);
  }
  return result;
}

// direction 方向に動かした新しい盤面と得点を返す。何も動かなければ moved は false。
export function move(board, direction, size = 4) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`不明な方向: ${direction}`);
  const next = board.slice();
  let score = 0;
  for (const indices of lines(size, direction)) {
    const slid = slideLine(indices.map((i) => board[i]));
    indices.forEach((cell, k) => { next[cell] = slid.line[k]; });
    score += slid.score;
  }
  const moved = next.some((v, i) => v !== board[i]);
  return { board: next, score, moved };
}

// ランダムな空きマスに 2（10% の確率で 4）を置いた新しい盤面を返す。空きがなければそのまま返す。
export function addRandomTile(board, random = Math.random) {
  const empties = [];
  board.forEach((v, i) => { if (v === 0) empties.push(i); });
  if (empties.length === 0) return board.slice();
  const next = board.slice();
  const cell = empties[Math.floor(random() * empties.length)];
  next[cell] = random() < 0.9 ? 2 : 4;
  return next;
}

export function createInitial(size = 4, random = Math.random) {
  return addRandomTile(addRandomTile(createEmpty(size), random), random);
}

export function canMoveAny(board, size = 4) {
  return DIRECTIONS.some((d) => move(board, d, size).moved);
}

export function hasWon(board, target = 2048) {
  return board.some((v) => v >= target);
}
