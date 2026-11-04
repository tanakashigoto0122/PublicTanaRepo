// メカ・ブラスターの計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。
// 床の上の向き（yaw）は y 軸まわりの角度で、yaw = 0 が +z 方向、π/2 が +x 方向。

export { SUPPORTED_FORMATS, detectFormat } from '../model-viewer/logic.js';

export const GAME_SECONDS = 60;
export const ARENA_HALF = 14;
export const CHARACTER_HEIGHT = 2;
export const CRATE_SIZE = 0.8;
// スティックを少し倒しただけでは動かない範囲（半径に対する割合）
export const DEAD_ZONE = 0.15;

// スティックを中心から (dx, dy) ずらしたときの入力。半径 radius で最大 1。画面の上（dy が負）が前
export function joystickVector(dx, dy, radius) {
  const distance = Math.hypot(dx, dy);
  if (!(radius > 0) || distance < radius * DEAD_ZONE) return { x: 0, y: 0, magnitude: 0 };
  const magnitude = Math.min(1, (distance - radius * DEAD_ZONE) / (radius * (1 - DEAD_ZONE)));
  return { x: (dx / distance) * magnitude, y: (-dy / distance) * magnitude, magnitude };
}

// キーボードの押されているキーから入力を作る（斜めでも速さが変わらないようにする）
export function keyboardVector({ up = false, down = false, left = false, right = false }) {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (up ? 1 : 0) - (down ? 1 : 0);
  const length = Math.hypot(x, y);
  return length === 0 ? { x: 0, y: 0, magnitude: 0 } : { x: x / length, y: y / length, magnitude: 1 };
}

// 入力（x が右、y が前）を、カメラの向き cameraYaw から見た床の上の速度 [vx, vz] にする
export function moveVelocity(input, cameraYaw, speed) {
  const forward = [Math.sin(cameraYaw), Math.cos(cameraYaw)];
  // カメラから見て右（前を時計回りに 90 度）
  const right = [-Math.cos(cameraYaw), Math.sin(cameraYaw)];
  return [
    (forward[0] * input.y + right[0] * input.x) * speed,
    (forward[1] * input.y + right[1] * input.x) * speed,
  ];
}

export function headingOf(vx, vz) {
  return Math.atan2(vx, vz);
}

// 角度を -π〜π にそろえる
export function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// current から target へ、近い回り方で最大 maxStep だけ向きを変える
export function turnTowards(current, target, maxStep) {
  const difference = wrapAngle(target - current);
  if (Math.abs(difference) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(difference) * maxStep);
}

// クォータニオン [x, y, z, w] で回った物体の、もとの上向きと真上とのなす角
export function tiltAngle([x, , z]) {
  const up = 1 - 2 * (x * x + z * z);
  return Math.acos(Math.min(1, Math.max(-1, up)));
}

// 箱が倒れた（崩れた）か。置いた位置から落ちた、大きくずれた、傾いた のどれか
export function isKnocked(start, position, quaternion) {
  const drop = start[1] - position[1];
  const shift = Math.hypot(position[0] - start[0], position[2] - start[2]);
  return drop > CRATE_SIZE * 0.4 || shift > CRATE_SIZE * 0.75 || tiltAngle(quaternion) > Math.PI / 6;
}

// 箱の塔を並べる。中心（メカのスタート地点）の近くと、塔どうしが近すぎる場所は避ける。
// 返すのは箱 1 つずつの位置 [x, y, z] の配列
export function towerLayout({ towers = 8, minHeight = 2, maxHeight = 5, random = Math.random } = {}) {
  const spots = [];
  for (let attempt = 0; spots.length < towers && attempt < 500; attempt++) {
    const x = (random() * 2 - 1) * (ARENA_HALF - 2);
    const z = (random() * 2 - 1) * (ARENA_HALF - 2);
    if (Math.hypot(x, z) < 4) continue;
    if (spots.some((s) => Math.hypot(s[0] - x, s[1] - z) < 3)) continue;
    spots.push([x, z]);
  }
  const crates = [];
  for (const [x, z] of spots) {
    const height = minHeight + Math.floor(random() * (maxHeight - minHeight + 1));
    for (let level = 0; level < height; level++) crates.push([x, CRATE_SIZE * (level + 0.5), z]);
  }
  return crates;
}

// 残り時間ボーナスつきの得点。全部倒すと、残った 1 秒ごとに 2 点
export function finalScore(knocked, total, secondsLeft) {
  return knocked + (knocked === total ? Math.max(0, Math.floor(secondsLeft)) * 2 : 0);
}

export function formatTime(seconds) {
  return Math.max(0, seconds).toFixed(1);
}

// キャラクターの高さを CHARACTER_HEIGHT にそろえる倍率
export function characterScale([, height]) {
  return height > 0 ? CHARACTER_HEIGHT / height : 1;
}

// 正面がわからないモデルの向きの見当。横幅より奥行きが大きいモデルは、横（+x）を向いていることが多いので
// 正面が +z になるように -90 度回す
export function guessFacing([width, , depth]) {
  return depth > width * 1.3 ? -Math.PI / 2 : 0;
}
