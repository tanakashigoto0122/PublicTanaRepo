// やわらか積み木の計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。
// 形・接着・重力などの共通部分は物理積み木のものを使い、ここにはパーツごとの柔らかさと、曲がるパーツの組み立てを書く。
import { glueKey } from '../physics-blocks/logic.js';

export {
  SHAPES, MAX_BODIES, FALL_LIMIT, massOf, halfHeight, dropPosition, breakForce, gravityY, restitution,
  glueKey, hasGlue, removeGlue, removeGluesOf, newGluePairs,
} from '../physics-blocks/logic.js';

// 物体の硬さは 5 段階にそろえる（物理エンジンでは、硬さの組み合わせごとに接触の設定を用意するため）
export const HARDNESS_STEPS = [0, 25, 50, 75, 100];

export function clampLevel(level) {
  return Math.min(100, Math.max(0, Number.isFinite(level) ? level : 0));
}

// いちばん近い段階の値に丸める
export function quantizeHardness(level) {
  const value = clampLevel(level);
  return HARDNESS_STEPS.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best));
}

// 物体の硬さ 0〜100 を接触の設定にする。0 だとぶつかったときに大きく沈み込み、100 でカチカチ。
// 変化が柔らかい側に集中するので 2 乗で割り当てる。
export function contactParams(hardness) {
  const t = clampLevel(hardness) / 100;
  return { stiffness: 10 ** (1.5 + 5.5 * t * t), relaxation: 10 - 7 * t };
}

// 柔らかい物と硬い物がぶつかったときは、柔らかいほうに合わせる
export function pairHardness(a, b) {
  return Math.min(a, b);
}

// 接着 1 本ごとの硬さ（0 でぷるぷる、100 でカチカチ）を物理エンジンの設定にする。
// 試したところ、ソルバーの反復が 80 回のとき、硬さ 1e3 あたりより上は見た目がほとんど変わらなかった
// （しなる板の先が 0.17 下がるところで止まる）。なので約 16〜1600 を対数で割り当て、スライダー全体で
// 違いが分かるようにする。relaxation は小さいほど継ぎ目のずれをすばやく直す。
export const SOLVER_ITERATIONS = 80;
export function jointParams(level) {
  const t = clampLevel(level) / 100;
  return { stiffness: 10 ** (1.2 + 2 * t), relaxation: 3 };
}

// ---- 接着 ----
// 接着は { a, b, type, stiffness } の配列。a < b の物体 id の組で、type は 'lock'（固定）か 'ball'（首振り）。

export function addGlue(glues, a, b, { type = 'lock', stiffness = 100 } = {}) {
  if (a === b) return glues;
  const key = glueKey(a, b);
  if (glues.some((g) => glueKey(g.a, g.b) === key)) return glues;
  return [...glues, { a: Math.min(a, b), b: Math.max(a, b), type, stiffness: clampLevel(stiffness) }];
}

// id につながっている固定の接着の硬さをまとめて変える。首振りの接着は硬さを持たないのでそのまま。
export function setStiffnessOf(glues, id, stiffness) {
  const value = clampLevel(stiffness);
  return glues.map((g) => ((g.a === id || g.b === id) && g.type === 'lock' ? { ...g, stiffness: value } : g));
}

export function setAllStiffness(glues, stiffness) {
  const value = clampLevel(stiffness);
  return glues.map((g) => (g.type === 'lock' ? { ...g, stiffness: value } : g));
}

// ---- 曲がるパーツ ----
// 小さな箱をつないで作る。offset は「パーツの底の中心」から見た各ピースの中心。
// joints の i, j はピースの番号。ball の pivotI / pivotJ は、それぞれのピースから見た首振りの位置。
// internal が true の接着でつながったピースどうしはぶつからない（めり込んで曲がれるように）。

export const PARTS = {
  bendy: { label: 'しなる板' },
  rope: { label: 'ロープ' },
  jelly: { label: 'ゼリー' },
};

const BENDY_SEGMENTS = 6;
const BENDY_SIZE = [0.5, 0.25, 0.8];
const ROPE_SEGMENTS = 10;
const ROPE_SIZE = [0.3, 0.12, 0.12];
const JELLY_SIZE = 0.5;

function chain(count, size, type) {
  const pieces = [];
  const joints = [];
  const total = count * size[0];
  for (let i = 0; i < count; i++) {
    pieces.push({ size, offset: [-total / 2 + size[0] * (i + 0.5), size[1] / 2, 0] });
    if (i > 0) {
      joints.push({ i: i - 1, j: i, type, pivotI: [size[0] / 2, 0, 0], pivotJ: [-size[0] / 2, 0, 0], internal: true });
    }
  }
  return { pieces, joints };
}

export function partLayout(kind) {
  if (kind === 'bendy') return chain(BENDY_SEGMENTS, BENDY_SIZE, 'lock');
  if (kind === 'rope') return chain(ROPE_SEGMENTS, ROPE_SIZE, 'ball');
  if (kind === 'jelly') {
    const s = JELLY_SIZE;
    const pieces = [];
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        for (let x = 0; x < 2; x++) {
          pieces.push({ size: [s, s, s], offset: [(x - 0.5) * s, (y + 0.5) * s, (z - 0.5) * s] });
        }
      }
    }
    // 面で隣り合うピース（offset の差がちょうど 1 辺）をすべてつなぐ
    const joints = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const d = pieces[i].offset.map((v, k) => Math.abs(v - pieces[j].offset[k]));
        if (Math.abs(d[0] + d[1] + d[2] - s) < 1e-9) joints.push({ i, j, type: 'lock', internal: true });
      }
    }
    return { pieces, joints };
  }
  throw new Error(`不明なパーツ: ${kind}`);
}

// パーツの高さ（床から一番上のピースの上端まで）
export function partHeight(kind) {
  return Math.max(...partLayout(kind).pieces.map((p) => p.offset[1] + p.size[1] / 2));
}

// パーツを y 軸まわりに yaw だけ回して、底の中心を origin に置いたときの各ピースの位置
export function placePieces(kind, origin, yaw = 0) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return partLayout(kind).pieces.map(({ size, offset: [x, y, z] }) => ({
    size,
    position: [origin[0] + x * cos + z * sin, origin[1] + y, origin[2] - x * sin + z * cos],
  }));
}
