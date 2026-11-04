// ぶっ飛ばしチャレンジの計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。
// 横から見たゲームで、x が進む向き（右）、y が上。

export { SUPPORTED_FORMATS, detectFormat } from '../model-viewer/logic.js';
export { characterScale, guessFacing } from '../mecha-blaster/logic.js';

export const MAX_LAUNCH_SPEED = 32;
export const MAX_ANGLE = (85 * Math.PI) / 180;
// これより短い引っぱりは、ただのタップとみなして発射しない（ピクセル）
export const MIN_DRAG = 12;
// 空中で 1 回だけ使えるブースト（速さに足す [x, y]）と、加速パッドに触れたときの加速。
// 空中のブーストは強すぎると発射の腕前が関係なくなるので、パッドより弱くしている
export const BOOST = [6, 4];
export const PAD_BOOST = [10, 6];
export const COURSE_LENGTH = 800;
// 速さがこれより遅い時間が REST_SECONDS 続いたら止まったとみなす
export const REST_SPEED = 0.35;
export const REST_SECONDS = 1;
export const FEATURE_TYPES = ['trampoline', 'boost', 'mud'];

// 画面上で (dx, dy) だけ引っぱった（dy は下が正）ときの発射。パチンコのように、引いた向きと逆へ飛ぶ。
// 後ろ向きには飛ばさず、角度は 0〜MAX_ANGLE に収める。引っぱりが短すぎれば null
export function launchVelocity(dx, dy, maxDrag, maxSpeed = MAX_LAUNCH_SPEED) {
  const length = Math.hypot(dx, dy);
  if (length < MIN_DRAG || !(maxDrag > 0)) return null;
  const angle = Math.min(MAX_ANGLE, Math.max(0, Math.atan2(dy, -dx)));
  const power = Math.min(1, length / maxDrag);
  const speed = power * maxSpeed;
  return { vx: speed * Math.cos(angle), vy: speed * Math.sin(angle), power, angle };
}

// 発射したときの放物線（空気の抵抗なし）。地面（y = 0）より下に行く手前まで
export function trajectory(start, [vx, vy], gravity = 9.82, { step = 0.05, maxPoints = 80 } = {}) {
  const points = [];
  for (let i = 0; i < maxPoints; i++) {
    const t = i * step;
    const y = start[1] + vy * t - (gravity * t * t) / 2;
    if (y < 0) break;
    points.push([start[0] + vx * t, y]);
  }
  return points;
}

// コースの仕掛けを並べる。最初の 15 m は何も置かず、15〜35 m ごとにどれかを置く
export function courseLayout({ length = COURSE_LENGTH, random = Math.random } = {}) {
  const features = [];
  let x = 15 + random() * 10;
  while (x < length) {
    const type = FEATURE_TYPES[Math.floor(random() * FEATURE_TYPES.length)];
    const width = type === 'mud' ? 6 + random() * 6 : 3 + random() * 2;
    features.push({ type, x, width });
    x += width + 15 + random() * 20;
  }
  return features;
}

export function distanceFrom(startX, x) {
  return Math.max(0, x - startX);
}

export function formatDistance(meters) {
  return `${meters.toFixed(1)} m`;
}

// 止まっている時間を数える。速くなったら 0 に戻す
export function restTimer(current, speed, dt) {
  return speed < REST_SPEED ? current + dt : 0;
}

export function isResting(timer) {
  return timer >= REST_SECONDS;
}

// 距離の目印を立てる位置（every m ごと）
export function markerPositions(length = COURSE_LENGTH, every = 25) {
  const result = [];
  for (let x = every; x <= length; x += every) result.push(x);
  return result;
}
