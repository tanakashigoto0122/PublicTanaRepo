import { createSolved, isSolved, move, shuffle } from './logic.js';

const SIZE = 4;
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const resetEl = document.getElementById('reset');

let board;
let moves;

function render() {
  boardEl.replaceChildren();
  board.forEach((value, index) => {
    const tile = document.createElement('button');
    tile.className = value === 0 ? 'tile empty' : 'tile';
    tile.textContent = value === 0 ? '' : String(value);
    tile.addEventListener('click', () => onTileClick(index));
    boardEl.append(tile);
  });
  statusEl.textContent = isSolved(board) ? `クリア！ ${moves} 手でした。` : `${moves} 手`;
}

function onTileClick(index) {
  if (isSolved(board)) return;
  const next = move(board, index, SIZE);
  if (!next) return;
  board = next;
  moves++;
  render();
}

function reset() {
  board = shuffle(createSolved(SIZE), SIZE);
  moves = 0;
  render();
}

resetEl.addEventListener('click', reset);
reset();
