// ぷるぷるキャッチの計算部分。DOM・Three.js・MediaPipe に依存しないので node:test から直接テストできる。
// ぷるぷるの体はぷるぷるラボ、手の扱いはてのひら粘土、時間の表示はメカ・ブラスターのものを使う。

export {
  addVelocity, averageSpacing, bindVertices, createBody, deformVertices, farthestPointSample, maxSpeed, stepBody,
  stiffnessFromSoftness, strideIndices, toFloatArray, translateBody,
} from '../jelly-lab/logic.js';
export {
  HAND_BONES, INDEX_TIP, LANDMARK_COUNT, THUMB_TIP, handToWorld, midpoint, palmSize, smoothPoints, updatePinch,
} from '../hand-clay/logic.js';
export { GAME_SECONDS, detectFormat, formatTime, guessFacing } from '../mecha-blaster/logic.js';

export const JELLY_HEIGHT = 1.2;
export const WALL = 4;
export const TARGET_RADIUS = 0.75;
// 的を置く範囲。縦長のスマホの画面にも左右が収まるようにする
export const TARGET_AREA = { minX: -2, maxX: 2, minZ: -3, maxZ: 1 };
// 床に触れているとみなす高さ
export const FLOOR_TOUCH = 0.05;

// 的を置く。いまの場所 avoid から minDistance 以上離す（同じ所に続けて置かない）
export function placeTarget({ random = Math.random, avoid = null, minDistance = 2 } = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = TARGET_AREA.minX + random() * (TARGET_AREA.maxX - TARGET_AREA.minX);
    const z = TARGET_AREA.minZ + random() * (TARGET_AREA.maxZ - TARGET_AREA.minZ);
    if (!avoid || Math.hypot(x - avoid[0], z - avoid[1]) >= minDistance) return [x, z];
  }
  // 見つからなければ、反対側の端に置く
  return avoid ? [avoid[0] > 0 ? TARGET_AREA.minX : TARGET_AREA.maxX, 0] : [0, 0];
}

// 粒の真ん中と、一番低い粒の高さ
export function bodySummary(positions) {
  const center = [0, 0, 0];
  let lowest = Infinity;
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) center[k] += positions[i * 3 + k];
    lowest = Math.min(lowest, positions[i * 3 + 1]);
  }
  return { center: center.map((v) => v / count), lowest };
}

// 的に入ったか。つかんでいない体が床に触れていて、真ん中が的の円の中にあること
export function isOnTarget({ center, lowest }, target, held) {
  if (held || lowest > FLOOR_TOUCH) return false;
  return Math.hypot(center[0] - target[0], center[2] - target[1]) <= TARGET_RADIUS;
}

// point の近くの粒（radius 以内）を選ぶ。1 つもなければ一番近い粒。それも reach より遠ければ空
export function grabMembers(positions, point, radius, reach) {
  const members = [];
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let i = 0; i < positions.length / 3; i++) {
    const d = Math.hypot(positions[i * 3] - point[0], positions[i * 3 + 1] - point[1], positions[i * 3 + 2] - point[2]);
    if (d <= radius) members.push(i);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = i;
    }
  }
  if (members.length > 0) return members;
  return nearest >= 0 && nearestDistance <= reach ? [nearest] : [];
}
