// ぷるぷる相撲の計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。
// ぷるぷるの体はぷるぷるラボ、体の真ん中と一番低い高さはぷるぷるキャッチのものを使う。

export {
  addVelocity, averageSpacing, bindVertices, createBody, deformVertices, farthestPointSample, stepBody,
  stiffnessFromSoftness, toFloatArray, translateBody,
} from '../jelly-lab/logic.js';
export { bodySummary } from '../jelly-catch/logic.js';
export { guessFacing } from '../mecha-blaster/logic.js';
export { displayName } from '../shared/logic.js';

export const JELLY_HEIGHT = 1.2;
export const RING_RADIUS = 2.4;
export const DOHYO_HEIGHT = 0.4;
// 土俵の外の地面の広さ（体が場外へ飛んでいきすぎないように）
export const WALL = 6;
export const START_GAP = 1.1;
export const WINS_NEEDED = 2;
// ぶちかましのあと、次に使えるまでの時間（秒）
export const DASH_COOLDOWN = 1.2;

// 土俵（半径 RING_RADIUS の台）の上なら台の高さ、外は地面
export function floorAt(x, z) {
  return Math.hypot(x, z) <= RING_RADIUS ? DOHYO_HEIGHT : 0;
}

// 土俵の外に出たか、台から落ちたら負け
export function isOut({ center, lowest }) {
  return Math.hypot(center[0], center[2]) > RING_RADIUS || lowest < DOHYO_HEIGHT - 0.15;
}

// 体の粒どうしがめり込んでいたら押し返す。distance は粒どうしが近づける距離。
// 両方を半分ずつ動かし、近づく向きの速さは消す（ぶつかった勢いは相手に渡る）。触れた粒の組の数を返す
export function collideBodies(a, b, distance) {
  const boxA = bounds(a.positions);
  const boxB = bounds(b.positions);
  for (let k = 0; k < 3; k++) {
    if (boxA.min[k] - distance > boxB.max[k] || boxB.min[k] - distance > boxA.max[k]) return 0;
  }
  const pa = a.positions;
  const pb = b.positions;
  const va = a.velocities;
  const vb = b.velocities;
  let contacts = 0;
  for (let i = 0; i < pa.length; i += 3) {
    if (pa[i] < boxB.min[0] - distance || pa[i] > boxB.max[0] + distance) continue;
    for (let j = 0; j < pb.length; j += 3) {
      const dx = pb[j] - pa[i];
      const dy = pb[j + 1] - pa[i + 1];
      const dz = pb[j + 2] - pa[i + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= distance * distance) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const n = d2 > 0 ? [dx / d, dy / d, dz / d] : [1, 0, 0];
      const push = (distance - d) / 2;
      for (let k = 0; k < 3; k++) {
        pa[i + k] -= n[k] * push;
        pb[j + k] += n[k] * push;
      }
      // 近づく向きの速さ（相対速度の法線成分）を、両方で分け合う
      const approach = (va[i] - vb[j]) * n[0] + (va[i + 1] - vb[j + 1]) * n[1] + (va[i + 2] - vb[j + 2]) * n[2];
      if (approach > 0) {
        for (let k = 0; k < 3; k++) {
          va[i + k] -= n[k] * approach / 2;
          vb[j + k] += n[k] * approach / 2;
        }
      }
      contacts++;
    }
  }
  return contacts;
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return { min, max };
}

// 長さ 1 にする。小さすぎれば [0, 0]
export function normalize2([x, z]) {
  const length = Math.hypot(x, z);
  return length < 1e-6 ? [0, 0] : [x / length, z / length];
}

// 移動は小さく跳ねて進む。ぶちかましは低く速く飛び込む
export function hopVelocity([x, z], { dash = false, power = 1 } = {}) {
  const [nx, nz] = normalize2([x, z]);
  const forward = (dash ? 5.5 : 2.2) * power;
  return [nx * forward, dash ? 1.6 : 2.4, nz * forward];
}

export const CPU_LEVELS = {
  weak: { power: 0.75, dashChance: 0.15, reaction: 0.55 },
  normal: { power: 0.95, dashChance: 0.35, reaction: 0.35 },
  strong: { power: 1.1, dashChance: 0.6, reaction: 0.2 },
};

// CPU の次の一手。相手へ向かうが、土俵の端に近いときは真ん中へ回り込む
export function cpuMove(self, other, level = CPU_LEVELS.normal, random = Math.random) {
  let dir = normalize2([other[0] - self[0], other[1] - self[1]]);
  const edge = Math.hypot(self[0], self[1]) / RING_RADIUS;
  if (edge > 0.7) {
    const inward = normalize2([-self[0], -self[1]]);
    const weight = (edge - 0.7) / 0.3 * 1.5;
    dir = normalize2([dir[0] + inward[0] * weight, dir[1] + inward[1] * weight]);
  }
  // 少しふらつかせる
  const wobble = (random() - 0.5) * 0.6;
  const cos = Math.cos(wobble);
  const sin = Math.sin(wobble);
  dir = [dir[0] * cos - dir[1] * sin, dir[0] * sin + dir[1] * cos];
  const distance = Math.hypot(other[0] - self[0], other[1] - self[1]);
  const dash = distance < 2 && edge <= 0.7 && random() < level.dashChance;
  return { dir, dash };
}

// 勝負の記録。wins は [あなた, あいて] の勝ち数
export function createMatch() {
  return { wins: [0, 0], round: 1, winner: null };
}

// side（0 か 1）がこの取組に勝った
export function recordRound(match, side) {
  const wins = match.wins.map((w, i) => (i === side ? w + 1 : w));
  const winner = wins[side] >= WINS_NEEDED ? side : null;
  return { wins, round: winner === null ? match.round + 1 : match.round, winner };
}

// 両方が同時に出たら、土俵の真ん中に近いほうの勝ち
export function roundWinner(outA, outB, distanceA, distanceB) {
  if (outA && outB) return distanceA <= distanceB ? 0 : 1;
  if (outA) return 1;
  if (outB) return 0;
  return null;
}

// 面の上に count 個の点を、面積に比例してばらまく。meshes は [{ positions, index }]（index はなくてもよい）。
// 頂点だけを使うと、箱のように頂点が少ないモデルは粒が角にしか置けず、相手がすり抜けてしまう
export function surfaceSamples(meshes, count, random = Math.random) {
  const triangles = [];
  let total = 0;
  for (const { positions, index } of meshes) {
    const n = index ? index.length : positions.length / 3;
    for (let t = 0; t + 2 < n; t += 3) {
      const ids = index ? [index[t], index[t + 1], index[t + 2]] : [t, t + 1, t + 2];
      const [a, b, c] = ids.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      if (!(area > 0)) continue;
      total += area;
      triangles.push({ a, u, v, end: total });
    }
  }
  if (triangles.length === 0) return [];
  const points = [];
  for (let i = 0; i < count; i++) {
    const pick = random() * total;
    let lo = 0;
    let hi = triangles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (triangles[mid].end < pick) lo = mid + 1;
      else hi = mid;
    }
    const { a, u, v } = triangles[lo];
    let s = random();
    let t = random();
    if (s + t > 1) {
      s = 1 - s;
      t = 1 - t;
    }
    points.push([a[0] + u[0] * s + v[0] * t, a[1] + u[1] * s + v[1] * t, a[2] + u[2] * s + v[2] * t]);
  }
  return points;
}
