// 3D ビューアの計算部分。DOM と Three.js に依存しないので node:test から直接テストできる。

export const SUPPORTED_FORMATS = ['glb', 'gltf', 'obj', 'stl'];

// ファイル名の拡張子から形式を判定する。対応していなければ null。
export function detectFormat(fileName) {
  const match = /\.([^./\\]+)$/.exec(fileName);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return SUPPORTED_FORMATS.includes(ext) ? ext : null;
}

// 方位角（真上から見て時計回り、0 度が手前）と高さの角度から、光源の位置を返す
export function lightPosition(azimuthDeg, elevationDeg, distance = 10) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const horizontal = distance * Math.cos(el);
  return {
    x: horizontal * Math.sin(az),
    y: distance * Math.sin(el),
    z: horizontal * Math.cos(az),
  };
}

// 半径 radius の球が画面に収まるカメラの距離。縦横のうち狭いほうの視野角に合わせる。
export function fitDistance(radius, fovDeg, aspect, margin = 1.2) {
  if (!(radius > 0)) return 1;
  const vertical = (fovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  const narrow = Math.min(vertical, horizontal);
  return (radius / Math.sin(narrow / 2)) * margin;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatCount(count) {
  return count.toLocaleString('ja-JP');
}

// 幅 × 高さ × 奥行きを有効数字 3 桁で表示する
export function formatDimensions({ x, y, z }) {
  return [x, y, z].map((v) => Number(v.toPrecision(3)).toString()).join(' × ');
}
