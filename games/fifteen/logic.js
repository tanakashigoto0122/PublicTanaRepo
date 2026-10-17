// 15パズルの盤面ロジック。DOM に依存しないので node:test から直接テストできる。
// 盤面は長さ size*size の配列で、0 が空きマスを表す。

export function createSolved(size = 4) {
  const board = [];
  for (let i = 1; i < size * size; i++) board.push(i);
  board.push(0);
  return board;
}

export function isSolved(board) {
  const last = board.length - 1;
  return board[last] === 0 && board.slice(0, last).every((value, i) => value === i + 1);
}

export function neighbors(index, size) {
  const row = Math.floor(index / size);
  const col = index % size;
  const result = [];
  if (row > 0) result.push(index - size);
  if (row < size - 1) result.push(index + size);
  if (col > 0) result.push(index - 1);
  if (col < size - 1) result.push(index + 1);
  return result;
}

export function canMove(board, index, size) {
  return neighbors(index, size).includes(board.indexOf(0));
}

// index のタイルを空きマスへ動かした新しい盤面を返す。動かせない場合は null。
export function move(board, index, size) {
  if (!canMove(board, index, size)) return null;
  const next = board.slice();
  const empty = board.indexOf(0);
  next[empty] = next[index];
  next[index] = 0;
  return next;
}

// 完成状態からランダムに合法手を打ってシャッフルするので、必ず解ける盤面になる。
export function shuffle(board, size, steps = 200, random = Math.random) {
  let current = board.slice();
  let previous = -1;
  for (let i = 0; i < steps; i++) {
    const empty = current.indexOf(0);
    // 直前の手を取り消す動きは除外して、かき混ぜ効率を上げる
    const candidates = neighbors(empty, size).filter((n) => n !== previous);
    const pick = candidates[Math.floor(random() * candidates.length)];
    current = move(current, pick, size);
    previous = empty;
  }
  if (isSolved(current)) return shuffle(board, size, steps, random);
  return current;
}
