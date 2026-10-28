// ブロック落としのゲームロジック。DOM に依存しないので node:test から直接テストできる。
// 盤面は長さ COLS*ROWS の配列で、0 が空きマス、1〜7 が固定されたブロックの種類を表す。
// ゲームの状態は不変のオブジェクトとして扱い、操作ごとに新しい状態を返す。

export const COLS = 10;
export const ROWS = 20;
export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
export const ACTIONS = ['left', 'right', 'rotate', 'soft', 'hard', 'tick'];

const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

// 1 段消し〜4 段消しの基本点。レベルを掛けて加算する。
const LINE_SCORES = [0, 100, 300, 500, 800];
// 回転して壁や他のブロックに当たったとき、横にずらして試す量
const KICKS = [0, -1, 1, -2, 2];

export function createEmptyBoard() {
  return new Array(COLS * ROWS).fill(0);
}

export function typeId(type) {
  return TYPES.indexOf(type) + 1;
}

// 正方行列を時計回りに 90 度回す
export function rotateMatrix(matrix) {
  const n = matrix.length;
  return matrix.map((row, y) => row.map((_, x) => matrix[n - 1 - x][y]));
}

// 盤面の上端中央に出現させる。形の上の空き行のぶんだけ上にずらし、1 段目から見えるようにする。
export function spawnPiece(type) {
  const matrix = SHAPES[type];
  const firstRow = matrix.findIndex((row) => row.some(Boolean));
  return { type, matrix, x: Math.floor((COLS - matrix.length) / 2), y: 0 - firstRow };
}

export function pieceCells(piece) {
  const cells = [];
  piece.matrix.forEach((row, dy) => row.forEach((filled, dx) => {
    if (filled) cells.push({ x: piece.x + dx, y: piece.y + dy });
  }));
  return cells;
}

// 盤面の上端より上（y < 0）ははみ出してもよい。左右と下の端、固定ブロックとは重ならないこと。
export function collides(board, piece) {
  return pieceCells(piece).some(({ x, y }) => (
    x < 0 || x >= COLS || y >= ROWS || (y >= 0 && board[y * COLS + x] !== 0)
  ));
}

export function tryMove(board, piece, dx, dy) {
  const next = { ...piece, x: piece.x + dx, y: piece.y + dy };
  return collides(board, next) ? null : next;
}

export function tryRotate(board, piece) {
  const matrix = rotateMatrix(piece.matrix);
  for (const kick of KICKS) {
    const next = { ...piece, matrix, x: piece.x + kick };
    if (!collides(board, next)) return next;
  }
  return null;
}

// あと何段まっすぐ落とせるか
export function dropDistance(board, piece) {
  let distance = 0;
  while (tryMove(board, piece, 0, distance + 1)) distance++;
  return distance;
}

// ピースを盤面に固定した新しい盤面を返す。上端より上に残るマスがあれば overflow が true。
export function lockPiece(board, piece) {
  const next = board.slice();
  let overflow = false;
  for (const { x, y } of pieceCells(piece)) {
    if (y < 0) overflow = true;
    else next[y * COLS + x] = typeId(piece.type);
  }
  return { board: next, overflow };
}

export function clearLines(board) {
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    const row = board.slice(y * COLS, (y + 1) * COLS);
    if (row.includes(0)) rows.push(row);
  }
  const cleared = ROWS - rows.length;
  const empty = new Array(cleared * COLS).fill(0);
  return { board: empty.concat(...rows), cleared };
}

export function scoreForLines(cleared, level) {
  return LINE_SCORES[cleared] * level;
}

// 10 段消すごとにレベルが 1 上がる
export function levelForLines(lines) {
  return Math.floor(lines / 10) + 1;
}

// 自動で 1 段落ちるまでのミリ秒。レベルが上がるほど速くなる。
export function dropInterval(level) {
  return Math.max(100, 800 - (level - 1) * 70);
}

// 7 種類を 1 つずつ含む袋をシャッフルして返す（同じ形ばかり続かないようにする）
export function createBag(random = Math.random) {
  const bag = TYPES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// 次のピースを出す。キューが短くなったら袋を足す。出す場所が埋まっていればゲームオーバー。
function spawnNext(state, random) {
  let queue = state.queue;
  while (queue.length <= TYPES.length) queue = queue.concat(createBag(random));
  const piece = spawnPiece(queue[0]);
  return { ...state, piece, queue: queue.slice(1), over: collides(state.board, piece) };
}

export function createGame(random = Math.random) {
  return spawnNext({
    board: createEmptyBoard(),
    piece: null,
    queue: [],
    score: 0,
    lines: 0,
    level: 1,
    over: false,
  }, random);
}

function lockAndContinue(state, random) {
  const locked = lockPiece(state.board, state.piece);
  if (locked.overflow) return { ...state, board: locked.board, over: true };
  const { board, cleared } = clearLines(locked.board);
  const lines = state.lines + cleared;
  return spawnNext({
    ...state,
    board,
    lines,
    score: state.score + scoreForLines(cleared, state.level),
    level: levelForLines(lines),
  }, random);
}

// 操作を 1 つ適用した新しい状態を返す。ゲームオーバー後と動かせない操作では元の状態を返す。
export function applyAction(state, action, random = Math.random) {
  if (!ACTIONS.includes(action)) throw new Error(`不明な操作: ${action}`);
  if (state.over) return state;
  const { board, piece } = state;
  switch (action) {
    case 'left':
    case 'right': {
      const moved = tryMove(board, piece, action === 'left' ? -1 : 1, 0);
      return moved ? { ...state, piece: moved } : state;
    }
    case 'rotate': {
      const rotated = tryRotate(board, piece);
      return rotated ? { ...state, piece: rotated } : state;
    }
    case 'soft':
    case 'tick': {
      const moved = tryMove(board, piece, 0, 1);
      if (!moved) return lockAndContinue(state, random);
      // 自分で下に落とした分は 1 段 1 点
      return { ...state, piece: moved, score: state.score + (action === 'soft' ? 1 : 0) };
    }
    case 'hard': {
      const distance = dropDistance(board, piece);
      const dropped = { ...state, piece: { ...piece, y: piece.y + distance }, score: state.score + distance * 2 };
      return lockAndContinue(dropped, random);
    }
  }
}
