// 物理積み木の計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。

// 形の種類。size は箱の幅・高さ・奥行き、球と円柱は radius / height。体積がそのまま重さ（kg）になる。
export const SHAPES = {
  box: { label: '箱', type: 'box', size: [1, 1, 1] },
  plank: { label: '板', type: 'box', size: [3, 0.25, 0.8] },
  pillar: { label: '柱', type: 'box', size: [0.5, 2, 0.5] },
  sphere: { label: '球', type: 'sphere', radius: 0.5 },
  cylinder: { label: '円柱', type: 'cylinder', radius: 0.5, height: 1 },
};
export const MAX_BODIES = 150;
// これより下に落ちた物体は消す
export const FALL_LIMIT = -10;

export function shapeVolume(kind) {
  const shape = SHAPES[kind];
  if (!shape) throw new Error(`不明な形: ${kind}`);
  if (shape.type === 'box') return shape.size[0] * shape.size[1] * shape.size[2];
  if (shape.type === 'sphere') return (4 / 3) * Math.PI * shape.radius ** 3;
  return Math.PI * shape.radius ** 2 * shape.height;
}

export function massOf(kind) {
  return shapeVolume(kind);
}

// 形の中心から底までの高さ
export function halfHeight(kind) {
  const shape = SHAPES[kind];
  if (!shape) throw new Error(`不明な形: ${kind}`);
  if (shape.type === 'box') return shape.size[1] / 2;
  if (shape.type === 'sphere') return shape.radius;
  return shape.height / 2;
}

// タップした面（surfaceY の高さ）の少し上から落とす
export function dropPosition([x, surfaceY, z], kind, gap = 1) {
  return [x, Math.max(surfaceY, 0) + halfHeight(kind) + gap, z];
}

function ratio(level, max = 100) {
  return Math.min(max, Math.max(0, level)) / 100;
}

// 硬さ 0〜100 を物理エンジンの設定にする。
// 接着の硬さ（jointStiffness）は 0 でぷるぷる、70 あたりから先はほぼカチカチ。
// 変化が低いほうに集中するので 2 乗で割り当て、スライダー全体で違いが分かるようにする。
// ぶつかったときの硬さ（contactStiffness）は、柔らかくしても床を突き抜けない範囲に留める。
// relaxation は小さいほどずれをすばやく直す（硬く感じる）。
export function stiffnessParams(level) {
  const t = ratio(level);
  return {
    jointStiffness: 10 ** (0.5 + 6.5 * t * t),
    contactStiffness: 10 ** (2.5 + 4.5 * t * t),
    relaxation: 10 - 7 * t,
  };
}

// 接着の強さ。100 なら外れない。それ以外はこの力（ニュートン）を超えると外れる。
export function breakForce(level) {
  const t = ratio(level);
  if (t >= 1) return Infinity;
  return 5 * 1000 ** t;
}

// 重力 0〜200%（下向きの加速度）
export function gravityY(level) {
  return -9.82 * ratio(level, 200);
}

// 弾み 0〜100 を反発係数 0〜0.9 に
export function restitution(level) {
  return 0.9 * ratio(level);
}

// ---- 接着の組み合わせ ----
// 接着は { a, b } の配列で、a < b の物体 id の組。床も 1 つの物体として id を持つ。

export function glueKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function hasGlue(glues, a, b) {
  const key = glueKey(a, b);
  return glues.some((g) => glueKey(g.a, g.b) === key);
}

export function addGlue(glues, a, b) {
  if (a === b || hasGlue(glues, a, b)) return glues;
  return [...glues, { a: Math.min(a, b), b: Math.max(a, b) }];
}

export function removeGlue(glues, a, b) {
  const key = glueKey(a, b);
  return glues.filter((g) => glueKey(g.a, g.b) !== key);
}

export function removeGluesOf(glues, id) {
  return glues.filter((g) => g.a !== id && g.b !== id);
}

// id とつながっている物体の id をすべて返す。floorId はたどらない（床を介しただけなら別の塊）。
export function connectedGroup(glues, id, floorId = null) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const g of glues) {
      const other = g.a === current ? g.b : g.b === current ? g.a : null;
      if (other === null || other === floorId || seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return seen;
}

// 触れ合っている組（{ a, b } の配列）のうち、まだ接着していないものを返す。重複は 1 つにまとめる。
export function newGluePairs(glues, contacts) {
  let result = [];
  for (const { a, b } of contacts) {
    if (a === b || hasGlue(glues, a, b) || hasGlue(result, a, b)) continue;
    result = addGlue(result, a, b);
  }
  return result;
}
