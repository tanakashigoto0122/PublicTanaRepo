// キャラクター管理室の計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。
// キャラクターの保存の形は games/shared/logic.js、形式の判定とサイズの表示は 3D ビューアのものを使う。
import { formatBytes } from '../model-viewer/logic.js';

export {
  LIBRARY_PREFIX, characterFileName, displayName, isCharacterRecord, libraryKey, newCharacterId, sortCharacters,
} from '../shared/logic.js';
export { detectFormat, formatBytes } from '../model-viewer/logic.js';
export { guessFacing } from '../mecha-blaster/logic.js';

export const MAX_CHARACTERS = 30;

// 向きは 90 度ずつ回し、-π〜π の範囲に収める
export function turnFacing(facing = 0, step = Math.PI / 2) {
  let angle = facing + step;
  while (angle > Math.PI + 1e-9) angle -= Math.PI * 2;
  while (angle <= -Math.PI + 1e-9) angle += Math.PI * 2;
  return angle;
}

// 追加した日（年/月/日）
export function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

// 一覧の 1 行の説明。例「glb・1.2 MB・2026/11/10」
export function characterSummary({ format, data, addedAt }) {
  return [format, Number.isFinite(data?.byteLength) ? formatBytes(data.byteLength) : '', formatDate(addedAt)].filter(Boolean).join('・');
}
