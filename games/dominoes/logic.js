// ドミノ倒しの計算部分。DOM・Three.js・物理エンジンに依存しないので node:test から直接テストできる。
// 床の上の位置は [x, z] で表す。ドミノの向き yaw は、倒れていく向き（進む向き）を y 軸まわりの角度で表し、
// yaw = 0 が +z 方向。

// ドミノの大きさ（幅・高さ・厚み）。厚みの向きが進む向き
export const DOMINO_SIZE = [0.5, 1, 0.15];
export const MAX_DOMINOES = 300;
export const SPACING_RANGE = { min: 0.3, max: 0.9 };
// これより傾いたら「倒れた」とみなす（ラジアン）
export const FALLEN_ANGLE = Math.PI / 4;

function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

// 折れ線の上に、始点から spacing ごとに点を取る
export function resamplePath(points, spacing) {
  if (points.length === 0 || !(spacing > 0)) return [];
  const result = [points[0]];
  let carried = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const segment = distance(a, b);
    let along = spacing - carried;
    while (along <= segment) {
      const t = along / segment;
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along += spacing;
    }
    carried = segment - (along - spacing);
  }
  return result;
}

// 進む向きの角度（+z が 0、+x が π/2）
export function headingOf(from, to) {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

// 同じ線の中で、隣どうし以外のドミノとの距離がこれより近いと重なる（線が交差したり折り返したりした所）
export const OVERLAP_DISTANCE = 0.45;

// なぞった線に沿ってドミノを置く位置と向きを決める。向きは前後の点を結ぶ向き（カーブでなめらかになる）。
// 線が交差したり折り返したりして、すでに置いたドミノと重なる場所は飛ばす（置いた瞬間に弾け飛ぶので）。
export function placeAlongPath(points, spacing) {
  const spots = resamplePath(points, spacing);
  if (spots.length < 2) return [];
  const placed = spots.map((spot, i) => {
    const before = spots[Math.max(0, i - 1)];
    const after = spots[Math.min(spots.length - 1, i + 1)];
    return { position: spot, yaw: headingOf(before, after) };
  });
  const kept = [];
  for (const candidate of placed) {
    const others = kept.slice(0, -1);
    if (others.every((k) => distance(k.position, candidate.position) >= OVERLAP_DISTANCE)) kept.push(candidate);
  }
  return kept;
}

// すでに置いてあるドミノに近すぎる場所を除く（重なって置くと、置いた瞬間に弾け飛ぶので）
export function removeTooClose(candidates, existing, minDistance) {
  return candidates.filter((c) => existing.every((e) => distance(c.position, e.position) >= minDistance));
}

// クォータニオン [x, y, z, w] で回った物体の、もとの上向きと真上とのなす角
export function tiltAngle([x, y, z, w]) {
  // 回したあとの上向きベクトルの y 成分
  const up = 1 - 2 * (x * x + z * z);
  return Math.acos(Math.min(1, Math.max(-1, up)));
}

export function isFallen(quaternion) {
  return tiltAngle(quaternion) > FALLEN_ANGLE;
}

// 結果の文
export function summary(fallen, total, seconds) {
  if (total === 0) return 'ドミノがありません。';
  const time = seconds === null ? '' : `（${seconds.toFixed(1)} 秒）`;
  if (fallen === total) return `全部倒れた！ ${total} 個${time}`;
  return `${fallen} / ${total} 個倒れた${time}`;
}

// ---- お手本の形 ----
// どれも床の上の折れ線（[x, z] の配列）を返す。

// 中心から外へ広がるうずまき。gap は隣の周との間隔。
// 間隔がドミノの高さに近いと、倒れたドミノが隣の周に届いて連鎖を乱し、内側の周がきついと連鎖が切れやすいので、
// 何度試しても最後まで倒れた値にしている。
export function spiralPath({ turns = 2.5, gap = 1.5, start = 2, step = 0.05 } = {}) {
  const points = [];
  for (let angle = 0; angle <= turns * 2 * Math.PI; angle += step) {
    const radius = start + (gap * angle) / (2 * Math.PI);
    points.push([radius * Math.sin(angle), radius * Math.cos(angle)]);
  }
  return points;
}

// ハート。size は横幅のおよそ半分
export function heartPath({ size = 4, step = 0.02 } = {}) {
  const points = [];
  const scale = size / 16;
  for (let t = 0; t <= 2 * Math.PI; t += step) {
    const x = 16 * Math.sin(t) ** 3;
    const z = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    // 画面の奥（-z）が上になるように z を反転する
    points.push([x * scale, -z * scale]);
  }
  return points;
}

// 左右に折り返すつづら折り。折り返しは半円にする（直角に曲がると、ドミノの連鎖がそこで止まるので）
export function zigzagPath({ width = 5, rows = 4, rowGap = 1.6, step = 0.1 } = {}) {
  const points = [];
  const radius = rowGap / 2;
  for (let row = 0; row < rows; row++) {
    const z = (row - (rows - 1) / 2) * rowGap;
    const direction = row % 2 === 0 ? 1 : -1;
    points.push([(-direction * width) / 2, z], [(direction * width) / 2, z]);
    if (row === rows - 1) break;
    // 次の行へ半円で折り返す（中心は 2 つの行のまん中）
    for (let angle = step; angle < Math.PI; angle += step) {
      points.push([(direction * width) / 2 + direction * radius * Math.sin(angle), z + radius - radius * Math.cos(angle)]);
    }
  }
  return points;
}
