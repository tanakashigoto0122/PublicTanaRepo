// キャラ写真スタジオの計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。

export { guessFacing } from '../mecha-blaster/logic.js';
export { displayName } from '../shared/logic.js';
export { lightPosition } from '../model-viewer/logic.js';

export const MAX_CHARACTERS = 3;
export const MAX_STAMPS = 12;
export const CHARACTER_HEIGHT = 1.6;
// キャラクターを置ける床の範囲（中心から）
export const STAGE_HALF = 3;

// 背景。色は assets/style.css の CSS 変数の名前で持ち、上から下へのグラデーションにする
export const BACKGROUNDS = {
  studio: { label: 'スタジオ', top: '--surface', bottom: '--bg', floor: '--bg' },
  sky: { label: '青空', top: '--piece-j', bottom: '--piece-i', floor: '--piece-s' },
  sunset: { label: '夕やけ', top: '--piece-t', bottom: '--piece-o', floor: '--piece-l' },
  night: { label: '夜', top: '--text', bottom: '--piece-t', floor: '--text', stars: true },
  candy: { label: 'パステル', top: '--piece-z', bottom: '--piece-o', floor: '--surface' },
};

// 写真のフィルター（canvas の filter と CSS の filter で同じ書き方）
export const FILTERS = {
  none: { label: 'なし', css: 'none' },
  vivid: { label: 'くっきり', css: 'saturate(1.5) contrast(1.1)' },
  mono: { label: 'モノクロ', css: 'grayscale(1) contrast(1.1)' },
  sepia: { label: 'セピア', css: 'sepia(0.85)' },
  soft: { label: 'ふんわり', css: 'brightness(1.08) saturate(0.85) contrast(0.92)' },
};

export const STAMPS = ['⭐', '❤️', '✨', '💥', '🎉', '👑', '🔥', '💦', '❓', '‼️'];

// スタンプや文字の位置は、写真の幅・高さに対する割合（0〜1）で持つ。画面の大きさが変わってもずれない
export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function createStamp(text, { x = 0.5, y = 0.5, size = 0.12, rotation = 0 } = {}) {
  return { text, x: clamp01(x), y: clamp01(y), size, rotation };
}

// 大きさは写真の短い辺に対する割合。小さすぎ・大きすぎないようにする
export function resizeStamp(stamp, factor) {
  return { ...stamp, size: Math.min(0.6, Math.max(0.04, stamp.size * factor)) };
}

// 割合で持った位置と大きさを、幅 width・高さ height の画像のピクセルにする
export function stampPixels({ x, y, size, rotation }, width, height) {
  return { x: x * width, y: y * height, size: size * Math.min(width, height), rotation };
}

// 床の上でキャラクターを動かすときは、範囲の中に収める
export function clampToStage([x, z]) {
  return [Math.min(STAGE_HALF, Math.max(-STAGE_HALF, x)), Math.min(STAGE_HALF, Math.max(-STAGE_HALF, z))];
}

// 並べるときの位置。1 体目は真ん中、2 体目以降は左右へ
export function slotPosition(index) {
  if (index === 0) return [0, 0];
  const side = index % 2 === 1 ? 1 : -1;
  return [side * 1.7 * Math.ceil(index / 2), 0];
}

// 保存する写真のファイル名（例 photo-20261111-153005.png）
export function photoFileName(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `photo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

// 夜空の星の位置（割合）。乱数は差し替えられる
export function starPositions(count, random = Math.random) {
  return Array.from({ length: count }, () => [random(), random() * 0.6, 0.5 + random() * 1.5]);
}
