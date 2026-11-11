// オセロの計算部分。DOM に依存しないので node:test から直接テストできる。
// 盤面は長さ 64 の配列（左上から横に並べる）。0 が空き、1 が黒、2 が白。黒が先手

export const SIZE = 8;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
const DIRECTIONS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

export function opponent(player) {
  return player === BLACK ? WHITE : BLACK;
}

export function createBoard() {
  const board = new Array(SIZE * SIZE).fill(EMPTY);
  board[3 * SIZE + 3] = WHITE;
  board[4 * SIZE + 4] = WHITE;
  board[3 * SIZE + 4] = BLACK;
  board[4 * SIZE + 3] = BLACK;
  return board;
}

// index に player が置いたときに裏返る石の位置。置けなければ空
export function flipsFor(board, index, player) {
  if (board[index] !== EMPTY) return [];
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  const flips = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === opponent(player)) {
      line.push(r * SIZE + c);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === player) flips.push(...line);
  }
  return flips;
}

export function legalMoves(board, player) {
  const moves = [];
  for (let i = 0; i < board.length; i++) if (flipsFor(board, i, player).length > 0) moves.push(i);
  return moves;
}

// 置いて裏返した新しい盤面。置けない所なら null
export function play(board, index, player) {
  const flips = flipsFor(board, index, player);
  if (flips.length === 0) return null;
  const next = board.slice();
  next[index] = player;
  for (const i of flips) next[i] = player;
  return next;
}

export function countStones(board) {
  let black = 0;
  let white = 0;
  for (const cell of board) {
    if (cell === BLACK) black++;
    else if (cell === WHITE) white++;
  }
  return { black, white };
}

// 次の手番。置ける手がなければパスして相手。両方なければ null（終わり）
export function nextTurn(board, justMoved) {
  const other = opponent(justMoved);
  if (legalMoves(board, other).length > 0) return other;
  if (legalMoves(board, justMoved).length > 0) return justMoved;
  return null;
}

export function winner(board) {
  const { black, white } = countStones(board);
  if (black === white) return 0;
  return black > white ? BLACK : WHITE;
}

// ---- CPU ----
// 隅は強く、隅の隣（X・C の位置）は弱い、という定番の重み
const WEIGHTS = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, 1, 1, 1, 1, -2, 10,
  5, -2, 1, 0, 0, 1, -2, 5,
  5, -2, 1, 0, 0, 1, -2, 5,
  10, -2, 1, 1, 1, 1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
];

// 隅の隣が悪いのは、相手に隅を取られるきっかけになるから。隅がもう埋まっていれば悪くない
const CORNERS = [
  [0, [1, 8, 9]], [7, [6, 14, 15]], [56, [48, 49, 57]], [63, [54, 55, 62]],
];
export function cellWeights(board) {
  const weights = WEIGHTS.slice();
  for (const [corner, neighbors] of CORNERS) {
    if (board[corner] !== EMPTY) for (const i of neighbors) weights[i] = 5;
  }
  return weights;
}

// player から見た盤面の良さ
export function evaluate(board, player) {
  const other = opponent(player);
  const empties = board.filter((c) => c === EMPTY).length;
  if (empties === 0 || (legalMoves(board, player).length === 0 && legalMoves(board, other).length === 0)) {
    const { black, white } = countStones(board);
    const diff = player === BLACK ? black - white : white - black;
    return diff * 1000;
  }
  const weights = cellWeights(board);
  let score = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === player) score += weights[i];
    else if (board[i] === other) score -= weights[i];
  }
  // 置ける手が多いほうが有利
  score += (legalMoves(board, player).length - legalMoves(board, other).length) * 5;
  return score;
}

function search(board, player, me, depth, alpha, beta) {
  const moves = legalMoves(board, player);
  if (depth === 0) return evaluate(board, me);
  if (moves.length === 0) {
    if (legalMoves(board, opponent(player)).length === 0) return evaluate(board, me);
    return search(board, opponent(player), me, depth - 1, alpha, beta);
  }
  if (player === me) {
    let best = -Infinity;
    for (const move of moves) {
      best = Math.max(best, search(play(board, move, player), opponent(player), me, depth - 1, alpha, beta));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const move of moves) {
    best = Math.min(best, search(play(board, move, player), opponent(player), me, depth - 1, alpha, beta));
    beta = Math.min(beta, best);
    if (alpha >= beta) break;
  }
  return best;
}

export const LEVELS = {
  easy: { label: 'よわい', depth: 1, randomness: 0.5 },
  normal: { label: 'ふつう', depth: 3, randomness: 0 },
  hard: { label: 'つよい', depth: 4, randomness: 0 },
};

// CPU の手。randomness の割合で、置ける手からでたらめに選ぶ（よわい用）。置けなければ null
export function chooseMove(board, player, level = LEVELS.normal, random = Math.random) {
  const moves = legalMoves(board, player);
  if (moves.length === 0) return null;
  if (random() < level.randomness) return moves[Math.floor(random() * moves.length)];
  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const score = search(play(board, move, player), opponent(player), player, level.depth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}
