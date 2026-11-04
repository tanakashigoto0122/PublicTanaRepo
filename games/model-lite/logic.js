// 3Dモデル軽量化の計算部分。DOM・Three.js・meshoptimizer に依存しないので node:test から直接テストできる。

export { SUPPORTED_FORMATS, detectFormat, fitDistance, formatBytes, formatCount } from '../model-viewer/logic.js';

export const MIN_RATIO = 0.01;
export const TEXTURE_SIZES = [Infinity, 4096, 2048, 1024, 512];

// スライダー 0〜100 を、残すポリゴンの割合 1%〜100% にする。少ない側を細かく選べるよう対数で割り当てる
// （0 → 1%、50 → 10%、100 → 100%）
export function ratioFromSlider(value) {
  const v = Math.min(100, Math.max(0, value));
  return 10 ** ((v - 100) / 50);
}

export function sliderFromRatio(ratio) {
  const r = Math.min(1, Math.max(MIN_RATIO, ratio));
  return 100 + 50 * Math.log10(r);
}

// 残すインデックスの数（三角形 1 枚につき 3 つ）。少なくとも三角形 1 枚は残す
export function targetIndexCount(indexCount, ratio) {
  return Math.max(3, Math.floor((indexCount * ratio) / 3) * 3);
}

// 使われている頂点だけを、最初に出てきた順に詰め直す。
// remap[古い番号] が新しい番号（使われていない頂点は -1）。
export function compactIndices(indices, vertexCount) {
  const remap = new Int32Array(vertexCount).fill(-1);
  const next = new Uint32Array(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const old = indices[i];
    if (remap[old] === -1) remap[old] = count++;
    next[i] = remap[old];
  }
  return { indices: next, remap, vertexCount: count };
}

// 頂点ごとの値（itemSize 個ずつ並んだ配列）を、compactIndices の remap に合わせて詰め直す
export function remapAttribute(array, itemSize, remap, vertexCount) {
  const result = new Float32Array(vertexCount * itemSize);
  for (let old = 0; old < remap.length; old++) {
    const index = remap[old];
    if (index === -1) continue;
    for (let k = 0; k < itemSize; k++) result[index * itemSize + k] = array[old * itemSize + k];
  }
  return result;
}

// itemSize 個ずつ並んだベクトルを、その場で長さ 1 にそろえる（長さ 0 のものはそのまま）
export function normalizeVectors(array, itemSize) {
  for (let i = 0; i < array.length; i += itemSize) {
    let length = 0;
    for (let k = 0; k < itemSize; k++) length += array[i + k] ** 2;
    length = Math.sqrt(length);
    if (length > 0) for (let k = 0; k < itemSize; k++) array[i + k] /= length;
  }
  return array;
}

// 「12.3%」のような、元に対する割合
export function percentOf(after, before) {
  if (!(before > 0)) return '-';
  const value = (after / before) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

// 書き出すファイルの名前。拡張子をとって「-lite.glb」を付ける
export function outputName(fileName) {
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'model';
  return `${base}-lite.glb`;
}

export function textureSizeLabel(size) {
  return size === Infinity ? 'そのまま' : `${size} px まで`;
}
