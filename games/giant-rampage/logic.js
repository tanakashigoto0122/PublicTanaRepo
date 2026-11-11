// 巨大化パニックの計算部分。DOM・Three.js・cannon-es に依存しないので node:test から直接テストできる。
// スティックやキーボードの入力、向きの変え方、時間の表示はメカ・ブラスターのものを使う。

export {
  GAME_SECONDS, formatTime, guessFacing, headingOf, joystickVector, keyboardVector, moveVelocity, tiltAngle, turnTowards,
  wrapAngle,
} from '../mecha-blaster/logic.js';
export { displayName } from '../shared/logic.js';

// 巨人に比べてビルが小さく見えるよう、箱は小さめ
export const BLOCK_SIZE = 0.5;
// 街の広さ（中心から端まで）
export const CITY_HALF = 14;
// 区画の間隔。区画の間が道になる
export const LOT_SPACING = 5;
// 最初の高さと、いちばん大きくなったときの高さ
export const START_HEIGHT = 3;
export const MAX_HEIGHT = 9;
// これだけ倒すごとに 1 段大きくなる
export const BLOCKS_PER_GROWTH = 50;
export const STOMP_COOLDOWN = 1.2;

// 区画ごとにビルを建てる。真ん中の区画は広場（巨人のスタート地点）にする
export function cityLayout({ random = Math.random } = {}) {
  const buildings = [];
  const lots = Math.floor((CITY_HALF - 2) / LOT_SPACING);
  for (let i = -lots; i <= lots; i++) {
    for (let j = -lots; j <= lots; j++) {
      if (i === 0 && j === 0) continue;
      // ところどころ空き地にする
      if (random() < 0.15) continue;
      // 箱が多すぎるとスマホで重くなるので、ビルは小さめにする
      const w = 2 + Math.floor(random() * 2);
      const d = 2 + Math.floor(random() * 2);
      const floors = 3 + Math.floor(random() * 4);
      buildings.push({ x: i * LOT_SPACING, z: j * LOT_SPACING, w, d, floors, color: Math.floor(random() * 4) });
    }
  }
  return buildings;
}

// ビルを 1 つずつの箱に分ける。返すのは箱の真ん中の位置の配列
export function buildingBlocks({ x, z, w, d, floors }, size = BLOCK_SIZE) {
  const blocks = [];
  for (let level = 0; level < floors; level++) {
    for (let a = 0; a < w; a++) {
      for (let b = 0; b < d; b++) {
        blocks.push([x + (a - (w - 1) / 2) * size, size * (level + 0.5), z + (b - (d - 1) / 2) * size]);
      }
    }
  }
  return blocks;
}

// 箱が崩れたか。置いた位置から落ちた、大きくずれた、傾いた のどれか
export function isToppled(start, position, quaternion, size = BLOCK_SIZE) {
  const drop = start[1] - position[1];
  const shift = Math.hypot(position[0] - start[0], position[2] - start[2]);
  const up = 1 - 2 * (quaternion[0] ** 2 + quaternion[2] ** 2);
  return drop > size * 0.4 || shift > size * 0.75 || up < Math.cos(Math.PI / 6);
}

// 倒した数に応じた巨人の高さ
export function giantHeight(knocked) {
  return Math.min(MAX_HEIGHT, START_HEIGHT + Math.floor(knocked / BLOCKS_PER_GROWTH));
}

// 歩く速さは体の大きさに比例させる（大きいほど一歩が大きい）
export function walkSpeed(height) {
  return 1.5 + height * 0.7;
}

// ドスン：足元から radius 以内の箱を、外向き・上向きに飛ばす速さ。遠いほど弱く、範囲の外は null
export function stompVelocity(block, center, radius, power) {
  const dx = block[0] - center[0];
  const dz = block[2] - center[2];
  const distance = Math.hypot(dx, dz);
  if (distance > radius) return null;
  const strength = power * (1 - distance / radius);
  const [nx, nz] = distance > 1e-6 ? [dx / distance, dz / distance] : [0, 0];
  // 低い箱ほど強く跳ねる（地面の揺れが伝わる）
  const lift = strength * Math.max(0.3, 1 - block[1] / (radius * 1.5));
  return [nx * strength * 0.6, lift, nz * strength * 0.6];
}

// 街の外へ出ないようにする
export function clampToCity([x, z], margin = 1) {
  const limit = CITY_HALF - margin;
  return [Math.min(limit, Math.max(-limit, x)), Math.min(limit, Math.max(-limit, z))];
}
