// キャラクター管理室の計算部分。DOM・Three.js に依存しないので node:test から直接テストできる。
// キャラクターの保存の形は games/shared/logic.js、形式の判定とサイズの表示は 3D ビューアのものを使う。
import { detectFormat, formatBytes } from '../model-viewer/logic.js';
import { isCharacterRecord } from '../shared/logic.js';

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

// ---- バックアップ（全キャラクターを 1 つのファイルにまとめる） ----
// 形：先頭 8 バイトの目印、4 バイトの目次の長さ、目次（JSON）、各キャラクターのデータを順に並べたもの

export const BACKUP_EXTENSION = 'mgchar';
const BACKUP_MAGIC = 'MGCHAR01';

export function packBackup(records, currentId = null) {
  let offset = 0;
  const characters = records.map(({ id, name, format, facing, addedAt, data }) => {
    const entry = { id, name, format, facing, addedAt, offset, length: data.byteLength };
    offset += data.byteLength;
    return entry;
  });
  const index = new TextEncoder().encode(JSON.stringify({ version: 1, current: currentId, characters }));
  const bytes = new Uint8Array(BACKUP_MAGIC.length + 4 + index.length + offset);
  bytes.set(new TextEncoder().encode(BACKUP_MAGIC), 0);
  new DataView(bytes.buffer).setUint32(BACKUP_MAGIC.length, index.length, true);
  bytes.set(index, BACKUP_MAGIC.length + 4);
  let position = BACKUP_MAGIC.length + 4 + index.length;
  for (const { data } of records) {
    bytes.set(new Uint8Array(data), position);
    position += data.byteLength;
  }
  return bytes.buffer;
}

// 読めないファイルなら null。壊れたキャラクターだけ飛ばす
export function unpackBackup(buffer) {
  const head = BACKUP_MAGIC.length + 4;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < head) return null;
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, BACKUP_MAGIC.length)) !== BACKUP_MAGIC) return null;
  const indexLength = new DataView(buffer).getUint32(BACKUP_MAGIC.length, true);
  if (head + indexLength > buffer.byteLength) return null;
  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, head, indexLength)));
  } catch {
    return null;
  }
  if (!Array.isArray(index?.characters)) return null;
  const start = head + indexLength;
  const records = [];
  for (const { id, name, format, facing, addedAt, offset, length } of index.characters) {
    if (typeof id !== 'string' || !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) continue;
    if (start + offset + length > buffer.byteLength) continue;
    const record = { id, name, format, data: buffer.slice(start + offset, start + offset + length) };
    if (Number.isFinite(facing)) record.facing = facing;
    if (Number.isFinite(addedAt)) record.addedAt = addedAt;
    if (isCharacterRecord(record) && detectFormat(name) === format) records.push(record);
  }
  return { current: typeof index.current === 'string' ? index.current : null, records };
}

export function backupFileName(ms = Date.now()) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `characters-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.${BACKUP_EXTENSION}`;
}
