// てのひら粘土の計算部分。DOM・Three.js・MediaPipe に依存しないので node:test から直接テストできる。
// 手の位置（ランドマーク）は MediaPipe と同じく、カメラ画像の左上が (0, 0)、右下が (1, 1) の x, y と、
// 手首を基準にした奥行き z（カメラに近いほど小さい）で表す。

export {
  applyOffset, brushWeights, groupByPosition, springStep, toFloatArray, fillZeroNormals, customName,
} from '../model-sculpt/logic.js';
export { detectFormat, guessFacing } from '../mecha-blaster/logic.js';

export const LANDMARK_COUNT = 21;
export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_TIP = 8;
export const MIDDLE_BASE = 9;
export const FINGERTIPS = [4, 8, 12, 16, 20];
// 骨（つなぐ関節の組）。親指・人差し指・中指・薬指・小指と、手のひら
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

// つまんだとみなす指先どうしの距離（手のひらの大きさに対する割合）。
// 離したとみなす距離を少し大きくして、境目でつまむ・離すがちらつかないようにする
export const PINCH_START = 0.3;
export const PINCH_END = 0.45;

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 手のひらの大きさ（画像の中での、手首から中指の付け根まで）。カメラに近いほど大きい
export function palmSize(landmarks) {
  return distance2d(landmarks[WRIST], landmarks[MIDDLE_BASE]);
}

// つまんでいるか。いまつまんでいるかどうか（wasPinching）で、しきい値を変える
export function updatePinch(wasPinching, landmarks) {
  const ratio = distance2d(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / (palmSize(landmarks) || 1);
  return wasPinching ? ratio < PINCH_END : ratio < PINCH_START;
}

// 画像の中の手を、3D の世界の位置にする。
// view は、モデルのある面（z = 0）で画面に映る幅・高さと、その真ん中の高さ。
// 鏡のように左右を反転する（自分の右手が画面の右に来る）。
// 奥行きは手のひらの大きさで決め、最初に見えたときの大きさ palmRef のとき startZ。
// スマホに手を近づける（手が大きく映る）ほど、画面の奥（モデルの方）へ進む。
export function handToWorld(landmarks, { view, palmRef, startZ = 1.2, depthGain = 3, jointDepth = 2 }) {
  const scale = palmRef > 0 ? palmSize(landmarks) / palmRef : 1;
  const handZ = startZ - (scale - 1) * depthGain;
  return landmarks.map((p) => [
    (0.5 - p.x) * view.width,
    view.centerY + (0.5 - p.y) * view.height,
    handZ + p.z * jointDepth * view.width,
  ]);
}

// ぶれを抑えるため、前の位置へ少しずつ近づける（alpha が大きいほど新しい位置に素早く追いつく）
export function smoothPoints(previous, next, alpha) {
  if (!previous || previous.length !== next.length) return next.map((p) => [...p]);
  return next.map((p, i) => p.map((v, k) => previous[i][k] + (v - previous[i][k]) * alpha));
}

export function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

// point に一番近い頂点の番号と距離
export function nearestVertex(positions, point) {
  let best = -1;
  let bestSq = Infinity;
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    const dx = positions[i] - point[0];
    const dy = positions[i + 1] - point[1];
    const dz = positions[i + 2] - point[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestSq) {
      bestSq = d;
      best = v;
    }
  }
  return { index: best, distance: Math.sqrt(bestSq) };
}

// 球（指の関節）の中に入った頂点を、球の表面まで押し出す。粘土に手を押し付けたように、手の形にへこむ。
// 動かした頂点の番号を返す
export function pushOut(positions, spheres) {
  if (spheres.length === 0) return [];
  // まず球全体を囲む箱の外の頂点を飛ばして、軽くする
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { center, radius } of spheres) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], center[k] - radius);
      max[k] = Math.max(max[k], center[k] + radius);
    }
  }
  const moved = [];
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    if (positions[i] < min[0] || positions[i] > max[0] || positions[i + 1] < min[1] || positions[i + 1] > max[1]
      || positions[i + 2] < min[2] || positions[i + 2] > max[2]) continue;
    let touched = false;
    for (const { center, radius } of spheres) {
      const dx = positions[i] - center[0];
      const dy = positions[i + 1] - center[1];
      const dz = positions[i + 2] - center[2];
      const length = Math.hypot(dx, dy, dz);
      if (length >= radius || length === 0) continue;
      const push = radius / length;
      positions[i] = center[0] + dx * push;
      positions[i + 1] = center[1] + dy * push;
      positions[i + 2] = center[2] + dz * push;
      touched = true;
    }
    if (touched) moved.push(v);
  }
  return moved;
}

// ベクトル 1 つ分のばね（つまんで離したときの引っぱり量を、揺れながら 0 に戻す）
export function springVector(value, velocity, { stiffness = 120, damping = 7, dt = 1 / 60 } = {}) {
  const nextVelocity = value.map((v, k) => velocity[k] + (-stiffness * v - damping * velocity[k]) * dt);
  const nextValue = value.map((v, k) => v + nextVelocity[k] * dt);
  return { value: nextValue, velocity: nextVelocity };
}

export function vectorLength(v) {
  return Math.hypot(...v);
}
