// からくり装置の計算部分。DOM・Three.js・cannon-es に依存しないので node:test から直接テストできる。
// 盤面は横 BOARD.width・縦 BOARD.height の縦の板で、玉や部品はその面の上（z = 0）だけを動く。

export const BOARD = { width: 8, height: 9 };
export const BALL_RADIUS = 0.2;
export const SNAP = 0.1;
export const ROTATE_STEP = Math.PI / 12;
// ゴールに入ってからこれだけたったらクリア（跳ねて出ていくこともあるので）
export const GOAL_HOLD = 0.4;
// スタートしてからこれだけたってもゴールしなければ失敗
export const RUN_LIMIT = 20;

// 置ける部品。w・h は幅と厚み（回す前）
export const PART_TYPES = {
  ramp: { label: '板', w: 1.6, h: 0.12 },
  longRamp: { label: '長い板', w: 2.4, h: 0.12 },
  domino: { label: 'ドミノ', w: 0.14, h: 0.8, dynamic: true },
  spring: { label: 'バネ', w: 1, h: 0.16, bouncy: true },
  block: { label: '箱', w: 0.5, h: 0.5 },
};

// ステージ。fixed は動かせない部品、parts は置ける部品の数。
// 固定の部品の種類：ledge（台）、ball（玉。最初の位置）、goal（かご。x は真ん中、y は底、w は幅）、
// seesaw（シーソー。x, y は支点）と、PART_TYPES の部品
export const STAGES = [
  {
    title: 'さかみち',
    hint: '板を置いて、玉をかごまで転がそう。',
    fixed: [
      { type: 'ledge', x: 0.9, y: 7.6, w: 1.8, h: 0.2, angle: -0.2 },
      { type: 'ball', x: 0.5, y: 8 },
      { type: 'goal', x: 6.9, y: 0, w: 1.4 },
    ],
    parts: { ramp: 2 },
  },
  {
    title: 'じぐざぐ',
    hint: '壁があるので、行ったり来たりさせて下まで運ぼう。',
    fixed: [
      { type: 'ledge', x: 0.9, y: 7.6, w: 1.8, h: 0.2, angle: -0.2 },
      { type: 'ball', x: 0.5, y: 8 },
      { type: 'ledge', x: 4.5, y: 4.2, w: 0.2, h: 4.4, angle: 0 },
      { type: 'goal', x: 1.2, y: 0, w: 1.4 },
    ],
    parts: { ramp: 2, longRamp: 1 },
  },
  {
    title: 'ドミノ',
    hint: '玉は低い壁を越えられない。ドミノなら壁を越えて倒れていく。右の玉をかごへ落とそう。',
    fixed: [
      { type: 'ledge', x: 0.9, y: 7.6, w: 1.8, h: 0.2, angle: -0.2 },
      { type: 'ball', x: 0.5, y: 8 },
      { type: 'ledge', x: 3.9, y: 2, w: 5.6, h: 0.2, angle: 0 },
      { type: 'ledge', x: 4.7, y: 2.3, w: 0.12, h: 0.4, angle: 0 },
      { type: 'ball', x: 6.5, y: 2.3 },
      { type: 'goal', x: 7.4, y: 0, w: 1.1 },
    ],
    parts: { ramp: 1, domino: 6 },
  },
  {
    title: 'ぴょーん',
    hint: '玉は穴に落ちてしまう。バネで跳ね上げて、右の台へ。',
    fixed: [
      { type: 'ledge', x: 0.9, y: 5.6, w: 1.8, h: 0.2, angle: -0.2 },
      { type: 'ball', x: 0.5, y: 6 },
      { type: 'ledge', x: 6, y: 2, w: 4, h: 0.2, angle: 0 },
      { type: 'ledge', x: 3.9, y: 1.1, w: 0.2, h: 2, angle: 0 },
      { type: 'goal', x: 6.9, y: 2.1, w: 1.4 },
    ],
    parts: { spring: 1, ramp: 1 },
  },
  {
    title: 'シーソー',
    hint: 'シーソーの左はしに玉を落として、右の軽い玉を左のかごまで飛ばそう。',
    fixed: [
      { type: 'ledge', x: 0.9, y: 7.6, w: 1.8, h: 0.2, angle: -0.2 },
      { type: 'ball', x: 0.5, y: 8 },
      { type: 'seesaw', x: 4.2, y: 0.6, w: 3.2 },
      { type: 'ball', x: 5.6, y: 1.3, light: true },
      { type: 'ledge', x: 2.05, y: 0.5, w: 0.15, h: 1, angle: 0 },
      { type: 'goal', x: 1, y: 0, w: 1.7 },
    ],
    // かごに入れるのは軽い玉（2 つ目の玉）だけ
    goalBall: 1,
    parts: { ramp: 2, longRamp: 1, block: 2 },
  },
];

// 自由に作るモード
export const SANDBOX = {
  title: 'じゆう',
  hint: '部品をいくつでも置ける。好きな装置を作ろう。',
  fixed: [
    { type: 'ledge', x: 0.9, y: 7.6, w: 1.8, h: 0.2, angle: -0.2 },
    { type: 'ball', x: 0.5, y: 8 },
  ],
  parts: { ramp: Infinity, longRamp: Infinity, domino: Infinity, spring: Infinity, block: Infinity },
};

export function snap(value, step = SNAP) {
  return Math.round(value / step) * step;
}

// 部品の真ん中が盤面の中に入るようにする
export function clampToBoard([x, y]) {
  return [Math.min(BOARD.width, Math.max(0, x)), Math.min(BOARD.height, Math.max(0, y))];
}

// 角度を -π/2〜π/2 にそろえる（板は 180 度回すと同じ形）
export function rotatePart(angle, step = ROTATE_STEP) {
  let next = angle + step;
  while (next > Math.PI / 2 + 1e-9) next -= Math.PI;
  while (next <= -Math.PI / 2 + 1e-9) next += Math.PI;
  return Math.abs(next) < 1e-9 ? 0 : next;
}

// 点が、真ん中 (x, y)・幅 w・厚み h・角度 angle の長方形の中（margin だけ広げて）にあるか
export function pointInPart([px, py], { x, y, w, h, angle = 0 }, margin = 0) {
  const dx = px - x;
  const dy = py - y;
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= w / 2 + margin && Math.abs(ly) <= h / 2 + margin;
}

// まだ置ける数
export function remainingParts(stage, placed) {
  const left = { ...stage.parts };
  for (const part of placed) if (part.type in left) left[part.type] -= 1;
  return left;
}

export function canPlace(stage, placed, type) {
  return (remainingParts(stage, placed)[type] ?? 0) > 0;
}

// 置く部品を作る。位置はマス目にそろえ、盤面の中に収める
export function makePart(type, [x, y], angle = 0) {
  const { w, h } = PART_TYPES[type];
  const [cx, cy] = clampToBoard([snap(x), snap(y)]);
  return { type, x: cx, y: cy, w, h, angle };
}

// かごの中（底から壁の高さまで）
export const GOAL_WALL = 0.6;
export function inGoal([px, py], goal) {
  return Math.abs(px - goal.x) < goal.w / 2 - 0.1 && py > goal.y && py < goal.y + GOAL_WALL + 0.1;
}

// クリアしたステージの記録（番号の集合）
export function markCleared(cleared, index) {
  return [...new Set([...cleared, index])].sort((a, b) => a - b);
}

export function parseCleared(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n >= 0 && n < STAGES.length) : [];
  } catch {
    return [];
  }
}

// 長方形 { x, y, w, h, angle } の 4 つの角
export function corners({ x, y, w, h, angle = 0 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [x + (a * w / 2) * c - (b * h / 2) * s, y + (a * w / 2) * s + (b * h / 2) * c]);
}

// 2 つの長方形が重なるか（分離軸で調べる）。少しだけ触れているのは重なりとしない
export function rectsOverlap(a, b, gap = 0.02) {
  const ca = corners(a);
  const cb = corners(b);
  for (const angle of [a.angle ?? 0, (a.angle ?? 0) + Math.PI / 2, b.angle ?? 0, (b.angle ?? 0) + Math.PI / 2]) {
    const axis = [Math.cos(angle), Math.sin(angle)];
    const project = (points) => points.map(([px, py]) => px * axis[0] + py * axis[1]);
    const pa = project(ca);
    const pb = project(cb);
    if (Math.max(...pa) <= Math.min(...pb) + gap || Math.max(...pb) <= Math.min(...pa) + gap) return false;
  }
  return true;
}

// 動かせない部品が占める長方形
export function fixedRects(stage) {
  const rects = [];
  for (const item of stage.fixed) {
    if (item.type === 'ledge' || PART_TYPES[item.type]) rects.push(item);
    else if (item.type === 'ball') rects.push({ x: item.x, y: item.y, w: BALL_RADIUS * 2, h: BALL_RADIUS * 2, angle: 0 });
    else if (item.type === 'goal') {
      rects.push({ x: item.x, y: item.y + GOAL_WALL / 2, w: item.w, h: GOAL_WALL, angle: 0 });
    } else if (item.type === 'seesaw') {
      rects.push({ x: item.x, y: item.y / 2, w: 0.3, h: item.y, angle: 0 });
      // シーソーは傾くので、動く範囲を広めにとる
      rects.push({ x: item.x, y: item.y, w: item.w, h: item.w * 0.5, angle: 0 });
    }
  }
  return rects;
}

// 置けるか。ほかの部品（others）や動かせない部品と重なっていたら置けない
export function canPut(stage, part, others = []) {
  return !fixedRects(stage).some((rect) => rectsOverlap(part, rect)) && !others.some((other) => other !== part && rectsOverlap(part, other));
}
