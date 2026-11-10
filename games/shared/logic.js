// いくつかのゲームで共通に使う、DOM に依存しない部分
import { detectFormat } from '../model-viewer/logic.js';

// 保存されたキャラクターが読み込める形をしているか
export function isCharacterRecord(record) {
  return record?.data instanceof ArrayBuffer && Boolean(detectFormat(record.name));
}

// 保存したキャラクターの一覧は、同じストアの "saved:<id>" に置く（"current" はいま使っているキャラクター）
export const LIBRARY_PREFIX = 'saved:';

export function libraryKey(id) {
  return LIBRARY_PREFIX + id;
}

export function newCharacterId(now = Date.now(), random = Math.random) {
  return `${now.toString(36)}-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

// 一覧は追加した順。追加した時刻がない古い記録は先頭
export function sortCharacters(records) {
  return [...records].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

// 画面に出す名前（拡張子なし）
export function displayName(fileName) {
  return String(fileName ?? '').replace(/\.[^./\\]+$/, '') || 'キャラクター';
}

// 名前を変えても形式がわかるように、拡張子は形式に合わせて付け直す
export function characterFileName(label, format) {
  const base = displayName(String(label ?? '').trim().replace(/[\\/:*?"<>|]/g, '')).trim();
  return `${base || 'キャラクター'}.${format}`;
}
