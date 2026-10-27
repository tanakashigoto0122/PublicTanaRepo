import { addRandomTile, canMoveAny, createInitial, hasWon, move } from './logic.js';

const SIZE = 4;
const BEST_KEY = 'mini-games:2048:best';
const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
};

const boardEl = document.getElementById('board');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const statusEl = document.getElementById('status');
const resetEl = document.getElementById('reset');

let board;
let score;
let best = loadBest();
// クリア後も続けて遊べるように、クリア表示は 1 回だけ出す
let wonShown;

// ベストスコアはブラウザ内だけに保存する。使えない環境では保存しない。
function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // 保存できなくても遊べる
  }
}

function render() {
  boardEl.replaceChildren();
  for (const value of board) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (value !== 0) {
      const level = Math.min(Math.log2(value), 11);
      cell.classList.add('filled');
      if (level >= 5) cell.classList.add('strong');
      if (value >= 1024) cell.classList.add('small');
      cell.style.setProperty('--level', level);
      cell.textContent = String(value);
    }
    boardEl.append(cell);
  }
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function step(direction) {
  if (!canMoveAny(board, SIZE)) return;
  const result = move(board, direction, SIZE);
  if (!result.moved) return;
  board = addRandomTile(result.board);
  score += result.score;
  if (score > best) {
    best = score;
    saveBest();
  }
  if (!canMoveAny(board, SIZE)) {
    statusEl.textContent = `ゲームオーバー。スコアは ${score} でした。`;
  } else if (!wonShown && hasWon(board)) {
    wonShown = true;
    statusEl.textContent = 'クリア！ このまま続けて遊べます。';
  }
  render();
}

function reset() {
  board = createInitial(SIZE);
  score = 0;
  wonShown = false;
  statusEl.textContent = '';
  render();
}

document.addEventListener('keydown', (event) => {
  const direction = KEYS[event.key] ?? KEYS[event.key.toLowerCase()];
  if (!direction || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  step(direction);
});

// マウスのドラッグとタッチのスワイプを Pointer Events でまとめて扱う
let start = null;
boardEl.addEventListener('pointerdown', (event) => {
  start = { x: event.clientX, y: event.clientY };
});
boardEl.addEventListener('pointerup', (event) => {
  if (!start) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  start = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if (Math.abs(dx) > Math.abs(dy)) step(dx > 0 ? 'right' : 'left');
  else step(dy > 0 ? 'down' : 'up');
});
boardEl.addEventListener('pointercancel', () => { start = null; });

resetEl.addEventListener('click', reset);
reset();
