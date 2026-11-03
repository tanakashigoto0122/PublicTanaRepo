// 3D 積み木のデータ操作。DOM と Three.js に依存しないので node:test から直接テストできる。
// 作品は { shapes, nextId } で表し、操作ごとに新しいオブジェクトを返す（元は変更しない）。
// 形は { id, kind, position: [x, y, z], rotation: [x, y, z]（ラジアン）, scale: [x, y, z], color: '#rrggbb' }。

export const SHAPE_KINDS = ['box', 'sphere', 'cylinder', 'cone', 'torus'];
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 20;
export const HISTORY_LIMIT = 100;
// 床に置いたときの形の中心の高さ（形はどれも高さ 1 の大きさで作る）
const FLOOR_Y = 0.5;
// 新しい形を置く場所を探すときの間隔
const SPOT_STEP = 1.5;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function createScene() {
  return { shapes: [], nextId: 1 };
}

function samePlace(shape, x, z) {
  return Math.abs(shape.position[0] - x) < SPOT_STEP / 2 && Math.abs(shape.position[2] - z) < SPOT_STEP / 2;
}

// 原点から渦巻き状に床のマスをたどり、どの形とも重ならない最初の場所を返す
export function findFreeSpot(shapes) {
  let x = 0;
  let z = 0;
  let dx = 1;
  let dz = 0;
  let length = 1;
  for (let walked = 0, turns = 0; walked < 10000;) {
    if (!shapes.some((s) => samePlace(s, x * SPOT_STEP, z * SPOT_STEP))) return [x * SPOT_STEP, z * SPOT_STEP];
    x += dx;
    z += dz;
    walked++;
    if (walked === length) {
      walked = 0;
      [dx, dz] = [-dz, dx];
      turns++;
      if (turns % 2 === 0) length++;
    }
  }
  return [0, 0];
}

export function addShape(scene, kind, color) {
  if (!SHAPE_KINDS.includes(kind)) throw new Error(`不明な形: ${kind}`);
  const [x, z] = findFreeSpot(scene.shapes);
  const shape = {
    id: scene.nextId,
    kind,
    position: [x, FLOOR_Y, z],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: normalizeColor(color),
  };
  return { shapes: [...scene.shapes, shape], nextId: scene.nextId + 1 };
}

export function findShape(scene, id) {
  return scene.shapes.find((s) => s.id === id) ?? null;
}

// 指定した項目だけを書き換える。大きさは範囲内に収め、色は小文字にそろえる。存在しない id なら元のまま。
export function updateShape(scene, id, patch) {
  if (!findShape(scene, id)) return scene;
  return {
    ...scene,
    shapes: scene.shapes.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...patch };
      if (patch.scale) next.scale = patch.scale.map(clampScale);
      if (patch.color) next.color = normalizeColor(patch.color);
      return next;
    }),
  };
}

export function removeShape(scene, id) {
  if (!findShape(scene, id)) return scene;
  return { ...scene, shapes: scene.shapes.filter((s) => s.id !== id) };
}

// 同じ形・向き・大きさ・色のコピーを空いている場所に置く
export function duplicateShape(scene, id) {
  const source = findShape(scene, id);
  if (!source) return scene;
  const [x, z] = findFreeSpot(scene.shapes);
  const copy = {
    ...source,
    id: scene.nextId,
    position: [x, source.position[1], z],
    rotation: [...source.rotation],
    scale: [...source.scale],
  };
  return { shapes: [...scene.shapes, copy], nextId: scene.nextId + 1 };
}

export function clampScale(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function normalizeColor(color) {
  const value = String(color).toLowerCase();
  if (!COLOR_PATTERN.test(value)) throw new Error(`色は #rrggbb で指定する: ${color}`);
  return value;
}

// 元に戻す・やり直すための履歴。present が今の状態。
export function createHistory(present) {
  return { past: [], present, future: [] };
}

// 新しい状態を記録する。やり直し用の履歴は捨てる。同じ状態なら記録しない。
export function record(history, next) {
  if (next === history.present) return history;
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undo(history) {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redo(history) {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

export function serialize(scene) {
  return JSON.stringify({ version: 1, shapes: scene.shapes });
}

function isVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

// 保存データを読み込む。壊れている・形式が違うときは null。おかしな形は捨て、id は振り直す。
export function deserialize(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.shapes)) return null;
  const shapes = data.shapes
    .filter((s) => s && SHAPE_KINDS.includes(s.kind) && isVector(s.position) && isVector(s.rotation)
      && isVector(s.scale) && COLOR_PATTERN.test(String(s.color).toLowerCase()))
    .map((s, i) => ({
      id: i + 1,
      kind: s.kind,
      position: [...s.position],
      rotation: [...s.rotation],
      scale: s.scale.map(clampScale),
      color: s.color.toLowerCase(),
    }));
  return { shapes, nextId: shapes.length + 1 };
}

// 最初に開いたときに置いておく作品
export function createSampleScene(colors) {
  let scene = createScene();
  scene = addShape(scene, 'box', colors[0]);
  scene = addShape(scene, 'cylinder', colors[1]);
  scene = addShape(scene, 'cone', colors[2]);
  const [box, cylinder, cone] = scene.shapes;
  scene = updateShape(scene, cylinder.id, { position: [0, 1.5, 0], scale: [0.8, 1, 0.8] });
  scene = updateShape(scene, cone.id, { position: [0, 2.5, 0] });
  return updateShape(scene, box.id, { scale: [1.4, 1, 1.4] });
}
