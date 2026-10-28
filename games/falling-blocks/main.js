import {
  COLS, ROWS, applyAction, createGame, dropDistance, dropInterval, pieceCells, spawnPiece, typeId,
} from './logic.js';

const BEST_KEY = 'mini-games:falling-blocks:best';
const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'soft', ArrowUp: 'rotate',
  x: 'rotate', X: 'rotate', ' ': 'hard',
};
// ボタンを押しっぱなしにしたとき連続で動かす操作と、その間隔（ミリ秒）
const REPEATABLE = ['left', 'right', 'soft'];
const REPEAT_DELAY = 170;
const REPEAT_INTERVAL = 50;

const boardEl = document.getElementById('board');
const nextEl = document.getElementById('next');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const levelEl = document.getElementById('level');
const linesEl = document.getElementById('lines');
const statusEl = document.getElementById('status');
const startEl = document.getElementById('start');
const controlsEl = document.getElementById('controls');

const cells = makeCells(boardEl, COLS * ROWS);
const nextCells = makeCells(nextEl, 16);

let game = createGame();
let best = loadBest();
let running = false;
let elapsed = 0;
let lastTime = null;
let rendered = null;

function makeCells(container, count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    container.append(cell);
    result.push(cell);
  }
  return result;
}

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
  if (rendered === game) return;
  rendered = game;
  const view = game.board.slice();
  const ghost = new Set();
  if (!game.over) {
    const distance = dropDistance(game.board, game.piece);
    for (const { x, y } of pieceCells({ ...game.piece, y: game.piece.y + distance })) {
      if (y >= 0) ghost.add(y * COLS + x);
    }
    for (const { x, y } of pieceCells(game.piece)) {
      if (y >= 0) view[y * COLS + x] = typeId(game.piece.type);
    }
  }
  view.forEach((value, i) => {
    cells[i].dataset.type = String(value);
    cells[i].classList.toggle('ghost', value === 0 && ghost.has(i));
  });

  const preview = spawnPiece(game.queue[0]);
  const size = preview.matrix.length;
  nextCells.forEach((cell, i) => {
    const x = (i % 4) - Math.floor((4 - size) / 2);
    const y = Math.floor(i / 4) - 1;
    const filled = preview.matrix[y]?.[x] === 1;
    cell.dataset.type = filled ? String(typeId(preview.type)) : '0';
  });

  scoreEl.textContent = String(game.score);
  bestEl.textContent = String(best);
  levelEl.textContent = String(game.level);
  linesEl.textContent = String(game.lines);
}

function act(action) {
  if (!running) return;
  game = applyAction(game, action);
  if (action !== 'tick') render();
  if (game.score > best) {
    best = game.score;
    saveBest();
  }
  if (game.over) {
    running = false;
    stopRepeat();
    statusEl.textContent = `ゲームオーバー。スコアは ${game.score} でした。`;
    startEl.textContent = 'もう一度';
    render();
  }
}

function frame(time) {
  if (running) {
    if (lastTime !== null) elapsed += time - lastTime;
    if (elapsed >= dropInterval(game.level)) {
      elapsed = 0;
      act('tick');
    }
    render();
  }
  lastTime = time;
  requestAnimationFrame(frame);
}

function setRunning(next) {
  running = next;
  startEl.textContent = running ? '一時停止' : '再開';
  statusEl.textContent = running ? '' : '一時停止中';
}

function onStartClick() {
  if (game.over) {
    game = createGame();
    elapsed = 0;
    setRunning(true);
    render();
    return;
  }
  setRunning(!running);
}

// 押しっぱなしで連続して動かす
let repeatTimer = null;
function stopRepeat() {
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
  repeatTimer = null;
}

controlsEl.addEventListener('pointerdown', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  event.preventDefault();
  const { action } = button.dataset;
  stopRepeat();
  act(action);
  if (REPEATABLE.includes(action)) {
    repeatTimer = setTimeout(() => {
      repeatTimer = setInterval(() => act(action), REPEAT_INTERVAL);
    }, REPEAT_DELAY);
  }
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  controlsEl.addEventListener(type, stopRepeat);
}
controlsEl.addEventListener('contextmenu', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'p' || event.key === 'P') {
    if (!game.over) onStartClick();
    return;
  }
  const action = KEYS[event.key];
  if (!action) return;
  event.preventDefault();
  act(action);
});

// 別のタブやアプリに切り替えたら一時停止する
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) setRunning(false);
});

startEl.addEventListener('click', onStartClick);
render();
requestAnimationFrame(frame);
