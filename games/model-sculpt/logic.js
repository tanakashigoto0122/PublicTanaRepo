// ぐにゃぐにゃ工房の計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。
// 頂点の位置は [x0, y0, z0, x1, y1, z1, ...] と並んだ Float32Array で扱う。
// ブラシの効き方は頂点の「位置」だけで決めるので、同じ位置に重なった頂点（テクスチャの継ぎ目など）は
// いつも同じように動き、形に割れ目ができない。

export { SUPPORTED_FORMATS, detectFormat } from '../model-viewer/logic.js';
export { guessFacing } from '../mecha-blaster/logic.js';

export const MODEL_HEIGHT = 2;
export const HISTORY_LIMIT = 10;

// ブラシの中心からの距離の割合 t（0〜1）に対する効き具合。中心で 1、縁で 0 になめらかに下がる
export function falloff(t) {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

// center から radius 以内の頂点の番号と、効き具合
export function brushWeights(positions, center, radius) {
  const indices = [];
  const weights = [];
  if (!(radius > 0)) return { indices: new Uint32Array(0), weights: new Float32Array(0) };
  const radiusSq = radius * radius;
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const dx = positions[i] - center[0];
    const dy = positions[i + 1] - center[1];
    const dz = positions[i + 2] - center[2];
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq >= radiusSq) continue;
    indices.push(v);
    weights.push(falloff(Math.sqrt(distanceSq) / radius));
  }
  return { indices: Uint32Array.from(indices), weights: Float32Array.from(weights) };
}

// 引っぱる：つかんだときの位置 base から、delta × 効き具合だけずらす
export function applyOffset(positions, base, { indices, weights }, delta) {
  for (let n = 0; n < indices.length; n++) {
    const i = indices[n] * 3;
    for (let k = 0; k < 3; k++) positions[i + k] = base[i + k] + delta[k] * weights[n];
  }
}

// ふくらます（amount が正）・へこます（負）：それぞれの頂点の向き（法線）に沿って動かす
export function inflate(positions, normals, { indices, weights }, amount) {
  for (let n = 0; n < indices.length; n++) {
    const i = indices[n] * 3;
    for (let k = 0; k < 3; k++) positions[i + k] += normals[i + k] * amount * weights[n];
  }
}

// 近くの頂点をすばやく探すための、位置で区切った箱分け。
// only を渡すと、その番号の頂点だけを入れる（ブラシのまわりだけで十分なときに軽くするため）
export function buildSpatialHash(positions, cellSize, only = null) {
  const cells = new Map();
  const add = (v) => {
    const i = v * 3;
    const k = `${Math.floor(positions[i] / cellSize)},${Math.floor(positions[i + 1] / cellSize)},${Math.floor(positions[i + 2] / cellSize)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(v);
  };
  if (only) for (const v of only) add(v);
  else for (let v = 0; v < positions.length / 3; v++) add(v);
  return { cells, cellSize };
}

// point から cellSize 以内にある頂点の位置の平均
export function neighborAverage(positions, { cells, cellSize }, point) {
  const [cx, cy, cz] = point.map((v) => Math.floor(v / cellSize));
  const sum = [0, 0, 0];
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const v of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const i = v * 3;
          const ex = positions[i] - point[0];
          const ey = positions[i + 1] - point[1];
          const ez = positions[i + 2] - point[2];
          if (ex * ex + ey * ey + ez * ez > cellSize * cellSize) continue;
          sum[0] += positions[i];
          sum[1] += positions[i + 1];
          sum[2] += positions[i + 2];
          count++;
        }
      }
    }
  }
  return count > 0 ? sum.map((s) => s / count) : [...point];
}

// ならす：近くの頂点の平均の位置へ、strength × 効き具合だけ寄せる（でこぼこが平らになる）。
// region には、ブラシより cellSize だけ広い範囲の頂点を渡す（平均に使う近所の頂点。省略すると全部）
export function smooth(positions, brush, cellSize, strength, region = null) {
  const hash = buildSpatialHash(positions, cellSize, region);
  const targets = [];
  for (let n = 0; n < brush.indices.length; n++) {
    const i = brush.indices[n] * 3;
    targets.push(neighborAverage(positions, hash, [positions[i], positions[i + 1], positions[i + 2]]));
  }
  for (let n = 0; n < brush.indices.length; n++) {
    const i = brush.indices[n] * 3;
    const t = Math.min(1, strength * brush.weights[n]);
    for (let k = 0; k < 3; k++) positions[i + k] += (targets[n][k] - positions[i + k]) * t;
  }
}

// 離したら戻る：もとの位置 rest へ、ばねのように揺れながら戻す。
// 一番大きいずれ（位置と速さ）を返すので、十分小さくなったら止められる
export function springStep(positions, velocities, rest, indices, { stiffness = 120, damping = 7, dt = 1 / 60 } = {}) {
  let largest = 0;
  for (const v of indices) {
    const i = v * 3;
    for (let k = 0; k < 3; k++) {
      const offset = positions[i + k] - rest[i + k];
      velocities[i + k] += (-stiffness * offset - damping * velocities[i + k]) * dt;
      positions[i + k] += velocities[i + k] * dt;
      largest = Math.max(largest, Math.abs(offset), Math.abs(velocities[i + k]) * dt);
    }
  }
  return largest;
}

// 同じ位置にある頂点（テクスチャの継ぎ目などで分かれている）に同じ番号を付ける。
// 返すのは頂点ごとの番号と、番号の数
export function groupByPosition(positions, tolerance = 1e-5) {
  const groupOf = new Int32Array(positions.length / 3);
  const lookup = new Map();
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const key = `${Math.round(positions[i] / tolerance)},${Math.round(positions[i + 1] / tolerance)},${Math.round(positions[i + 2] / tolerance)}`;
    if (!lookup.has(key)) lookup.set(key, lookup.size);
    groupOf[v] = lookup.get(key);
  }
  return { groupOf, groupCount: lookup.size };
}

// 同じ位置の頂点どうしで法線を平均して、長さ 1 にそろえる。
// 継ぎ目の頂点がそれぞれ違う向きにふくらむと割れ目ができるので、ふくらますときはこれを使う
export function groupedNormals(normals, { groupOf, groupCount }) {
  const sums = new Float32Array(groupCount * 3);
  for (let v = 0; v < groupOf.length; v++) {
    for (let k = 0; k < 3; k++) sums[groupOf[v] * 3 + k] += normals[v * 3 + k];
  }
  const result = new Float32Array(normals.length);
  for (let v = 0; v < groupOf.length; v++) {
    const g = groupOf[v] * 3;
    const length = Math.hypot(sums[g], sums[g + 1], sums[g + 2]) || 1;
    for (let k = 0; k < 3; k++) result[v * 3 + k] = sums[g + k] / length;
  }
  return result;
}

// どの三角形にも使われていない頂点は、法線を計算すると長さ 0 になる。書き出すときに困らないよう、上向きにしておく
export function fillZeroNormals(normals) {
  for (let i = 0; i < normals.length; i += 3) {
    if (normals[i] === 0 && normals[i + 1] === 0 && normals[i + 2] === 0) normals[i + 1] = 1;
  }
  return normals;
}

// 元に戻す用の履歴。古いものから捨てて HISTORY_LIMIT 件まで残す
export function pushHistory(history, snapshot) {
  return [...history, snapshot].slice(-HISTORY_LIMIT);
}

// どんな形式の頂点データでも（getX などで読める物なら）ふつうの小数の配列に読み出す
export function toFloatArray(attribute) {
  const { count, itemSize } = attribute;
  const result = new Float32Array(count * itemSize);
  const getters = ['getX', 'getY', 'getZ', 'getW'];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < itemSize; k++) result[i * itemSize + k] = attribute[getters[k]](i);
  }
  return result;
}

// 書き出すファイルの名前
export function customName(fileName) {
  const base = fileName.replace(/\.[^./\\]+$/, '').replace(/-custom$/, '') || 'model';
  return `${base}-custom.glb`;
}
