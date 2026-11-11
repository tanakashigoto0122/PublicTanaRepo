// ラグドール階段落ちの計算部分。DOM・Three.js・cannon-es に依存しないので node:test から直接テストできる。

export { guessFacing } from '../mecha-blaster/logic.js';
export { displayName } from '../shared/logic.js';
export { surfaceSamples } from '../jelly-sumo/logic.js';
export { toFloatArray } from '../model-sculpt/logic.js';

export const DOLL_HEIGHT = 1.6;
export const STEP_COUNT = 10;
export const STEP_RISE = 0.35;
export const STEP_RUN = 0.6;
export const STAIR_WIDTH = 3;
// 階段の上の踊り場の長さ（x がこれより小さい所）。階段は +x へ下っていく
export const LANDING = 2;
export const FLOOR_LENGTH = 9;

// 体の部位。weight は当たったときの点の倍率
export const PART_NAMES = {
  head: '頭', chest: '胸', pelvis: '腰', upperArmL: '左うで', lowerArmL: '左手', upperArmR: '右うで', lowerArmR: '右手',
  thighL: '左もも', shinL: '左すね', thighR: '右もも', shinR: '右すね',
};
const PART_WEIGHTS = { head: 3, chest: 1.5, pelvis: 1.5 };

// 足元が原点、正面が +z、高さ height・横幅 width・奥行き depth の人形を、部位（箱と球）と関節に分ける。
// 横幅が広いモデルは、腕を横に広げた形（T ポーズ）とみなす
export function layoutRagdoll({ height: H, width: W, depth: D }) {
  const tPose = W > 0.7 * H;
  const headR = 0.1 * H;
  const torsoW = Math.min(tPose ? 0.34 * H : W * 0.62, 0.36 * H);
  const torsoD = Math.max(0.08 * H, Math.min(D * 0.8, 0.2 * H));
  const limb = Math.max(0.035 * H, Math.min(0.06 * H, torsoD / 2));
  const neckY = H - 2 * headR;
  const waistY = 0.62 * H;
  const hipY = 0.47 * H;
  const kneeY = 0.24 * H;
  const legX = torsoW * 0.27;
  // 左右の脚が重ならない太さ
  const legLimb = Math.min(limb, legX * 0.95);
  const box = (name, min, max) => ({
    name, shape: 'box', center: min.map((v, k) => (v + max[k]) / 2), half: min.map((v, k) => Math.max((max[k] - v) / 2, 0.01)),
  });
  const parts = [
    { name: 'head', shape: 'sphere', center: [0, H - headR, 0], radius: headR },
    box('chest', [-torsoW / 2, waistY, -torsoD / 2], [torsoW / 2, neckY, torsoD / 2]),
    box('pelvis', [-torsoW / 2 * 0.9, hipY, -torsoD / 2], [torsoW / 2 * 0.9, waistY, torsoD / 2]),
  ];
  const joints = [
    { a: 'head', b: 'chest', pivot: [0, neckY, 0], angle: 0.6, twist: 0.6 },
    { a: 'chest', b: 'pelvis', pivot: [0, waistY, 0], angle: 0.5, twist: 0.4 },
  ];
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    // 正面が +z なので、モデルの左手は +x 側
    parts.push(
      box(`thigh${side}`, [sx * legX - legLimb, kneeY, -legLimb], [sx * legX + legLimb, hipY, legLimb]),
      box(`shin${side}`, [sx * legX - legLimb, 0, -legLimb], [sx * legX + legLimb, kneeY, legLimb]),
    );
    joints.push(
      { a: 'pelvis', b: `thigh${side}`, pivot: [sx * legX, hipY, 0], angle: 1.2, twist: 0.4 },
      { a: `thigh${side}`, b: `shin${side}`, pivot: [sx * legX, kneeY, 0], angle: 1.3, twist: 0.1 },
    );
    const shoulderX = sx * (torsoW / 2);
    if (tPose) {
      const reach = Math.max(W / 2, torsoW / 2 + 0.2 * H);
      const elbowX = sx * (torsoW / 2 + (reach - torsoW / 2) / 2);
      const armY = neckY - limb * 1.5;
      const [x0, x1] = [shoulderX, elbowX].sort((p, q) => p - q);
      const [x2, x3] = [elbowX, sx * reach].sort((p, q) => p - q);
      parts.push(
        box(`upperArm${side}`, [x0, armY - limb * 0.8, -limb * 0.8], [x1, armY + limb * 0.8, limb * 0.8]),
        box(`lowerArm${side}`, [x2, armY - limb * 0.8, -limb * 0.8], [x3, armY + limb * 0.8, limb * 0.8]),
      );
      joints.push(
        { a: 'chest', b: `upperArm${side}`, pivot: [shoulderX, armY, 0], angle: 1.4, twist: 0.6 },
        { a: `upperArm${side}`, b: `lowerArm${side}`, pivot: [elbowX, armY, 0], angle: 1.3, twist: 0.2 },
      );
    } else {
      const armX = sx * (torsoW / 2 + limb * 0.8 + 0.01 * H);
      const elbowY = 0.55 * H;
      const handY = Math.max(0.36 * H, hipY - 0.12 * H);
      parts.push(
        box(`upperArm${side}`, [armX - limb * 0.8, elbowY, -limb * 0.8], [armX + limb * 0.8, neckY, limb * 0.8]),
        box(`lowerArm${side}`, [armX - limb * 0.8, handY, -limb * 0.8], [armX + limb * 0.8, elbowY, limb * 0.8]),
      );
      joints.push(
        { a: 'chest', b: `upperArm${side}`, pivot: [armX, neckY, 0], angle: 1.4, twist: 0.6 },
        { a: `upperArm${side}`, b: `lowerArm${side}`, pivot: [armX, elbowY, 0], angle: 1.3, twist: 0.2 },
      );
    }
  }
  return { parts, joints, tPose };
}

// 点 p から部位の表面までの距離（中にあれば 0 以下）
export function distanceToPart(p, part) {
  const d = p.map((v, k) => v - part.center[k]);
  if (part.shape === 'sphere') return Math.hypot(...d) - part.radius;
  const q = d.map((v, k) => Math.abs(v) - part.half[k]);
  const outside = Math.hypot(...q.map((v) => Math.max(v, 0)));
  return outside + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

// 頂点ごとに、近い部位 2 つとその重み（合計 1）を決める。境目のあたりだけ 2 つにまたがって、なめらかに曲がる
export function assignParts(vertices, parts, blend) {
  const count = vertices.length / 3;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const p = [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
    let first = 0;
    let second = 0;
    let d1 = Infinity;
    let d2 = Infinity;
    parts.forEach((part, j) => {
      const d = distanceToPart(p, part);
      if (d < d1) {
        [second, d2] = [first, d1];
        [first, d1] = [j, d];
      } else if (d < d2) {
        [second, d2] = [j, d];
      }
    });
    // 2 番目が blend より遠ければ 1 つだけ。近いほど半々に近づける
    const w2 = Number.isFinite(d2) ? Math.max(0, 0.5 * (1 - (d2 - d1) / blend)) : 0;
    indices[i * 4] = first;
    indices[i * 4 + 1] = second;
    weights[i * 4] = 1 - w2;
    weights[i * 4 + 1] = w2;
  }
  return { indices, weights };
}

// 階段の段（箱）。i 段目の上面の高さは (STEP_COUNT - 1 - i) * STEP_RISE … の順に下がる。
// 返すのは { center, half }。踊り場と床も含む
export function stairBoxes({ steps = STEP_COUNT, rise = STEP_RISE, run = STEP_RUN, width = STAIR_WIDTH } = {}) {
  const top = steps * rise;
  const boxes = [{ center: [-LANDING / 2, top / 2, 0], half: [LANDING / 2, top / 2, width / 2] }];
  for (let i = 0; i < steps; i++) {
    const height = (steps - 1 - i) * rise;
    if (height <= 0) continue;
    boxes.push({ center: [i * run + run / 2, height / 2, 0], half: [run / 2, height / 2, width / 2] });
  }
  return { boxes, top, bottomX: steps * run };
}

// ぶつかったときの点。ゆっくりなら 0、速いほど大きく、頭は高い
// 物理が乱れて速さがとんでもない値になっても、点が飛び抜けないように上限を付ける
export const MAX_IMPACT_SPEED = 15;
export function impactScore(speed, partName, threshold = 1.2) {
  if (!(speed > threshold)) return 0;
  const capped = Math.min(speed, MAX_IMPACT_SPEED);
  return Math.round((capped - threshold) ** 2 * 10 * (PART_WEIGHTS[partName] ?? 1)) + 1;
}

// 押す強さ。ドラッグの長さ（画面の高さに対する割合）を 0〜1 にする
export function pushPower(dragLength, viewHeight) {
  if (!(viewHeight > 0)) return 0;
  return Math.min(1, Math.max(0, dragLength / (viewHeight * 0.35)));
}

// 全部の部位がゆっくりになって quietTime 秒たったら終わり
export function updateSettle(state, speeds, dt, { threshold = 0.25, quietTime = 1.5 } = {}) {
  const quiet = speeds.every((s) => s < threshold);
  const time = quiet ? state.time + dt : 0;
  return { time, settled: time >= quietTime };
}
