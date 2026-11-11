import {
  BLACK, LEVELS, SIZE, WHITE, chooseMove, countStones, createBoard, flipsFor, legalMoves, nextTurn, opponent, play,
  winner,
} from './logic.js';

const CPU_DELAY = 450;

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const colorEl = document.getElementById('color');

// history は [{ board, turn, last }]。最後がいまの局面
let history = [];
let thinking = null;

function current() {
  return history.at(-1);
}

function human() {
  return Number(colorEl.value);
}

function isCpuTurn() {
  const { turn } = current();
  return modeEl.value !== 'two' && turn !== null && turn !== human();
}

const cells = Array.from({ length: SIZE * SIZE }, (_, index) => {
  const cell = document.createElement('button');
  cell.className = 'cell';
  cell.setAttribute('aria-label', `${Math.floor(index / SIZE) + 1} 行 ${(index % SIZE) + 1} 列`);
  cell.addEventListener('click', () => move(index));
  boardEl.append(cell);
  return cell;
});

const NAMES = { [BLACK]: '黒', [WHITE]: '白' };

function render() {
  const { board, turn, last } = current();
  const hints = turn && !isCpuTurn() ? new Set(legalMoves(board, turn)) : new Set();
  cells.forEach((cell, i) => {
    cell.replaceChildren();
    if (board[i] !== 0) {
      const stone = document.createElement('span');
      stone.className = `stone ${board[i] === BLACK ? 'black' : 'white'}`;
      cell.append(stone);
    } else if (hints.has(i)) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      cell.append(hint);
    }
    cell.classList.toggle('last', i === last);
    cell.disabled = !hints.has(i);
  });
  const { black, white } = countStones(board);
  const blackEl = document.getElementById('black-score');
  const whiteEl = document.getElementById('white-score');
  blackEl.textContent = `● 黒 ${black}`;
  whiteEl.textContent = `○ 白 ${white}`;
  blackEl.classList.toggle('turn', turn === BLACK);
  whiteEl.classList.toggle('turn', turn === WHITE);
  document.getElementById('undo').disabled = history.length < 2 || thinking !== null;
  if (turn === null) {
    const win = winner(board);
    if (win === 0) statusEl.textContent = `引き分け（${black} 対 ${white}）`;
    else if (modeEl.value === 'two') statusEl.textContent = `${NAMES[win]}の勝ち！（${black} 対 ${white}）`;
    else statusEl.textContent = win === human() ? `あなたの勝ち！（${black} 対 ${white}）` : `CPU の勝ち…（${black} 対 ${white}）`;
  } else if (isCpuTurn()) {
    statusEl.textContent = 'CPU が考え中…';
  } else {
    const passed = history.length > 1 && history.at(-2).turn === turn ? `${NAMES[opponent(turn)]}は置ける所がないのでパス。` : '';
    statusEl.textContent = `${passed}${modeEl.value === 'two' ? `${NAMES[turn]}の番` : 'あなたの番'}`;
  }
}

function move(index) {
  const { board, turn } = current();
  if (turn === null || isCpuTurn() || flipsFor(board, index, turn).length === 0) return;
  advance(index);
}

function advance(index) {
  const { board, turn } = current();
  const next = play(board, index, turn);
  history.push({ board: next, turn: nextTurn(next, turn), last: index });
  render();
  scheduleCpu();
}

function scheduleCpu() {
  if (!isCpuTurn()) return;
  thinking = setTimeout(() => {
    thinking = null;
    const { board, turn } = current();
    const index = chooseMove(board, turn, LEVELS[modeEl.value]);
    if (index !== null) advance(index);
  }, CPU_DELAY);
}

function newGame() {
  clearTimeout(thinking);
  thinking = null;
  history = [{ board: createBoard(), turn: BLACK, last: null }];
  render();
  scheduleCpu();
}

// 1 手もどす：CPU と遊んでいるときは、自分の番まで戻す
document.getElementById('undo').addEventListener('click', () => {
  if (history.length < 2 || thinking !== null) return;
  history.pop();
  while (history.length > 1 && isCpuTurn()) history.pop();
  render();
  scheduleCpu();
});
document.getElementById('new').addEventListener('click', newGame);
modeEl.addEventListener('change', newGame);
colorEl.addEventListener('change', newGame);

newGame();
