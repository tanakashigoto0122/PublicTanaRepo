// ぷるぷるラボの計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。
// モデルの表面に置いた「粒」を、近所の粒のまとまりごとに元の形へ戻そうとする（シェイプマッチング）ことで、
// ゼリーのように揺れる体を作る。モデルの頂点は、近くの粒にくっついて動く。
// 位置は [x0, y0, z0, x1, ...] と並んだ Float32Array、クォータニオンは [x, y, z, w]、
// 3x3 行列は行優先の長さ 9 の配列で表す。

export { detectFormat, guessFacing } from '../mecha-blaster/logic.js';
export { farthestPointSample, strideIndices } from '../model-blocks/logic.js';
export { toFloatArray } from '../model-sculpt/logic.js';

export const MODEL_HEIGHT = 2;
export const BIND_COUNT = 4;

// ---- 回転 ----

export function quatToMatrix([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

export function quatMultiply([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function multiplyMatrixVector(m, [x, y, z]) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

// 行列 A に一番近い回転を、クォータニオン q から少しずつ回して求める
// （Müller ら「A Robust Method to Extract the Rotational Part of Deformations」の方法）。
// 前のフレームの答えを q に渡すと、少ない回数で収まる
export function extractRotation(a, q = [0, 0, 0, 1], iterations = 8) {
  let result = q;
  for (let n = 0; n < iterations; n++) {
    const r = quatToMatrix(result);
    // 列どうしの外積と内積
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let dot = 0;
    for (let c = 0; c < 3; c++) {
      const rc = [r[c], r[3 + c], r[6 + c]];
      const ac = [a[c], a[3 + c], a[6 + c]];
      ox += rc[1] * ac[2] - rc[2] * ac[1];
      oy += rc[2] * ac[0] - rc[0] * ac[2];
      oz += rc[0] * ac[1] - rc[1] * ac[0];
      dot += rc[0] * ac[0] + rc[1] * ac[1] + rc[2] * ac[2];
    }
    const scale = 1 / (Math.abs(dot) + 1e-9);
    const omega = [ox * scale, oy * scale, oz * scale];
    const angle = Math.hypot(...omega);
    if (angle < 1e-9) break;
    const s = Math.sin(angle / 2) / angle;
    result = quatMultiply([omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(angle / 2)], result);
    const length = Math.hypot(...result);
    result = result.map((v) => v / length);
  }
  return result;
}

// ---- 粒のまとまり ----

// 粒ごとに、radius 以内にある粒の番号を集める（自分も入る）
export function buildClusters(particles, radius) {
  const count = particles.length / 3;
  const clusters = [];
  for (let i = 0; i < count; i++) {
    const members = [];
    for (let j = 0; j < count; j++) {
      const dx = particles[j * 3] - particles[i * 3];
      const dy = particles[j * 3 + 1] - particles[i * 3 + 1];
      const dz = particles[j * 3 + 2] - particles[i * 3 + 2];
      if (dx * dx + dy * dy + dz * dz <= radius * radius) members.push(j);
    }
    clusters.push(members);
  }
  return clusters;
}

// 粒どうしの平均の間隔（一番近い粒までの距離の平均）
export function averageSpacing(particles) {
  const count = particles.length / 3;
  if (count < 2) return 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    let best = Infinity;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      best = Math.min(best, Math.hypot(
        particles[j * 3] - particles[i * 3],
        particles[j * 3 + 1] - particles[i * 3 + 1],
        particles[j * 3 + 2] - particles[i * 3 + 2],
      ));
    }
    total += best;
  }
  return total / count;
}

// ぷるぷるの体の状態を作る。
// 近所の粒のまとまり（粒ごとに 1 つ）に加えて、最後に体全体のまとまりを 1 つ足す。
// 粒は表面にしかない（中が空の殻）ので、近所のまとまりだけだと殻が折れ曲がって全体がつぶれてしまう。
// 全体のまとまりが、全体の形を保つ
export function createBody(rest, clusterRadius) {
  const clusters = buildClusters(rest, clusterRadius);
  clusters.push(Array.from({ length: rest.length / 3 }, (_, i) => i));
  return {
    rest: Float32Array.from(rest),
    positions: Float32Array.from(rest),
    velocities: new Float32Array(rest.length),
    // 床に触れている粒（静止摩擦で横に滑らないようにするため）
    grounded: new Uint8Array(rest.length / 3),
    clusters,
    rotations: clusters.map(() => [0, 0, 0, 1]),
    // 指でつかんでいる粒と、その目標の位置
    pinned: new Map(),
  };
}

function centroid(array, members) {
  const c = [0, 0, 0];
  for (const j of members) for (let k = 0; k < 3; k++) c[k] += array[j * 3 + k];
  return c.map((v) => v / members.length);
}

// 1 ステップ進める。stiffness（0〜1）が大きいほど硬く、すぐ元の形に戻る。
// 床（y = 0）と、|x|, |z| が wall の壁で跳ね返る
// globalWeight は、体全体のまとまりの目標を、近所のまとまり何個分として数えるか。
// 床に触れていてゆっくり動いている粒は、静止摩擦として横には動かさない。
// これがないと、元の形へ戻そうとする力に引きずられて、置いただけの体が床の上をじわじわ転がり続ける
export const STATIC_FRICTION_SPEED = 0.5;
// rollingResistance（1 秒あたり）は、床に触れているときに体全体の回転を弱める強さ。
// やわらかい物は転がると形が崩れて抵抗が大きい。これがないと、少しの偏りで置いただけの体が転がり続ける
export function stepBody(body, {
  dt, stiffness, gravity = -9.82, bounce = 0.3, friction = 0.8, wall = 4, pinStrength = 0.5, globalWeight = 4,
  rollingResistance = 15,
}) {
  const { rest, positions, velocities, clusters, rotations } = body;
  const count = positions.length / 3;
  // 重力で動かす
  for (let i = 0; i < count; i++) {
    velocities[i * 3 + 1] += gravity * dt;
    for (let k = 0; k < 3; k++) positions[i * 3 + k] += velocities[i * 3 + k] * dt;
  }
  // まとまりごとに、元の形を回して重ねた位置（目標）を求め、粒ごとに平均する
  const goals = new Float32Array(positions.length);
  const counts = new Float32Array(count);
  const last = clusters.length - 1;
  clusters.forEach((members, ci) => {
    const weight = ci === last ? globalWeight : 1;
    const c0 = centroid(rest, members);
    const c = centroid(positions, members);
    const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const j of members) {
      const p = [positions[j * 3] - c[0], positions[j * 3 + 1] - c[1], positions[j * 3 + 2] - c[2]];
      const q = [rest[j * 3] - c0[0], rest[j * 3 + 1] - c0[1], rest[j * 3 + 2] - c0[2]];
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) a[r * 3 + s] += p[r] * q[s];
    }
    rotations[ci] = extractRotation(a, rotations[ci], 3);
    const m = quatToMatrix(rotations[ci]);
    for (const j of members) {
      const g = multiplyMatrixVector(m, [rest[j * 3] - c0[0], rest[j * 3 + 1] - c0[1], rest[j * 3 + 2] - c0[2]]);
      for (let k = 0; k < 3; k++) goals[j * 3 + k] += (g[k] + c[k]) * weight;
      counts[j] += weight;
    }
  });
  // 目標へ引き寄せ、その動きを速さにも反映する
  for (let i = 0; i < count; i++) {
    const sticking = body.grounded[i]
      && Math.hypot(velocities[i * 3], velocities[i * 3 + 2]) < STATIC_FRICTION_SPEED && !body.pinned.has(i);
    for (let k = 0; k < 3; k++) {
      if (sticking && k !== 1) {
        velocities[i * 3 + k] = 0;
        continue;
      }
      const goal = goals[i * 3 + k] / counts[i];
      const correction = (goal - positions[i * 3 + k]) * stiffness;
      positions[i * 3 + k] += correction;
      velocities[i * 3 + k] += correction / dt;
    }
  }
  // つかんでいる粒は指の位置へ
  for (const [i, target] of body.pinned) {
    for (let k = 0; k < 3; k++) {
      const correction = (target[k] - positions[i * 3 + k]) * pinStrength;
      positions[i * 3 + k] += correction;
      velocities[i * 3 + k] += correction / dt;
    }
  }
  if (body.grounded.some(Boolean) && body.pinned.size === 0) dampRotation(body, Math.min(1, rollingResistance * dt));
  // 床と壁
  for (let i = 0; i < count; i++) {
    const y = i * 3 + 1;
    body.grounded[i] = positions[y] <= 1e-3 ? 1 : 0;
    if (positions[y] < 0) {
      positions[y] = 0;
      if (velocities[y] < 0) velocities[y] = -velocities[y] * bounce;
      velocities[i * 3] *= friction;
      velocities[i * 3 + 2] *= friction;
    }
    for (const k of [0, 2]) {
      const v = i * 3 + k;
      if (Math.abs(positions[v]) > wall) {
        positions[v] = Math.sign(positions[v]) * wall;
        velocities[v] = -velocities[v] * bounce;
      }
    }
  }
}

export function invertMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

// 体全体の回転（角速度）を damping の割合だけ弱める。床の上での転がり抵抗に使う
export function dampRotation(body, damping) {
  const { positions, velocities } = body;
  const count = positions.length / 3;
  const c = centroid(positions, Array.from({ length: count }, (_, i) => i));
  const v = centroid(velocities, Array.from({ length: count }, (_, i) => i));
  const momentum = [0, 0, 0];
  const inertia = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const r = [positions[i * 3] - c[0], positions[i * 3 + 1] - c[1], positions[i * 3 + 2] - c[2]];
    const u = [velocities[i * 3] - v[0], velocities[i * 3 + 1] - v[1], velocities[i * 3 + 2] - v[2]];
    momentum[0] += r[1] * u[2] - r[2] * u[1];
    momentum[1] += r[2] * u[0] - r[0] * u[2];
    momentum[2] += r[0] * u[1] - r[1] * u[0];
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) inertia[a * 3 + b] += (a === b ? rr : 0) - r[a] * r[b];
  }
  const inverse = invertMatrix(inertia);
  if (!inverse) return;
  const omega = multiplyMatrixVector(inverse, momentum).map((w) => w * damping);
  for (let i = 0; i < count; i++) {
    const r = [positions[i * 3] - c[0], positions[i * 3 + 1] - c[1], positions[i * 3 + 2] - c[2]];
    velocities[i * 3] -= omega[1] * r[2] - omega[2] * r[1];
    velocities[i * 3 + 1] -= omega[2] * r[0] - omega[0] * r[2];
    velocities[i * 3 + 2] -= omega[0] * r[1] - omega[1] * r[0];
  }
}

// 全体に同じ速さを足す（ジャンプや投げ）
export function addVelocity(body, [vx, vy, vz]) {
  for (let i = 0; i < body.velocities.length; i += 3) {
    body.velocities[i] += vx;
    body.velocities[i + 1] += vy;
    body.velocities[i + 2] += vz;
  }
}

// 全体を平行移動する（持ち上げるときなど）。速さは 0 にする
export function translateBody(body, [dx, dy, dz]) {
  for (let i = 0; i < body.positions.length; i += 3) {
    body.positions[i] += dx;
    body.positions[i + 1] += dy;
    body.positions[i + 2] += dz;
  }
  body.velocities.fill(0);
}

// ---- 頂点を粒にくっつける ----

// 頂点ごとに、近い粒 BIND_COUNT 個とその重み（近いほど大きい、合計 1）を決める
export function bindVertices(vertices, particles) {
  const count = vertices.length / 3;
  const particleCount = particles.length / 3;
  const take = Math.min(BIND_COUNT, particleCount);
  const indices = new Uint16Array(count * BIND_COUNT);
  const weights = new Float32Array(count * BIND_COUNT);
  const bestIndex = new Int32Array(take);
  const bestDistance = new Float64Array(take);
  for (let v = 0; v < count; v++) {
    bestIndex.fill(-1);
    bestDistance.fill(Infinity);
    for (let j = 0; j < particleCount; j++) {
      const dx = particles[j * 3] - vertices[v * 3];
      const dy = particles[j * 3 + 1] - vertices[v * 3 + 1];
      const dz = particles[j * 3 + 2] - vertices[v * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d >= bestDistance[take - 1]) continue;
      let k = take - 1;
      while (k > 0 && bestDistance[k - 1] > d) {
        bestDistance[k] = bestDistance[k - 1];
        bestIndex[k] = bestIndex[k - 1];
        k--;
      }
      bestDistance[k] = d;
      bestIndex[k] = j;
    }
    let total = 0;
    for (let k = 0; k < take; k++) total += 1 / (bestDistance[k] + 1e-6);
    for (let k = 0; k < take; k++) {
      indices[v * BIND_COUNT + k] = bestIndex[k];
      weights[v * BIND_COUNT + k] = 1 / (bestDistance[k] + 1e-6) / total;
    }
  }
  return { indices, weights };
}

// 粒の動きに合わせて頂点を動かす。粒ごとのまとまりの回転も使うので、ねじれても形が崩れにくい
export function deformVertices(out, restVertices, binding, body) {
  const matrices = body.rotations.map(quatToMatrix);
  const { rest, positions } = body;
  for (let v = 0; v < restVertices.length / 3; v++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < BIND_COUNT; k++) {
      const w = binding.weights[v * BIND_COUNT + k];
      if (w === 0) continue;
      const j = binding.indices[v * BIND_COUNT + k];
      const m = matrices[j];
      const ox = restVertices[v * 3] - rest[j * 3];
      const oy = restVertices[v * 3 + 1] - rest[j * 3 + 1];
      const oz = restVertices[v * 3 + 2] - rest[j * 3 + 2];
      x += w * (m[0] * ox + m[1] * oy + m[2] * oz + positions[j * 3]);
      y += w * (m[3] * ox + m[4] * oy + m[5] * oz + positions[j * 3 + 1]);
      z += w * (m[6] * ox + m[7] * oy + m[8] * oz + positions[j * 3 + 2]);
    }
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
}

// 粒の動きの大きさ（一番速い粒の速さ）
export function maxSpeed(body) {
  let best = 0;
  for (let i = 0; i < body.velocities.length; i += 3) {
    best = Math.max(best, Math.hypot(body.velocities[i], body.velocities[i + 1], body.velocities[i + 2]));
  }
  return best;
}

// やわらかさのスライダー 0〜100（100 がいちばん柔らかい）を、1 ステップで元の形へ戻る割合にする
export function stiffnessFromSoftness(softness) {
  const t = Math.min(100, Math.max(0, softness)) / 100;
  return 0.6 * (1 - t) + 0.03 * t;
}
